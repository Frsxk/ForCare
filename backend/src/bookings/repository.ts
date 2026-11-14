import type { SQL } from "bun";
import type { BookingIntake } from "./schemas";

export type BookingStatus = "draft" | "submitted" | "accepted" | "rejected" | "cancelled";

export type BookingRow = {
  id: string;
  patient_id: string;
  nurse_id: string;
  slot_id: string | null;
  availability_version_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  reserved_until: Date | string;
  status: BookingStatus;
  intake: BookingIntake;
  profile_snapshot: Record<string, unknown> | null;
  version: number;
  submitted_at: Date | string | null;
  decided_at: Date | string | null;
  cancelled_at: Date | string | null;
  decision_by: string | null;
  decision_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  nurse_display_name: string;
  nurse_staff_code: string;
  patient_display_name: string;
  patient_record_number: string | null;
  visit_id: string | null;
  visit_status: "scheduled" | "cancelled" | null;
  priority_request_id: string | null;
  intake_grant_active: boolean;
  visit_grant_active: boolean;
  slot_matches_reservation: boolean;
  had_nurse_grant: boolean;
  nurse_identity_eligible: boolean;
};

export type BookingEventRow = {
  booking_id: string;
  id: string;
  action: string;
  version: number;
  reason: string | null;
  data: unknown;
  created_at: Date | string;
};

const COLUMNS = `
  b.id, b.patient_id, b.nurse_id, b.slot_id, b.availability_version_id,
  b.starts_at, b.ends_at, b.reserved_until, b.status, b.intake, b.profile_snapshot,
  b.version, b.submitted_at, b.decided_at, b.cancelled_at, b.decision_by,
  b.decision_reason, b.created_at, b.updated_at,
  n.display_name AS nurse_display_name, n.staff_code AS nurse_staff_code,
  p.full_name AS patient_display_name, p.record_number AS patient_record_number,
  v.id AS visit_id, v.status AS visit_status,
  (SELECT pr.id FROM public.priority_requests pr
    JOIN public.schedule_exceptions se ON se.priority_request_id = pr.id
    WHERE pr.booking_id = b.id AND pr.status = 'availability_accepted'
      AND pr.nurse_id = b.nurse_id AND pr.starts_at = b.starts_at AND pr.ends_at = b.ends_at
    LIMIT 1) AS priority_request_id,
  EXISTS (
    SELECT 1 FROM public.patient_access_grants ig
    WHERE ig.source_booking_id = b.id AND ig.staff_id = b.nurse_id
      AND ig.basis = 'request_intake' AND ig.revoked_at IS NULL
      AND (ig.expires_at IS NULL OR ig.expires_at > now())
  ) AS intake_grant_active,
  EXISTS (
    SELECT 1 FROM public.patient_access_grants vg
    WHERE vg.source_visit_id = v.id AND vg.staff_id = b.nurse_id
      AND vg.basis = 'visit' AND vg.revoked_at IS NULL
      AND (vg.expires_at IS NULL OR vg.expires_at > now())
      AND v.status = 'scheduled' AND v.ends_at > now()
  ) AS visit_grant_active,
  EXISTS (
    SELECT 1 FROM public.nurse_availability_slots es
    JOIN public.nurse_availability_versions eav ON eav.id = es.availability_version_id
    WHERE es.id = b.slot_id AND es.availability_version_id = b.availability_version_id
  ) AS slot_matches_reservation,
  EXISTS (
    SELECT 1 FROM public.patient_access_grants ng
    WHERE ng.staff_id = b.nurse_id
      AND (ng.source_booking_id = b.id OR (v.id IS NOT NULL AND ng.source_visit_id = v.id))
  ) AS had_nurse_grant,
  (n.active = true AND a.status = 'active' AND btrim(n.identity_approval_ref) <> ''
    AND n.provisioning_email_domain = split_part(a.email_normalized, '@', 2)) AS nurse_identity_eligible

`;

const FROM = `
  FROM public.bookings b
  JOIN public.staff n ON n.id = b.nurse_id
  JOIN public.accounts a ON a.id = n.account_id
  JOIN public.patients p ON p.id = b.patient_id
  LEFT JOIN public.visits v ON v.booking_id = b.id
`;

