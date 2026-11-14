import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;
let db: DisposableDatabase;
let sequence = 0;

let identities: {
  patient: { id: string; accountId: string };
  otherPatient: { id: string; accountId: string };
  nurse: { id: string; accountId: string };
  otherNurse: { id: string; accountId: string };
};

async function patientFixture() {
  const suffix = ++sequence;
  const accountId = randomUUID();
  await db.sql`
    INSERT INTO public.accounts (id, email_normalized, password_hash, updated_at)
    VALUES (${accountId}, ${`stop4-${suffix}@example.com`}, 'synthetic-hash', now())
  `;
  await db.sql`INSERT INTO public.account_roles (account_id, role) VALUES (${accountId}, 'patient')`;
  const [patient] = await db.sql`
    INSERT INTO public.patients (
      id, account_id, full_name, birth_date, gender, phone, address_line,
      emergency_contact_name, emergency_contact_phone, record_number, updated_at
    ) VALUES (
      ${randomUUID()}, ${accountId}, 'Synthetic Patient', '1990-01-01', 'undisclosed',
      '+620000', 'Synthetic address', 'Synthetic contact', '+620001', ${`RM-S4-${suffix}`}, now()
    ) RETURNING id
  `;
  return { id: patient.id as string, accountId };
}

async function nurseFixture() {
  const suffix = ++sequence;
  const nurse = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
    email: `stop4-${suffix}@nurse.invalid`,
    passwordHash: "synthetic-hash",
    staffCode: `S4-${suffix}`,
    displayName: "Synthetic Nurse",
    approvalReference: "synthetic-stop4",
    operator: "stop4-schema-test",
    nurseDomain: "nurse.invalid",
  }));
  const [row] = await db.sql`SELECT account_id FROM public.staff WHERE id = ${nurse.staffId}`;
  return { id: nurse.staffId, accountId: row.account_id as string };
}

function intake(consent = true) {
  return {
    complaint: "Synthetic complaint",
    otherComplaint: null,
    history: null,
    consciousness: null,
    conditions: [],
    observations: [],
    note: null,
    consent,
  };
}

async function approve(booking: BookingRow, target = { startsAt: booking.starts_at, endsAt: booking.ends_at }) {
  const [request] = await db.sql`
    INSERT INTO public.priority_requests (id, booking_id, patient_id, nurse_id, starts_at, ends_at, statement)
    VALUES (${randomUUID()}, ${booking.id}, ${booking.patient_id}, ${booking.nurse_id}, ${target.startsAt}, ${target.endsAt}, 'Synthetic exception')
    RETURNING id
  `;
  const [nurse] = await db.sql`SELECT account_id FROM public.staff WHERE id = ${booking.nurse_id}`;
  await db.sql`
    UPDATE public.priority_requests
    SET status = 'availability_accepted', reason = 'Approved synthetic exception',
      reviewed_by = ${nurse.account_id}, reviewed_at = now(), version = 1
    WHERE id = ${request.id}
  `;
  await db.sql`
    INSERT INTO public.schedule_exceptions (id, priority_request_id, booking_id, nurse_id, starts_at, ends_at, approved_by, reason)
    VALUES (${randomUUID()}, ${request.id}, ${booking.id}, ${booking.nurse_id}, ${target.startsAt}, ${target.endsAt}, ${nurse.account_id}, 'Approved synthetic exception')
  `;
  return request.id as string;
}

async function outOfHoursDraft(options: { nurseId?: string; patientId?: string; startsAt: Date; endsAt: Date }): Promise<BookingRow> {
  const nurseId = options.nurseId ?? identities.nurse.id;
  const [policy] = await db.sql`
    SELECT buffer_minutes FROM public.nurse_availability_versions
    WHERE nurse_id = ${nurseId} ORDER BY version DESC LIMIT 1
  `;
  const reservedUntil = new Date(options.endsAt.getTime() + (policy?.buffer_minutes ?? 0) * 60_000);
  const [booking] = await db.sql`
    INSERT INTO public.bookings (id, patient_id, nurse_id, starts_at, ends_at, reserved_until, intake, updated_at)
    VALUES (${randomUUID()}, ${options.patientId ?? identities.patient.id}, ${nurseId},
      ${options.startsAt}, ${options.endsAt}, ${reservedUntil}, ${intake()}, now())
    RETURNING *
  `;
  return booking as unknown as BookingRow;
}

