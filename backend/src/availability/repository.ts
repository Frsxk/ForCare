import type { SQL } from "bun";
import type { AvailabilitySlotInput, AvailabilityWindow } from "./schemas";

export type AvailabilityVersionRow = {
  id: string;
  nurse_id: string;
  version: number;
  time_zone: string;
  slot_minutes: number;
  buffer_minutes: number;
  effective_from: Date | string;
  effective_to: Date | string;
  windows: AvailabilityWindow[] | string;
  created_by: string;
  created_at: Date | string;
};

export type AvailabilitySlotRow = {
  id: string;
  availability_version_id: string;
  nurse_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
};

export type AvailabilitySlotListRow = AvailabilitySlotRow & {
  availability_version: number;
};

export type ActiveNurseRow = {
  id: string;
  account_id: string;
  active: boolean;
  version: number;
};

export async function readActiveNurse(
  sql: SQL,
  nurseId: string,
  nurseEmailDomain: string | null,
): Promise<ActiveNurseRow | null> {
  const rows = (await sql`
    SELECT s.id, s.account_id, s.active, s.version
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles r ON r.account_id = s.account_id AND r.role = 'nurse'
    WHERE s.id = ${nurseId}
      AND s.active = true
      AND a.status = 'active'
      AND ${nurseEmailDomain}::text IS NOT NULL
      AND btrim(s.identity_approval_ref) <> ''
      AND s.provisioning_email_domain = ${nurseEmailDomain}::text
      AND split_part(a.email_normalized, '@', 2) = ${nurseEmailDomain}::text
    LIMIT 1
  `) as unknown as ActiveNurseRow[];
  return rows[0] ?? null;
}

export async function lockActiveNurse(sql: SQL, accountId: string): Promise<ActiveNurseRow | null> {
  const rows = (await sql`
    SELECT s.id, s.account_id, s.active, s.version
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles r ON r.account_id = s.account_id AND r.role = 'nurse'
    WHERE s.account_id = ${accountId}
      AND s.active = true
      AND a.status = 'active'
    FOR UPDATE OF s
  `) as unknown as ActiveNurseRow[];
  return rows[0] ?? null;
}

export async function readLatestAvailabilityVersion(
  sql: SQL,
  nurseId: string,
): Promise<AvailabilityVersionRow | null> {
  const rows = (await sql`
    SELECT id, nurse_id, version, time_zone, slot_minutes, buffer_minutes,
           effective_from, effective_to, windows, created_by, created_at
    FROM public.nurse_availability_versions
    WHERE nurse_id = ${nurseId}
    ORDER BY version DESC
    LIMIT 1
  `) as unknown as AvailabilityVersionRow[];
  return rows[0] ?? null;
}

export type BookingAvailabilitySlotRow = {
  id: string;
  availability_version_id: string;
  nurse_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  version: number;
  time_zone: string;
  slot_minutes: number;
  buffer_minutes: number;
  effective_from: Date | string;
  effective_to: Date | string;
};

/** Current slot plus immutable scheduling settings, for booking validation. */
export async function readCurrentAvailabilitySlot(
  sql: SQL,
  input: { nurseId: string; slotId: string; startsAt: string; endsAt: string },
): Promise<BookingAvailabilitySlotRow | null> {
  const rows = (await sql`
    SELECT s.id, s.availability_version_id, s.nurse_id, s.starts_at, s.ends_at,
           v.version, v.time_zone, v.slot_minutes, v.buffer_minutes,
           v.effective_from, v.effective_to
    FROM public.nurse_availability_slots s
    JOIN public.nurse_availability_versions v
      ON v.id = s.availability_version_id AND v.nurse_id = s.nurse_id
    WHERE s.id = ${input.slotId}
      AND s.nurse_id = ${input.nurseId}
      AND s.starts_at = ${input.startsAt}::timestamptz
      AND s.ends_at = ${input.endsAt}::timestamptz
      AND v.effective_from <= s.starts_at
      AND s.ends_at <= v.effective_to
      AND NOT EXISTS (
        SELECT 1
        FROM public.nurse_availability_versions newer
        WHERE newer.nurse_id = s.nurse_id
          AND newer.version > v.version
          AND newer.effective_from <= s.starts_at
          AND s.ends_at <= newer.effective_to
          AND EXISTS (
            SELECT 1 FROM public.nurse_availability_slots replacement
            WHERE replacement.availability_version_id = newer.id
              AND replacement.starts_at = s.starts_at
          )
      )
    LIMIT 1
  `) as unknown as BookingAvailabilitySlotRow[];
  return rows[0] ?? null;
}

