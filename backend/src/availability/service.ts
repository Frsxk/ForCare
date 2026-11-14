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
  receiptResourceKey,
  storeIdempotencyReceipt,
  type IdempotencyScope,
} from "../http/idempotency";
import { isUuid } from "../http/request";
import { isoTimestamp } from "../http/time";
import {
  insertAvailabilitySlots,
  insertAvailabilityVersion,
  listAvailabilitySlots,
  listCurrentUnreservedSlots,
  lockActiveNurse,
  readActiveNurse,
  readLatestAvailabilityVersion,
  type AvailabilityVersionRow,
  type AvailabilitySlotRow,
} from "./repository";
import { isoUtcSchema, type AvailabilityPublish, type AvailabilityWindow } from "./schemas";

const MAX_AVAILABILITY_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SLOT_READ_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export type AvailabilityWindowDto = AvailabilityWindow;
export type AvailabilitySlotDto = { id: string; startsAt: string; endsAt: string };
export type AvailabilityCurrentDto = {
  id: string;
  version: number;
  timeZone: string;
  slotMinutes: number;
  bufferMinutes: number;
  effectiveFrom: string;
  effectiveTo: string;
  windows: AvailabilityWindowDto[];
  slots: AvailabilitySlotDto[];
};
export type OwnAvailabilityDto = {
  nurseId: string;
  version: number;
  current: AvailabilityCurrentDto | null;
};
export type PublicSlotDto = {
  id: string;
  nurseId: string;
  startsAt: string;
  endsAt: string;
  availabilityVersionId: string;
  availabilityVersion: number;
};
export type PublicSlotsDto = {
  nurseId: string;
  timeZone: string | null;
  items: PublicSlotDto[];
  page: { nextCursor: string | null; hasMore: boolean };
};

export type AvailabilityService = {
  getOwnAvailability(auth: AuthContext): Promise<OwnAvailabilityDto>;
  publishOwnAvailability(
    auth: AuthContext,
    input: AvailabilityPublish,
    meta: { requestId: string; key: string },
  ): Promise<{ data: OwnAvailabilityDto; statusCode: number }>;
  listNurseSlots(
    auth: AuthContext,
    nurseId: string,
    query: { from: string | null; to: string | null; cursor: string | null; limit: number },
  ): Promise<PublicSlotsDto>;
};

function validationError(message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, 422);
}

function parseTime(raw: string, field: string): Date {
  const result = isoUtcSchema.safeParse(raw);
  if (!result.success) throw validationError(`Invalid request: ${field}`);
  return new Date(result.data);
}

function requireNurse(auth: AuthContext): string {
  if (auth.role !== "nurse" || !auth.staffId) {
    throw new AppError("FORBIDDEN", "Nurse access is required", 403);
  }
  return auth.staffId;
}

function windowsFromRow(row: AvailabilityVersionRow): AvailabilityWindow[] {
  const windows = typeof row.windows === "string" ? (JSON.parse(row.windows) as unknown) : row.windows;
  return windows as AvailabilityWindow[];
}

function slotDto(row: AvailabilitySlotRow): AvailabilitySlotDto {
  return { id: row.id, startsAt: isoTimestamp(row.starts_at), endsAt: isoTimestamp(row.ends_at) };
}

async function ownAvailabilityDto(sql: SQL, nurseId: string): Promise<OwnAvailabilityDto> {
  const latest = await readLatestAvailabilityVersion(sql, nurseId);
  if (!latest) return { nurseId, version: 0, current: null };
  const slots = await listAvailabilitySlots(sql, latest.id);
  return {
    nurseId,
    version: latest.version,
    current: {
      id: latest.id,
      version: latest.version,
      timeZone: latest.time_zone,
      slotMinutes: latest.slot_minutes,
      bufferMinutes: latest.buffer_minutes,
      effectiveFrom: isoTimestamp(latest.effective_from),
      effectiveTo: isoTimestamp(latest.effective_to),
      windows: windowsFromRow(latest),
      slots: slots.map(slotDto),
    },
  };
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw validationError("Invalid request: timeZone");
  }
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return;
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  if (canonical !== timeZone) throw validationError("Invalid request: timeZone");
}