async function availabilityFixture(startHour: number, bufferMinutes = 0) {
  const versionId = randomUUID();
  const localDate = "2099-01-05"; // Monday in Asia/Jakarta.
  const startsAt = new Date(Date.UTC(2099, 0, 5, startHour - 7));
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  await db.sql`
    INSERT INTO public.nurse_availability_versions (
      id, nurse_id, version, time_zone, slot_minutes, buffer_minutes,
      effective_from, effective_to, windows, created_by, created_at
    ) VALUES (
      ${versionId}, ${identities.nurse.id}, 1, 'Asia/Jakarta', 60, ${bufferMinutes},
      ${new Date(Date.UTC(2099, 0, 4))}, ${new Date(Date.UTC(2099, 1, 1))},
      (${JSON.stringify([{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }])}::text)::jsonb,
      ${identities.nurse.accountId}, now()
    )
  `;
  const slotId = randomUUID();
  await db.sql`
    INSERT INTO public.nurse_availability_slots (
      id, availability_version_id, nurse_id, starts_at, ends_at
    ) VALUES (${slotId}, ${versionId}, ${identities.nurse.id}, ${startsAt}, ${endsAt})
  `;
  return { versionId, slotId, startsAt, endsAt, reservedUntil: new Date(endsAt.getTime() + bufferMinutes * 60_000), localDate };
}

type BookingRow = {
  id: string;
  patient_id: string;
  nurse_id: string;
  slot_id: string | null;
  availability_version_id: string | null;
  starts_at: Date;
  ends_at: Date;
  reserved_until: Date;
  status: string;
  version: number;
};

async function draftFixture(options: { slotId?: string | null; versionId?: string | null; nurseId?: string; startsAt?: Date; endsAt?: Date; patientId?: string } = {}) {
  const slot = options.slotId === undefined ? (await availabilityFixture(9)).slotId : options.slotId;
  const availability = slot ? await db.sql`SELECT * FROM public.nurse_availability_slots WHERE id = ${slot}` : [];
  const startsAt = options.startsAt ?? (slot ? availability[0].starts_at as Date : new Date(Date.UTC(2099, 0, 5, 1)));
  const endsAt = options.endsAt ?? (slot ? availability[0].ends_at as Date : new Date(Date.UTC(2099, 0, 5, 2)));
  let bufferMinutes = 0;
  if (slot) {
    const [policy] = await db.sql`SELECT buffer_minutes FROM public.nurse_availability_versions WHERE id = ${availability[0].availability_version_id}`;
    bufferMinutes = policy.buffer_minutes;
  }
  const [booking] = await db.sql`
    INSERT INTO public.bookings (
      id, patient_id, nurse_id, slot_id, availability_version_id,
      starts_at, ends_at, reserved_until, status, intake, updated_at
    ) VALUES (
      ${randomUUID()}, ${options.patientId ?? identities.patient.id}, ${options.nurseId ?? identities.nurse.id},
      ${slot ?? null}, ${options.versionId === undefined ? (slot ? availability[0].availability_version_id : null) : options.versionId},
      ${startsAt}, ${endsAt}, ${new Date(endsAt.getTime() + bufferMinutes * 60_000)},
      'draft', ${intake()}, now()
    ) RETURNING *
  `;
  return booking as unknown as BookingRow;
}

async function submit(booking: BookingRow) {
  const [patient] = await db.sql`SELECT * FROM public.patients WHERE id = ${booking.patient_id}`;
  const snap = {
    fullName: patient.full_name,
    birthDate: "1990-01-01",
    gender: patient.gender,
    phone: patient.phone,
    addressLine: patient.address_line,
    recordNumber: patient.record_number,
    emergencyContactName: patient.emergency_contact_name,
    emergencyContactPhone: patient.emergency_contact_phone,
  };
  await db.sql`
    UPDATE public.bookings
    SET status = 'submitted', profile_snapshot = ${snap}, submitted_at = now(),
      version = version + 1, updated_at = now()
    WHERE id = ${booking.id}
  `;
  return { ...booking, status: "submitted", profile_snapshot: snap };
}

