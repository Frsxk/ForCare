import { createHash } from "node:crypto";
import type { SQL } from "bun";
import type { AuthContext } from "../auth/policy";
import type { AuthConfig } from "../config";
import { nurseIdentityValid, type PrincipalRow } from "../auth/policy";
import { listCareGuideSources, listOrderHeads, type CareOrderRow, type ClinicalSourceRow } from "../clinical/repository";
import { writeAuditEvent, writeOutboxEvent } from "../http/audit";
import { decodeCursor, encodeCursor, hashFilter, type CursorBinding } from "../http/cursor";
import { AppError } from "../http/errors";
import { canonicalRequestHash, findIdempotencyReceipt, lockIdempotencyScope, storeIdempotencyReceipt, type IdempotencyScope } from "../http/idempotency";
import { isUuid } from "../http/request";
import { isoTimestamp } from "../http/time";
import {
  acceptBooking,
  cancelBooking,
  cancelVisit,
  countActive,
  findScheduleConflict,
  grantIntake,
  grantVisit,
  insertBooking,
  insertBookingEvent,
  insertVisit,
  listBookingEvents,
  listBookingEventsFor,
  listBookings,
  lockBooking,
  lockNurseIdentity,
  lockPatientIdentity,
  lockScheduledVisit,
  readApplicableAvailability,
  readBooking,
  readCurrentSlot,
  readExactApprovedException,
  rejectBooking,
  rescheduleVisitAndBooking,
  revokeIntake,
  revokeVisit,
  submitBooking,
  updateBookingDraft,
  updateVisitGrantExpiry,
  type BookingRow,
  type BookingEventRow,
  type BookingStatus,
  type Slot,
} from "./repository";
import type { BookingCancel, BookingCreate, BookingDecision, BookingPatch, BookingReschedule, BookingVersion } from "./schemas";

type Page = { items: unknown[]; page: { nextCursor: string | null; hasMore: boolean } };
type Result = { data: unknown; statusCode: number };
type Meta = { requestId: string; key: string };

export type BookingService = {
  createBooking(auth: AuthContext, input: BookingCreate, meta: Meta): Promise<Result>;
  patchBooking(auth: AuthContext, id: string, input: BookingPatch, meta: Meta): Promise<Result>;
  listOwnBookings(auth: AuthContext, query: { status: string | null; cursor: string | null; limit: number }): Promise<Page>;
  getOwnBooking(auth: AuthContext, id: string): Promise<unknown>;
  submitBooking(auth: AuthContext, id: string, input: BookingVersion, meta: Meta): Promise<Result>;
  cancelOwnBooking(auth: AuthContext, id: string, input: BookingCancel, meta: Meta): Promise<Result>;
  listNurseBookings(auth: AuthContext, query: { status: string | null; search: string; cursor: string | null; limit: number }): Promise<Page>;
  getNurseBooking(auth: AuthContext, id: string): Promise<unknown>;
  decideBooking(auth: AuthContext, id: string, input: BookingDecision, meta: Meta): Promise<Result>;
  cancelNurseBooking(auth: AuthContext, id: string, input: BookingCancel, meta: Meta): Promise<Result>;
  rescheduleBooking(auth: AuthContext, id: string, input: BookingReschedule, meta: Meta): Promise<Result>;
  listSchedule(auth: AuthContext, query: { from: string; to: string; cursor: string | null; limit: number }): Promise<Page>;
  getCareGuide(auth: AuthContext, id: string): Promise<unknown>;
};

function patient(auth: AuthContext): string {
  if (auth.role !== "patient" || !auth.patientId) throw new AppError("FORBIDDEN", "Patient access is required", 403);
  return auth.patientId;
}

function nurse(auth: AuthContext): string {
  if (auth.role !== "nurse" || !auth.staffId) throw new AppError("FORBIDDEN", "Nurse access is required", 403);
  return auth.staffId;
}

function requireId(id: string): void {
  if (!isUuid(id)) throw new AppError("NOT_FOUND", "Booking not found", 404);
}

function statusFilter(raw: string | null): BookingStatus | null {
  if (raw === null || raw.trim() === "") return null;
  const statuses: BookingStatus[] = ["draft", "submitted", "accepted", "rejected", "cancelled"];
  if (!statuses.includes(raw as BookingStatus)) throw new AppError("VALIDATION_FAILED", "Invalid request: status", 422);
  return raw as BookingStatus;
}

function versionConflict(row: BookingRow): AppError {
  return new AppError("VERSION_CONFLICT", "Booking version conflict", 409, { currentVersion: row.version });
}