export type NurseIdentity = { id: string; display_name: string; staff_code: string };
export type PatientIdentity = {
  id: string;
  full_name: string;
  birth_date: string;
  gender: string;
  phone: string;
  address_line: string | null;
  record_number: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

export async function lockPatientIdentity(sql: SQL, patientId: string): Promise<PatientIdentity | null> {
  const rows = (await sql`
    SELECT id, full_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
      gender, phone, address_line, record_number, emergency_contact_name, emergency_contact_phone
    FROM public.patients WHERE id = ${patientId} FOR UPDATE
  `) as unknown as PatientIdentity[];
  return rows[0] ?? null;
}

export async function lockNurseIdentity(sql: SQL, nurseId: string): Promise<NurseIdentity | null> {
  const rows = (await sql`
    SELECT s.id, s.display_name, s.staff_code
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles ar ON ar.account_id = a.id AND ar.role = 'nurse'
    WHERE s.id = ${nurseId}
      AND btrim(s.identity_approval_ref) <> ''
    FOR UPDATE OF s
  `) as unknown as NurseIdentity[];
  return rows[0] ?? null;
}

export async function readBooking(sql: SQL, id: string): Promise<BookingRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)} WHERE b.id = ${id} LIMIT 1
  `) as unknown as BookingRow[];
  return rows[0] ?? null;
}

export async function lockBooking(sql: SQL, id: string): Promise<BookingRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)}
    WHERE b.id = ${id} FOR UPDATE OF b
  `) as unknown as BookingRow[];
  return rows[0] ?? null;
}

export async function listBookingEvents(sql: SQL, bookingId: string): Promise<BookingEventRow[]> {
  return (await sql`
    SELECT booking_id, id, action, version, reason, data, created_at
    FROM public.booking_events WHERE booking_id = ${bookingId}
    ORDER BY created_at, id
  `) as unknown as BookingEventRow[];
}

export async function listBookingEventsFor(sql: SQL, bookingIds: string[]): Promise<BookingEventRow[]> {
  if (bookingIds.length === 0) return [];
  return (await sql`
    SELECT booking_id, id, action, version, reason, data, created_at
    FROM public.booking_events WHERE booking_id IN ${sql(bookingIds)}
    ORDER BY created_at, id
  `) as unknown as BookingEventRow[];
}

export type Slot = {
  id: string;
  nurse_id: string;
  availability_version_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  buffer_minutes: number;
};

/** Canonical eligibility follows a fully-applicable replacement at the same start. */
export async function readCurrentSlot(sql: SQL, nurseId: string, slotId: string): Promise<Slot | null> {
  const rows = (await sql`
    SELECT s.id, s.nurse_id, s.availability_version_id, s.starts_at, s.ends_at,
      av.buffer_minutes
    FROM public.nurse_availability_slots s
    JOIN public.nurse_availability_versions av ON av.id = s.availability_version_id
    WHERE s.id = ${slotId} AND s.nurse_id = ${nurseId} AND s.starts_at > now()
      AND av.effective_from <= s.starts_at AND av.effective_to >= s.ends_at
      AND NOT EXISTS (
        SELECT 1 FROM public.nurse_availability_slots replacement
        JOIN public.nurse_availability_versions newer ON newer.id = replacement.availability_version_id
        WHERE newer.nurse_id = s.nurse_id AND newer.version > av.version
          AND newer.effective_from <= s.starts_at AND replacement.ends_at <= newer.effective_to
          AND replacement.nurse_id = s.nurse_id AND replacement.starts_at = s.starts_at
      )
    LIMIT 1
  `) as unknown as Slot[];
  return rows[0] ?? null;
}

export async function readApplicableAvailability(
  sql: SQL,
  nurseId: string,
  startsAt: string,
  endsAt: string,
): Promise<{ slot_minutes: number; buffer_minutes: number } | null> {
  const rows = (await sql`
    SELECT av.slot_minutes, av.buffer_minutes
    FROM public.nurse_availability_versions av
    WHERE av.nurse_id = ${nurseId}
      AND av.effective_from <= ${startsAt}::timestamptz
      AND av.effective_to >= ${endsAt}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM public.nurse_availability_versions newer
        WHERE newer.nurse_id = av.nurse_id AND newer.version > av.version
          AND newer.effective_from <= ${startsAt}::timestamptz
      )
    LIMIT 1
  `) as unknown as Array<{ slot_minutes: number; buffer_minutes: number }>;
  return rows[0] ?? null;
}

