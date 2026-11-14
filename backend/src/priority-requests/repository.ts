import type { SQL } from "bun";

export type PriorityRequestStatus = "pending" | "availability_accepted" | "declined";

export type PriorityRequestId = { id: string };

export type PriorityRequestRow = {
  id: string;
  booking_id: string;
  patient_id: string;
  nurse_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  statement: string;
  status: PriorityRequestStatus;
  reason: string | null;
  version: number;
  reviewed_at: Date | string | null;
  created_at: Date | string;
  patient_display_name: string;
  patient_record_number: string | null;
};

export type PriorityBookingStatus = "draft" | "submitted" | "accepted" | "rejected" | "cancelled";

export type PriorityBookingBinding = {
  id: string;
  patient_id: string;
  nurse_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: PriorityBookingStatus;
};

const COLUMNS = `
  pr.id, pr.booking_id, pr.patient_id, pr.nurse_id, pr.starts_at, pr.ends_at,
  pr.statement, pr.status, pr.reason, pr.version, pr.reviewed_at, pr.created_at,
  p.full_name AS patient_display_name, p.record_number AS patient_record_number
`;

const FROM = `
  FROM public.priority_requests pr
  JOIN public.patients p ON p.id = pr.patient_id
`;

export async function readBookingBinding(
  sql: SQL,
  bookingId: string,
  patientId: string,
): Promise<PriorityBookingBinding | null> {
  const rows = (await sql`
    SELECT id, patient_id, nurse_id, starts_at, ends_at, status
    FROM public.bookings
    WHERE id = ${bookingId} AND patient_id = ${patientId}
    LIMIT 1
  `) as unknown as PriorityBookingBinding[];
  return rows[0] ?? null;
}

export async function lockPriorityPatient(sql: SQL, patientId: string): Promise<void> {
  await sql`SELECT id FROM public.patients WHERE id = ${patientId} FOR UPDATE`;
}

export async function lockPriorityEligibleNurse(
  sql: SQL,
  input: { nurseId: string; accountId: string | null; nurseEmailDomain: string | null },
): Promise<boolean> {
  const rows = (await sql`
    SELECT s.id
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles r ON r.account_id = a.id AND r.role = 'nurse'
    WHERE s.id = ${input.nurseId}
      AND (${input.accountId}::uuid IS NULL OR s.account_id = ${input.accountId}::uuid)
      AND s.active = true
      AND a.status = 'active'
      AND ${input.nurseEmailDomain}::text IS NOT NULL
      AND btrim(s.identity_approval_ref) <> ''
      AND s.provisioning_email_domain = ${input.nurseEmailDomain}::text
      AND split_part(a.email_normalized, '@', 2) = ${input.nurseEmailDomain}::text
    FOR UPDATE OF s
  `) as unknown as Array<{ id: string }>;
  return rows[0] !== undefined;
}

export async function lockBookingBinding(
  sql: SQL,
  bookingId: string,
): Promise<PriorityBookingBinding | null> {
  const rows = (await sql`
    SELECT id, patient_id, nurse_id, starts_at, ends_at, status
    FROM public.bookings
    WHERE id = ${bookingId}
    FOR UPDATE
  `) as unknown as PriorityBookingBinding[];
  return rows[0] ?? null;
}

export type ApplicableAvailability = {
  version: number;
  slot_minutes: number;
  effective_to: Date | string;
};

/** A later published version supersedes older settings once effective. */
export async function readApplicableAvailability(
  sql: SQL,
  nurseId: string,
  startsAt: string,
  endsAt: string,
): Promise<ApplicableAvailability | null> {
  const rows = (await sql`
    SELECT version, slot_minutes, effective_to
    FROM public.nurse_availability_versions
    WHERE nurse_id = ${nurseId} AND effective_from <= ${startsAt}::timestamptz
      AND effective_to >= ${endsAt}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM public.nurse_availability_versions newer
        WHERE newer.nurse_id = nurse_availability_versions.nurse_id
          AND newer.version > nurse_availability_versions.version
          AND newer.effective_from <= ${startsAt}::timestamptz
      )
    LIMIT 1
  `) as unknown as ApplicableAvailability[];
  return rows[0] ?? null;
}

export async function insertPriorityRequest(
  sql: SQL,
  input: {
    bookingId: string;
    patientId: string;
    nurseId: string;
    startsAt: string;
    endsAt: string;
    statement: string;
  },
): Promise<PriorityRequestRow> {
  const rows = (await sql`
    INSERT INTO public.priority_requests (
      booking_id, patient_id, nurse_id, starts_at, ends_at, statement
    ) VALUES (
      ${input.bookingId}, ${input.patientId}, ${input.nurseId},
      ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, ${input.statement}
    )
    RETURNING id
  `) as unknown as PriorityRequestId[];
  // The identity join is deliberately separate: RETURNING cannot read patients.
  const created = await readOwnPriorityRequest(sql, rows[0].id, input.patientId);
  if (!created) throw new Error("Inserted priority request could not be read");
  return created;
}

