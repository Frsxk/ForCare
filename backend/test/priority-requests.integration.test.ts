import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { hashPassword } from "../src/auth/password";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request } from "./fixtures/test-app";

const integration = process.env.FORCARE_TEST_DATABASE_URL?.trim() ? describe : describe.skip;
const NURSE_PASSWORD = "test-nurse-password-long";
const SCHEDULE_BASE_MS = Date.now();

type Actor = { cookie: string; csrf: string; id: string };
type App = { handle(request: Request): Promise<Response> | Response };
type Context = { app: App };
type Priority = {
  id: string;
  bookingId: string;
  patientId: string;
  nurseId: string;
  startsAt: string;
  endsAt: string;
  statement: string;
  status: string;
  reason: string | null;
  version: number;
  patient?: { displayName: string; recordNumber: string | null };
};

let db: DisposableDatabase;

function body(response: Response): Promise<any> {
  return response.json();
}

async function registerPatient(app: Context["app"], label: string, ip: string, complete = true): Promise<Actor> {
  const response = await app.handle(
    jsonRequest(
      "/api/v1/auth/register",
      "POST",
      { fullName: label, birthDate: "1990-01-01", gender: "female", phone: "+62123456789", email: `${label}@patient.invalid`, password: "patient-password-long" },
      { "user-agent": `test/${ip}` },
    ),
  );
  expect(response.status).toBe(201);
  const payload = await body(response);
  if (complete) {
    const profileResponse = await app.handle(request("/api/v1/me/profile", "GET", { cookie: cookieFrom(response) }));
    expect(profileResponse.status).toBe(200);
    const profile = (await body(profileResponse)).data;
    const updated = await app.handle(
    jsonRequest(
      "/api/v1/me/profile",
      "PATCH",
      {
        expectedVersion: profile.version,
        phone: "+62123456789",
        addressLine: "Test address",
      },
      {
        cookie: cookieFrom(response),
        "x-csrf-token": payload.data.session.csrfToken,
        "idempotency-key": `profile-${label}`.padEnd(32, "_"),
      },
    ),
    );
    expect(updated.status).toBe(200);
  }
  return { cookie: cookieFrom(response), csrf: payload.data.session.csrfToken, id: payload.data.patientProfile.id };
}

async function provisionNurse(label: string): Promise<Actor> {
  const result = await db.sql.begin(async (tx) =>
    provisionNurseInTransaction(tx, {
      email: `${label}@nurse.invalid`,
      passwordHash: await hashPassword(NURSE_PASSWORD),
      staffCode: label.toUpperCase(),
      displayName: `Nurse ${label}`,
      approvalReference: `approval-${label}`,
      operator: "priority-integration",
      nurseDomain: "nurse.invalid",
    }),
  );
  return { cookie: "", csrf: "", id: result.staffId };
}

async function nurseLogin(app: Context["app"], label: string, staffId: string): Promise<Actor> {
  const response = await app.handle(
    jsonRequest("/api/v1/auth/login", "POST", {
      email: `${label}@nurse.invalid`,
      password: NURSE_PASSWORD,
    }),
  );
  expect(response.status).toBe(200);
  const payload = await body(response);
  return { cookie: cookieFrom(response), csrf: payload.data.session.csrfToken, id: staffId };
}

function post(app: Context["app"], path: string, actor: Actor, key: string, payload: unknown) {
  return app.handle(
    jsonRequest(path, "POST", payload, {
      cookie: actor.cookie,
      "x-csrf-token": actor.csrf,
      "idempotency-key": key.padEnd(32, "_"),
    }),
  );
}

function get(app: Context["app"], path: string, actor: Actor) {
  return app.handle(request(path, "GET", { cookie: actor.cookie }));
}

