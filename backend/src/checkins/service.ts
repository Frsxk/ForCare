import type { SQL } from "bun";
import type { AuthContext } from "../auth/policy";
import type { AuthConfig } from "../config";
import { lockPatientRow } from "../clinical/repository";
import { requirePrimaryScope, requireSelfOrPrimaryScope } from "../clinical/policy";
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
  deleteMedicationAdherenceForCheckIn,
  deleteObservationsForCheckIn,
  insertCheckIn,
  insertMedicationAdherence,
  insertObservationConfirmation,
  insertObservations,
  listCheckIns,
  listObservationsForCheckIn,
  listSubmittedObservations,
  readCheckInById,
  readCheckInByIdForUpdate,
  readDraftForDay,
  readLatestObservationConfirmation,
  readObservationConfirmation,
  readObservationWithCheckIn,
  submitCheckInRow,
  updateDraftCheckIn,
  type CheckInRow,
  type ObservationConfirmationRow,
  type ObservationRow,
} from "./repository";
import {
  observationTypeSchema,
  type CheckInCreate,
  type CheckInPatch,
  type CheckInSubmit,
  type CheckInUpdate,
  type ObservationConfirm,
  type ObservationType,
} from "./schemas";

export type CheckInEdit = CheckInUpdate | CheckInPatch;