export async function lockPriorityRequest(
  sql: SQL,
  id: string,
  nurseId: string,
): Promise<PriorityRequestRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)}
    WHERE pr.id = ${id} AND pr.nurse_id = ${nurseId}
    FOR UPDATE OF pr
  `) as unknown as PriorityRequestRow[];
  return rows[0] ?? null;
}

export async function readOwnPriorityRequest(
  sql: SQL,
  id: string,
  patientId: string,
): Promise<PriorityRequestRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)}
    WHERE pr.id = ${id} AND pr.patient_id = ${patientId}
    LIMIT 1
  `) as unknown as PriorityRequestRow[];
  return rows[0] ?? null;
}

export async function readNursePriorityRequest(
  sql: SQL,
  id: string,
  nurseId: string,
): Promise<PriorityRequestRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)}
    WHERE pr.id = ${id} AND pr.nurse_id = ${nurseId}
    LIMIT 1
  `) as unknown as PriorityRequestRow[];
  return rows[0] ?? null;
}

export async function listPriorityRequests(
  sql: SQL,
  input:
    | { owner: "patient"; ownerId: string; limit: number; afterCreatedAt: string | null; afterId: string | null }
    | { owner: "nurse"; ownerId: string; limit: number; afterCreatedAt: string | null; afterId: string | null },
): Promise<PriorityRequestRow[]> {
  const ownerColumn = input.owner === "patient" ? "pr.patient_id" : "pr.nurse_id";
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)} ${sql.unsafe(FROM)}
    WHERE ${sql.unsafe(ownerColumn)} = ${input.ownerId}::uuid
      AND (
        ${input.afterCreatedAt}::timestamptz IS NULL
        OR (pr.created_at, pr.id) < (
          ${input.afterCreatedAt}::timestamptz, ${input.afterId}::uuid
        )
      )
    ORDER BY pr.created_at DESC, pr.id DESC
    LIMIT ${input.limit + 1}
  `) as unknown as PriorityRequestRow[];
}

/** Nurse reservations include their buffer; patient reservations use the raw interval. */
export async function acceptedPriorityConflictExists(
  sql: SQL,
  input: {
    bookingId: string;
    patientId: string;
    nurseId: string;
    startsAt: string;
    endsAt: string;
  },
): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.status = 'accepted'
        AND (
          (b.nurse_id = ${input.nurseId} AND tstzrange(b.starts_at, b.reserved_until, '[)')
            && tstzrange(${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, '[)'))
          OR
          (b.patient_id = ${input.patientId} AND tstzrange(b.starts_at, b.ends_at, '[)')
            && tstzrange(${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, '[)'))
        )
        AND (
          b.id <> ${input.bookingId}::uuid
          OR b.starts_at <> ${input.startsAt}::timestamptz
          OR b.ends_at <> ${input.endsAt}::timestamptz
        )
    ) AS conflict
  `) as unknown as Array<{ conflict: boolean }>;
  return rows[0]?.conflict === true;
}

export async function decidePriorityRequest(
  sql: SQL,
  input: {
    id: string;
    nurseId: string;
    expectedVersion: number;
    status: "availability_accepted" | "declined";
    reason: string;
    reviewerAccountId: string;
  },
): Promise<{ version: number; reviewed_at: Date | string } | null> {
  const rows = (await sql`
    UPDATE public.priority_requests
    SET status = ${input.status}, reason = ${input.reason},
        reviewed_by = ${input.reviewerAccountId}, reviewed_at = now(), version = version + 1
    WHERE id = ${input.id} AND nurse_id = ${input.nurseId}
      AND status = 'pending' AND version = ${input.expectedVersion}
    RETURNING version, reviewed_at
  `) as unknown as Array<{ version: number; reviewed_at: Date | string }>;
  return rows[0] ?? null;
}

export async function insertScheduleException(
  sql: SQL,
  input: {
    priorityRequestId: string;
    bookingId: string;
    nurseId: string;
    startsAt: string;
    endsAt: string;
    approvedBy: string;
    reason: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO public.schedule_exceptions (
      priority_request_id, booking_id, nurse_id, starts_at, ends_at, approved_by, reason
    ) VALUES (
      ${input.priorityRequestId}, ${input.bookingId}, ${input.nurseId},
      ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz,
      ${input.approvedBy}, ${input.reason}
    )
  `;
}