async function availability(
  sql: SQL,
  nurseId: string,
  startsAt: string,
  endsAt: string,
): Promise<void> {
  const effectiveFrom = new Date(Date.now() + 60_000);
  const effectiveTo = new Date(Date.now() + 8 * 24 * 60 * 60_000);
  const windows = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1, startMinute: 0, endMinute: 1440,
  }));
  await sql`
    WITH version AS (
      INSERT INTO public.nurse_availability_versions (
        nurse_id, version, time_zone, effective_from, effective_to, slot_minutes, buffer_minutes, windows, created_by
      )
      SELECT ${nurseId}, 1, 'UTC', ${effectiveFrom}, ${effectiveTo}, 60, 0, (${JSON.stringify(windows)}::text)::jsonb, s.account_id
      FROM public.staff s WHERE s.id = ${nurseId}
      RETURNING id
    )
    INSERT INTO public.nurse_availability_slots (availability_version_id, nurse_id, starts_at, ends_at)
    SELECT v.id, ${nurseId}, times.starts_at, times.ends_at
    FROM version v
    LEFT JOIN LATERAL (VALUES
      (${startsAt}::timestamptz, ${endsAt}::timestamptz),
      ((${startsAt}::timestamptz + interval '2 hours'), (${endsAt}::timestamptz + interval '2 hours')),
      ((${startsAt}::timestamptz + interval '4 hours'), (${endsAt}::timestamptz + interval '4 hours')),
      ((${startsAt}::timestamptz + interval '6 hours'), (${endsAt}::timestamptz + interval '6 hours')),
      ((${startsAt}::timestamptz + interval '8 hours'), (${endsAt}::timestamptz + interval '8 hours'))
    ) AS times(starts_at, ends_at) ON true
    WHERE times.starts_at IS NOT NULL
  `;
}

function intakeFor(consent = true) {
  return {
    complaint: "Additional private complaint", otherComplaint: null,
    history: "private history which is not a priority input",
    consciousness: "alert", conditions: ["pale"], observations: [],
    note: null, consent,
  };
}

async function draft(
  app: Context["app"],
  patient: Actor,
  nurseId: string,
  startsAt: string,
  endsAt: string,
  key: string,
  slot = true,
): Promise<any> {
  const slotId = slot
    ? ((await db.sql`
        SELECT s.id FROM public.nurse_availability_slots s
        WHERE s.nurse_id = ${nurseId} AND s.starts_at = ${startsAt}::timestamptz
      `) as unknown as Array<{ id: string }>)[0].id
    : null;
  const response = await post(app, "/api/v1/me/bookings", patient, key, {
    nurseId,
    slotId,
    startsAt,
    endsAt,
    intake: intakeFor(!key.startsWith("incomplete")),
  });
  expect(response.status).toBe(201);
  return (await body(response)).data;
}

async function priority(
  app: Context["app"],
  patient: Actor,
  bookingId: string,
  startsAt: string | undefined,
  endsAt: string | undefined,
  key: string,
): Promise<Priority> {
  const response = await post(app, "/api/v1/me/priority-requests", patient, key, {
    bookingId,
    statement: "Please review this exact requested interval.",
    startsAt,
    endsAt,
  });
  expect(response.status).toBe(201);
  return (await body(response)).data;
}

async function review(
  app: Context["app"],
  nurse: Actor,
  requestId: string,
  key: string,
  decision: "accept_availability" | "decline",
  expectedVersion = 0,
) {
  return post(app, `/api/v1/priority-requests/${requestId}/review`, nurse, key, {
    expectedVersion,
    decision,
    reason: decision === "accept_availability" ? "Nurse confirms exception availability." : "Nurse declines request.",
    available: decision === "accept_availability",
  });
}

function later(hours: number): { startsAt: string; endsAt: string } {
  const start = new Date(SCHEDULE_BASE_MS + hours * 60 * 60_000);
  start.setUTCMinutes(0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 60 * 60_000).toISOString() };
}

