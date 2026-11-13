import type { SQL } from "bun";
import type { AuthConfig } from "../config";
import { writeAuditEvent } from "../http/audit";
import { decodeCursor, encodeCursor, hashFilter } from "../http/cursor";
import { AppError } from "../http/errors";
import {
  canonicalRequestHash,
  findIdempotencyReceipt,
  lockIdempotencyScope,
  receiptResourceKey,
  storeIdempotencyReceipt,
  type IdempotencyScope,
} from "../http/idempotency";
import { isUuid } from "../http/request";
import { isoTimestamp } from "../http/time";
import { scopesForRole, type AuthContext } from "../auth/policy";
import { readLatestSubmittedCheckIn } from "../checkins/repository";
import { countActiveOrderHeads } from "../clinical/repository";
import type { NurseProfilePatch, PatientProfilePatch } from "./schemas";
import {
  listAssignedPatients,
  listNurses as listNursesQuery,
  readAssignedPatient,
  readOwnPatient,
  readOwnPatientForUpdate,
  readOwnStaff,
  readOwnStaffForUpdate,
  updatePatientContact,
  updateStaffPhone,
} from "./repository";

export type OwnProfile = Record<string, unknown>;

export type PatientService = {
  getOwnProfile(auth: AuthContext): Promise<OwnProfile>;
  patchOwnProfile(
    auth: AuthContext,
    input: PatientProfilePatch | NurseProfilePatch,
    meta: { requestId: string; key: string },
  ): Promise<{ data: OwnProfile; statusCode: number }>;
  getAccess(auth: AuthContext): Promise<{ scopes: string[]; accessContexts: unknown[] }>;
  listNurses(
    auth: AuthContext,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  listPatients(
    auth: AuthContext,
    query: { scope: string | null; search: string; cursor: string | null; limit: number },
  ): Promise<{ scope: string; items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  getSummary(auth: AuthContext, patientId: string): Promise<unknown>;
  getDetail(auth: AuthContext, patientId: string, scope: string | null): Promise<unknown>;
};

function patientProfile(row: NonNullable<Awaited<ReturnType<typeof readOwnPatient>>>): OwnProfile {
  return {
    role: "patient",
    id: row.id,
    accountId: row.account_id,
    fullName: row.full_name,
    birthDate: row.birth_date,
    gender: row.gender,
    phone: row.phone,
    addressLine: row.address_line,
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    recordNumber: row.record_number,
    primaryNurse: row.primary_nurse_id
      ? { id: row.primary_nurse_id, displayName: row.primary_nurse_display_name ?? "" }
      : null,
    version: row.version,
  };
}

function staffProfile(row: NonNullable<Awaited<ReturnType<typeof readOwnStaff>>>): OwnProfile {
  return {
    role: "nurse",
    id: row.id,
    accountId: row.account_id,
    staffCode: row.staff_code,
    displayName: row.display_name,
    discipline: row.discipline,
    email: row.email_normalized,
    phone: row.phone,
    displayTimeZone: row.display_time_zone,
    version: row.version,
  };
}

function requireNurse(auth: AuthContext): string {
  if (auth.role !== "nurse" || !auth.staffId) {
    throw new AppError("FORBIDDEN", "Nurse access is required", 403);
  }
  return auth.staffId;
}

type PatientListSource = {
  id: string;
  full_name: string;
  record_number: string | null;
  latest_check_in_id?: string | null;
  latest_check_in_condition?: string | null;
  latest_check_in_local_date?: string | null;
  latest_check_in_submitted_at?: Date | string | null;
};

/**
 * Projection shared by the assigned-patient list and summary. Only the most
 * recent submitted check-in is exposed; drafts never appear here.
 */
function patientListRow(row: PatientListSource) {
  return {
    id: row.id,
    displayName: row.full_name,
    recordNumber: row.record_number,
    latestCheckIn:
      row.latest_check_in_id == null || row.latest_check_in_condition == null
        ? null
        : {
            id: row.latest_check_in_id,
            condition: row.latest_check_in_condition,
            localDate: row.latest_check_in_local_date ?? null,
            submittedAt:
              row.latest_check_in_submitted_at == null
                ? null
                : isoTimestamp(row.latest_check_in_submitted_at),
          },
    nextVisit: null,
  };
}

export function createPatientService(options: { sql: SQL; config: AuthConfig }): PatientService {
  const { sql, config } = options;

  async function getOwnProfile(auth: AuthContext): Promise<OwnProfile> {
    if (auth.role === "patient") {
      const row = await readOwnPatient(sql, auth.accountId);
      if (!row) throw new AppError("NOT_FOUND", "Profile not found", 404);
      return patientProfile(row);
    }
    const row = await readOwnStaff(sql, auth.accountId);
    if (!row) throw new AppError("NOT_FOUND", "Profile not found", 404);
    return staffProfile(row);
  }

  async function patchOwnProfile(
    auth: AuthContext,
    input: PatientProfilePatch | NurseProfilePatch,
    meta: { requestId: string; key: string },
  ): Promise<{ data: OwnProfile; statusCode: number }> {
    const method = "PATCH";
    const resourceKey = receiptResourceKey(method, "/api/v1/me/profile");
    const scope: IdempotencyScope = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      method,
      resourceKey,
      key: meta.key,
      requestHash: canonicalRequestHash(input),
    };

    const existing = await findIdempotencyReceipt(sql, scope);
    if (existing) {
      if (existing.requestHash !== scope.requestHash) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request", 409);
      }
      return { data: existing.response as OwnProfile, statusCode: existing.statusCode };
    }

    return sql.begin(async (tx) => {
      await lockIdempotencyScope(tx, scope);
      const replayed = await findIdempotencyReceipt(tx, scope);
      if (replayed) {
        if (replayed.requestHash !== scope.requestHash) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request", 409);
        }
        return { data: replayed.response as OwnProfile, statusCode: replayed.statusCode };
      }

      if (auth.role === "patient") {
        const current = await readOwnPatientForUpdate(tx, auth.accountId);
        if (!current) throw new AppError("NOT_FOUND", "Profile not found", 404);
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Profile version conflict", 409, {
            currentVersion: current.version,
          });
        }
        const patientInput = input as PatientProfilePatch;
        const fields: string[] = [];
        if (patientInput.phone !== undefined) fields.push("phone");
        if (patientInput.addressLine !== undefined) fields.push("addressLine");
        if (patientInput.emergencyContactName !== undefined) fields.push("emergencyContactName");
        if (patientInput.emergencyContactPhone !== undefined) fields.push("emergencyContactPhone");
        await updatePatientContact(tx, {
          patientId: current.id,
          phone: patientInput.phone !== undefined ? patientInput.phone : current.phone,
          addressLine:
            patientInput.addressLine !== undefined ? patientInput.addressLine : current.address_line,
          emergencyContactName:
            patientInput.emergencyContactName !== undefined
              ? patientInput.emergencyContactName
              : current.emergency_contact_name,
          emergencyContactPhone:
            patientInput.emergencyContactPhone !== undefined
              ? patientInput.emergencyContactPhone
              : current.emergency_contact_phone,
        });
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "patient.profile.contact_updated",
          subjectType: "patient",
          subjectId: current.id,
          requestId: meta.requestId,
          after: { fields },
        });
        const updated = await readOwnPatient(tx, auth.accountId);
        if (!updated) throw new AppError("INTERNAL", "Profile update failed", 500);
        const data = patientProfile(updated);
        await storeIdempotencyReceipt(tx, scope, 200, data);
        return { data, statusCode: 200 };
      }

      const current = await readOwnStaffForUpdate(tx, auth.accountId);
      if (!current) throw new AppError("NOT_FOUND", "Profile not found", 404);
      if (current.version !== input.expectedVersion) {
        throw new AppError("VERSION_CONFLICT", "Profile version conflict", 409, {
          currentVersion: current.version,
        });
      }
      const nurseInput = input as NurseProfilePatch;
      await updateStaffPhone(
        tx,
        current.id,
        nurseInput.phone !== undefined ? nurseInput.phone : current.phone,
      );
      await writeAuditEvent(tx, {
        actorAccountId: auth.accountId,
        action: "staff.profile.contact_updated",
        subjectType: "staff",
        subjectId: current.id,
        requestId: meta.requestId,
        after: { fields: ["phone"] },
      });
      const updated = await readOwnStaff(tx, auth.accountId);
      if (!updated) throw new AppError("INTERNAL", "Profile update failed", 500);
      const data = staffProfile(updated);
      await storeIdempotencyReceipt(tx, scope, 200, data);
      return { data, statusCode: 200 };
    });
  }

  async function getAccess(auth: AuthContext) {
    if (auth.role === "patient") {
      return { scopes: scopesForRole("patient"), accessContexts: [] };
    }
    if (!auth.staffId) return { scopes: [], accessContexts: [] };
    return listGrantContexts(sql, auth.staffId);
  }

  async function listNurses(
    auth: AuthContext,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }> {
    const binding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: "nurses",
      filterHash: hashFilter(""),
    };
    const after = query.cursor ? decodeCursor(query.cursor, binding, config.sessionSecret) : null;
    const rows = await listNursesQuery(sql, {
      limit: query.limit,
      afterName: after?.name ?? null,
      afterId: after?.id ?? null,
      nurseEmailDomain: config.nurseEmailDomain,
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      displayName: row.display_name,
      staffCode: row.staff_code,
      workingWindowSummary: null,
      active: row.active,
    }));
    const last = rows.length > 0 ? rows[Math.min(rows.length, query.limit) - 1] : null;
    const nextCursor =
      hasMore && last
        ? encodeCursor(binding, { name: last.display_name.toLowerCase(), id: last.id }, config.sessionSecret)
        : null;
    return { items, page: { nextCursor, hasMore } };
  }

  async function listPatients(
    auth: AuthContext,
    query: { scope: string | null; search: string; cursor: string | null; limit: number },
  ) {
    const staffId = requireNurse(auth);
    const scope = query.scope?.trim() ?? "";
    if (scope === "") throw new AppError("SCOPE_REQUIRED", "scope is required", 422);
    if (scope !== "assigned") {
      if (scope.startsWith("visit:")) {
        throw new AppError("GATE_UNAVAILABLE", "Visit scope is gated by G04", 503, { gate: "G04" });
      }
      if (scope === "request_intake") {
        throw new AppError("GATE_UNAVAILABLE", "Request intake scope is gated by G03", 503, { gate: "G03" });
      }
      throw new AppError("VALIDATION_FAILED", "Invalid request: scope", 422);
    }
    const search = query.search.trim().toLowerCase();
    if (search.length > 100) throw new AppError("VALIDATION_FAILED", "Invalid request: search", 422);
    const binding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: "patients:assigned",
      filterHash: hashFilter(search),
    };
    const after = query.cursor ? decodeCursor(query.cursor, binding, config.sessionSecret) : null;
    const rows = await listAssignedPatients(sql, {
      staffId,
      search,
      limit: query.limit,
      afterName: after?.name ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(binding, { name: last.full_name.toLowerCase(), id: last.id }, config.sessionSecret)
        : null;
    return {
      scope: "assigned",
      items: selected.map(patientListRow),
      page: { nextCursor, hasMore },
    };
  }

  async function getSummary(auth: AuthContext, patientId: string) {
    const staffId = requireNurse(auth);
    if (!isUuid(patientId)) throw new AppError("NOT_FOUND", "Patient not found", 404);
    const row = await readAssignedPatient(sql, staffId, patientId);
    if (!row) throw new AppError("NOT_FOUND", "Patient not found", 404);
    const latest = await readLatestSubmittedCheckIn(sql, row.id);
    return {
      ...patientListRow({ id: row.id, full_name: row.full_name, record_number: row.record_number }),
      latestCheckIn: latest
        ? {
            id: latest.id,
            condition: latest.condition,
            localDate: latest.local_date,
            submittedAt: isoTimestamp(latest.submitted_at),
          }
        : null,
      activeOrderCount: await countActiveOrderHeads(sql, row.id),
    };
  }

  async function getDetail(auth: AuthContext, patientId: string, scope: string | null) {
    const staffId = requireNurse(auth);
    const requestedScope = scope?.trim() ?? "";
    if (requestedScope === "") throw new AppError("SCOPE_REQUIRED", "scope is required", 422);
    if (requestedScope.startsWith("visit:")) {
      throw new AppError("GATE_UNAVAILABLE", "Visit-scoped patient detail is gated by G04", 503, { gate: "G04" });
    }
    if (requestedScope !== "assigned") {
      throw new AppError("VALIDATION_FAILED", "Invalid request: scope", 422);
    }
    if (!isUuid(patientId)) throw new AppError("NOT_FOUND", "Patient not found", 404);
    const row = await readAssignedPatient(sql, staffId, patientId);
    if (!row) throw new AppError("NOT_FOUND", "Patient not found", 404);
    return {
      id: row.id,
      displayName: row.full_name,
      recordNumber: row.record_number,
      version: row.version,
      access: {
        scope: "assigned",
        expiresAt: row.expires_at === null ? null : isoTimestamp(row.expires_at),
      },
      profile: { birthDate: row.birth_date, gender: row.gender },
      primaryNurse: row.primary_nurse_id
        ? { id: row.primary_nurse_id, displayName: row.primary_nurse_display_name ?? "" }
        : null,
      availableSections: ["profile", "care_guide"],
    };
  }

  return {
    getOwnProfile,
    patchOwnProfile,
    getAccess,
    listNurses,
    listPatients,
    getSummary,
    getDetail,
  };
}

async function listGrantContexts(sql: SQL, staffId: string) {
  const rows = (await sql`
    SELECT patient_id, basis, expires_at
    FROM public.patient_access_grants
    WHERE staff_id = ${staffId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY granted_at, id
  `) as unknown as Array<{ patient_id: string; basis: string; expires_at: Date | string | null }>;
  return {
    scopes: scopesForRole(
      "nurse",
      rows.map((row) => row.basis),
    ),
    accessContexts: rows.map((row) => ({
      basis: row.basis,
      patientId: row.patient_id,
      expiresAt: row.expires_at === null ? null : isoTimestamp(row.expires_at),
    })),
  };
}