async function accept(booking: BookingRow, slotId = booking.slot_id, versionId = booking.availability_version_id) {
  let reservedUntil = booking.reserved_until;
  if (slotId) {
    const [version] = await db.sql`SELECT buffer_minutes FROM public.nurse_availability_versions WHERE id = ${versionId}`;
    reservedUntil = new Date(booking.ends_at.getTime() + version.buffer_minutes * 60_000);
  }
  await db.sql.begin(async (tx) => {
    await tx`
      UPDATE public.bookings
      SET status = 'accepted', decided_at = now(), decision_by = (SELECT account_id FROM public.staff WHERE id = ${booking.nurse_id}),
        decision_reason = 'Synthetic acceptance', slot_id = ${slotId}, availability_version_id = ${versionId}, reserved_until = ${reservedUntil},
        version = version + 1, updated_at = now()
      WHERE id = ${booking.id}
    `;
    await tx`
      INSERT INTO public.visits (id, booking_id, patient_id, nurse_id, starts_at, ends_at, version, updated_at)
      VALUES (${randomUUID()}, ${booking.id}, ${booking.patient_id}, ${booking.nurse_id}, ${booking.starts_at}, ${booking.ends_at}, 0, now())
    `;
  });
  return (await db.sql`SELECT * FROM public.bookings WHERE id = ${booking.id}`)[0] as unknown as BookingRow;
}