integration("priority request independent review", () => {
  let app: Context["app"];
  let patient: Actor;
  let otherPatient: Actor;
  let nurse: Actor;
  let unrelatedNurse: Actor;

  beforeAll(async () => {
    db = await createDisposableDatabase("priority-requests");
    app = createTestApp(db.sql).app;
    patient = await registerPatient(app, "priority-patient", "101");
    otherPatient = await registerPatient(app, "priority-other", "102");
    const selected = await provisionNurse("priority-nurse");
    const unrelated = await provisionNurse("priority-unrelated");
    nurse = await nurseLogin(app, "priority-nurse", selected.id);
    unrelatedNurse = await nurseLogin(app, "priority-unrelated", unrelated.id);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  test("review rejection, approval exception, and separate submit/accept", async () => {
    const normal = later(24);
    await availability(db.sql, nurse.id, normal.startsAt, normal.endsAt);
    const normalDraft = await draft(app, patient, nurse.id, normal.startsAt, normal.endsAt, "normal-draft");
    const normalRequest = await priority(
      app,
      patient,
      normalDraft.id,
      undefined,
      undefined,
      "normal-priority",
    );
    expect(normalRequest.status).toBe("pending");
    const normalAccepted = await review(app, nurse, normalRequest.id, "normal-accept", "accept_availability");
    expect(normalAccepted.status).toBe(200);
    expect((await body(normalAccepted)).data.status).toBe("availability_accepted");

    const o = later(73);
    const oohDraft = await draft(app, patient, nurse.id, o.startsAt, o.endsAt, "ooh-draft", false);
    const created = await priority(app, patient, oohDraft.id, undefined, undefined, "ooh-priority");
    expect(created).toMatchObject({
      bookingId: oohDraft.id,
      nurseId: nurse.id,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      status: "pending",
      version: 0,
      statement: "Please review this exact requested interval.",
    });
    expect("patient" in created).toBe(false);
    expect("intake" in created).toBe(false);

    const rejected = await post(app, "/api/v1/me/priority-requests", patient, "ooh-invalid", {
      bookingId: oohDraft.id,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      statement: "draft cannot choose an independent interval",
    });
    expect(rejected.status).toBe(422);
    const noHours = await post(app, "/api/v1/me/bookings", otherPatient, "no-hours-draft", {
      nurseId: unrelatedNurse.id, slotId: null,
      startsAt: new Date(new Date(o.startsAt).getTime() + 10 * 60 * 60_000).toISOString(),
      endsAt: new Date(new Date(o.endsAt).getTime() + 10 * 60 * 60_000).toISOString(),
      intake: intakeFor(),
    });
    expect(noHours.status).toBe(422);

    const nurseList = await body(await get(app, "/api/v1/priority-requests", nurse));
    const projection = nurseList.data.items.find((item: Priority) => item.id === created.id) as Priority;
    expect(projection.patient).toEqual({ displayName: "priority-patient", recordNumber: null });
    expect(JSON.stringify(projection)).not.toContain("private history");
    expect(JSON.stringify(projection)).not.toContain("intake");
    expect((await get(app, `/api/v1/priority-requests/${created.id}`, unrelatedNurse)).status).toBe(404);
    expect((await get(app, "/api/v1/me/priority-requests", nurse)).status).toBe(403);
    expect((await get(app, `/api/v1/me/priority-requests/${created.id}`, otherPatient)).status).toBe(404);
    expect((await review(app, unrelatedNurse, created.id, "foreign-review", "accept_availability")).status).toBe(404);
    expect((await post(app, `/api/v1/priority-requests/${created.id}/review`, nurse, "bad-decision", {
      expectedVersion: 0,
      decision: "accept_availability",
      available: false,
      reason: "acceptance requires explicit availability",
    })).status).toBe(422);
    expect((await review(app, nurse, created.id, "stale", "accept_availability", 1)).status).toBe(409);
    expect((await post(app, `/api/v1/priority-requests/${created.id}/review`, nurse, "missing-reason", {
      expectedVersion: 0,
      decision: "decline",
      available: false,
      reason: "",
    })).status).toBe(422);

    expect((await get(app, `/api/v1/me/bookings/${oohDraft.id}`, patient)).status).toBe(200);
    const before = await db.sql`SELECT status, version, submitted_at FROM public.bookings WHERE id = ${oohDraft.id}`;
    expect(before[0]).toMatchObject({ status: "draft", version: 0, submitted_at: null });
    expect((await post(app, `/api/v1/me/bookings/${oohDraft.id}/submit`, patient, "preapproval-submit", {
      expectedVersion: 0,
    })).status).toBe(422);

    const accepted = await review(app, nurse, created.id, "approve-ooh", "accept_availability");
    expect(accepted.status).toBe(200);
    expect((await body(accepted)).data).toMatchObject({ status: "availability_accepted", version: 1 });
    const replay = await review(app, nurse, created.id, "approve-ooh", "accept_availability");
    expect(replay.status).toBe(200);
    expect((await body(replay)).data).toMatchObject({ status: "availability_accepted", version: 1 });
    expect((await review(app, nurse, created.id, "conflicting-replay", "decline")).status).toBe(409);
    expect((await review(app, nurse, created.id, "one-decision", "decline", 1)).status).toBe(409);
    const afterReview = await db.sql`SELECT status, version, submitted_at, decided_at FROM public.bookings WHERE id = ${oohDraft.id}`;
    expect(afterReview[0]).toMatchObject({ status: "draft", version: 0, submitted_at: null, decided_at: null });
    const exception = await db.sql`
      SELECT booking_id, nurse_id, starts_at, ends_at, approved_by
      FROM public.schedule_exceptions WHERE priority_request_id = ${created.id}
    `;
    expect(exception).toEqual([{
      booking_id: oohDraft.id,
      nurse_id: nurse.id,
      starts_at: new Date(o.startsAt),
      ends_at: new Date(o.endsAt),
      approved_by: (await db.sql`SELECT account_id FROM public.staff WHERE id = ${nurse.id}`)[0].account_id,
    }]);

    const beforeSubmitAccept = await post(app, `/api/v1/bookings/${oohDraft.id}/decisions`, nurse, "premature-accept", {
      expectedVersion: 0,
      decision: "accept",
      reason: null,
    });
    expect(beforeSubmitAccept.status).toBe(404);
    const submitted = await post(app, `/api/v1/me/bookings/${oohDraft.id}/submit`, patient, "submit-ooh", {
      expectedVersion: 0,
    });
    expect(submitted.status).toBe(200);
    expect((await body(submitted)).data.status).toBe("submitted");
    const createdReplay = await post(app, "/api/v1/me/priority-requests", patient, "ooh-priority", {
      bookingId: oohDraft.id,
      statement: "Please review this exact requested interval.",
    });
    expect(createdReplay.status).toBe(201);
    expect((await body(createdReplay)).data.id).toBe(created.id);
    expect((await db.sql`SELECT count(*)::int AS count FROM public.priority_requests WHERE id = ${created.id}`)[0].count).toBe(1);
    const acceptedBooking = await post(app, `/api/v1/bookings/${oohDraft.id}/decisions`, nurse, "accept-booking", {
      expectedVersion: 1,
      decision: "accept",
      reason: null,
    });
    expect(acceptedBooking.status).toBe(200);
    expect((await body(acceptedBooking)).data.status).toBe("accepted");
    const persisted = await db.sql`
      SELECT b.status, v.id AS visit_id
      FROM public.bookings b LEFT JOIN public.visits v ON v.booking_id = b.id
      WHERE b.id = ${oohDraft.id}
    `;
    expect(persisted[0].status).toBe("accepted");
    expect(persisted[0].visit_id).toBeString();
    const audit = await db.sql`SELECT action, "after" FROM public.audit_events WHERE subject_id = ${created.id}`;
    expect(JSON.stringify(audit)).not.toContain(created.statement);
    expect(JSON.stringify(audit)).not.toContain("Nurse confirms exception availability");
  }, 60_000);

  test("declined and out-of-horizon requests cannot be submitted", async () => {
    const o = later(125);
    const booking = await draft(app, patient, nurse.id, o.startsAt, o.endsAt, "declined-draft", false);
    const declined = await priority(app, patient, booking.id, undefined, undefined, "declined-request");
    const response = await review(app, nurse, declined.id, "decline", "decline");
    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ status: "declined", version: 1 });
    expect((await db.sql`SELECT count(*)::int AS count FROM public.schedule_exceptions WHERE priority_request_id = ${declined.id}`)[0].count).toBe(0);
    expect((await post(app, `/api/v1/me/bookings/${booking.id}/submit`, patient, "declined-submit", {
      expectedVersion: 0,
    })).status).toBe(422);

    const far = later(24 * 100);
    const noHorizon = await post(app, "/api/v1/me/bookings", otherPatient, "far-draft", {
      nurseId: nurse.id, slotId: null, ...far, intake: intakeFor(),
    });
    expect(noHorizon.status).toBe(422);
  }, 60_000);

  test("accepted patient/nurse conflicts block approval without revealing competitors", async () => {
    const o = later(32);
    const acceptedDraft = await draft(app, patient, nurse.id, o.startsAt, o.endsAt, "occupied-draft");
    expect((await post(app, `/api/v1/me/bookings/${acceptedDraft.id}/submit`, patient, "occupied-submit", {
      expectedVersion: 0,
    })).status).toBe(200);
    expect((await post(app, `/api/v1/bookings/${acceptedDraft.id}/decisions`, nurse, "occupied-accept", {
      expectedVersion: 1,
      decision: "accept",
      reason: null,
    })).status).toBe(200);

    const other = await draft(app, otherPatient, nurse.id, o.startsAt, o.endsAt, "competing-draft", false);
    expect((await post(app, "/api/v1/me/priority-requests", otherPatient, "competing-request", {
      bookingId: other.id,
      statement: "conflict should not reveal another patient",
    })).status).toBe(409);
    const acceptedProposal = await post(app, "/api/v1/me/priority-requests", patient, "accepted-proposal", {
      bookingId: acceptedDraft.id,
      startsAt: new Date(new Date(o.startsAt).getTime() + 60 * 60_000).toISOString(),
      endsAt: new Date(new Date(o.endsAt).getTime() + 60 * 60_000).toISOString(),
      statement: "immutable accepted proposed target",
    });
    expect(acceptedProposal.status).toBe(201);
    const acceptedProposalBody = (await body(acceptedProposal)).data as Priority;
    expect(acceptedProposalBody.startsAt).not.toBe(o.startsAt);
    expect(acceptedProposalBody.endsAt).not.toBe(o.endsAt);
    expect((await db.sql`SELECT starts_at, ends_at, status, version FROM public.bookings WHERE id = ${acceptedDraft.id}`)[0])
      .toMatchObject({ starts_at: new Date(o.startsAt), ends_at: new Date(o.endsAt), status: "accepted", version: 2 });
    expect((await post(app, `/api/v1/bookings/${acceptedProposalBody.bookingId}/reschedule`, nurse, "no-auto-reschedule", {
      expectedVersion: 2,
      startsAt: acceptedProposalBody.startsAt,
      endsAt: acceptedProposalBody.endsAt,
      patientAgreed: false,
      reason: "not actually used",
    })).status).toBe(422);
  }, 60_000);

  test("unrelated booking IDs and incomplete profile are not usable", async () => {
    const o = later(146);
    const other = await draft(app, otherPatient, nurse.id, o.startsAt, o.endsAt, "foreign-draft", false);
    expect((await post(app, "/api/v1/me/priority-requests", patient, "foreign-id", {
      bookingId: other.id,
      statement: "cannot guess unrelated booking IDs",
    })).status).toBe(404);
    expect((await post(app, "/api/v1/me/priority-requests", patient, "invalid-id", {
      bookingId: "00000000-0000-0000-0000-000000000000",
      statement: "not found",
    })).status).toBe(404);
    const incomplete = await registerPatient(app, "priority-incomplete", "110", false);
    const incompleteBooking = await draft(app, incomplete, nurse.id, new Date(new Date(o.startsAt).getTime() + 2 * 60 * 60_000).toISOString(), new Date(new Date(o.endsAt).getTime() + 2 * 60 * 60_000).toISOString(), "incomplete-draft", false);
    expect((await post(app, "/api/v1/me/priority-requests", incomplete, "incomplete-priority", {
      bookingId: incompleteBooking.id,
      statement: "profile is only needed at booking submit",
    })).status).toBe(201);
  }, 60_000);
});