export async function listAvailabilitySlots(
  sql: SQL,
  availabilityVersionId: string,
): Promise<AvailabilitySlotRow[]> {
  return (await sql`
    SELECT id, availability_version_id, nurse_id, starts_at, ends_at
    FROM public.nurse_availability_slots
    WHERE availability_version_id = ${availabilityVersionId}
    ORDER BY starts_at, id
  `) as unknown as AvailabilitySlotRow[];
}

export async function insertAvailabilityVersion(
  sql: SQL,
  input: {
    nurseId: string;
    version: number;
    timeZone: string;
    slotMinutes: number;
    bufferMinutes: number;
    effectiveFrom: string;
    effectiveTo: string;
    windows: readonly AvailabilityWindow[];
    createdBy: string;
  },
): Promise<AvailabilityVersionRow> {
  const rows = (await sql`
    INSERT INTO public.nurse_availability_versions (
      nurse_id, version, time_zone, slot_minutes, buffer_minutes,
      effective_from, effective_to, windows, created_by
    )
    VALUES (
      ${input.nurseId}, ${input.version}, ${input.timeZone}, ${input.slotMinutes},
      ${input.bufferMinutes}, ${input.effectiveFrom}, ${input.effectiveTo},
      (${JSON.stringify(input.windows)}::text)::jsonb, ${input.createdBy}
    )
    RETURNING id, nurse_id, version, time_zone, slot_minutes, buffer_minutes,
              effective_from, effective_to, windows, created_by, created_at
  `) as unknown as AvailabilityVersionRow[];
  return rows[0];
}

export async function insertAvailabilitySlots(
  sql: SQL,
  input: {
    availabilityVersionId: string;
    nurseId: string;
    slots: readonly AvailabilitySlotInput[];
  },
): Promise<void> {
  for (const slot of input.slots) {
    await sql`
      INSERT INTO public.nurse_availability_slots (
        availability_version_id, nurse_id, starts_at, ends_at
      )
      VALUES (
        ${input.availabilityVersionId}, ${input.nurseId}, ${slot.startsAt}, ${slot.endsAt}
      )
    `;
  }
}

/**
 * A version is applicable only when its effective_from precedes the slot and
 * its effective_to covers the entire slot. The highest applicable version wins.
 * Accepted reservations use reserved_until so nurse buffer also removes the
 * interval from public availability. Submitted requests do not reserve slots.
 */
export async function listCurrentUnreservedSlots(
  sql: SQL,
  input: {
    nurseId: string;
    from: string;
    to: string;
    limit: number;
    afterStartsAt: string | null;
    afterId: string | null;
  },
): Promise<AvailabilitySlotListRow[]> {
  return (await sql`
    WITH current_slots AS (
      SELECT s.id, s.availability_version_id, s.nurse_id, s.starts_at, s.ends_at,
             v.version AS availability_version
      FROM public.nurse_availability_slots s
      JOIN public.nurse_availability_versions v
        ON v.id = s.availability_version_id
       AND v.nurse_id = s.nurse_id
      WHERE s.nurse_id = ${input.nurseId}
        AND s.nurse_id = v.nurse_id
        AND v.id = (
          SELECT applicable.id
          FROM public.nurse_availability_versions applicable
          WHERE applicable.nurse_id = s.nurse_id
            AND applicable.effective_from <= s.starts_at
            AND s.ends_at <= applicable.effective_to
            AND EXISTS (
              SELECT 1
              FROM public.nurse_availability_slots replacement
              WHERE replacement.availability_version_id = applicable.id
                AND replacement.starts_at = s.starts_at
            )
          ORDER BY applicable.version DESC
          LIMIT 1
        )
        AND s.starts_at >= ${input.from}
        AND s.starts_at > now()
        AND s.ends_at <= ${input.to}
        AND v.effective_from <= s.starts_at
        AND s.ends_at <= v.effective_to
    )
    SELECT c.id, c.availability_version_id, c.nurse_id, c.starts_at, c.ends_at,
           c.availability_version
    FROM current_slots c
    WHERE (
        ${input.afterStartsAt}::timestamptz IS NULL
        OR (c.starts_at, c.id) > (${input.afterStartsAt}::timestamptz, ${input.afterId}::uuid)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.bookings b
        WHERE b.nurse_id = c.nurse_id
          AND b.status = 'accepted'
          AND c.ends_at > b.starts_at
          AND c.starts_at < b.reserved_until
      )
    ORDER BY c.starts_at, c.id
    LIMIT ${input.limit + 1}
  `) as unknown as AvailabilitySlotListRow[];
}
