import type { SQL } from "bun";

export type SchedulingGrantFixture = {
  patientId: string;
  patientAccountId: string;
  nurseId: string;
  nurseAccountId: string;
};

export type SchedulingGrant = {
  bookingId: string;
  visitId: string | null;
  startsAt: Date;
  endsAt: Date;
  expiresAt: string | null;
};

const SLOT_OFFSETS = { intake: 2, visit: 3, "expired-visit": 4 } as const;
const BUFFER_MINUTES = 0;

/**
 * Creates the legal lifecycle draft -> submit -> cancel (intake) or
 * draft -> submit -> accept (visit) and its real provenance atomically.
 * Intake defaults to cancellation/revocation for negative-scope tests; auth
 * may retain the active submitted grant. Visit expiry follows the accepted end,
 * or is past for expiry vectors.
 */
export async function createSchedulingGrant(
  sql: SQL,
  actor: SchedulingGrantFixture,
  basis: "request_intake" | "visit",
  options: { expired?: boolean; keepIntakeActive?: boolean } = {},
): Promise<SchedulingGrant> {
  const kind = basis === "visit" ? (options.expired ? "expired-visit" : "visit") : "intake";
  const now = Date.now();
  const startsAt = new Date(now + SLOT_OFFSETS[kind] * 24 * 60 * 60 * 1000);
  startsAt.setUTCHours(2, 0, 0, 0); // 09:00 Asia/Jakarta, aligned to the hourly working window.
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

  return sql.begin(async (tx) => {
    const identities = await tx`
      SELECT p.id
      FROM public.patients p
      JOIN public.accounts a ON a.id = p.account_id AND a.status = 'active'
      JOIN public.staff s ON s.id = ${actor.nurseId} AND s.account_id = ${actor.nurseAccountId}
                           AND s.active = true AND s.identity_approval_ref IS NOT NULL
      WHERE p.id = ${actor.patientId} AND p.account_id = ${actor.patientAccountId}
      FOR UPDATE OF p
    `;
    if (identities.length !== 1) {
      throw new Error("scheduling grant fixture requires bound active patient and approved nurse identities");
    }
    const lockedNurse = await tx`
      SELECT id FROM public.staff WHERE id = ${actor.nurseId} FOR UPDATE
    `;
    if (lockedNurse.length !== 1) throw new Error("scheduling grant fixture nurse disappeared");
    await tx`
      UPDATE public.patients
      SET address_line = COALESCE(address_line, 'Synthetic address'),
          emergency_contact_name = COALESCE(emergency_contact_name, 'Synthetic emergency contact'),
          emergency_contact_phone = COALESCE(emergency_contact_phone, '+6281234567899'),
          record_number = COALESCE(record_number, 'RM-TEST-' || upper(replace(id::text, '-', ''))),
          version = version + 1,
          updated_at = now()
      WHERE id = ${actor.patientId}
    `;

    const effectiveFrom = new Date(startsAt.getTime() - 60 * 60 * 1000);
    const effectiveTo = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
    const versions = await tx`
      INSERT INTO public.nurse_availability_versions (
        nurse_id, version, time_zone, slot_minutes, buffer_minutes,
        effective_from, effective_to, windows, created_by
      )
      SELECT ${actor.nurseId}, COALESCE(max(version), 0) + 1, 'Asia/Jakarta', 60, ${BUFFER_MINUTES},
             ${effectiveFrom}, ${effectiveTo},
             (${JSON.stringify(Array.from({ length: 7 }, (_, index) => ({
               weekday: index + 1, startMinute: 0, endMinute: 1440,
             })))}::text)::jsonb,
             ${actor.nurseAccountId}
      FROM public.nurse_availability_versions WHERE nurse_id = ${actor.nurseId}
      RETURNING id, version
    ` as unknown as Array<{ id: string; version: number }>;
    const availabilityVersion = versions[0];
    if (!availabilityVersion) throw new Error("failed to create fixture availability version");

    const slots = await tx`
      INSERT INTO public.nurse_availability_slots (
        availability_version_id, nurse_id, starts_at, ends_at
      ) VALUES (
        ${availabilityVersion.id}, ${actor.nurseId}, ${startsAt}, ${endsAt}
      ) RETURNING id
    ` as unknown as Array<{ id: string }>;
    const slotId = slots[0]?.id;
    if (!slotId) throw new Error("failed to create fixture availability slot");

    const expiredVisit = basis === "visit" && options.expired;
    const submittedAt = new Date(now - (expiredVisit ? 120 : 2) * 60 * 1000);
    const decidedAt = new Date(now - (expiredVisit ? 90 : 1) * 60 * 1000);
    const profile = await tx`
      SELECT jsonb_build_object(
        'fullName', full_name,
        'birthDate', birth_date,
        'gender', gender,
        'phone', phone,
        'addressLine', address_line,
        'emergencyContactName', emergency_contact_name,
        'emergencyContactPhone', emergency_contact_phone,
        'recordNumber', record_number
      ) AS snapshot
      FROM public.patients WHERE id = ${actor.patientId}
    ` as unknown as Array<{ snapshot: unknown }>;
    if (!profile[0]) throw new Error("patient disappeared while creating scheduling grant fixture");

    const intake = {
      complaint: "Synthetic scheduling fixture complaint",
      otherComplaint: null,
      history: null,
      consciousness: null,
      conditions: [],
      observations: [],
      note: null,
      consent: true,
    };
    const draft = await tx`
      INSERT INTO public.bookings (
        patient_id, nurse_id, slot_id, availability_version_id,
        starts_at, ends_at, reserved_until, status, intake
      ) VALUES (
        ${actor.patientId}, ${actor.nurseId}, ${slotId}, ${availabilityVersion.id},
        ${startsAt}, ${endsAt}, ${endsAt}, 'draft', (${JSON.stringify(intake)}::text)::jsonb
      ) RETURNING id
    ` as unknown as Array<{ id: string }>;
    const bookingId = draft[0]?.id;
    if (!bookingId) throw new Error("failed to create fixture draft booking");

    await tx`
      INSERT INTO public.booking_events (booking_id, actor_account_id, action, version, data)
      VALUES (${bookingId}, ${actor.patientAccountId}, 'submitted', 1, '{}'::jsonb)
    `;
    await tx`
      UPDATE public.bookings
      SET status = 'submitted', profile_snapshot = (${JSON.stringify(profile[0].snapshot)}::text)::jsonb,
          submitted_at = ${submittedAt}, version = 1, updated_at = now()
      WHERE id = ${bookingId}
    `;

    let visitId: string | null = null;
    if (basis === "request_intake" && !options.keepIntakeActive) {
      await tx`
        INSERT INTO public.booking_events (booking_id, actor_account_id, action, version, reason, data)
        VALUES (${bookingId}, ${actor.patientAccountId}, 'cancelled', 2,
                'Synthetic intake fixture cleanup', '{}'::jsonb)
      `;
      await tx`
        UPDATE public.bookings
        SET status = 'cancelled', decision_reason = 'Synthetic intake fixture cleanup',
            cancelled_at = ${decidedAt}, version = 2, updated_at = now()
        WHERE id = ${bookingId}
      `;
    } else if (basis === "visit") {
      await tx`
        INSERT INTO public.booking_events (booking_id, actor_account_id, action, version, data)
        VALUES (${bookingId}, ${actor.nurseAccountId}, 'accepted', 2, '{}'::jsonb)
      `;
      await tx`
        UPDATE public.bookings
        SET status = 'accepted', decided_at = ${decidedAt}, decision_by = ${actor.nurseAccountId},
            reserved_until = ${new Date(endsAt.getTime() + BUFFER_MINUTES * 60 * 1000)},
            version = 2, updated_at = now()
        WHERE id = ${bookingId}
      `;
      const visits = await tx`
        INSERT INTO public.visits (
          booking_id, patient_id, nurse_id, starts_at, ends_at, status, version
        ) VALUES (
          ${bookingId}, ${actor.patientId}, ${actor.nurseId}, ${startsAt}, ${endsAt}, 'scheduled', 0
        ) RETURNING id
      ` as unknown as Array<{ id: string }>;
      visitId = visits[0]?.id ?? null;
      if (!visitId) throw new Error("failed to create fixture scheduled visit");
    }

    const grants = await tx`
      INSERT INTO public.patient_access_grants (
        staff_id, patient_id, basis, source_booking_id, source_visit_id,
        granted_at, expires_at, revoked_at
      ) VALUES (
        ${actor.nurseId}, ${actor.patientId}, ${basis},
        ${basis === "request_intake" ? bookingId : null},
        ${basis === "visit" ? visitId : null},
        ${basis === "visit" ? decidedAt : submittedAt},
        ${basis === "visit" ? (expiredVisit ? new Date(now - 60 * 60 * 1000) : endsAt) : null},
        ${basis === "request_intake" && !options.keepIntakeActive ? decidedAt : null}
      ) RETURNING expires_at
    ` as unknown as Array<{ expires_at: Date | string | null }>;
    const expiresAt = grants[0]?.expires_at ?? null;
    return {
      bookingId,
      visitId,
      startsAt,
      endsAt,
      expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
    };
  });
}