function eventData(row: BookingRow): Record<string, unknown> {
  return { startsAt: isoTimestamp(row.starts_at), endsAt: isoTimestamp(row.ends_at), slotId: row.slot_id, availabilityVersionId: row.availability_version_id };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dto(row: BookingRow, events: BookingEventRow[], privateAccess: boolean) {
  return {
    id: row.id,
    patientId: row.patient_id,
    nurseId: row.nurse_id,
    nurse: { id: row.nurse_id, displayName: row.nurse_display_name, staffCode: row.nurse_staff_code },
    slotId: row.slot_id,
    availabilityVersionId: row.availability_version_id,
    startsAt: isoTimestamp(row.starts_at),
    endsAt: isoTimestamp(row.ends_at),
    status: row.status,
    version: row.version,
    intake: privateAccess ? jsonRecord(row.intake) : null,
    profileSnapshot: privateAccess ? (row.profile_snapshot === null ? null : jsonRecord(row.profile_snapshot)) : null,
    visitId: row.visit_id,
    priorityRequestId: row.priority_request_id,
    decisionReason: row.decision_reason,
    submittedAt: row.submitted_at === null ? null : isoTimestamp(row.submitted_at),
    decidedAt: row.decided_at === null ? null : isoTimestamp(row.decided_at),
    cancelledAt: row.cancelled_at === null ? null : isoTimestamp(row.cancelled_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    events: events.map((event) => ({
      id: event.id,
      action: event.action,
      version: event.version,
      reason: event.reason,
      data: jsonRecord(event.data),
      createdAt: isoTimestamp(event.created_at),
    })),
  };
}

function nursePrivateAccess(row: BookingRow): boolean {
  if (row.status === "submitted") return row.intake_grant_active;
  if (row.status === "accepted") return row.visit_grant_active;
  return false;
}

function patientSourceDto(row: ClinicalSourceRow) {
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, revisionNumber: row.revision_number, approvedAt: row.approved_at === null ? null : isoTimestamp(row.approved_at) };
}

function patientOrderDto(row: CareOrderRow) {
  const payload = jsonRecord(row.payload);
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

export function createBookingService(options: { sql: SQL; config: AuthConfig }): BookingService {
  const { sql, config } = options;

  async function loadDto(handle: SQL, id: string, privateAccess: boolean) {
    const row = await readBooking(handle, id);
    if (!row) throw new AppError("NOT_FOUND", "Booking not found", 404);
    return dto(row, await listBookingEvents(handle, id), privateAccess);
  }

  async function requireNurseAccess(
    handle: SQL,
    auth: AuthContext,
    id: string,
    requireActiveGrant = false,
  ): Promise<BookingRow> {
    nurse(auth);
    requireId(id);
    const row = await readBooking(handle, id);
    const activeGrant = row && (row.intake_grant_active || row.visit_grant_active);
    if (!row || row.nurse_id !== auth.staffId || row.status === "draft" || !row.had_nurse_grant) {
      throw new AppError("NOT_FOUND", "Booking not found", 404);
    }
    if (requireActiveGrant && !activeGrant) throw new AppError("FORBIDDEN", "Active booking grant is required", 403);
    const principal = (await handle`
      SELECT a.status, s.active AS staff_active, s.identity_approval_ref,
        s.provisioning_email_domain, a.email_normalized
      FROM public.accounts a JOIN public.staff s ON s.account_id = a.id
      WHERE a.id = ${auth.accountId} AND s.id = ${auth.staffId!}
    `) as unknown as Array<{
      status: string;
      staff_active: boolean;
      identity_approval_ref: string;
      provisioning_email_domain: string;
      email_normalized: string;
    }>;
    if (principal[0]?.status !== "active" || principal[0]?.staff_active !== true) {
      throw new AppError("FORBIDDEN", "Nurse access is not active", 403);
    }
    return row;
  }

  async function requireOwn(auth: AuthContext, id: string): Promise<BookingRow> {
    patient(auth);
    requireId(id);
    const row = await readBooking(sql, id);
    if (!row || row.patient_id !== auth.patientId) throw new AppError("NOT_FOUND", "Booking not found", 404);
    return row;
  }

  async function lockTargets(handle: SQL, id: string): Promise<{ patientId: string; nurseId: string } | null> {
    const rows = (await handle`
      SELECT patient_id, nurse_id FROM public.bookings WHERE id = ${id}
    `) as unknown as Array<{ patient_id: string; nurse_id: string }>;
    return rows[0] ? { patientId: rows[0].patient_id, nurseId: rows[0].nurse_id } : null;
  }

  async function lockIdentities(
    tx: SQL,
    target: { patientId: string; nurseId: string },
  ) {
    const identity = await lockPatientIdentity(tx, target.patientId);
    if (!identity) throw new AppError("NOT_FOUND", "Patient not found", 404);
    if (!(await lockNurseIdentity(tx, target.nurseId))) throw new AppError("NOT_FOUND", "Nurse not found", 404);
    return identity;
  }

  async function runIdempotent(
    auth: AuthContext,
    method: string,
    path: string,
    key: string,
    request: unknown,
    action: (tx: SQL) => Promise<Result>,
  ): Promise<Result> {
    const scope: IdempotencyScope = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      method,
      resourceKey: path,
      key,
      requestHash: canonicalRequestHash(request),
    };
    const receipt = await findIdempotencyReceipt(sql, scope);
    if (receipt) {
      if (receipt.requestHash !== scope.requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request", 409);
      return { data: receipt.response, statusCode: receipt.statusCode };
    }
    return sql.begin(async (tx) => {
      await lockIdempotencyScope(tx, scope);
      const replay = await findIdempotencyReceipt(tx, scope);
      if (replay) {
        if (replay.requestHash !== scope.requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request", 409);
        return { data: replay.response, statusCode: replay.statusCode };
      }
      const result = await action(tx);
      await storeIdempotencyReceipt(tx, scope, result.statusCode, result.data);
      return result;
    });
  }

  type Reservation = { slot: Slot | null; reservedUntil: string };

  function validateInterval(startsAt: string, endsAt: string): { start: number; end: number } {
    const start = new Date(startsAt).getTime();
    const end = new Date(endsAt).getTime();
    if (!(end > start) || start <= Date.now()) throw new AppError("VALIDATION_FAILED", "Booking must be a future interval with end after start", 422);
    return { start, end };
  }
  function hashFilter(value: string): string { return createHash("sha256").update(value).digest("hex"); }
  async function draftReservation(
    tx: SQL,
    input: { nurseId: string; slotId: string | null; startsAt: string; endsAt: string },
  ): Promise<Reservation> {
    const { end } = validateInterval(input.startsAt, input.endsAt);
    if (input.slotId === null) return { slot: null, reservedUntil: input.endsAt };
    const slot = await readCurrentSlot(tx, input.nurseId, input.slotId);
    if (!slot || isoTimestamp(slot.starts_at) !== isoTimestamp(input.startsAt) || isoTimestamp(slot.ends_at) !== isoTimestamp(input.endsAt)) {
      throw new AppError("VALIDATION_FAILED", "Selected availability slot is not eligible", 422);
    }
    return { slot, reservedUntil: new Date(end + slot.buffer_minutes * 60_000).toISOString() };
  }

  async function submissionReservation(
    tx: SQL,
    row: BookingRow,
  ): Promise<Reservation> {
    const startsAt = isoTimestamp(row.starts_at);
    const endsAt = isoTimestamp(row.ends_at);
    const { start, end } = validateInterval(startsAt, endsAt);
    if (row.slot_id !== null) {
      const slot = await readCurrentSlot(tx, row.nurse_id, row.slot_id);
      if (!slot || !row.slot_matches_reservation) throw new AppError("VALIDATION_FAILED", "Selected availability slot is no longer eligible", 422);
      return { slot, reservedUntil: new Date(end + slot.buffer_minutes * 60_000).toISOString() };
    }
    const approved = await readExactApprovedException(tx, { bookingId: row.id, nurseId: row.nurse_id, startsAt, endsAt });
    const availability = await readApplicableAvailability(tx, row.nurse_id, startsAt, endsAt);
    if (!approved || !availability || end - start !== availability.slot_minutes * 60_000) {
      throw new AppError("VALIDATION_FAILED", "A current slot or exact approved availability exception is required", 422);
    }
    return { slot: null, reservedUntil: new Date(end + availability.buffer_minutes * 60_000).toISOString() };
  }

  async function acceptedReservation(
    tx: SQL,
    row: BookingRow,
    input?: { slotId: string | null; startsAt: string; endsAt: string },
  ): Promise<Reservation> {
    if (!input) {
      const selected = await submissionReservation(tx, row);
      if (selected.reservedUntil !== isoTimestamp(row.reserved_until)) throw new AppError("VALIDATION_FAILED", "Availability policy changed; create a fresh booking request", 422);
      return selected;
    }
    const { start, end } = validateInterval(input.startsAt, input.endsAt);
    if (row.slot_id !== null && input.slotId === row.slot_id &&
      isoTimestamp(row.starts_at) === isoTimestamp(input.startsAt) && isoTimestamp(row.ends_at) === isoTimestamp(input.endsAt)) {
      if (row.availability_version_id === null || !row.slot_matches_reservation) throw new AppError("VALIDATION_FAILED", "Bound availability slot is inconsistent", 422);
      return {
        slot: { id: row.slot_id, availability_version_id: row.availability_version_id, nurse_id: row.nurse_id, starts_at: row.starts_at, ends_at: row.ends_at, buffer_minutes: 0 },
        reservedUntil: isoTimestamp(row.reserved_until),
      };
    }
    if (input.slotId !== null) return draftReservation(tx, { ...input, nurseId: row.nurse_id });
    const approved = await readExactApprovedException(tx, { bookingId: row.id, nurseId: row.nurse_id, startsAt: input.startsAt, endsAt: input.endsAt });
    const availability = await readApplicableAvailability(tx, row.nurse_id, input.startsAt, input.endsAt);
    if (!approved || !availability || end - start !== availability.slot_minutes * 60_000) throw new AppError("VALIDATION_FAILED", "An exact approved availability exception is required", 422);
    return { slot: null, reservedUntil: new Date(end + availability.buffer_minutes * 60_000).toISOString() };
  }

  async function assertDraftReservation(tx: SQL, nurseId: string, slot: Slot | null, startsAt: string, endsAt: string) {
    if (slot) {
      if (isoTimestamp(slot.starts_at) !== isoTimestamp(startsAt) || isoTimestamp(slot.ends_at) !== isoTimestamp(endsAt)) {
        throw new AppError("VALIDATION_FAILED", "Slot timestamps must match its canonical interval", 422);
      }
      return;
    }
    if (!(await readApplicableAvailability(tx, nurseId, startsAt, endsAt))) {
      throw new AppError("VALIDATION_FAILED", "An applicable availability policy is required for an outside-hours draft", 422);
    }
  }

  async function appendTransition(
    tx: SQL,
    actor: AuthContext,
    row: BookingRow,
    action: string,
    requestId: string,
    reason: string | null = null,
    reschedule?: { previous: BookingRow; patientAgreed: true },
  ) {
    const after = { status: row.status, version: row.version, ...eventData(row) };
    const data = reschedule ? {
      ...eventData(row), patientAgreed: reschedule.patientAgreed,
      previousSlotId: reschedule.previous.slot_id,
      previousAvailabilityVersionId: reschedule.previous.availability_version_id,
      previousStartsAt: isoTimestamp(reschedule.previous.starts_at),
      previousEndsAt: isoTimestamp(reschedule.previous.ends_at),
      previousReservedUntil: isoTimestamp(reschedule.previous.reserved_until),
      previousVersion: reschedule.previous.version, version: row.version,
    } : eventData(row);
    await insertBookingEvent(tx, { bookingId: row.id, actorAccountId: actor.accountId, action, version: row.version, reason, data });
    await writeAuditEvent(tx, { actorAccountId: actor.accountId, action, subjectType: "booking", subjectId: row.id, requestId, after });
    await writeOutboxEvent(tx, { aggregateType: "booking", aggregateId: row.id, eventType: action, payload: after });
  }

  async function withConflictMapping<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "23P01" || error.code === "23505")) {
        throw new AppError("SCHEDULE_CONFLICT", "Requested interval is no longer available", 409);
      }
      throw error;
    }
  }

  async function createBooking(auth: AuthContext, input: BookingCreate, meta: Meta): Promise<Result> {
    const patientId = patient(auth);
    return runIdempotent(auth, "POST", "/api/v1/me/bookings", meta.key, input, async (tx) => {
      if (!(await lockPatientIdentity(tx, patientId))) throw new AppError("NOT_FOUND", "Patient not found", 404);
      if (!(await lockNurseIdentity(tx, input.nurseId)) || !(await eligibleNurse(tx, input.nurseId))) throw new AppError("NOT_FOUND", "Nurse not found", 404);
      const selected = await draftReservation(tx, input);
      await assertDraftReservation(tx, input.nurseId, selected.slot, input.startsAt, input.endsAt);
      const row = await insertBooking(tx, { patientId, nurseId: input.nurseId, slot: selected.slot, startsAt: input.startsAt, endsAt: input.endsAt, reservedUntil: selected.reservedUntil, intake: input.intake });
      await appendTransition(tx, auth, row, "booking.created", meta.requestId);
      return { data: await loadDto(tx, row.id, true), statusCode: 201 };
    });
  }

  async function eligibleNurse(tx: SQL, nurseId: string): Promise<boolean> {
    const rows = (await tx`
      SELECT a.status, a.email_normalized, s.active AS staff_active, s.staff_code,
        s.identity_approval_ref, s.provisioning_email_domain
      FROM public.staff s JOIN public.accounts a ON a.id = s.account_id
      JOIN public.account_roles ar ON ar.account_id = a.id AND ar.role = 'nurse'
      WHERE s.id = ${nurseId}
    `) as unknown as Array<{
      status: string;
      email_normalized: string;
      staff_active: boolean;
      staff_code: string;
      identity_approval_ref: string;
      provisioning_email_domain: string;
    }>;
    const row = rows[0];
    if (!row || row.status !== "active") return false;
    const principal: PrincipalRow = {
      account_id: "server-checked-nurse",
      email_normalized: row.email_normalized,
      status: row.status,
      display_time_zone: "UTC",
      role: "nurse",
      staff_id: nurseId,
      staff_code: row.staff_code,
      staff_display_name: null,
      staff_active: row.staff_active,
      identity_approval_ref: row.identity_approval_ref,
      provisioning_email_domain: row.provisioning_email_domain,
      patient_id: null,
      patient_full_name: null,
    };
    return nurseIdentityValid(principal, config);
  }

  async function patchBooking(auth: AuthContext, id: string, input: BookingPatch, meta: Meta): Promise<Result> {
    await requireOwn(auth, id);
    return runIdempotent(auth, "PATCH", `/api/v1/me/bookings/${id}`, meta.key, input, async (tx) => {
      const target = input.nurseId === undefined ? await lockTargets(tx, id) : { patientId: auth.patientId!, nurseId: input.nurseId };
      if (!target) throw new AppError("NOT_FOUND", "Booking not found", 404);
      await lockIdentities(tx, target);
      const current = await lockBooking(tx, id);
      if (!current || current.patient_id !== auth.patientId) throw new AppError("NOT_FOUND", "Booking not found", 404);
      if (current.status !== "draft") throw new AppError("INVALID_TRANSITION", "Only draft bookings can be edited", 409);
      if (current.version !== input.expectedVersion) throw versionConflict(current);
      const nurseId = input.nurseId ?? current.nurse_id;
      if (!(await eligibleNurse(tx, nurseId))) throw new AppError("NOT_FOUND", "Nurse not found", 404);
      const startsAt = input.startsAt ?? isoTimestamp(current.starts_at);
      const endsAt = input.endsAt ?? isoTimestamp(current.ends_at);
      const slotId = input.slotId !== undefined ? input.slotId : current.slot_id;
      const timingChanged = nurseId !== current.nurse_id || input.startsAt !== undefined || input.endsAt !== undefined || input.slotId !== undefined;
      if (timingChanged && (input.slotId === undefined || input.startsAt === undefined || input.endsAt === undefined)) {
        throw new AppError("VALIDATION_FAILED", "Timing changes must explicitly supply slotId, startsAt and endsAt", 422);
      }
      const selected = await draftReservation(tx, { nurseId, slotId, startsAt, endsAt });
      await assertDraftReservation(tx, nurseId, selected.slot, startsAt, endsAt);
      const updated = await updateBookingDraft(tx, {
        id, expectedVersion: input.expectedVersion, nurseId, slot: selected.slot,
        startsAt, endsAt, reservedUntil: selected.reservedUntil,
        intake: input.intake ?? jsonRecord(current.intake) as BookingCreate["intake"],
      });
      if (!updated) throw versionConflict(current);
      await appendTransition(tx, auth, updated, "booking.updated", meta.requestId);
      return { data: await loadDto(tx, id, true), statusCode: 200 };
    });
  }

  async function submit(auth: AuthContext, id: string, input: BookingVersion, meta: Meta): Promise<Result> {
    await requireOwn(auth, id);
    return runIdempotent(auth, "POST", `/api/v1/me/bookings/${id}/submit`, meta.key, input, async (tx) => {
      const target = await lockTargets(tx, id);
      if (!target) throw new AppError("NOT_FOUND", "Booking not found", 404);
      const identity = await lockIdentities(tx, target);
      const current = await lockBooking(tx, id);
      if (!current || current.patient_id !== auth.patientId) throw new AppError("NOT_FOUND", "Booking not found", 404);
      if (current.status === "submitted") {
        if (current.version !== input.expectedVersion) throw versionConflict(current);
        return { data: await loadDto(tx, id, true), statusCode: 200 };
      }
      if (current.status !== "draft") throw new AppError("INVALID_TRANSITION", "Only drafts can be submitted", 409);
      if (current.version !== input.expectedVersion) throw versionConflict(current);
      if (!(await eligibleNurse(tx, current.nurse_id))) throw new AppError("FORBIDDEN", "Selected nurse is not eligible", 403);
      if (!identity.phone.trim() || !identity.address_line?.trim() || jsonRecord(current.intake).consent !== true) {
        throw new AppError("VALIDATION_FAILED", "Complete owned contact details and explicit consent are required", 422);
      }
      const selected = await submissionReservation(tx, current);
      if ((await countActive(tx, current.patient_id, id)) >= 3) throw new AppError("SCHEDULE_CONFLICT", "Maximum three active booking requests", 409);
      const conflict = await findScheduleConflict(tx, { bookingId: id, patientId: current.patient_id, nurseId: current.nurse_id, startsAt: isoTimestamp(current.starts_at), endsAt: isoTimestamp(current.ends_at), reservedUntil: selected.reservedUntil });
      if (conflict) throw new AppError("SCHEDULE_CONFLICT", "Requested interval is no longer available", 409);
      const snapshot = {
        fullName: identity.full_name, birthDate: identity.birth_date, gender: identity.gender,
        phone: identity.phone, addressLine: identity.address_line, recordNumber: identity.record_number,
        emergencyContactName: identity.emergency_contact_name, emergencyContactPhone: identity.emergency_contact_phone,
      };
      const submitted = await submitBooking(tx, {
        id, expectedVersion: current.version, slot: selected.slot,
        reservedUntil: selected.reservedUntil, snapshot,
      });
      if (!submitted) throw versionConflict(current);
      await grantIntake(tx, id, current.patient_id, current.nurse_id, current.ends_at);
      await appendTransition(tx, auth, submitted, "booking.submitted", meta.requestId);
      return { data: await loadDto(tx, id, true), statusCode: 200 };
    });
  }

  async function cancel(auth: AuthContext, id: string, input: BookingCancel, meta: Meta, byNurse: boolean): Promise<Result> {
    const row = byNurse ? await requireNurseAccess(sql, auth, id, true) : await requireOwn(auth, id);
    return runIdempotent(auth, "POST", `${byNurse ? "/api/v1/bookings" : "/api/v1/me/bookings"}/${id}/cancel`, meta.key, input, async (tx) => {
      const target = await lockTargets(tx, id);
      if (!target || target.patientId !== row!.patient_id) throw new AppError("NOT_FOUND", "Booking not found", 404);
      await lockIdentities(tx, target);
      const current = await lockBooking(tx, id);
      if (!current || (byNurse ? current.nurse_id !== auth.staffId || !current.had_nurse_grant : current.patient_id !== auth.patientId)) throw new AppError("NOT_FOUND", "Booking not found", 404);
      if (byNurse && !(current.intake_grant_active || current.visit_grant_active)) throw new AppError("FORBIDDEN", "Active booking grant is required", 403);
      if (current.version !== input.expectedVersion) throw versionConflict(current);
      if (!["draft", "submitted", "accepted"].includes(current.status)) throw new AppError("INVALID_TRANSITION", "Booking is already terminal", 409);
      if (new Date(current.starts_at).getTime() <= Date.now()) throw new AppError("INVALID_TRANSITION", "A started booking cannot be cancelled", 409);
      const cancelledId = await withConflictMapping(() => cancelBooking(tx, id, input.expectedVersion, input.reason));
      if (!cancelledId) throw versionConflict(current);
      if (current.visit_id) {
        await cancelVisit(tx, current.visit_id, id);
        await revokeVisit(tx, current.visit_id);
      }
      await revokeIntake(tx, id);
      const cancelled = (await readBooking(tx, id))!;
      await appendTransition(tx, auth, cancelled, "booking.cancelled", meta.requestId, input.reason);
      return { data: await loadDto(tx, id, byNurse ? false : true), statusCode: 200 };
    });
  }

  async function decide(auth: AuthContext, id: string, input: BookingDecision, meta: Meta): Promise<Result> {
    await requireNurseAccess(sql, auth, id, true);
    return runIdempotent(auth, "POST", `/api/v1/bookings/${id}/decisions`, meta.key, input, async (tx) => {
      const target = await lockTargets(tx, id);
      if (!target) throw new AppError("NOT_FOUND", "Booking not found", 404);
      await lockIdentities(tx, target);
      const current = await lockBooking(tx, id);
      if (!current || current.nurse_id !== auth.staffId || !current.had_nurse_grant) throw new AppError("NOT_FOUND", "Booking not found", 404);
      if (current.status === "rejected" && input.decision === "reject" && current.decision_by === auth.accountId && current.decision_reason === input.reason) {
        if (current.version !== input.expectedVersion) throw versionConflict(current);
        return { data: await loadDto(tx, id, false), statusCode: 200 };
      }
      if (current.status === "accepted" && input.decision === "accept") {
        if (current.version !== input.expectedVersion) throw versionConflict(current);
        return { data: await loadDto(tx, id, nursePrivateAccess(current)), statusCode: 200 };
      }
      if (current.status !== "submitted") throw new AppError("INVALID_TRANSITION", "Only submitted bookings can be decided", 409);
      if (current.version !== input.expectedVersion) throw versionConflict(current);
      if (!current.intake_grant_active) throw new AppError("FORBIDDEN", "Active intake grant is required", 403);
      if (!(await eligibleNurse(tx, current.nurse_id))) throw new AppError("FORBIDDEN", "Selected nurse is not eligible", 403);
      if (input.decision === "reject") {
        if (await rejectBooking(tx, id, input.expectedVersion, auth.accountId, input.reason!)) {
          await revokeIntake(tx, id);
          const rejected = (await readBooking(tx, id))!;
          await appendTransition(tx, auth, rejected, "booking.rejected", meta.requestId, input.reason);
          return { data: await loadDto(tx, id, false), statusCode: 200 };
        }
        throw versionConflict(current);
      }
      const selected = await acceptedReservation(tx, current);
      if ((await countActive(tx, current.patient_id, id)) >= 3) throw new AppError("SCHEDULE_CONFLICT", "Maximum three active booking requests", 409);
      const conflict = await findScheduleConflict(tx, { bookingId: id, patientId: current.patient_id, nurseId: current.nurse_id, startsAt: isoTimestamp(current.starts_at), endsAt: isoTimestamp(current.ends_at), reservedUntil: selected.reservedUntil });
      if (conflict) throw new AppError("SCHEDULE_CONFLICT", "Requested interval is no longer available", 409);
      const acceptedId = await withConflictMapping(() => acceptBooking(tx, id, input.expectedVersion, auth.accountId));
      if (!acceptedId) throw versionConflict(current);
      let accepted = (await readBooking(tx, id))!;
      const visitId = await insertVisit(tx, { bookingId: id, patientId: current.patient_id, nurseId: current.nurse_id, startsAt: current.starts_at, endsAt: current.ends_at });
      await revokeIntake(tx, id);
      await grantVisit(tx, visitId, current.patient_id, current.nurse_id, current.ends_at);
      accepted = (await readBooking(tx, id))!;
      await appendTransition(tx, auth, accepted, "booking.accepted", meta.requestId);
      return { data: await loadDto(tx, id, true), statusCode: 200 };
    });
  }

  async function reschedule(auth: AuthContext, id: string, input: BookingReschedule, meta: Meta): Promise<Result> {
    await requireNurseAccess(sql, auth, id, true);
    return runIdempotent(auth, "POST", `/api/v1/bookings/${id}/reschedule`, meta.key, input, async (tx) => {
      const target = await lockTargets(tx, id);
      if (!target) throw new AppError("NOT_FOUND", "Booking not found", 404);
      await lockIdentities(tx, target);
      const booking = await lockBooking(tx, id);
      if (!booking || booking.nurse_id !== auth.staffId || !booking.had_nurse_grant) throw new AppError("NOT_FOUND", "Booking not found", 404);
      if (!(await eligibleNurse(tx, booking.nurse_id))) throw new AppError("FORBIDDEN", "Selected nurse is not eligible", 403);
      if (booking.status !== "accepted" || !booking.visit_grant_active || !booking.visit_id) throw new AppError("INVALID_TRANSITION", "Only accepted bookings with active visit access can be rescheduled", 409);
      if (!(await lockScheduledVisit(tx, booking.visit_id, id))) throw new AppError("INVALID_TRANSITION", "Only scheduled visits can be rescheduled", 409);
      if (booking.version !== input.expectedVersion) throw versionConflict(booking);
      if (new Date(booking.starts_at).getTime() <= Date.now()) throw new AppError("INVALID_TRANSITION", "A started booking cannot be rescheduled", 409);
      const selected = await acceptedReservation(tx, booking, input);
      const conflict = await findScheduleConflict(tx, { bookingId: id, patientId: booking.patient_id, nurseId: booking.nurse_id, startsAt: input.startsAt, endsAt: input.endsAt, reservedUntil: selected.reservedUntil });
      if (conflict) throw new AppError("SCHEDULE_CONFLICT", "Requested interval is no longer available", 409);
      const updated = await withConflictMapping(() => rescheduleVisitAndBooking(tx, { bookingId: id, visitId: booking.visit_id!, expectedBookingVersion: input.expectedVersion, slot: selected.slot, startsAt: input.startsAt, endsAt: input.endsAt, reservedUntil: selected.reservedUntil }));
      if (!updated) throw versionConflict(booking);
      await updateVisitGrantExpiry(tx, booking.visit_id, input.endsAt);
      const fresh = (await readBooking(tx, id))!;
      await appendTransition(tx, auth, fresh, "booking.rescheduled", meta.requestId, input.reason, { previous: booking, patientAgreed: input.patientAgreed });
      return { data: await loadDto(tx, id, true), statusCode: 200 };
    });
  }

  async function list(auth: AuthContext, owner: "patient" | "nurse", query: { status: string | null; search?: string; cursor: string | null; limit: number }, schedule: { from: string; to: string } | null = null): Promise<Page> {
    const actorId = owner === "patient" ? patient(auth) : nurse(auth);
    if (owner === "nurse") {
      const rows = (await sql`
        SELECT a.status, s.active FROM public.accounts a JOIN public.staff s ON s.account_id = a.id
        WHERE a.id = ${auth.accountId} AND s.id = ${actorId}
      `) as unknown as Array<{ status: string; active: boolean }>;
      if (rows[0]?.status !== "active" || rows[0]?.active !== true) throw new AppError("FORBIDDEN", "Nurse access is not active", 403);
    }
    const status = statusFilter(query.status);
    if (schedule && status !== "accepted") throw new AppError("VALIDATION_FAILED", "Invalid request: status", 422);
    const search = query.search?.trim().toLowerCase() ?? "";
    if (search.length > 100) throw new AppError("VALIDATION_FAILED", "Invalid request: search", 422);
    const filter = `${status ?? ""}:${search}:${schedule ? `${schedule.from}:${schedule.to}` : ""}`;
    const binding: CursorBinding = { accountId: auth.accountId, sessionId: auth.sessionId, scope: `bookings:${owner}:${schedule ? "schedule" : "list"}`, filterHash: hashFilter(filter) };
    const after = query.cursor ? decodeCursor(query.cursor, binding, config.sessionSecret) : null;
    if (after && Number.isNaN(new Date(after.name).getTime())) throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
    const rows = await listBookings(sql, { actorId, owner, status, search, limit: query.limit, afterCreatedAt: after?.name ?? null, afterId: after?.id ?? null, schedule });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(binding, { name: isoTimestamp(last.starts_at), id: last.id }, config.sessionSecret) : null;
    const eventsByBooking = new Map<string, BookingEventRow[]>();
    for (const event of await listBookingEventsFor(sql, selected.map((booking) => booking.id))) {
      const events = eventsByBooking.get(event.booking_id);
      if (events) events.push(event);
      else eventsByBooking.set(event.booking_id, [event]);
    }
    return {
      items: selected.map((booking) => dto(booking, eventsByBooking.get(booking.id) ?? [], owner === "patient" || nursePrivateAccess(booking))),
      page: { nextCursor, hasMore },
    };
  }

  return {
    createBooking,
    patchBooking,
    listOwnBookings: (auth, query) => list(auth, "patient", query),
    getOwnBooking: async (auth, id) => { await requireOwn(auth, id); return loadDto(sql, id, true); },
    submitBooking: submit,
    cancelOwnBooking: (auth, id, input, meta) => cancel(auth, id, input, meta, false),
    listNurseBookings: (auth, query) => list(auth, "nurse", query),
    getNurseBooking: async (auth, id) => {
      const row = await requireNurseAccess(sql, auth, id);
      return loadDto(sql, id, nursePrivateAccess(row));
    },
    decideBooking: decide,
    cancelNurseBooking: (auth, id, input, meta) => cancel(auth, id, input, meta, true),
    rescheduleBooking: reschedule,
    listSchedule: (auth, query) => list(auth, "nurse", { ...query, status: "accepted", search: "" }, query),
    getCareGuide: async (auth, id) => {
      const row = await requireNurseAccess(sql, auth, id);
      if (row.status !== "accepted" || !row.visit_grant_active || !row.visit_id) throw new AppError("NOT_FOUND", "Care guide not found for this visit", 404);
      const sources = await listCareGuideSources(sql, row.patient_id);
      const orders = await listOrderHeads(sql, { patientId: row.patient_id, patientView: true, limit: 100, afterEffectiveFrom: null, afterId: null });
      return { patientId: row.patient_id, sources: sources.map(patientSourceDto), sourceVersions: sources.map((source) => ({ sourceDocumentId: source.id, sourceVersion: source.revision_number })), orders: orders.slice(0, 100).map(patientOrderDto) };
    },
  };
}
