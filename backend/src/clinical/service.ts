import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import type { AuthContext } from "../auth/policy";
import type { AuthConfig } from "../config";
import { writeAuditEvent, writeOutboxEvent } from "../http/audit";
import { decodeCursor, encodeCursor, hashFilter, type CursorBinding } from "../http/cursor";
import { AppError } from "../http/errors";
import {
  canonicalRequestHash,
  findIdempotencyReceipt,
  lockIdempotencyScope,
  storeIdempotencyReceipt,
  type IdempotencyScope,
} from "../http/idempotency";
import { isUuid } from "../http/request";
import { isoTimestamp } from "../http/time";
import {
  requirePrimaryScope,
  requireSelfOrPrimaryScope,
} from "./policy";
import {
  insertMedicalRecord,
  insertOrder,
  insertSource,
  insertSourceChunks,
  isCurrentActiveOrderHead,
  listCareGuideSources,
  listMedicalRecordRows,
  listOrderHeads,
  lockPatientRow,
  readLatestApprovedSourceHead,
  readLatestMedicalRecord,
  readLatestOrderRevision,
  readLatestSourceRevision,
  readMedicalRecord,
  readOrderById,
  readOrderByIdForUpdate,
  readSourceById,
  readSourceByIdForUpdate,
  readSourceExactRevision,
  type CareOrderRow,
  type ClinicalSourceRow,
  type MedicalRecordRow,
} from "./repository";
import type {
  CareOrderCreate,
  CareOrderPatch,
  CareOrderPublish,
  ClinicalSourceCreate,
  ClinicalSourcePatch,
  MedicalRecordCreate,
} from "./schemas";

const CHUNK_SIZE = 2000;

