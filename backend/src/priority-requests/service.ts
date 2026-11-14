import type { SQL } from "bun";
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
  acceptedPriorityConflictExists,
  decidePriorityRequest,
  insertPriorityRequest,
  insertScheduleException,
  listPriorityRequests,
  lockBookingBinding,
  lockPriorityEligibleNurse,
  lockPriorityPatient,
  lockPriorityRequest,
  readApplicableAvailability,
  readBookingBinding,
  readNursePriorityRequest,
  readOwnPriorityRequest,
  type PriorityRequestRow,
} from "./repository";
import type { PriorityRequestCreate, PriorityRequestReview } from "./schemas";

export type PriorityRequestDto = {
  id: string;
  bookingId: string;
  patientId: string;
  nurseId: string;
  startsAt: string;
  endsAt: string;
  statement: string;
  status: PriorityRequestRow["status"];
  reason: string | null;
  version: number;
  reviewedAt: string | null;
  createdAt: string;
  patient?: { displayName: string; recordNumber: string | null };
};

export type PriorityRequestService = {
  createPriorityRequest(
    auth: AuthContext,
    input: PriorityRequestCreate,
    meta: { requestId: string; key: string },
  ): Promise<{ data: PriorityRequestDto; statusCode: number }>;
  listOwnPriorityRequests(
    auth: AuthContext,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: PriorityRequestDto[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  getOwnPriorityRequest(auth: AuthContext, id: string): Promise<PriorityRequestDto>;
  listNursePriorityRequests(
    auth: AuthContext,
    query: { cursor: string | null; limit: number },
  ): Promise<{ items: PriorityRequestDto[]; page: { nextCursor: string | null; hasMore: boolean } }>;
  getNursePriorityRequest(auth: AuthContext, id: string): Promise<PriorityRequestDto>;
  reviewPriorityRequest(
    auth: AuthContext,
    id: string,
    input: PriorityRequestReview,
    meta: { requestId: string; key: string },
  ): Promise<{ data: PriorityRequestDto; statusCode: number }>;
};

type ServiceResult<T> = { data: T; statusCode: number };

function priorityDto(row: PriorityRequestRow, nurseProjection = false): PriorityRequestDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    patientId: row.patient_id,
    nurseId: row.nurse_id,
    startsAt: isoTimestamp(row.starts_at),
    endsAt: isoTimestamp(row.ends_at),
    statement: row.statement,
    status: row.status,
    reason: row.reason,
    version: row.version,
    reviewedAt: row.reviewed_at === null ? null : isoTimestamp(row.reviewed_at),
    createdAt: isoTimestamp(row.created_at),
    ...(nurseProjection
      ? {
          patient: {
            displayName: row.patient_display_name,
            recordNumber: row.patient_record_number,
          },
        }
      : {}),
  };
}