integration("Stop4 schema integrity (real PostgreSQL)", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("stop4_schema");
    identities = {
      patient: await patientFixture(),
      otherPatient: await patientFixture(),
      nurse: await nurseFixture(),
      otherNurse: await nurseFixture(),
    };
  }, 90_000);
  beforeEach(async () => {
    identities = {
      patient: await patientFixture(),
      otherPatient: await patientFixture(),
      nurse: await nurseFixture(),
      otherNurse: await nurseFixture(),
    };
  });
  afterAll(async () => { await db?.close(); }, 30_000);

  test("availability versions, windows and timestamped slots are immutable", async () => {
    const availability = await availabilityFixture(9);
    await expect(Promise.resolve(db.sql`UPDATE public.nurse_availability_versions SET windows = '[]' WHERE id = ${availability.versionId}`)).rejects.toMatchObject({ errno: "55000" });
    await expect(Promise.resolve(db.sql`UPDATE public.nurse_availability_slots SET starts_at = now() WHERE id = ${availability.slotId}`)).rejects.toMatchObject({ errno: "55000" });
    await expect(Promise.resolve(db.sql`DELETE FROM public.nurse_availability_versions WHERE id = ${availability.versionId}`)).rejects.toMatchObject({ errno: "55000" });
    await expect(Promise.resolve(db.sql`DELETE FROM public.nurse_availability_slots WHERE id = ${availability.slotId}`)).rejects.toMatchObject({ errno: "55000" });
    expect((await db.sql`SELECT count(*)::int AS count FROM public.nurse_availability_slots WHERE availability_version_id = ${availability.versionId}`)[0].count).toBe(1);
  });

  test("invalid windows, local alignment, duration and exact duplicate overlap are rejected", async () => {
    await expect(Promise.resolve(db.sql`
      INSERT INTO public.nurse_availability_versions (
        id, nurse_id, version, time_zone, slot_minutes, buffer_minutes,
        effective_from, effective_to, windows, created_by
      ) VALUES (
        ${randomUUID()}, ${identities.nurse.id}, 99, 'Not/AZone', 60, 0,
        ${new Date(Date.UTC(2099, 0, 4))}, ${new Date(Date.UTC(2099, 1, 1))}, '[]', ${identities.nurse.accountId}
      )
    `)).rejects.toMatchObject({ errno: "22023" });
    const a = await availabilityFixture(10);
    await expect(Promise.resolve(db.sql`
      INSERT INTO public.nurse_availability_slots (id, availability_version_id, nurse_id, starts_at, ends_at)
      VALUES (${randomUUID()}, ${a.versionId}, ${identities.nurse.id}, ${a.startsAt}, ${a.endsAt})
    `)).rejects.toMatchObject({ errno: "23505" });
    await expect(Promise.resolve(db.sql`
      INSERT INTO public.nurse_availability_slots (id, availability_version_id, nurse_id, starts_at, ends_at)
      VALUES (${randomUUID()}, ${a.versionId}, ${identities.nurse.id}, ${new Date(a.startsAt.getTime() + 30 * 60_000)}, ${new Date(a.endsAt.getTime() + 30 * 60_000)})
    `)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`
      INSERT INTO public.nurse_availability_slots (id, availability_version_id, nurse_id, starts_at, ends_at)
      VALUES (${randomUUID()}, ${a.versionId}, ${identities.nurse.id}, ${new Date(a.startsAt.getTime() + 15 * 60_000)}, ${new Date(a.endsAt.getTime() + 15 * 60_000)})
    `)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`
      INSERT INTO public.nurse_availability_slots (id, availability_version_id, nurse_id, starts_at, ends_at)
      VALUES (${randomUUID()}, ${a.versionId}, ${identities.nurse.id}, ${new Date(a.startsAt.getTime() + 30 * 60_000)}, ${new Date(a.endsAt.getTime() + 90 * 60_000)})
    `)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`
      INSERT INTO public.nurse_availability_slots (id, availability_version_id, nurse_id, starts_at, ends_at)
      VALUES (${randomUUID()}, ${a.versionId}, ${identities.nurse.id}, ${new Date(Date.UTC(2099, 0, 5, 0))}, ${new Date(Date.UTC(2099, 0, 5, 1))})
    `)).rejects.toMatchObject({ errno: "23514" });
  });

  test("submitted requests may share a slot, but accepted nurse and patient exclusions are real", async () => {
    const first = await draftFixture();
    const second = await draftFixture({ slotId: first.slot_id, patientId: identities.otherPatient.id });
    const patientOverlap = await outOfHoursDraft({
      nurseId: identities.otherNurse.id, startsAt: first.starts_at, endsAt: first.ends_at,
    });
    await approve(patientOverlap);
    await submit(patientOverlap);
    const firstSubmitted = await submit(first);
    await submit(second);
    await accept(firstSubmitted);
    await expect(accept(second)).rejects.toMatchObject({ errno: "23P01" });
    await expect(accept(patientOverlap)).rejects.toMatchObject({ errno: "23P01" });

    const independent = await outOfHoursDraft({
      nurseId: identities.otherNurse.id, patientId: identities.otherPatient.id,
      startsAt: new Date(Date.UTC(2099, 0, 5, 6)),
      endsAt: new Date(Date.UTC(2099, 0, 5, 7)),
    });
    await approve(independent);
    expect((await submit(independent)).status).toBe("submitted");
    await accept(independent);
  });

  test("buffered nurse intervals reject overlap while patient uses the raw interval", async () => {
    const buffered = await availabilityFixture(9, 30);
    const original = await submit(await draftFixture({ slotId: buffered.slotId }));
    const rawStartsAt = new Date(Date.UTC(2099, 0, 5, 3));
    const rawEndsAt = new Date(Date.UTC(2099, 0, 5, 4));
    const adjacentForPatient = await outOfHoursDraft({
      nurseId: identities.otherNurse.id,
      startsAt: rawStartsAt,
      endsAt: rawEndsAt,
    });
    const bufferConflict = await outOfHoursDraft({
      patientId: identities.otherPatient.id,
      startsAt: rawStartsAt,
      endsAt: rawEndsAt,
    });
    expect(adjacentForPatient.patient_id).toBe(original.patient_id);
    expect(adjacentForPatient.nurse_id).toBe(identities.otherNurse.id);
    expect(bufferConflict.nurse_id).toBe(original.nurse_id);
    expect(bufferConflict.patient_id).toBe(identities.otherPatient.id);
    await approve(adjacentForPatient);
    await approve(bufferConflict);
    await submit(adjacentForPatient);
    await submit(bufferConflict);

    const accepted = await accept(original);
    expect(accepted.reserved_until).toEqual(buffered.reservedUntil);
    const patientAccepted = await accept(adjacentForPatient);
    expect(patientAccepted.status).toBe("accepted");
    expect(patientAccepted.starts_at).toEqual(accepted.ends_at);
    await expect(accept(bufferConflict)).rejects.toMatchObject({ errno: "23P01" });
  });

  test("state guards freeze submitted intake and require version, reason and actual visit", async () => {
    const draft = await draftFixture();
    const submitted = await submit(draft);
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET intake = ${intake(false)}, version = version + 1 WHERE id = ${draft.id}`)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET starts_at = starts_at + interval '1 hour' WHERE id = ${draft.id}`)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET status = 'cancelled', cancelled_at = now(), version = version + 1, updated_at = now() WHERE id = ${draft.id}`)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`DELETE FROM public.bookings WHERE id = ${draft.id}`)).rejects.toMatchObject({ errno: "55000" });
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET nurse_id = ${identities.otherNurse.id}, version = version + 1 WHERE id = ${submitted.id}`)).rejects.toMatchObject({ errno: "23514" });
    const accepted = await accept(submitted);
    const [originalSnapshot] = await db.sql`
      SELECT profile_snapshot, submitted_at, decided_at, decision_by, decision_reason
      FROM public.bookings WHERE id = ${accepted.id}
    `;
    expect(originalSnapshot.decision_reason).toBe("Synthetic acceptance");
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET intake = ${intake(false)}, version = version + 1 WHERE id = ${accepted.id}`)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET nurse_id = ${identities.otherNurse.id}, version = version + 1 WHERE id = ${accepted.id}`)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`UPDATE public.bookings SET decision_reason = 'Rewritten acceptance', version = version + 1 WHERE id = ${accepted.id}`)).rejects.toMatchObject({ errno: "23514" });
    await db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id) VALUES (${accepted.nurse_id}, ${accepted.patient_id}, 'request_intake', ${accepted.id})`;
    const [visit] = await db.sql`SELECT id, version FROM public.visits WHERE booking_id = ${accepted.id}`;
    expect(visit.version).toBe(0);
    await db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id) VALUES (${accepted.nurse_id}, ${accepted.patient_id}, 'visit', ${visit.id})`;
    await db.sql.begin(async (tx) => {
      await tx`
        INSERT INTO public.booking_events (booking_id, actor_account_id, action, version, reason)
        VALUES (${accepted.id}, ${identities.nurse.accountId}, 'accepted', ${accepted.version}, 'Synthetic acceptance')
      `;
      await tx`
        UPDATE public.bookings
        SET status = 'cancelled', cancelled_at = now(), decision_reason = 'Synthetic cancellation',
          version = version + 1, updated_at = now()
        WHERE id = ${accepted.id}
      `;
      await tx`
        INSERT INTO public.booking_events (booking_id, actor_account_id, action, version, reason)
        VALUES (${accepted.id}, ${identities.nurse.accountId}, 'cancelled', ${accepted.version + 1}, 'Synthetic cancellation')
      `;
      await tx`UPDATE public.visits SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = ${visit.id}`;
      await tx`UPDATE public.patient_access_grants SET revoked_at = now() WHERE (source_booking_id = ${accepted.id} OR source_visit_id = ${visit.id}) AND revoked_at IS NULL`;
    });
    const [cancelled] = await db.sql`
      SELECT status, profile_snapshot, submitted_at, decided_at, decision_by, decision_reason
      FROM public.bookings WHERE id = ${accepted.id}
    `;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.decision_reason).toBe("Synthetic cancellation");
    expect(cancelled.profile_snapshot).toEqual(originalSnapshot.profile_snapshot);
    expect(cancelled.submitted_at).toEqual(originalSnapshot.submitted_at);
    expect(cancelled.decided_at).toEqual(originalSnapshot.decided_at);
    expect(cancelled.decision_by).toEqual(originalSnapshot.decision_by);
    const events = await db.sql`
      SELECT action, version, reason FROM public.booking_events
      WHERE booking_id = ${accepted.id} AND action IN ('accepted', 'cancelled')
      ORDER BY version
    `;
    expect(events).toEqual([
      { action: "accepted", version: accepted.version, reason: "Synthetic acceptance" },
      { action: "cancelled", version: accepted.version + 1, reason: "Synthetic cancellation" },
    ]);
    expect((await db.sql`SELECT status, version FROM public.visits WHERE id = ${visit.id}`)[0]).toMatchObject({ status: "cancelled", version: 1 });
    expect((await db.sql`SELECT count(*)::int AS count FROM public.patient_access_grants WHERE (source_booking_id = ${accepted.id} OR source_visit_id = ${visit.id}) AND revoked_at IS NULL`)[0].count).toBe(0);
  });

  test("edited drafts accept with independent visit versions and atomic reschedule/cancel", async () => {
    const draft = await draftFixture();
    for (let index = 0; index < 3; index += 1) {
      await db.sql`
        UPDATE public.bookings
        SET intake = ${{ ...intake(), otherComplaint: `Edited complaint ${index + 1}`, note: `Edited note ${index + 1}` }},
          version = version + 1, updated_at = now()
        WHERE id = ${draft.id}
      `;
    }
    const accepted = await accept(await submit({ ...draft, status: "draft" }));
    expect(accepted.version).toBe(5);
    const [edited] = await db.sql`SELECT intake FROM public.bookings WHERE id = ${accepted.id}`;
    expect(edited.intake).toMatchObject({ otherComplaint: "Edited complaint 3", note: "Edited note 3", consent: true });
    const [visit] = await db.sql`SELECT id, version FROM public.visits WHERE booking_id = ${accepted.id}`;
    expect(visit.version).toBe(0);

    const startsAt = new Date(Date.UTC(2099, 0, 7, 2));
    const endsAt = new Date(Date.UTC(2099, 0, 7, 3));
    const priorityRequestId = await approve(accepted, { startsAt, endsAt });
    await db.sql.begin(async (tx) => {
      await tx`
        UPDATE public.bookings SET slot_id = NULL, availability_version_id = NULL,
          starts_at = ${startsAt}, ends_at = ${endsAt}, reserved_until = ${endsAt},
          version = version + 1, updated_at = now() WHERE id = ${accepted.id}
      `;
      await tx`
        INSERT INTO public.booking_events (id, booking_id, actor_account_id, action, version, reason, data)
        VALUES (
          ${randomUUID()}, ${accepted.id}, ${identities.nurse.accountId}, 'booking.rescheduled',
          ${accepted.version + 1}, 'Synthetic reschedule with patient agreement: patientAgreed=true',
          (${JSON.stringify({
            previousStartsAt: accepted.starts_at.toISOString(),
            previousEndsAt: accepted.ends_at.toISOString(),
            previousReservedUntil: accepted.reserved_until.toISOString(),
            previousSlotId: accepted.slot_id,
            previousAvailabilityVersionId: accepted.availability_version_id,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            reservedUntil: endsAt.toISOString(),
            slotId: null,
            availabilityVersionId: null,
            priorityRequestId,
            previousVersion: accepted.version,
            version: accepted.version + 1,
            patientAgreed: true,
          })}::text)::jsonb
        )
      `;
      await tx`
        UPDATE public.visits SET starts_at = ${startsAt}, ends_at = ${endsAt}, version = version + 1, updated_at = now()
        WHERE id = ${visit.id}
      `;
    });
    const [rescheduled] = await db.sql`
      SELECT slot_id, availability_version_id, starts_at, ends_at, reserved_until, version,
        nurse_id, patient_id, decision_reason, decision_by, decided_at, profile_snapshot
      FROM public.bookings WHERE id = ${accepted.id}
    `;
    expect(rescheduled).toMatchObject({
      slot_id: null,
      availability_version_id: null,
      starts_at: startsAt,
      ends_at: endsAt,
      reserved_until: endsAt,
      version: 6,
      nurse_id: accepted.nurse_id,
      patient_id: accepted.patient_id,
      decision_reason: "Synthetic acceptance",
    });
    const [rescheduleEvidence] = await db.sql`
      SELECT version, reason, data FROM public.booking_events
      WHERE booking_id = ${accepted.id} AND version = 6 AND action = 'booking.rescheduled'
    `;
    expect(rescheduleEvidence.version).toBe(6);
    expect(rescheduleEvidence.reason).toContain("patientAgreed=true");
    expect(rescheduleEvidence.data).toMatchObject({
      previousStartsAt: accepted.starts_at.toISOString(),
      previousEndsAt: accepted.ends_at.toISOString(),
      previousReservedUntil: accepted.reserved_until.toISOString(),
      previousSlotId: accepted.slot_id,
      previousAvailabilityVersionId: accepted.availability_version_id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reservedUntil: endsAt.toISOString(),
      slotId: null,
      availabilityVersionId: null,
      priorityRequestId,
      previousVersion: 5,
      version: 6,
      patientAgreed: true,
    });
    expect((await db.sql`SELECT status, starts_at, ends_at, version FROM public.visits WHERE id = ${visit.id}`)[0]).toMatchObject({ status: "scheduled", starts_at: startsAt, ends_at: endsAt, version: 1 });

    await db.sql.begin(async (tx) => {
      await tx`
        UPDATE public.bookings SET status = 'cancelled', cancelled_at = now(), decision_reason = 'Synthetic cancellation',
          version = version + 1, updated_at = now() WHERE id = ${accepted.id}
      `;
      await tx`UPDATE public.visits SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = ${visit.id}`;
    });
    expect((await db.sql`SELECT status, version FROM public.bookings WHERE id = ${accepted.id}`)[0]).toMatchObject({ status: "cancelled", version: 7 });
    expect((await db.sql`SELECT status, version FROM public.visits WHERE id = ${visit.id}`)[0]).toMatchObject({ status: "cancelled", version: 2 });
  });

  test("active requests are capped and accepted reschedules require reasoned evidence", async () => {
    const accepted = await accept(await submit(await draftFixture()));
    const acceptedAt = new Date(Date.UTC(2099, 0, 7, 2));
    const acceptedEnd = new Date(Date.UTC(2099, 0, 7, 3));
    await approve(accepted, { startsAt: acceptedAt, endsAt: acceptedEnd });
    await expect(Promise.resolve(db.sql`
      UPDATE public.bookings SET slot_id = NULL, availability_version_id = NULL,
        starts_at = ${acceptedAt}, ends_at = ${acceptedEnd}, reserved_until = ${acceptedEnd},
        version = version + 1, updated_at = now()
      WHERE id = ${accepted.id}
    `)).rejects.toMatchObject({ errno: "23514" });
    const [unchanged] = await db.sql`
      SELECT slot_id, availability_version_id, starts_at, ends_at, reserved_until, status, version
      FROM public.bookings WHERE id = ${accepted.id}
    `;
    expect(unchanged).toMatchObject({
      slot_id: accepted.slot_id,
      availability_version_id: accepted.availability_version_id,
      starts_at: accepted.starts_at,
      ends_at: accepted.ends_at,
      reserved_until: accepted.reserved_until,
      status: "accepted",
      version: accepted.version,
    });
    for (let index = 0; index < 2; index += 1) {
      const next = await outOfHoursDraft({
        nurseId: identities.otherNurse.id,
        startsAt: new Date(Date.UTC(2099, 0, 10 + index, 2)),
        endsAt: new Date(Date.UTC(2099, 0, 10 + index, 3)),
      });
      await approve(next);
      await submit(next);
    }
    const fourth = await outOfHoursDraft({
      nurseId: identities.otherNurse.id,
      startsAt: new Date(Date.UTC(2099, 0, 12, 2)),
      endsAt: new Date(Date.UTC(2099, 0, 12, 3)),
    });
    await approve(fourth);
    await expect(submit(fourth)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`
      UPDATE public.priority_requests SET statement = '  uncanonical  '
      WHERE booking_id = ${fourth.id}
    `)).rejects.toMatchObject({ errno: "23514" });
  });

  test("patient contact edits cannot invalidate an already frozen acceptance snapshot", async () => {
    const submitted = await submit(await draftFixture());
    const [original] = await db.sql`SELECT profile_snapshot FROM public.bookings WHERE id = ${submitted.id}`;
    await db.sql`
      UPDATE public.patients
      SET phone = '+6281234567890', address_line = 'Edited synthetic address',
        emergency_contact_phone = '+6281234567891', version = version + 1, updated_at = now()
      WHERE id = ${submitted.patient_id}
    `;
    const accepted = await accept(submitted);
    expect(accepted.status).toBe("accepted");
    const [frozen] = await db.sql`SELECT profile_snapshot FROM public.bookings WHERE id = ${accepted.id}`;
    expect(frozen.profile_snapshot).toEqual(original.profile_snapshot);
    expect(frozen.profile_snapshot).toMatchObject({ phone: "+620000", addressLine: "Synthetic address" });
  });

  test("booking history and priorities are reasoned, append-only and immutable", async () => {
    const draft = await draftFixture();
    const [event] = await db.sql`
      INSERT INTO public.booking_events (id, booking_id, actor_account_id, action, version, data)
      VALUES (${randomUUID()}, ${draft.id}, ${identities.patient.accountId}, 'created', 0, '{"version":0}')
      RETURNING id
    `;
    await expect(Promise.resolve(db.sql`UPDATE public.booking_events SET data = '{}' WHERE id = ${event.id}`)).rejects.toMatchObject({ errno: "55000" });
    await expect(Promise.resolve(db.sql`DELETE FROM public.booking_events WHERE id = ${event.id}`)).rejects.toMatchObject({ errno: "55000" });
    const requestId = randomUUID();
    await db.sql`INSERT INTO public.priority_requests (id, booking_id, patient_id, nurse_id, starts_at, ends_at, statement) VALUES (${requestId}, ${draft.id}, ${draft.patient_id}, ${draft.nurse_id}, ${draft.starts_at}, ${draft.ends_at}, 'Synthetic request')`;
    await expect(Promise.resolve(db.sql`UPDATE public.priority_requests SET statement = 'Rewritten', version = 1 WHERE id = ${requestId}`)).rejects.toMatchObject({ errno: "23514" });
    await expect(Promise.resolve(db.sql`UPDATE public.priority_requests SET status = 'availability_accepted', reason = 'Allowed', reviewed_by = ${identities.nurse.accountId}, reviewed_at = now(), version = 1 WHERE id = ${requestId}`)).resolves.toBeDefined();
    const exceptionId = randomUUID();
    await db.sql`INSERT INTO public.schedule_exceptions (id, priority_request_id, booking_id, nurse_id, starts_at, ends_at, approved_by, reason) VALUES (${exceptionId}, ${requestId}, ${draft.id}, ${draft.nurse_id}, ${draft.starts_at}, ${draft.ends_at}, ${identities.nurse.accountId}, 'Allowed')`;
    await expect(Promise.resolve(db.sql`UPDATE public.schedule_exceptions SET ends_at = ends_at + interval '1 hour' WHERE id = ${exceptionId}`)).rejects.toMatchObject({ errno: "55000" });
    await expect(Promise.resolve(db.sql`DELETE FROM public.schedule_exceptions WHERE id = ${exceptionId}`)).rejects.toMatchObject({ errno: "55000" });
    const after = await submit(draft);
    expect(after.status).toBe("submitted");
  });

  test("earlier human exception approvals do not reserve competing acceptance targets", async () => {
    const startsAt = new Date(Date.UTC(2099, 0, 5, 6));
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const first = await outOfHoursDraft({ startsAt, endsAt });
    const second = await outOfHoursDraft({ patientId: identities.otherPatient.id, startsAt, endsAt });
    await approve(first);
    await approve(second);
    await submit(first);
    await submit(second);
    await accept(first);
    await expect(accept(second)).rejects.toMatchObject({ errno: "23P01" });
    const [secondState] = await db.sql`SELECT status FROM public.bookings WHERE id = ${second.id}`;
    expect(secondState.status).toBe("submitted");
    expect((await db.sql`SELECT count(*)::int AS count FROM public.visits WHERE booking_id = ${second.id}`)[0].count).toBe(0);
  });

  test("grant sources require real booking and visit rows", async () => {
    const submitted = await submit(await draftFixture());
    await expect(Promise.resolve(db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id) VALUES (${identities.nurse.id}, ${submitted.patient_id}, 'request_intake', ${randomUUID()})`)).rejects.toMatchObject({ errno: "23503" });
    await expect(Promise.resolve(db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id) VALUES (${identities.nurse.id}, ${submitted.patient_id}, 'visit', ${randomUUID()})`)).rejects.toMatchObject({ errno: "23503" });
    await db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id) VALUES (${identities.nurse.id}, ${submitted.patient_id}, 'request_intake', ${submitted.id})`;
    const accepted = await accept(submitted);
    const [visit] = await db.sql`SELECT id FROM public.visits WHERE booking_id = ${accepted.id}`;
    await db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id) VALUES (${identities.nurse.id}, ${accepted.patient_id}, 'visit', ${visit.id})`;
    await expect(Promise.resolve(db.sql`INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id) VALUES (${identities.nurse.id}, ${identities.otherPatient.id}, 'request_intake', ${accepted.id})`)).rejects.toMatchObject({ errno: "23503" });
  });
});