export type ClinicalService = {
  createMedicalRecord(
    auth: AuthContext,
    patientId: string,
    input: MedicalRecordCreate,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  listMedicalRecords(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  getMedicalRecord(auth: AuthContext, patientId: string, id: string): Promise<unknown>;
  createSource(
    auth: AuthContext,
    input: ClinicalSourceCreate,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  getSource(auth: AuthContext, id: string): Promise<unknown>;
  patchSource(
    auth: AuthContext,
    id: string,
    input: ClinicalSourcePatch,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  publishSource(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  createOrder(
    auth: AuthContext,
    input: CareOrderCreate,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  patchOrder(
    auth: AuthContext,
    id: string,
    input: CareOrderPatch,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  publishOrder(
    auth: AuthContext,
    id: string,
    input: CareOrderPublish,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  listOrders(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  getOrder(auth: AuthContext, id: string): Promise<unknown>;
  careGuide(auth: AuthContext, patientId: string): Promise<unknown>;
};

type ServiceResult<T> = { data: T; statusCode: number };

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function recordValue(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function medicalRecordDto(row: MedicalRecordRow) {
  return {
    id: row.id,
    patientId: row.patient_id,
    revisionNumber: row.revision_number,
    supersedesId: row.supersedes_id,
    sourceReference: row.source_reference,
    payload: jsonValue(row.payload),
    recordedAt: isoTimestamp(row.recorded_at),
    enteredBy: row.entered_by,
    version: row.version,
  };
}

function sourceDto(row: ClinicalSourceRow) {
  return {
    id: row.id,
    patientId: row.patient_id,
    medicalRecordVersionId: row.medical_record_version_id,
    lineageId: row.lineage_id,
    revisionNumber: row.revision_number,
    kind: row.kind,
    title: row.title,
    body: row.body,
    checksum: row.checksum,
    status: row.status,
    supersedesId: row.supersedes_id,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at === null ? null : isoTimestamp(row.approved_at),
    version: row.version,
    chunkCount: row.chunk_count,
  };
}

function orderDto(row: CareOrderRow) {
  return {
    id: row.id,
    patientId: row.patient_id,
    medicalRecordVersionId: row.medical_record_version_id,
    lineageId: row.lineage_id,
    kind: row.kind,
    sourceDocumentId: row.source_document_id,
    sourceVersion: row.source_version,
    payload: jsonValue(row.payload),
    effectiveFrom: isoTimestamp(row.effective_from),
    effectiveTo: row.effective_to === null ? null : isoTimestamp(row.effective_to),
    revisionNumber: row.revision_number,
    version: row.version,
    status: row.status,
    supersedesId: row.supersedes_id,
    enteredBy: row.entered_by,
    createdAt: isoTimestamp(row.created_at),
    publishedBy: row.published_by,
    publishedAt: row.published_at === null ? null : isoTimestamp(row.published_at),
  };
}

function patientSourceDto(row: ClinicalSourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    revisionNumber: row.revision_number,
    approvedAt: row.approved_at === null ? null : isoTimestamp(row.approved_at),
  };
}

function patientOrderDto(row: CareOrderRow) {
  const payload = recordValue(row.payload);
  const items = Array.isArray(payload.items) ? payload.items : undefined;
  return {
    id: row.id,
    kind: row.kind,
    revisionNumber: row.revision_number,
    sourceDocumentId: row.source_document_id,
    sourceVersion: row.source_version,
    instructions: payload.instructions,
    ...(items === undefined ? {} : { items }),
    effectiveFrom: isoTimestamp(row.effective_from),
    effectiveTo: row.effective_to === null ? null : isoTimestamp(row.effective_to),
    status: row.status,
    version: row.version,
  };
}

function sourceChecksum(kind: string, title: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([kind, title, body])).digest("hex");
}

function splitChunks(body: string): string[] {
  const characters = Array.from(body);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += CHUNK_SIZE) {
    chunks.push(characters.slice(offset, offset + CHUNK_SIZE).join(""));
  }
  return chunks.length > 0 ? chunks : [body];
}

function versionConflict(message: string, reason?: string): AppError {
  return new AppError("VERSION_CONFLICT", message, 409, reason ? { reason } : undefined);
}

function requirePathUuid(id: string, message: string): void {
  if (!isUuid(id)) throw new AppError("NOT_FOUND", message, 404);
}

function idempotencyScope(
  auth: AuthContext,
  method: string,
  resourceKey: string,
  key: string,
  requestHash: string,
): IdempotencyScope {
  return {
    accountId: auth.accountId,
    sessionId: auth.sessionId,
    method,
    resourceKey,
    key,
    requestHash,
  };
}

export function createClinicalService(options: { sql: SQL; config: AuthConfig }): ClinicalService {
  const { sql, config } = options;

  async function runIdempotent<T>(
    auth: AuthContext,
    method: string,
    resourceKey: string,
    key: string,
    requestHash: string,
    action: (tx: SQL) => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    const scope = idempotencyScope(auth, method, resourceKey, key, requestHash);
    const existing = await findIdempotencyReceipt(sql, scope);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was reused with a different request",
          409,
        );
      }
      return { data: existing.response as T, statusCode: existing.statusCode };
    }

    return sql.begin(async (tx) => {
      await lockIdempotencyScope(tx, scope);
      const replayed = await findIdempotencyReceipt(tx, scope);
      if (replayed) {
        if (replayed.requestHash !== requestHash) {
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was reused with a different request",
            409,
          );
        }
        return { data: replayed.response as T, statusCode: replayed.statusCode };
      }

      const result = await action(tx);
      await storeIdempotencyReceipt(tx, scope, result.statusCode, result.data);
      return result;
    });
  }

  async function lockedPrimaryPatient(tx: SQL, auth: AuthContext, patientId: string) {
    const patient = await lockPatientRow(tx, patientId);
    if (!patient) throw new AppError("NOT_FOUND", "Patient not found", 404);
    await requirePrimaryScope(tx, auth, patientId);
    return patient;
  }

  async function requireCurrentOrderSource(
    tx: SQL,
    patientId: string,
    sourceDocumentId: string,
    sourceVersion: number,
  ): Promise<ClinicalSourceRow> {
    const source = await readSourceExactRevision(tx, {
      patientId,
      id: sourceDocumentId,
      revisionNumber: sourceVersion,
    });
    if (!source) throw new AppError("NOT_FOUND", "Clinical source not found", 404);
    if (source.status !== "approved") {
      throw new AppError("INVALID_TRANSITION", "Clinical source is not approved", 409);
    }
    const latestMedicalRecord = await readLatestMedicalRecord(tx, patientId);
    if (!latestMedicalRecord || latestMedicalRecord.id !== source.medical_record_version_id) {
      throw versionConflict("Clinical source is bound to a stale medical record", "STALE_MEDICAL_RECORD");
    }
    const currentSourceHead = await readLatestApprovedSourceHead(tx, source.lineage_id);
    if (!currentSourceHead || currentSourceHead.id !== source.id) {
      throw versionConflict("Clinical source is not the current approved head", "STALE_SOURCE_HEAD");
    }
    return source;
  }

  async function createMedicalRecord(
    auth: AuthContext,
    patientId: string,
    input: MedicalRecordCreate,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    await requirePrimaryScope(sql, auth, patientId);
    return runIdempotent(
      auth,
      "POST",
      `/api/v1/patients/${patientId}/medical-record-versions`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, patientId);
        const latest = await readLatestMedicalRecord(tx, patientId);
        const currentVersion = latest?.revision_number ?? 0;
        if (input.expectedVersion !== currentVersion) {
          throw new AppError("VERSION_CONFLICT", "Medical record version conflict", 409, {
            currentVersion,
          });
        }
        if (currentVersion === 0) {
          if (input.supersedesId) {
            throw new AppError(
              "INVALID_TRANSITION",
              "The first medical record revision cannot supersede a predecessor",
              409,
            );
          }
        } else if (!latest || input.supersedesId !== latest.id) {
          throw new AppError(
            "INVALID_TRANSITION",
            "A correction must supersede the exact current medical record revision",
            409,
            { currentVersion, currentId: latest?.id ?? null },
          );
        }

        const row = await insertMedicalRecord(tx, {
          patientId,
          revisionNumber: currentVersion + 1,
          supersedesId: input.supersedesId ?? null,
          enteredBy: auth.staffId!,
          sourceReference: input.sourceReference,
          payload: input.payload,
        });
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "medical_record.version.created",
          subjectType: "medical_record_version",
          subjectId: row.id,
          requestId: meta.requestId,
          after: { revisionNumber: row.revision_number },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "medical_record_version",
          aggregateId: row.id,
          eventType: "medical_record.version.created",
          payload: { revisionNumber: row.revision_number },
        });
        return { data: medicalRecordDto(row), statusCode: 201 };
      },
    );
  }

  async function listMedicalRecords(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ) {
    await requirePrimaryScope(sql, auth, patientId);
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `medical-record-versions:${patientId}`,
      filterHash: hashFilter(patientId),
    };
    const after = query.cursor ? decodeCursor(query.cursor, binding, config.sessionSecret) : null;
    const afterRevision = after === null ? null : Number(after.name);
    if (afterRevision !== null && (!Number.isInteger(afterRevision) || afterRevision < 1)) {
      throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
    }
    const rows = await listMedicalRecordRows(sql, {
      patientId,
      limit: query.limit,
      afterRevision,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: String(last.revision_number), id: last.id },
            config.sessionSecret,
          )
        : null;
    return {
      items: selected.map(medicalRecordDto),
      page: { nextCursor, hasMore },
    };
  }

  async function getMedicalRecord(auth: AuthContext, patientId: string, id: string) {
    requirePathUuid(id, "Medical record not found");
    await requirePrimaryScope(sql, auth, patientId);
    const row = await readMedicalRecord(sql, patientId, id);
    if (!row) throw new AppError("NOT_FOUND", "Medical record not found", 404);
    return medicalRecordDto(row);
  }

  type SourceRevisionInput = {
    patientId: string;
    medicalRecordVersionId: string;
    kind: string;
    title: string;
    body: string;
  };

  async function insertSourceRevision(
    tx: SQL,
    auth: AuthContext,
    input: SourceRevisionInput,
    derived: { lineageId: string; revisionNumber: number; supersedesId: string | null },
    meta: { requestId: string; key: string },
    options: { requireCurrentMedicalRecord: boolean; event: string },
  ): Promise<ServiceResult<unknown>> {
    const medicalRecord = await readMedicalRecord(tx, input.patientId, input.medicalRecordVersionId);
    if (!medicalRecord) {
      throw new AppError("NOT_FOUND", "Medical record not found", 404);
    }
    if (options.requireCurrentMedicalRecord) {
      const latestMedicalRecord = await readLatestMedicalRecord(tx, input.patientId);
      if (!latestMedicalRecord || latestMedicalRecord.id !== medicalRecord.id) {
        throw versionConflict("Clinical source is bound to a stale medical record", "STALE_MEDICAL_RECORD");
      }
    }

    const checksum = sourceChecksum(input.kind, input.title, input.body);
    const chunks = splitChunks(input.body);
    const row = await insertSource(tx, {
      lineageId: derived.lineageId,
      revisionNumber: derived.revisionNumber,
      patientId: input.patientId,
      medicalRecordVersionId: input.medicalRecordVersionId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      checksum,
      createdBy: auth.staffId!,
      supersedesId: derived.supersedesId,
    });
    await insertSourceChunks(tx, row.id, chunks);
    await writeAuditEvent(tx, {
      actorAccountId: auth.accountId,
      action: options.event,
      subjectType: "clinical_source",
      subjectId: row.id,
      requestId: meta.requestId,
      after: {
        revisionNumber: row.revision_number,
        kind: row.kind,
        chunkCount: chunks.length,
      },
    });
    await writeOutboxEvent(tx, {
      aggregateType: "clinical_source",
      aggregateId: row.id,
      eventType: options.event,
      payload: { revisionNumber: row.revision_number, kind: row.kind, chunkCount: chunks.length },
    });
    const created = await readSourceById(tx, row.id);
    if (!created) throw new AppError("INTERNAL", "Source creation failed", 500);
    return { data: sourceDto(created), statusCode: 201 };
  }

  async function createSource(
    auth: AuthContext,
    input: ClinicalSourceCreate,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    await requirePrimaryScope(sql, auth, input.patientId);
    return runIdempotent(
      auth,
      "POST",
      "/api/v1/clinical-sources",
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, input.patientId);
        const medicalRecord = await readMedicalRecord(tx, input.patientId, input.medicalRecordVersionId);
        if (!medicalRecord) {
          throw new AppError("NOT_FOUND", "Medical record not found", 404);
        }

        let lineageId: string = randomUUID();
        let revisionNumber = 1;
        let supersedesId: string | null = null;
        if (input.supersedesId) {
          const predecessor = await readSourceById(tx, input.supersedesId);
          if (!predecessor || predecessor.patient_id !== input.patientId) {
            throw new AppError("NOT_FOUND", "Clinical source not found", 404);
          }
          const latest = await readLatestSourceRevision(tx, predecessor.lineage_id);
          if (!latest || latest.id !== predecessor.id) {
            throw versionConflict("Clinical source lineage has a newer revision");
          }
          if (predecessor.status !== "approved" && predecessor.status !== "draft") {
            throw new AppError("INVALID_TRANSITION", "Clinical source is retired", 409);
          }
          lineageId = predecessor.lineage_id;
          revisionNumber = predecessor.revision_number + 1;
          supersedesId = predecessor.id;
        }

        return insertSourceRevision(
          tx,
          auth,
          input,
          { lineageId, revisionNumber, supersedesId },
          meta,
          { requireCurrentMedicalRecord: false, event: "clinical_source.created" },
        );
      },
    );
  }

  async function patchSource(
    auth: AuthContext,
    id: string,
    input: ClinicalSourcePatch,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Clinical source not found");
    const preRead = await readSourceById(sql, id);
    if (!preRead) throw new AppError("NOT_FOUND", "Clinical source not found", 404);
    await requirePrimaryScope(sql, auth, preRead.patient_id);

    return runIdempotent(
      auth,
      "PATCH",
      `/api/v1/clinical-sources/${id}`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, preRead.patient_id);
        const current = await readSourceByIdForUpdate(tx, id);
        if (!current) throw new AppError("NOT_FOUND", "Clinical source not found", 404);
        if (current.patient_id !== preRead.patient_id) {
          throw new AppError("NOT_FOUND", "Clinical source not found", 404);
        }
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Clinical source version conflict", 409, {
            currentVersion: current.version,
          });
        }
        if (current.status !== "approved" && current.status !== "draft") {
          throw new AppError("INVALID_TRANSITION", "Clinical source is retired", 409);
        }
        const latest = await readLatestSourceRevision(tx, current.lineage_id);
        if (!latest || latest.id !== current.id) {
          throw versionConflict("Clinical source lineage has a newer revision", "STALE_LINEAGE_HEAD");
        }

        return insertSourceRevision(
          tx,
          auth,
          {
            patientId: current.patient_id,
            medicalRecordVersionId: input.medicalRecordVersionId,
            kind: input.kind,
            title: input.title,
            body: input.body,
          },
          {
            lineageId: current.lineage_id,
            revisionNumber: current.revision_number + 1,
            supersedesId: current.id,
          },
          meta,
          { requireCurrentMedicalRecord: true, event: "clinical_source.revised" },
        );
      },
    );
  }

  async function getSource(auth: AuthContext, id: string) {
    requirePathUuid(id, "Clinical source not found");
    const row = await readSourceById(sql, id);
    if (!row) throw new AppError("NOT_FOUND", "Clinical source not found", 404);
    await requirePrimaryScope(sql, auth, row.patient_id);
    return sourceDto(row);
  }

  async function publishSource(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Clinical source not found");
    const preRead = await readSourceById(sql, id);
    if (!preRead) throw new AppError("NOT_FOUND", "Clinical source not found", 404);
    await requirePrimaryScope(sql, auth, preRead.patient_id);

    return runIdempotent(
      auth,
      "POST",
      `/api/v1/clinical-sources/${id}/publish`,
      meta.key,
      canonicalRequestHash({ expectedVersion }),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, preRead.patient_id);
        const current = await readSourceByIdForUpdate(tx, id);
        if (!current) throw new AppError("NOT_FOUND", "Clinical source not found", 404);
        if (current.status === "approved") {
          return { data: sourceDto(current), statusCode: 200 };
        }
        if (current.status !== "draft") {
          throw new AppError("INVALID_TRANSITION", "Clinical source is not publishable", 409);
        }
        if (current.version !== expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Clinical source version conflict", 409, {
            currentVersion: current.version,
          });
        }
        const latestMedicalRecord = await readLatestMedicalRecord(tx, current.patient_id);
        if (!latestMedicalRecord || latestMedicalRecord.id !== current.medical_record_version_id) {
          throw versionConflict("Clinical source is bound to a stale medical record", "STALE_MEDICAL_RECORD");
        }
        const latestRevision = await readLatestSourceRevision(tx, current.lineage_id);
        if (!latestRevision || latestRevision.id !== current.id) {
          throw versionConflict("Clinical source is not the lineage head", "STALE_LINEAGE_HEAD");
        }
        const updated = (await tx`
          UPDATE public.clinical_source_documents
          SET status = 'approved',
              approved_by = ${auth.staffId!},
              approved_at = now(),
              version = version + 1,
              updated_at = now()
          WHERE id = ${current.id} AND version = ${expectedVersion}
          RETURNING id
        `) as unknown as Array<{ id: string }>;
        if (updated.length === 0) {
          throw versionConflict("Clinical source version conflict");
        }
        const row = await readSourceById(tx, current.id);
        if (!row) throw new AppError("INTERNAL", "Source publication failed", 500);
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "clinical_source.published",
          subjectType: "clinical_source",
          subjectId: row.id,
          requestId: meta.requestId,
          after: { revisionNumber: row.revision_number, status: row.status },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "clinical_source",
          aggregateId: row.id,
          eventType: "clinical_source.published",
          payload: { revisionNumber: row.revision_number, status: row.status },
        });
        return { data: sourceDto(row), statusCode: 200 };
      },
    );
  }

  async function createOrder(
    auth: AuthContext,
    input: CareOrderCreate,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    await requirePrimaryScope(sql, auth, input.patientId);
    return runIdempotent(
      auth,
      "POST",
      "/api/v1/orders",
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, input.patientId);
        const source = await requireCurrentOrderSource(
          tx,
          input.patientId,
          input.sourceDocumentId,
          input.sourceVersion,
        );

        let lineageId: string = randomUUID();
        let revisionNumber = 1;
        let supersedesId: string | null = null;
        if (input.supersedesId) {
          const predecessor = await readOrderById(tx, input.supersedesId);
          if (!predecessor || predecessor.patient_id !== input.patientId) {
            throw new AppError("NOT_FOUND", "Care order not found", 404);
          }
          const latest = await readLatestOrderRevision(tx, predecessor.lineage_id);
          if (!latest || latest.id !== predecessor.id) {
            throw versionConflict("Care order lineage has a newer revision");
          }
          lineageId = predecessor.lineage_id;
          revisionNumber = predecessor.revision_number + 1;
          supersedesId = predecessor.id;
        }

        const row = await insertOrder(tx, {
          lineageId,
          revisionNumber,
          patientId: input.patientId,
          medicalRecordVersionId: source.medical_record_version_id,
          kind: input.kind,
          sourceDocumentId: input.sourceDocumentId,
          sourceVersion: input.sourceVersion,
          payload: input.payload,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          enteredBy: auth.staffId!,
          supersedesId,
        });
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "care_order.created",
          subjectType: "care_order",
          subjectId: row.id,
          requestId: meta.requestId,
          after: { revisionNumber: row.revision_number, kind: row.kind },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "care_order",
          aggregateId: row.id,
          eventType: "care_order.created",
          payload: { revisionNumber: row.revision_number, kind: row.kind },
        });
        return { data: orderDto(row), statusCode: 201 };
      },
    );
  }

  async function patchOrder(
    auth: AuthContext,
    id: string,
    input: CareOrderPatch,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Care order not found");
    const preRead = await readOrderById(sql, id);
    if (!preRead) throw new AppError("NOT_FOUND", "Care order not found", 404);
    await requirePrimaryScope(sql, auth, preRead.patient_id);

    return runIdempotent(
      auth,
      "PATCH",
      `/api/v1/orders/${id}`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, preRead.patient_id);
        const current = await readOrderByIdForUpdate(tx, id);
        if (!current) throw new AppError("NOT_FOUND", "Care order not found", 404);
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Care order version conflict", 409, {
            currentVersion: current.version,
          });
        }
        const latest = await readLatestOrderRevision(tx, current.lineage_id);
        if (!latest || latest.id !== current.id) {
          throw versionConflict("Care order lineage has a newer revision");
        }
        const source = await requireCurrentOrderSource(
          tx,
          current.patient_id,
          input.sourceDocumentId,
          input.sourceVersion,
        );
        const row = await insertOrder(tx, {
          lineageId: current.lineage_id,
          revisionNumber: current.revision_number + 1,
          patientId: current.patient_id,
          medicalRecordVersionId: source.medical_record_version_id,
          kind: input.kind,
          sourceDocumentId: input.sourceDocumentId,
          sourceVersion: input.sourceVersion,
          payload: input.payload,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          enteredBy: auth.staffId!,
          supersedesId: current.id,
        });
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "care_order.revised",
          subjectType: "care_order",
          subjectId: row.id,
          requestId: meta.requestId,
          after: { revisionNumber: row.revision_number, kind: row.kind, supersedesId: current.id },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "care_order",
          aggregateId: row.id,
          eventType: "care_order.revised",
          payload: { revisionNumber: row.revision_number, kind: row.kind },
        });
        return { data: orderDto(row), statusCode: 201 };
      },
    );
  }

  async function publishOrder(
    auth: AuthContext,
    id: string,
    input: CareOrderPublish,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Care order not found");
    const preRead = await readOrderById(sql, id);
    if (!preRead) throw new AppError("NOT_FOUND", "Care order not found", 404);
    await requirePrimaryScope(sql, auth, preRead.patient_id);

    return runIdempotent(
      auth,
      "POST",
      `/api/v1/orders/${id}/publish`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedPrimaryPatient(tx, auth, preRead.patient_id);
        const current = await readOrderByIdForUpdate(tx, id);
        if (!current) throw new AppError("NOT_FOUND", "Care order not found", 404);
        if (current.status !== "draft") {
          if (current.status === input.status) {
            return { data: orderDto(current), statusCode: 200 };
          }
          throw new AppError(
            "INVALID_TRANSITION",
            "Care order was already published with a different decision",
            409,
          );
        }
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Care order version conflict", 409, {
            currentVersion: current.version,
          });
        }
        const latest = await readLatestOrderRevision(tx, current.lineage_id);
        if (!latest || latest.id !== current.id) {
          throw versionConflict("Care order is not the lineage head", "STALE_LINEAGE_HEAD");
        }
        const source = await requireCurrentOrderSource(
          tx,
          current.patient_id,
          current.source_document_id,
          current.source_version,
        );
        if (source.medical_record_version_id !== current.medical_record_version_id) {
          throw versionConflict("Care order source binding is stale", "STALE_MEDICAL_RECORD");
        }

        const updated = (await tx`
          UPDATE public.care_orders
          SET status = ${input.status},
              published_by = ${auth.staffId!},
              published_at = now(),
              version = version + 1,
              updated_at = now()
          WHERE id = ${current.id} AND version = ${input.expectedVersion}
          RETURNING id
        `) as unknown as Array<{ id: string }>;
        if (updated.length === 0) throw versionConflict("Care order version conflict");
        const row = await readOrderById(tx, current.id);
        if (!row) throw new AppError("INTERNAL", "Order publication failed", 500);
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "care_order.published",
          subjectType: "care_order",
          subjectId: row.id,
          requestId: meta.requestId,
          after: { revisionNumber: row.revision_number, status: row.status },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "care_order",
          aggregateId: row.id,
          eventType: "care_order.published",
          payload: { revisionNumber: row.revision_number, status: row.status },
        });
        return { data: orderDto(row), statusCode: 200 };
      },
    );
  }

  async function listOrders(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ) {
    await requireSelfOrPrimaryScope(sql, auth, patientId);
    const patientView = auth.role === "patient";
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `orders:${patientId}:${patientView ? "patient" : "staff"}`,
      filterHash: hashFilter(patientId),
    };
    const after = query.cursor ? decodeCursor(query.cursor, binding, config.sessionSecret) : null;
    const rows = await listOrderHeads(sql, {
      patientId,
      patientView,
      limit: query.limit,
      afterEffectiveFrom: after?.name ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: isoTimestamp(last.effective_from), id: last.id },
            config.sessionSecret,
          )
        : null;
    return {
      items: selected.map((row) => (patientView ? patientOrderDto(row) : orderDto(row))),
      page: { nextCursor, hasMore },
    };
  }

  async function getOrder(auth: AuthContext, id: string) {
    requirePathUuid(id, "Care order not found");
    const row = await readOrderById(sql, id);
    if (!row) throw new AppError("NOT_FOUND", "Care order not found", 404);
    await requireSelfOrPrimaryScope(sql, auth, row.patient_id);
    if (auth.role === "patient") {
      if (!(await isCurrentActiveOrderHead(sql, row.id))) {
        throw new AppError("NOT_FOUND", "Care order not found", 404);
      }
      return patientOrderDto(row);
    }
    return orderDto(row);
  }

  async function careGuide(auth: AuthContext, patientId: string) {
    await requireSelfOrPrimaryScope(sql, auth, patientId);
    const sources = await listCareGuideSources(sql, patientId);
    const orders = await listOrderHeads(sql, {
      patientId,
      patientView: true,
      limit: 100,
      afterEffectiveFrom: null,
      afterId: null,
    });
    return {
      patientId,
      sources: sources.map(patientSourceDto),
      sourceVersions: sources.map((source) => ({
        sourceDocumentId: source.id,
        sourceVersion: source.revision_number,
      })),
      orders: orders.slice(0, 100).map(patientOrderDto),
    };
  }

  return {
    createMedicalRecord,
    listMedicalRecords,
    getMedicalRecord,
    createSource,
    getSource,
    patchSource,
    publishSource,
    createOrder,
    patchOrder,
    publishOrder,
    listOrders,
    getOrder,
    careGuide,
  };
}