function decodePriorityCursor(
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

function scheduleConflict(error: unknown): never {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (["23505", "23P01", "23514"].includes(code)) {
    throw new AppError("SCHEDULE_CONFLICT", "Requested interval conflicts with an accepted booking", 409);
  }
  throw error;
}

export function createPriorityRequestService(options: {
  sql: SQL;
  config: AuthConfig;
}): PriorityRequestService {
  const { sql, config } = options;

  function requirePatient(auth: AuthContext): string {
    if (auth.role !== "patient" || !auth.patientId) {
      throw new AppError("FORBIDDEN", "Patient access is required", 403);
    }
    return auth.patientId;
  }

  function requireNurse(auth: AuthContext): string {
    if (auth.role !== "nurse" || !auth.staffId) {
      throw new AppError("FORBIDDEN", "Selected nurse access is required", 403);
    }
    return auth.staffId;
  }

  function requireUuid(id: string): void {
    if (!isUuid(id)) throw new AppError("NOT_FOUND", "Priority request not found", 404);
  }

  async function runIdempotent<T>(
    auth: AuthContext,
    resourceKey: string,
    key: string,
    requestHash: string,
    action: (tx: SQL) => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    const scope: IdempotencyScope = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      method: "POST",
      resourceKey,
      key,
      requestHash,
    };
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

  async function applicablePolicy(
    tx: SQL,
    nurseId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<void> {
    if (
      !Number.isFinite(new Date(startsAt).getTime()) ||
      !Number.isFinite(new Date(endsAt).getTime()) ||
      new Date(startsAt).getTime() <= Date.now() ||
      new Date(endsAt).getTime() <= new Date(startsAt).getTime()
    ) {
      throw new AppError("VALIDATION_FAILED", "Requested interval must be in the future", 422);
    }

    const availability = await readApplicableAvailability(tx, nurseId, startsAt, endsAt);
    if (!availability) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Requested interval has no applicable nurse availability settings",
        422,
      );
    }
    const exactDuration = Number(availability.slot_minutes) * 60_000;
    if (
      new Date(endsAt).getTime() - new Date(startsAt).getTime() !== exactDuration ||
      new Date(endsAt).getTime() > new Date(availability.effective_to).getTime()
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Requested interval must match the nurse's configured duration and availability horizon",
        422,
      );
    }
  }

  async function assertNoAcceptedConflict(
    tx: SQL,
    input: {
      bookingId: string;
      patientId: string;
      nurseId: string;
      startsAt: string;
      endsAt: string;
    },
  ): Promise<void> {
    if (await acceptedPriorityConflictExists(tx, input)) {
      throw new AppError("SCHEDULE_CONFLICT", "Requested interval conflicts with an accepted booking", 409);
    }
  }

  async function createPriorityRequest(
    auth: AuthContext,
    input: PriorityRequestCreate,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<PriorityRequestDto>> {
    const patientId = requirePatient(auth);
    const requested = await readBookingBinding(sql, input.bookingId, patientId);
    // A receipt must replay even after the draft has since been submitted.
    return runIdempotent(
      auth,
      "/api/v1/me/priority-requests",
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        if (!requested || !["draft", "accepted"].includes(requested.status)) {
          throw new AppError("NOT_FOUND", "Draft or accepted booking not found", 404);
        }
        if (requested.status === "draft" && (input.startsAt !== undefined || input.endsAt !== undefined)) {
          throw new AppError("VALIDATION_FAILED", "Draft priority requests use the exact draft interval", 422);
        }
        const startsAt = input.startsAt ?? isoTimestamp(requested.starts_at);
        const endsAt = input.endsAt ?? isoTimestamp(requested.ends_at);
        await lockPriorityPatient(tx, patientId);
        const eligible = await lockPriorityEligibleNurse(tx, {
          nurseId: requested.nurse_id,
          accountId: null,
          nurseEmailDomain: config.nurseEmailDomain,
        });
        const binding = await lockBookingBinding(tx, requested.id);
        if (!binding || binding.patient_id !== patientId || !["draft", "accepted"].includes(binding.status)) {
          throw new AppError("NOT_FOUND", "Draft or accepted booking not found", 404);
        }
        if (
          binding.status === "draft" &&
          (isoTimestamp(binding.starts_at) !== startsAt || isoTimestamp(binding.ends_at) !== endsAt)
        ) {
          throw new AppError("VALIDATION_FAILED", "Draft priority request must match the current draft", 422);
        }
        if (
          !eligible ||
          binding.nurse_id !== requested.nurse_id ||
          !(await lockPriorityEligibleNurse(tx, {
            nurseId: binding.nurse_id,
            accountId: null,
            nurseEmailDomain: config.nurseEmailDomain,
          }))
        ) {
          throw new AppError("FORBIDDEN", "Selected nurse is not currently eligible", 403);
        }
        await applicablePolicy(tx, binding.nurse_id, startsAt, endsAt);
        await assertNoAcceptedConflict(tx, {
          bookingId: binding.id,
          patientId,
          nurseId: binding.nurse_id,
          startsAt,
          endsAt,
        });

        const created = await insertPriorityRequest(tx, {
          bookingId: binding.id,
          patientId,
          nurseId: binding.nurse_id,
          startsAt,
          endsAt,
          statement: input.statement,
        });
        const event = {
          id: created.id,
          bookingId: created.booking_id,
          nurseId: created.nurse_id,
          startsAt: isoTimestamp(created.starts_at),
          endsAt: isoTimestamp(created.ends_at),
          status: created.status,
          version: created.version,
        };
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action: "priority_request.created",
          subjectType: "priority_request",
          subjectId: created.id,
          requestId: meta.requestId,
          after: event,
        });
        await writeOutboxEvent(tx, {
          aggregateType: "priority_request",
          aggregateId: created.id,
          eventType: "priority_request.created",
          payload: event,
        });
        return { data: priorityDto(created), statusCode: 201 };
      },
    );
  }

  async function listFor(
    auth: AuthContext,
    owner: "patient" | "nurse",
    ownerId: string,
    query: { cursor: string | null; limit: number },
  ) {
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `priority-requests:${owner}:${ownerId}`,
      filterHash: hashFilter(`${owner}:${ownerId}`),
    };
    const after = query.cursor
      ? decodePriorityCursor(query.cursor, binding, config.sessionSecret)
      : null;
    const rows = await listPriorityRequests(sql, {
      owner,
      ownerId,
      limit: query.limit,
      afterCreatedAt: after?.createdAt ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    return {
      items: selected.map((row) => priorityDto(row, owner === "nurse")),
      page: {
        nextCursor:
          hasMore && last
            ? encodeCursor(
                binding,
                { name: isoTimestamp(last.created_at), id: last.id },
                config.sessionSecret,
              )
            : null,
        hasMore,
      },
    };
  }

  async function reviewPriorityRequest(
    auth: AuthContext,
    id: string,
    input: PriorityRequestReview,
    meta: { requestId: string; key: string },
  ): Promise<ServiceResult<PriorityRequestDto>> {
    requireUuid(id);
    const nurseId = requireNurse(auth);
    const preRead = await readNursePriorityRequest(sql, id, nurseId);

    return runIdempotent(
      auth,
      `/api/v1/priority-requests/${id}/review`,
      meta.key,
      canonicalRequestHash(input),
      async (tx) => {
        if (!preRead) throw new AppError("NOT_FOUND", "Priority request not found", 404);
        await lockPriorityPatient(tx, preRead.patient_id);
        const eligible = await lockPriorityEligibleNurse(tx, {
          nurseId,
          accountId: auth.accountId,
          nurseEmailDomain: config.nurseEmailDomain,
        });
        if (!eligible) {
          throw new AppError("FORBIDDEN", "Selected nurse is not currently eligible", 403);
        }
        const binding = await lockBookingBinding(tx, preRead.booking_id);
        if (
          !binding ||
          binding.patient_id !== preRead.patient_id ||
          binding.nurse_id !== preRead.nurse_id ||
          !["draft", "accepted"].includes(binding.status)
        ) {
          throw new AppError("INVALID_TRANSITION", "Bound booking can no longer be reviewed", 409);
        }
        const current = await lockPriorityRequest(tx, id, nurseId);
        if (!current) throw new AppError("NOT_FOUND", "Priority request not found", 404);
        if (current.version !== input.expectedVersion) {
          throw new AppError("VERSION_CONFLICT", "Priority request version conflict", 409, {
            currentVersion: current.version,
          });
        }
        if (current.status !== "pending") {
          throw new AppError("INVALID_TRANSITION", "Priority request already has a decision", 409);
        }

        const startsAt = isoTimestamp(current.starts_at);
        const endsAt = isoTimestamp(current.ends_at);
        if (
          binding.status === "draft" &&
          (isoTimestamp(binding.starts_at) !== startsAt || isoTimestamp(binding.ends_at) !== endsAt)
        ) {
          throw new AppError("INVALID_TRANSITION", "Draft interval changed; request must be recreated", 409);
        }

        const status = input.decision === "accept_availability" ? "availability_accepted" : "declined";
        try {
          if (status === "availability_accepted") {
            await assertNoAcceptedConflict(tx, {
              bookingId: current.booking_id,
              patientId: current.patient_id,
              nurseId: current.nurse_id,
              startsAt,
              endsAt,
            });
            await applicablePolicy(tx, current.nurse_id, startsAt, endsAt);
          }

          const decision = await decidePriorityRequest(tx, {
            id,
            nurseId,
            expectedVersion: input.expectedVersion,
            status,
            reason: input.reason,
            reviewerAccountId: auth.accountId,
          });
          if (!decision) {
            throw new AppError("VERSION_CONFLICT", "Priority request version conflict", 409);
          }

          if (status === "availability_accepted") {
            await insertScheduleException(tx, {
              priorityRequestId: id,
              bookingId: current.booking_id,
              nurseId: current.nurse_id,
              startsAt,
              endsAt,
              approvedBy: auth.accountId,
              reason: input.reason,
            });
          }
        } catch (error) {
          scheduleConflict(error);
        }

        const reviewed = await readNursePriorityRequest(tx, id, nurseId);
        if (!reviewed) throw new AppError("NOT_FOUND", "Priority request not found", 404);
        const event = {
          id,
          bookingId: reviewed.booking_id,
          nurseId: reviewed.nurse_id,
          startsAt: isoTimestamp(reviewed.starts_at),
          endsAt: isoTimestamp(reviewed.ends_at),
          status: reviewed.status,
          version: reviewed.version,
        };
        await writeAuditEvent(tx, {
          actorAccountId: auth.accountId,
          action:
            reviewed.status === "availability_accepted"
              ? "priority_request.availability_accepted"
              : "priority_request.declined",
          subjectType: "priority_request",
          subjectId: id,
          requestId: meta.requestId,
          before: { status: current.status, version: current.version },
          after: event,
        });
        await writeOutboxEvent(tx, {
          aggregateType: "priority_request",
          aggregateId: id,
          eventType:
            reviewed.status === "availability_accepted"
              ? "priority_request.availability_accepted"
              : "priority_request.declined",
          payload: event,
        });

        // Availability approval is intentionally not a booking mutation: no
        // submission, reservation, acceptance, grant, visit, or dispatch occurs.
        return { data: priorityDto(reviewed, true), statusCode: 200 };
      },
    );
  }

  return {
    createPriorityRequest,
    listOwnPriorityRequests(auth, query) {
      return listFor(auth, "patient", requirePatient(auth), query);
    },
    getOwnPriorityRequest(auth, id) {
      requireUuid(id);
      const patientId = requirePatient(auth);
      return readOwnPriorityRequest(sql, id, patientId).then((row) => {
        if (!row) throw new AppError("NOT_FOUND", "Priority request not found", 404);
        return priorityDto(row);
      });
    },
    listNursePriorityRequests(auth, query) {
      return listFor(auth, "nurse", requireNurse(auth), query);
    },
    getNursePriorityRequest(auth, id) {
      requireUuid(id);
      const nurseId = requireNurse(auth);
      return readNursePriorityRequest(sql, id, nurseId).then((row) => {
        if (!row) throw new AppError("NOT_FOUND", "Priority request not found", 404);
        return priorityDto(row, true);
      });
    },
    reviewPriorityRequest,
  };
}