export type ApprovedException = { priority_request_id: string; ends_at: Date | string };
export async function readExactApprovedException(
  sql: SQL,
  input: { bookingId: string; nurseId: string; startsAt: string; endsAt: string },
): Promise<ApprovedException | null> {
  const rows = (await sql`
    SELECT pr.id AS priority_request_id, pr.ends_at
    FROM public.priority_requests pr
    JOIN public.schedule_exceptions se ON se.priority_request_id = pr.id
    WHERE pr.booking_id = ${input.bookingId} AND pr.nurse_id = ${input.nurseId}
      AND pr.status = 'availability_accepted'
      AND pr.starts_at = ${input.startsAt}::timestamptz
      AND pr.ends_at = ${input.endsAt}::timestamptz
      AND pr.ends_at > now()
      AND se.booking_id = ${input.bookingId} AND se.nurse_id = ${input.nurseId}
      AND se.starts_at = ${input.startsAt}::timestamptz
      AND se.ends_at = ${input.endsAt}::timestamptz
    LIMIT 1
  `) as unknown as ApprovedException[];
  return rows[0] ?? null;
}

export async function insertBooking(
  sql: SQL,
  input: {
    patientId: string;
    nurseId: string;
    slot: Slot | null;
    startsAt: string;
    endsAt: string;
    reservedUntil: string;
    intake: BookingIntake;
  },
): Promise<BookingRow> {
  const inserted = (await sql`
    INSERT INTO public.bookings (
      patient_id, nurse_id, slot_id, availability_version_id, starts_at, ends_at,
      reserved_until, status, intake
    ) VALUES (
      ${input.patientId}, ${input.nurseId}, ${input.slot?.id ?? null},
      ${input.slot?.availability_version_id ?? null}, ${input.startsAt}::timestamptz,
      ${input.endsAt}::timestamptz, ${input.reservedUntil}::timestamptz,
      'draft', (${JSON.stringify(input.intake)}::text)::jsonb
    ) RETURNING id
  `) as unknown as Array<{ id: string }>;
  return (await readBooking(sql, inserted[0].id))!;
}

export async function updateBookingDraft(
  sql: SQL,
  input: {
    id: string;
    expectedVersion: number;
    nurseId: string;
    slot: Slot | null;
    startsAt: string;
    endsAt: string;
    reservedUntil: string;
    intake: BookingIntake;
  },
): Promise<BookingRow | null> {
  const rows = (await sql`
    UPDATE public.bookings b SET
      nurse_id = ${input.nurseId}, slot_id = ${input.slot?.id ?? null},
      availability_version_id = ${input.slot?.availability_version_id ?? null},
      starts_at = ${input.startsAt}::timestamptz, ends_at = ${input.endsAt}::timestamptz,
      reserved_until = ${input.reservedUntil}::timestamptz,
      intake = (${JSON.stringify(input.intake)}::text)::jsonb,
      version = version + 1, updated_at = now()
    WHERE b.id = ${input.id} AND b.version = ${input.expectedVersion} AND b.status = 'draft'
    RETURNING b.id
  `) as unknown as Array<{ id: string }>;
  return rows[0] ? readBooking(sql, rows[0].id) : null;
}