type LocalDateTimeParts = {
  weekday: number;
  year: number;
  month: number;
  day: number;
  minuteOfDay: number;
  second: number;
};

function localParts(value: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdays[get("weekday")];
  if (!weekday) throw validationError("Invalid request: timeZone");
  return {
    weekday,
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")),
    second: Number(get("second")),
  };
}

function localEndMinute(start: LocalDateTimeParts, end: LocalDateTimeParts): number | null {
  if (start.year === end.year && start.month === end.month && start.day === end.day) {
    return end.minuteOfDay + (end.second > 0 ? 1 : 0);
  }
  const nextDay = new Date(Date.UTC(start.year, start.month - 1, start.day) + 24 * 60 * 60_000);
  if (
    nextDay.getUTCFullYear() === end.year &&
    nextDay.getUTCMonth() + 1 === end.month &&
    nextDay.getUTCDate() === end.day &&
    end.minuteOfDay === 0 &&
    end.second === 0
  ) {
    return 24 * 60;
  }
  return null;
}

function validatePublishInput(input: AvailabilityPublish, nowMs: number): void {
  assertValidTimeZone(input.timeZone);
  const effectiveFrom = parseTime(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = parseTime(input.effectiveTo, "effectiveTo");
  if (effectiveFrom.getTime() < nowMs) {
    throw validationError("effectiveFrom cannot be in the past");
  }
  if (effectiveFrom.getTime() >= effectiveTo.getTime()) {
    throw validationError("effectiveFrom must precede effectiveTo");
  }
  if (effectiveTo.getTime() - effectiveFrom.getTime() > MAX_AVAILABILITY_HORIZON_MS) {
    throw validationError("Availability effective horizon cannot exceed 90 days");
  }

  for (let left = 0; left < input.windows.length; left += 1) {
    for (let right = left + 1; right < input.windows.length; right += 1) {
      const a = input.windows[left];
      const b = input.windows[right];
      if (
        a.weekday === b.weekday &&
        a.startMinute < b.endMinute &&
        b.startMinute < a.endMinute
      ) {
        throw validationError("Working windows cannot overlap on the same weekday");
      }
    }
  }

  const orderedSlots = [...input.slots].sort(
    (a, b) => parseTime(a.startsAt, "slots.startsAt").getTime() -
      parseTime(b.startsAt, "slots.startsAt").getTime(),
  );
  for (let index = 0; index < orderedSlots.length; index += 1) {
    const slot = orderedSlots[index];
    const startsAt = parseTime(slot.startsAt, "slots.startsAt");
    const endsAt = parseTime(slot.endsAt, "slots.endsAt");
    if (startsAt.getTime() >= endsAt.getTime()) {
      throw validationError("Each slot must have startsAt before endsAt");
    }
    if (startsAt.getTime() < effectiveFrom.getTime() || endsAt.getTime() > effectiveTo.getTime()) {
      throw validationError("Every slot must fit inside the effective horizon");
    }
    if (endsAt.getTime() - startsAt.getTime() !== input.slotMinutes * 60_000) {
      throw validationError("Every slot must exactly match slotMinutes");
    }
    const localStart = localParts(startsAt, input.timeZone);
    const localEnd = localParts(endsAt, input.timeZone);
    if (localStart.second !== 0) {
      throw validationError("Slots must align to whole local minutes");
    }
    const endMinute = localEndMinute(localStart, localEnd);
    if (endMinute === null) {
      throw validationError("Every slot must fit in one local working window");
    }
    const window = input.windows.find(
      (candidate) =>
        candidate.weekday === localStart.weekday &&
        localStart.minuteOfDay >= candidate.startMinute &&
        (localStart.minuteOfDay - candidate.startMinute) % input.slotMinutes === 0 &&
        endMinute <= candidate.endMinute,
    );
    if (!window) {
      throw validationError("Every slot must align to and fit inside one working window");
    }
    const next = orderedSlots[index + 1];
    if (next && startsAt.getTime() + input.slotMinutes * 60_000 > parseTime(next.startsAt, "slots.startsAt").getTime()) {
      throw validationError("Availability slots cannot overlap");
    }
  }
}

function validRange(rawFrom: string | null, rawTo: string | null): { from: Date; to: Date } {
  if (rawFrom === null || rawTo === null) {
    throw validationError("Invalid request: from, to");
  }
  const from = parseTime(rawFrom, "from");
  const to = parseTime(rawTo, "to");
  if (from.getTime() >= to.getTime()) throw validationError("from must precede to");
  if (to.getTime() - from.getTime() > MAX_SLOT_READ_RANGE_MS) {
    throw validationError("Slot read range cannot exceed 31 days");
  }
  return { from, to };
}

export function createAvailabilityService(options: { sql: SQL; config: AuthConfig }): AvailabilityService {
  const { sql, config } = options;

  async function getOwnAvailability(auth: AuthContext): Promise<OwnAvailabilityDto> {
    const nurseId = requireNurse(auth);
    const nurse = await readActiveNurse(sql, nurseId, config.nurseEmailDomain);
    if (!nurse || nurse.account_id !== auth.accountId) {
      throw new AppError("FORBIDDEN", "Active nurse access is required", 403);
    }
    return ownAvailabilityDto(sql, nurseId);
  }

  async function publishOwnAvailability(
    auth: AuthContext,
    input: AvailabilityPublish,
    meta: { requestId: string; key: string },
  ): Promise<{ data: OwnAvailabilityDto; statusCode: number }> {
    requireNurse(auth);
    validatePublishInput(input, Date.now() - 1);
    const scope: IdempotencyScope = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      method: "PUT",
      resourceKey: receiptResourceKey("PUT", "/api/v1/nurses/me/availability"),
      key: meta.key,
      requestHash: canonicalRequestHash(input),
    };
    const existing = await findIdempotencyReceipt(sql, scope);
    if (existing) {
      if (existing.requestHash !== scope.requestHash) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was reused with a different request",
          409,
        );
      }
      return { data: existing.response as OwnAvailabilityDto, statusCode: existing.statusCode };
    }

    return sql.begin(async (tx) => {
      await lockIdempotencyScope(tx, scope);
      const replayed = await findIdempotencyReceipt(tx, scope);
      if (replayed) {
        if (replayed.requestHash !== scope.requestHash) {
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was reused with a different request",
            409,
          );
        }
        return { data: replayed.response as OwnAvailabilityDto, statusCode: replayed.statusCode };
      }

      const nurse = await lockActiveNurse(tx, auth.accountId);
      if (!nurse || nurse.id !== auth.staffId) {
        throw new AppError("FORBIDDEN", "Active nurse access is required", 403);
      }
      const latest = await readLatestAvailabilityVersion(tx, nurse.id);
      const currentVersion = latest?.version ?? 0;
      if (input.expectedVersion !== currentVersion) {
        throw new AppError("VERSION_CONFLICT", "Availability version conflict", 409, {
          currentVersion,
        });
      }
      // Recheck the wall-clock horizon after locks are acquired; a queued
      // publish cannot become valid merely because it was prepared earlier.
      if (new Date(input.effectiveFrom).getTime() < Date.now() - 1) {
        throw validationError("effectiveFrom cannot be in the past");
      }
      const inserted = await insertAvailabilityVersion(tx, {
        nurseId: nurse.id,
        version: currentVersion + 1,
        timeZone: input.timeZone,
        slotMinutes: input.slotMinutes,
        bufferMinutes: input.bufferMinutes,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        windows: input.windows,
        createdBy: auth.accountId,
      });
      await insertAvailabilitySlots(tx, {
        availabilityVersionId: inserted.id,
        nurseId: nurse.id,
        slots: input.slots,
      });
      await writeAuditEvent(tx, {
        actorAccountId: auth.accountId,
        action: "availability.published",
        subjectType: "nurse_availability_version",
        subjectId: inserted.id,
        requestId: meta.requestId,
        before: { version: currentVersion },
        after: {
          nurseId: nurse.id,
          version: inserted.version,
          timeZone: inserted.time_zone,
          slotMinutes: inserted.slot_minutes,
          bufferMinutes: inserted.buffer_minutes,
          effectiveFrom: isoTimestamp(inserted.effective_from),
          effectiveTo: isoTimestamp(inserted.effective_to),
          slotCount: input.slots.length,
        },
      });
      await writeOutboxEvent(tx, {
        aggregateType: "nurse_availability_version",
        aggregateId: inserted.id,
        eventType: "availability.published",
        payload: { nurseId: nurse.id, version: inserted.version },
      });
      const data = await ownAvailabilityDto(tx, nurse.id);
      const storedSlots = await listAvailabilitySlots(tx, inserted.id);
      const publishedSlots = storedSlots.map((row) => ({
        id: row.id,
        startsAt: isoTimestamp(row.starts_at),
        endsAt: isoTimestamp(row.ends_at),
      }));
      const currentSlots = data.current?.slots;
      if (currentSlots && currentSlots.length === publishedSlots.length) {
        for (let index = 0; index < currentSlots.length; index += 1) {
          const stored = publishedSlots.find(
            ({ startsAt, endsAt }) =>
              startsAt === currentSlots[index].startsAt && endsAt === currentSlots[index].endsAt,
          );
          if (!stored) throw new AppError("INTERNAL", "Published slot could not be read back", 500);
          currentSlots[index].id = stored.id;
        }
      }
      await storeIdempotencyReceipt(tx, scope, 200, data);
      return { data, statusCode: 200 };
    });
  }

  async function listNurseSlots(
    auth: AuthContext,
    nurseId: string,
    query: { from: string | null; to: string | null; cursor: string | null; limit: number },
  ): Promise<PublicSlotsDto> {
    if (!isUuid(nurseId)) throw new AppError("NOT_FOUND", "Nurse not found", 404);
    const { from, to } = validRange(query.from, query.to);
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `availability:nurse:${nurseId}`,
      filterHash: hashFilter(`${nurseId}:${isoTimestamp(from)}:${isoTimestamp(to)}`),
    };
    let after: { startsAt: string; id: string } | null = null;
    if (query.cursor !== null) {
      const decoded = decodeCursor(query.cursor, binding, config.sessionSecret);
      after = { startsAt: isoTimestamp(parseTime(decoded.name, "cursor")), id: decoded.id };
    }
    const nurse = await readActiveNurse(sql, nurseId, config.nurseEmailDomain);
    if (!nurse) throw new AppError("NOT_FOUND", "Nurse not found", 404);
    const latest = await readLatestAvailabilityVersion(sql, nurseId);
    if (!latest) {
      return {
        nurseId,
        timeZone: null,
        items: [],
        page: { nextCursor: null, hasMore: false },
      };
    }
    const rows = await listCurrentUnreservedSlots(sql, {
      nurseId,
      from: isoTimestamp(from),
      to: isoTimestamp(to),
      limit: query.limit,
      afterStartsAt: after?.startsAt ?? null,
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: isoTimestamp(last.starts_at), id: last.id },
            config.sessionSecret,
          )
        : null;
    return {
      nurseId,
      timeZone: latest.time_zone,
      items: selected.map((row) => ({
        id: row.id,
        nurseId: row.nurse_id,
        startsAt: isoTimestamp(row.starts_at),
        endsAt: isoTimestamp(row.ends_at),
        availabilityVersionId: row.availability_version_id,
        availabilityVersion: row.availability_version,
      })),
      page: { nextCursor, hasMore },
    };
  }

  return { getOwnAvailability, publishOwnAvailability, listNurseSlots };
}
