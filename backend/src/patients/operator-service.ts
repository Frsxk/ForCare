import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { writeAuditEvent, writeOutboxEvent } from "../http/audit";
import { AppError } from "../http/errors";
import { isUuid } from "../http/request";

const RECORD_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;
const NIK = /^\d{16}$/;

export type OperatorAssignmentService = {
  assignRecordNumber(input: {
    patientId: string;
    recordNumber: string;
    expectedVersion: number;
    operator: string;
    approvalReference: string;
  }): Promise<{ patientId: string; version: number; recordNumber: string }>;
  assignPrimaryNurse(input: {
    patientId: string;
    nurseId: string;
    expectedVersion: number;
    operator: string;
    approvalReference: string;
  }): Promise<{ patientId: string; version: number; nurseId: string; grantId: string }>;
};

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", `Invalid request: ${field}`, 422);
  return trimmed;
}

function requiredVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError("VALIDATION_FAILED", "Invalid request: expectedVersion", 422);
  }
  return value;
}

function requiredUuid(value: string, field: string): string {
  const candidate = requiredText(value, field);
  if (!isUuid(candidate)) {
    throw new AppError("VALIDATION_FAILED", `Invalid request: ${field}`, 422);
  }
  return candidate;
}

async function lockPatient(sql: SQL, patientId: string, expectedVersion: number) {
  const rows = (await sql`
    SELECT id, version, primary_nurse_id
    FROM public.patients
    WHERE id = ${patientId}
    FOR UPDATE
  `) as unknown as Array<{ id: string; version: number; primary_nurse_id: string | null }>;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", "Patient not found", 404);
  if (row.version !== expectedVersion) {
    throw new AppError("VERSION_CONFLICT", "Patient version conflict", 409, {
      currentVersion: row.version,
    });
  }
  return row;
}

export function createOperatorAssignmentService(options: {
  sql: SQL;
  config: { nurseEmailDomain: string | null };
}): OperatorAssignmentService {
  const { sql, config } = options;

  async function assignRecordNumber(input: Parameters<OperatorAssignmentService["assignRecordNumber"]>[0]) {
    const patientId = requiredUuid(input.patientId, "patientId");
    const recordNumber = requiredText(input.recordNumber, "recordNumber");
    const operator = requiredText(input.operator, "operator");
    const approvalReference = requiredText(input.approvalReference, "approvalReference");
    const expectedVersion = requiredVersion(input.expectedVersion);
    if (NIK.test(recordNumber)) {
      throw new AppError("VALIDATION_FAILED", "NIK is not accepted as a record number", 422);
    }
    if (!RECORD_NUMBER.test(recordNumber)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request: recordNumber", 422);
    }

    try {
      return await sql.begin(async (tx) => {
        const current = await lockPatient(tx, patientId, expectedVersion);
        const requestId = randomUUID();
        const rows = (await tx`
          UPDATE public.patients
          SET record_number = ${recordNumber}, version = version + 1, updated_at = now()
          WHERE id = ${current.id}
          RETURNING version
        `) as unknown as Array<{ version: number }>;
        const version = rows[0].version;
        await writeAuditEvent(tx, {
          actorAccountId: null,
          action: "patient.record_number.assigned",
          subjectType: "patient",
          subjectId: patientId,
          requestId,
          after: { operator, approvalReference, expectedVersion },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "patient",
          aggregateId: patientId,
          eventType: "patient.record_number.assigned",
          payload: { version },
        });
        return { patientId, version, recordNumber };
      });
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const record = error as { code?: string; errno?: string };
        if (record.code === "23505" || record.errno === "23505") {
          throw new AppError("VALIDATION_FAILED", "Record number is already assigned", 422);
        }
      }
      throw error;
    }
  }

  async function assignPrimaryNurse(input: Parameters<OperatorAssignmentService["assignPrimaryNurse"]>[0]) {
    const patientId = requiredUuid(input.patientId, "patientId");
    const nurseId = requiredUuid(input.nurseId, "nurseId");
    const operator = requiredText(input.operator, "operator");
    const approvalReference = requiredText(input.approvalReference, "approvalReference");
    const expectedVersion = requiredVersion(input.expectedVersion);
    if (!config.nurseEmailDomain) {
      throw new AppError("GATE_UNAVAILABLE", "Nurse domain is not configured", 503, { gate: "G01" });
    }

    return sql.begin(async (tx) => {
      const nurses = (await tx`
        SELECT s.id
        FROM public.staff s
        JOIN public.accounts a ON a.id = s.account_id
        JOIN public.account_roles r ON r.account_id = s.account_id AND r.role = 'nurse'
        WHERE s.id = ${nurseId}
          AND s.active = true
          AND a.status = 'active'
          AND s.identity_approval_ref <> ''
          AND s.provisioning_email_domain = ${config.nurseEmailDomain}
          AND split_part(a.email_normalized, '@', 2) = ${config.nurseEmailDomain}
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
      if (!nurses[0]) {
        throw new AppError("FORBIDDEN", "Nurse is not eligible for primary assignment", 403);
      }

      const current = await lockPatient(tx, patientId, expectedVersion);
      const requestId = randomUUID();
      await tx`
        UPDATE public.patient_access_grants
        SET revoked_at = now()
        WHERE patient_id = ${patientId}
          AND basis = 'primary'
          AND revoked_at IS NULL
          AND staff_id <> ${nurseId}
      `;

      const existing = (await tx`
        SELECT id, expires_at
        FROM public.patient_access_grants
        WHERE patient_id = ${patientId}
          AND staff_id = ${nurseId}
          AND basis = 'primary'
          AND revoked_at IS NULL
        ORDER BY granted_at DESC
        LIMIT 1
      `) as unknown as Array<{ id: string; expires_at: Date | string | null }>;

      let grantId: string;
      if (
        existing[0] &&
        (existing[0].expires_at === null || new Date(existing[0].expires_at).getTime() > Date.now())
      ) {
        grantId = existing[0].id;
      } else {
        if (existing[0]) {
          await tx`UPDATE public.patient_access_grants SET revoked_at = now() WHERE id = ${existing[0].id}`;
        }
        const grants = (await tx`
          INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
          VALUES (${nurseId}, ${patientId}, 'primary')
          RETURNING id
        `) as unknown as Array<{ id: string }>;
        grantId = grants[0].id;
      }

      const rows = (await tx`
        UPDATE public.patients
        SET primary_nurse_id = ${nurseId}, version = version + 1, updated_at = now()
        WHERE id = ${current.id}
        RETURNING version
      `) as unknown as Array<{ version: number }>;
      const version = rows[0].version;

      await writeAuditEvent(tx, {
        actorAccountId: null,
        action: "patient.primary_nurse.assigned",
        subjectType: "patient",
        subjectId: patientId,
        requestId,
        after: { operator, approvalReference, primaryNurseStaffId: nurseId, expectedVersion },
      });
      await writeOutboxEvent(tx, {
        aggregateType: "patient",
        aggregateId: patientId,
        eventType: "patient.primary_nurse.assigned",
        payload: { version },
      });
      return { patientId, version, nurseId, grantId };
    });
  }

  return { assignRecordNumber, assignPrimaryNurse };
}