export type CheckInService = {
  createCheckIn(
    auth: AuthContext,
    input: CheckInCreate,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  listOwnCheckIns(
    auth: AuthContext,
    query: { status: string | null; cursor: string | null; limit: number },
  ): Promise<{ items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  getCheckIn(auth: AuthContext, id: string): Promise<unknown>;
  updateCheckIn(
    auth: AuthContext,
    id: string,
    input: CheckInEdit,
    meta: { requestId: string; key: string; method: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  submitCheckIn(
    auth: AuthContext,
    id: string,
    input: CheckInSubmit,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
  listPatientCheckIns(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  listObservations(
    auth: AuthContext,
    patientId: string,
    query: { type: string | null; cursor: string | null; limit: number },
  ): Promise<unknown>;
  confirmObservation(
    auth: AuthContext,
    id: string,
    input: ObservationConfirm,
    meta: { requestId: string; key: string },
  ): Promise<{ data: unknown; statusCode: number }>;
};

type ServiceResult<T> = { data: T; statusCode: number };

function versionConflict(message: string, reason?: string): AppError {
  return new AppError("VERSION_CONFLICT", message, 409, reason ? { reason } : undefined);
}

function requirePathUuid(id: string, message: string): void {
  if (!isUuid(id)) throw new AppError("NOT_FOUND", message, 404);
}

function requirePatientSelf(auth: AuthContext): string {
  if (auth.role !== "patient" || !auth.patientId) {
    throw new AppError("FORBIDDEN", "Patient access is required", 403);
  }
  return auth.patientId;
}

function observationTypeFilter(raw: string | null): ObservationType | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = observationTypeSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request: type", 422);
  }
  return parsed.data;
}

function checkInStatusFilter(raw: string | null): "draft" | "submitted" | null {
  if (raw === null || raw.trim() === "") return null;
  const status = raw.trim();
  if (status === "draft" || status === "submitted") return status;
  throw new AppError("VALIDATION_FAILED", "Invalid request: status", 422);
}

/** Server-owned local date derived from the authenticated display time zone. */
function localDateFor(timeZone: string, at = new Date()): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
  } catch {
    throw new AppError("INTERNAL", "Display time zone is invalid", 500);
  }
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (year.length !== 4 || month.length !== 2 || day.length !== 2) {
    throw new AppError("INTERNAL", "Display time zone could not be resolved", 500);
  }
  return `${year}-${month}-${day}`;
}

/** Patient-facing observation projection; no internal confirmation fields. */
function observationDto(row: ObservationRow) {
  return {
    id: row.id,
    checkInId: row.check_in_id,
    type: row.type,
    value: Number(row.value),
    unit: row.unit,
    observedAt: isoTimestamp(row.observed_at),
    source: "patient_check_in",
  };
}

/** Staff confirmation response may carry the internal note. */
function confirmationDto(row: ObservationConfirmationRow) {
  return {
    id: row.id,
    observationId: row.observation_id,
    checkInId: row.check_in_id,
    patientId: row.patient_id,
    checkInVersion: row.check_in_version,
    value: Number(row.observation_value),
    unit: row.observation_unit,
    observedAt: isoTimestamp(row.observation_observed_at),
    note: row.note,
    confirmedByStaffId: row.staff_id,
    confirmedAt: isoTimestamp(row.confirmed_at),
  };
}

/** History/lastConfirmed projection never exposes the internal note. */
function lastConfirmedDto(row: ObservationConfirmationRow) {
  return {
    value: Number(row.observation_value),
    unit: row.observation_unit,
    observedAt: isoTimestamp(row.observation_observed_at),
    confirmedAt: isoTimestamp(row.confirmed_at),
    confirmedByStaffId: row.staff_id,
    observationId: row.observation_id,
    checkInId: row.check_in_id,
  };
}

function checkInDto(row: CheckInRow, observations: ObservationRow[]) {
  return {
    id: row.id,
    patientId: row.patient_id,
    localDate: row.local_date,
    timeZone: row.time_zone,
    condition: row.condition,
    note: row.note,
    medicationAdherence: row.medication_adherence,
    status: row.status,
    supersedesCheckInId: row.supersedes_check_in_id,
    version: row.version,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    submittedAt: row.submitted_at === null ? null : isoTimestamp(row.submitted_at),
    observations: observations.map(observationDto),
  };
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

function decodeCheckInCursor(
  cursor: string,
  binding: CursorBinding,
  secret: string,
): { createdAt: string; id: string } {
  const after = decodeCursor(cursor, binding, secret);
  const createdAt = new Date(after.name);
  if (Number.isNaN(createdAt.getTime())) {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }
  return { createdAt: isoTimestamp(createdAt), id: after.id };
}

function decodeObservationCursor(
  cursor: string,
  binding: CursorBinding,
  secret: string,
): { observedAt: string; id: string } {
  const after = decodeCursor(cursor, binding, secret);
  const observedAt = new Date(after.name);
  if (Number.isNaN(observedAt.getTime())) {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }
  return { observedAt: isoTimestamp(observedAt), id: after.id };
}

export function createCheckInService(options: { sql: SQL; config: AuthConfig }): CheckInService {
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

  async function lockedSelfPatient(tx: SQL, patientId: string) {
    const patient = await lockPatientRow(tx, patientId);
    if (!patient) throw new AppError("NOT_FOUND", "Patient not found", 404);
    return patient;
  }

  async function loadCheckInDto(sqlHandle: SQL, row: CheckInRow) {
    const observations = await listObservationsForCheckIn(sqlHandle, row.id);
    return checkInDto(row, observations);
  }

  async function createCheckIn(
    auth: AuthContext,
    input: CheckInCreate,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    const patientId = requirePatientSelf(auth);
    return runIdempotent(
      auth,
      "POST",
      "/api/v1/check-ins",
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedSelfPatient(tx, patientId);
        const timeZone = auth.displayTimeZone;
        const localDate = localDateFor(timeZone);
        const draft = await readDraftForDay(tx, patientId, localDate);
        if (draft) {
          throw new AppError("VERSION_CONFLICT", "A draft check-in already exists for today", 409, {
            reason: "DRAFT_EXISTS",
            draftId: draft.id,
          });
        }

        if (input.supersedesCheckInId) {
          const predecessor = await readCheckInById(tx, input.supersedesCheckInId);
          if (!predecessor || predecessor.patient_id !== patientId) {
            throw new AppError("NOT_FOUND", "Check-in not found", 404);
          }
          if (predecessor.status !== "submitted") {
            throw new AppError(
              "INVALID_TRANSITION",
              "A correction must supersede a submitted check-in",
              409,
            );
          }
        }

        const row = await insertCheckIn(tx, {
          patientId,
          localDate,
          timeZone,
          condition: input.condition,
          note: input.note,
          medicationAdherence: input.medicationAdherence,
          supersedesCheckInId: input.supersedesCheckInId ?? null,
        });
        await insertMedicationAdherence(tx, row.id, input.medicationAdherence);
        await insertObservations(tx, row.id, patientId, input.observations);
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "check_in.created",
          subjectType: "check_in",
          subjectId: row.id,
          requestId: meta.requestId,
          after: { localDate, supersedesCheckInId: row.supersedes_check_in_id },
        });
        return { data: await loadCheckInDto(tx, row), statusCode: 201 };
      },
    );
  }

  async function listOwnCheckIns(
    auth: AuthContext,
    query: { status: string | null; cursor: string | null; limit: number },
  ) {
    const patientId = requirePatientSelf(auth);
    const status = checkInStatusFilter(query.status);
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `check-ins:self:${patientId}`,
      filterHash: hashFilter(`${patientId}:${status ?? ""}`),
    };
    const after = query.cursor ? decodeCheckInCursor(query.cursor, binding, config.sessionSecret) : null;
    const rows = await listCheckIns(sql, {
      patientId,
      includeDrafts: true,
      status,
      limit: query.limit,
      afterCreatedAt: after?.createdAt ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: isoTimestamp(last.created_at), id: last.id },
            config.sessionSecret,
          )
        : null;
    return {
      items: await Promise.all(selected.map((row) => loadCheckInDto(sql, row))),
      page: { nextCursor, hasMore },
    };
  }

  async function listPatientCheckIns(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ) {
    await requireSelfOrPrimaryScope(sql, auth, patientId);
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `check-ins:patient:${patientId}:${auth.role}`,
      filterHash: hashFilter(`${patientId}:submitted`),
    };
    const after = query.cursor ? decodeCheckInCursor(query.cursor, binding, config.sessionSecret) : null;
    const rows = await listCheckIns(sql, {
      patientId,
      includeDrafts: false,
      status: "submitted",
      limit: query.limit,
      afterCreatedAt: after?.createdAt ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: isoTimestamp(last.created_at), id: last.id },
            config.sessionSecret,
          )
        : null;
    return {
      items: await Promise.all(selected.map((row) => loadCheckInDto(sql, row))),
      page: { nextCursor, hasMore },
    };
  }

  async function getCheckIn(auth: AuthContext, id: string) {
    requirePathUuid(id, "Check-in not found");
    const row = await readCheckInById(sql, id);
    if (!row) throw new AppError("NOT_FOUND", "Check-in not found", 404);
    if (auth.role === "patient") {
      if (auth.patientId !== row.patient_id) {
        throw new AppError("NOT_FOUND", "Check-in not found", 404);
      }
    } else {
      if (row.status !== "submitted") {
        throw new AppError("NOT_FOUND", "Check-in not found", 404);
      }
      await requirePrimaryScope(sql, auth, row.patient_id);
    }
    return loadCheckInDto(sql, row);
  }

  async function updateCheckIn(
    auth: AuthContext,
    id: string,
    input: CheckInEdit,
    meta: { requestId: string; key: string; method: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Check-in not found");
    const patientId = requirePatientSelf(auth);
    const preRead = await readCheckInById(sql, id);
    if (!preRead || preRead.patient_id !== patientId) {
      throw new AppError("NOT_FOUND", "Check-in not found", 404);
    }

    return runIdempotent(
      auth,
      meta.method,
      `/api/v1/check-ins/${id}`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedSelfPatient(tx, patientId);
        const current = await readCheckInByIdForUpdate(tx, id);
        if (!current || current.patient_id !== patientId) {
          throw new AppError("NOT_FOUND", "Check-in not found", 404);
        }
        if (current.status !== "draft") {
          throw new AppError("INVALID_TRANSITION", "Only draft check-ins can be edited", 409);
        }
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Check-in version conflict", 409, {
            currentVersion: current.version,
          });
        }

        const nextCondition = input.condition ?? current.condition;
        const nextNote = input.note !== undefined ? input.note : current.note;
        const nextMedicationAdherence =
          input.medicationAdherence !== undefined
            ? input.medicationAdherence
            : current.medication_adherence;

        // PATCH omits fields; omitted child arrays and scalars stay untouched.
        if (input.observations !== undefined) {
          await deleteObservationsForCheckIn(tx, current.id);
          await insertObservations(tx, current.id, patientId, input.observations);
        }
        if (input.medicationAdherence !== undefined) {
          await deleteMedicationAdherenceForCheckIn(tx, current.id);
          await insertMedicationAdherence(tx, current.id, nextMedicationAdherence);
        }

        const updated = await updateDraftCheckIn(tx, {
          id: current.id,
          expectedVersion: input.expectedVersion,
          condition: nextCondition,
          note: nextNote,
          medicationAdherence: nextMedicationAdherence,
        });
        if (!updated) throw versionConflict("Check-in version conflict");
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "check_in.updated",
          subjectType: "check_in",
          subjectId: updated.id,
          requestId: meta.requestId,
          after: { version: updated.version },
        });
        return { data: await loadCheckInDto(tx, updated), statusCode: 200 };
      },
    );
  }

  async function submitCheckIn(
    auth: AuthContext,
    id: string,
    input: CheckInSubmit,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Check-in not found");
    const patientId = requirePatientSelf(auth);
    const preRead = await readCheckInById(sql, id);
    if (!preRead || preRead.patient_id !== patientId) {
      throw new AppError("NOT_FOUND", "Check-in not found", 404);
    }

    return runIdempotent(
      auth,
      "POST",
      `/api/v1/check-ins/${id}/submit`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedSelfPatient(tx, patientId);
        const current = await readCheckInByIdForUpdate(tx, id);
        if (!current || current.patient_id !== patientId) {
          throw new AppError("NOT_FOUND", "Check-in not found", 404);
        }
        if (current.status === "submitted") {
          // Exact same-key retries already replayed above. A fresh key must
          // still present the current submitted workflow version and never
          // emits a duplicate outbox event.
          if (current.version !== input.expectedVersion) {
            throw new AppError("VERSION_CONFLICT", "Check-in version conflict", 409, {
              currentVersion: current.version,
            });
          }
          return { data: await loadCheckInDto(tx, current), statusCode: 200 };
        }
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Check-in version conflict", 409, {
            currentVersion: current.version,
          });
        }
        const submitted = await submitCheckInRow(tx, {
          id: current.id,
          expectedVersion: input.expectedVersion,
        });
        if (!submitted) throw versionConflict("Check-in version conflict");
        const observations = await listObservationsForCheckIn(tx, submitted.id);
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "check_in.submitted",
          subjectType: "check_in",
          subjectId: submitted.id,
          requestId: meta.requestId,
          after: { localDate: submitted.local_date, version: submitted.version },
        });
        await writeOutboxEvent(tx, {
          aggregateType: "check_in",
          aggregateId: submitted.id,
          eventType: "check_in.submitted",
          payload: {
            status: "submitted",
            localDate: submitted.local_date,
            version: submitted.version,
            observationCount: observations.length,
            medicationAdherence: submitted.medication_adherence,
          },
        });
        return { data: checkInDto(submitted, observations), statusCode: 200 };
      },
    );
  }

  async function listObservations(
    auth: AuthContext,
    patientId: string,
    query: { type: string | null; cursor: string | null; limit: number },
  ) {
    await requireSelfOrPrimaryScope(sql, auth, patientId);
    const type = observationTypeFilter(query.type);
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `observations:${patientId}:${auth.role}`,
      filterHash: hashFilter(`${patientId}:${type ?? ""}`),
    };
    const after = query.cursor
      ? decodeObservationCursor(query.cursor, binding, config.sessionSecret)
      : null;
    const rows = await listSubmittedObservations(sql, {
      patientId,
      type,
      limit: query.limit,
      afterObservedAt: after?.observedAt ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: isoTimestamp(last.observed_at), id: last.id },
            config.sessionSecret,
          )
        : null;

    const latestRows = await listSubmittedObservations(sql, {
      patientId,
      type,
      limit: 1,
      afterObservedAt: null,
      afterId: null,
    });
    const latest = latestRows[0] ?? null;
    const lastConfirmed = await readLatestObservationConfirmation(sql, patientId, type);

    return {
      latestObservation: latest === null ? null : observationDto(latest),
      lastConfirmed: lastConfirmed === null ? null : lastConfirmedDto(lastConfirmed),
      history: { items: selected.map(observationDto), page: { nextCursor, hasMore } },
      trend: { status: "unavailable", reason: "G02_NOT_APPROVED" },
    };
  }

  async function confirmObservation(
    auth: AuthContext,
    id: string,
    input: ObservationConfirm,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<unknown>> {
    requirePathUuid(id, "Observation not found");
    const preRead = await readObservationWithCheckIn(sql, id);
    if (!preRead) throw new AppError("NOT_FOUND", "Observation not found", 404);
    // Fresh grant check happens before any saved-receipt replay.
    await requirePrimaryScope(sql, auth, preRead.patient_id);

    return runIdempotent(
      auth,
      "POST",
      `/api/v1/observations/${id}/confirm`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        await lockedSelfPatient(tx, preRead.patient_id);
        // Recheck the same account grant while the patient row is locked.
        await requirePrimaryScope(tx, auth, preRead.patient_id);
        const observation = await readObservationWithCheckIn(tx, id);
        if (!observation) throw new AppError("NOT_FOUND", "Observation not found", 404);
        if (observation.check_in_status !== "submitted") {
          throw new AppError(
            "INVALID_TRANSITION",
            "Only submitted check-in observations can be confirmed",
            409,
          );
        }

        const existing = await readObservationConfirmation(tx, id);
        if (existing) {
          const exactReplay =
            existing.check_in_version === input.expectedVersion &&
            (existing.note ?? null) === (input.note ?? null) &&
            existing.observation_type === observation.type &&
            Number(existing.observation_value) === Number(observation.value) &&
            existing.observation_unit === observation.unit &&
            isoTimestamp(existing.observation_observed_at) === isoTimestamp(observation.observed_at);
          if (!exactReplay) {
            throw new AppError(
              "INVALID_TRANSITION",
              "Observation was already confirmed with a different decision",
              409,
              { reason: "CONFIRMATION_EXISTS", confirmationId: existing.id },
            );
          }
          return { data: confirmationDto(existing), statusCode: 200 };
        }

        if (observation.check_in_version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Check-in version conflict", 409, {
            currentVersion: observation.check_in_version,
          });
        }

        const confirmation = await insertObservationConfirmation(tx, {
          observationId: observation.id,
          checkInId: observation.check_in_id,
          patientId: observation.patient_id,
          observationType: observation.type,
          observationValue: Number(observation.value),
          observationUnit: observation.unit,
          observationObservedAt: isoTimestamp(observation.observed_at),
          checkInVersion: observation.check_in_version,
          note: input.note ?? null,
          staffId: auth.staffId!,
        });
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "observation.confirmed",
          subjectType: "observation",
          subjectId: observation.id,
          requestId: meta.requestId,
          after: {
            checkInId: observation.check_in_id,
            checkInVersion: observation.check_in_version,
          },
        });
        return { data: confirmationDto(confirmation), statusCode: 201 };
      },
    );
  }

  return {
    createCheckIn,
    listOwnCheckIns,
    getCheckIn,
    updateCheckIn,
    submitCheckIn,
    listPatientCheckIns,
    listObservations,
    confirmObservation,
  };
}