export async function submitBooking(
  sql: SQL,
  input: {
    id: string;
    expectedVersion: number;
    slot: Slot | null;
    reservedUntil: string;
    snapshot: unknown;
  },
) {
  const rows = (await sql`
    UPDATE public.bookings SET
      slot_id = ${input.slot?.id ?? null},
      availability_version_id = ${input.slot?.availability_version_id ?? null},
      reserved_until = ${input.reservedUntil}::timestamptz,
      status = 'submitted', profile_snapshot = (${JSON.stringify(input.snapshot)}::text)::jsonb,
      submitted_at = now(), version = version + 1, updated_at = now()
    WHERE id = ${input.id} AND version = ${input.expectedVersion} AND status = 'draft'
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] ? readBooking(sql, rows[0].id) : null;
}

export async function acceptBooking(sql: SQL, id: string, expectedVersion: number, actorAccountId: string) {
  const rows = (await sql`
    UPDATE public.bookings SET status = 'accepted', decided_at = now(), decision_by = ${actorAccountId},
      decision_reason = NULL, version = version + 1, updated_at = now()
    WHERE id = ${id} AND version = ${expectedVersion} AND status = 'submitted'
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function rejectBooking(
  sql: SQL,
  id: string,
  expectedVersion: number,
  actorAccountId: string,
  reason: string,
) {
  const rows = (await sql`
    UPDATE public.bookings SET status = 'rejected', decided_at = now(), decision_by = ${actorAccountId},
      decision_reason = ${reason}, version = version + 1, updated_at = now()
    WHERE id = ${id} AND version = ${expectedVersion} AND status = 'submitted'
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function cancelBooking(
  sql: SQL,
  id: string,
  expectedVersion: number,
  reason: string,
) {
  const rows = (await sql`
    UPDATE public.bookings SET status = 'cancelled', cancelled_at = now(),
      decision_reason = ${reason}, version = version + 1, updated_at = now()
    WHERE id = ${id} AND version = ${expectedVersion} AND status IN ('draft', 'submitted', 'accepted')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function insertVisit(
  sql: SQL,
  input: { bookingId: string; patientId: string; nurseId: string; startsAt: Date | string; endsAt: Date | string },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO public.visits (booking_id, patient_id, nurse_id, starts_at, ends_at, status)
    VALUES (${input.bookingId}, ${input.patientId}, ${input.nurseId}, ${input.startsAt}, ${input.endsAt}, 'scheduled')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

export async function lockScheduledVisit(sql: SQL, visitId: string, bookingId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM public.visits
    WHERE id = ${visitId} AND booking_id = ${bookingId} AND status = 'scheduled'
    FOR UPDATE
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export async function rescheduleVisitAndBooking(
  sql: SQL,
  input: {
    bookingId: string;
    visitId: string;
    expectedBookingVersion: number;
    slot: Slot | null;
    startsAt: string;
    endsAt: string;
    reservedUntil: string;
  },
): Promise<string | null> {
  const rows = (await sql`
    UPDATE public.bookings SET slot_id = ${input.slot?.id ?? null},
      availability_version_id = ${input.slot?.availability_version_id ?? null},
      starts_at = ${input.startsAt}::timestamptz, ends_at = ${input.endsAt}::timestamptz,
      reserved_until = ${input.reservedUntil}::timestamptz,
      version = version + 1, updated_at = now()
    WHERE id = ${input.bookingId} AND version = ${input.expectedBookingVersion} AND status = 'accepted'
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  if (!rows[0]) return null;
  const visits = (await sql`
    UPDATE public.visits SET starts_at = ${input.startsAt}::timestamptz,
      ends_at = ${input.endsAt}::timestamptz, version = version + 1, updated_at = now()
    WHERE id = ${input.visitId} AND booking_id = ${input.bookingId} AND status = 'scheduled'
    RETURNING version
  `) as unknown as Array<{ version: number }>;
  return visits[0] ? rows[0].id : null;
}

export async function cancelVisit(sql: SQL, visitId: string, bookingId: string): Promise<void> {
  await sql`
    UPDATE public.visits SET status = 'cancelled', version = version + 1, updated_at = now()
    WHERE id = ${visitId} AND booking_id = ${bookingId} AND status = 'scheduled'
  `;
}

export async function grantIntake(sql: SQL, bookingId: string, patientId: string, nurseId: string, expiresAt: Date | string) {
  await sql`
    INSERT INTO public.patient_access_grants (
      staff_id, patient_id, basis, source_booking_id, expires_at
    ) VALUES (${nurseId}, ${patientId}, 'request_intake', ${bookingId}, ${expiresAt})
  `;
}

export async function grantVisit(sql: SQL, visitId: string, patientId: string, nurseId: string, expiresAt: Date | string) {
  await sql`
    INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id, expires_at)
    VALUES (${nurseId}, ${patientId}, 'visit', ${visitId}, ${expiresAt})
  `;
}

export async function revokeIntake(sql: SQL, bookingId: string): Promise<void> {
  await sql`
    UPDATE public.patient_access_grants SET revoked_at = now()
    WHERE source_booking_id = ${bookingId} AND basis = 'request_intake' AND revoked_at IS NULL
  `;
}

export async function revokeVisit(sql: SQL, visitId: string): Promise<void> {
  await sql`
    UPDATE public.patient_access_grants SET revoked_at = now()
    WHERE source_visit_id = ${visitId} AND basis = 'visit' AND revoked_at IS NULL
  `;
}

export async function updateVisitGrantExpiry(sql: SQL, visitId: string, expiresAt: string): Promise<void> {
  await sql`
    UPDATE public.patient_access_grants SET expires_at = ${expiresAt}::timestamptz
    WHERE source_visit_id = ${visitId} AND basis = 'visit' AND revoked_at IS NULL
  `;
}

export async function insertBookingEvent(
  sql: SQL,
  input: { bookingId: string; actorAccountId: string; action: string; version: number; reason?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  await sql`
    INSERT INTO public.booking_events (booking_id, actor_account_id, action, version, reason, data)
    VALUES (${input.bookingId}, ${input.actorAccountId}, ${input.action}, ${input.version},
      ${input.reason ?? null}, (${JSON.stringify(input.data ?? {})}::text)::jsonb)
  `;
}

export async function countActive(sql: SQL, patientId: string, excludeBookingId?: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count FROM public.bookings
    WHERE patient_id = ${patientId} AND status IN ('submitted', 'accepted') AND ends_at > now()
      AND (${excludeBookingId ?? null}::uuid IS NULL OR id <> ${excludeBookingId ?? null}::uuid)
  `) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

export async function findScheduleConflict(
  sql: SQL,
  input: { bookingId: string; patientId: string; nurseId: string; startsAt: string; endsAt: string; reservedUntil: string },
): Promise<"nurse" | "patient" | null> {
  const rows = (await sql`
    SELECT CASE WHEN nurse_conflict THEN 'nurse' ELSE 'patient' END AS actor
    FROM (
      SELECT EXISTS (
        SELECT 1 FROM public.bookings WHERE status = 'accepted' AND id <> ${input.bookingId}
          AND nurse_id = ${input.nurseId}
          AND tstzrange(starts_at, reserved_until, '[)') && tstzrange(${input.startsAt}::timestamptz, ${input.reservedUntil}::timestamptz, '[)')
      ) AS nurse_conflict,
      EXISTS (
        SELECT 1 FROM public.bookings WHERE status = 'accepted' AND id <> ${input.bookingId}
          AND patient_id = ${input.patientId}
          AND tstzrange(starts_at, ends_at, '[)') && tstzrange(${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, '[)')
      ) AS patient_conflict
    ) conflicts
    WHERE nurse_conflict OR patient_conflict LIMIT 1
  `) as unknown as Array<{ actor: "nurse" | "patient" }>;
  return rows[0]?.actor ?? null;
}

export type BookingListInput = {
  schedule?: { from: string; to: string } | null;
  actorId: string;
  owner: "patient" | "nurse";
  status: BookingStatus | null;
  search?: string;
  limit: number;
  afterCreatedAt: string | null;
  afterId: string | null;
};

export async function listBookings(sql: SQL, input: BookingListInput): Promise<BookingRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)}
    WHERE (
      (${input.owner} = 'patient' AND b.patient_id = ${input.actorId})
      OR (
        ${input.owner} = 'nurse' AND b.nurse_id = ${input.actorId} AND b.status <> 'draft'
        AND n.active = true AND a.status = 'active' AND btrim(n.identity_approval_ref) <> ''
        AND EXISTS (
          SELECT 1 FROM public.patient_access_grants lg
          WHERE lg.staff_id = b.nurse_id
            AND (lg.source_booking_id = b.id OR lg.source_visit_id = v.id)
        )
      )
    )
      AND (${input.status ?? null}::text IS NULL OR b.status = ${input.status ?? null})
      AND (
        ${input.schedule === undefined || input.schedule === null}::boolean = true
        OR (b.status = 'accepted' AND v.status = 'scheduled'
          AND b.starts_at < ${input.schedule?.to ?? null}::timestamptz
          AND b.ends_at > ${input.schedule?.from ?? null}::timestamptz)
      )
      AND (
        ${input.search ?? ""} = ''
        OR (
          ${input.owner} = 'nurse'
          AND (
            strpos(lower(p.full_name), ${input.search ?? ""}) > 0
            OR strpos(lower(coalesce(p.record_number, '')), ${input.search ?? ""}) > 0
          )
        )
      )
      AND (${input.afterCreatedAt ?? null}::timestamptz IS NULL
        OR (b.starts_at, b.id) > (${input.afterCreatedAt}::timestamptz, ${input.afterId}::uuid))
    ORDER BY b.starts_at, b.id LIMIT ${input.limit + 1}
  `) as unknown as BookingRow[];
}
