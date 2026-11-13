import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/password";
import { createOperatorAssignmentService } from "../src/patients/operator-service";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request } from "./fixtures/test-app";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;

const PATIENT_PASSWORD = "synthetic-min8-password";
const NURSE_PASSWORD = "synthetic-nurse-password";

let db: DisposableDatabase;
let operator: ReturnType<typeof createOperatorAssignmentService>;

type Registered = { cookie: string; csrf: string; patientId: string; accountId: string };
type Nurse = { cookie: string; csrf: string; staffId: string; accountId: string; email: string };

function appFor() {
  return createTestApp(db.sql, { ip: `127.0.0.${Math.floor(Math.random() * 200) + 1}` }).app;
}

async function registerPatient(email: string, fullName = "Check-in Patient"): Promise<Registered> {
  const app = appFor();
  const response = await app.handle(
    jsonRequest("/api/v1/auth/register", "POST", {
      fullName,
      birthDate: "1991-04-12",
      gender: "female",
      email,
      phone: "+6281234567891",
      password: PATIENT_PASSWORD,
    }),
  );
  if (response.status !== 201) {
    throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as any;
  return {
    cookie: cookieFrom(response),
    csrf: body.data.session.csrfToken,
    patientId: body.data.patientProfile.id,
    accountId: body.data.account.id,
  };
}

async function provisionNurse(label: string, email: string, staffCode: string) {
  const passwordHash = await hashPassword(NURSE_PASSWORD);
  return db.sql.begin((tx) =>
    provisionNurseInTransaction(tx, {
      email,
      passwordHash,
      staffCode,
      displayName: label,
      approvalReference: `approval-${staffCode}`,
      operator: "synthetic-operator",
      nurseDomain: "nurse.invalid",
    }),
  );
}

async function setupNurse(label: string, email: string, staffCode: string): Promise<Nurse> {
  const provisioned = await provisionNurse(label, email, staffCode);
  const app = appFor();
  const response = await app.handle(
    jsonRequest("/api/v1/auth/login", "POST", { email, password: NURSE_PASSWORD }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  return {
    cookie: cookieFrom(response),
    csrf: body.data.session.csrfToken,
    staffId: provisioned.staffId,
    accountId: provisioned.accountId,
    email,
  };
}

async function assignPrimary(patient: Registered, nurse: Nurse, expectedVersion = 0) {
  return operator.assignPrimaryNurse({
    patientId: patient.patientId,
    nurseId: nurse.staffId,
    expectedVersion,
    operator: "synthetic-operator",
    approvalReference: `approval-assign-${randomUUID()}`,
  });
}

function authed(method: string, path: string, body: unknown, actor: Nurse | Registered, key?: string) {
  return jsonRequest(path, method, body, {
    cookie: actor.cookie,
    "x-csrf-token": actor.csrf,
    ...(key ? { "idempotency-key": key } : {}),
  });
}

async function createCheckIn(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Registered,
  body: Record<string, unknown>,
  key = randomUUID(),
) {
  return app.handle(authed("POST", "/api/v1/check-ins", body, actor, key));
}

async function updateCheckIn(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Registered,
  id: string,
  method: "PUT" | "PATCH",
  body: Record<string, unknown>,
  key = randomUUID(),
) {
  return app.handle(authed(method, `/api/v1/check-ins/${id}`, body, actor, key));
}

async function submitCheckIn(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Registered,
  id: string,
  expectedVersion: number,
  key = randomUUID(),
) {
  return app.handle(authed("POST", `/api/v1/check-ins/${id}/submit`, { expectedVersion }, actor, key));
}

async function confirmObservation(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Nurse,
  id: string,
  body: Record<string, unknown>,
  key = randomUUID(),
) {
  return app.handle(authed("POST", `/api/v1/observations/${id}/confirm`, body, actor, key));
}

async function expectStatus(response: Response, status: number) {
  const text = await response.text();
  expect({ status: response.status, body: text }).toMatchObject({ status });
  return text ? (JSON.parse(text) as any) : null;
}

async function expectRejects(run: Promise<unknown> | (() => Promise<unknown>), label = "operation") {
  try {
    await (typeof run === "function" ? run() : run);
  } catch {
    return;
  }
  throw new Error(`${label} must reject`);
}

const VALID_OBSERVATIONS = [
  {
    type: "temperature_c",
    value: 36.8,
    unit: "c",
    observedAt: "2026-11-13T01:15:00Z",
  },
  {
    type: "heart_rate_bpm",
    value: 72,
    unit: "bpm",
    observedAt: "2026-11-13T01:20:00Z",
  },
];

/** Every POST/PUT carries the full approved scalar body; no legacy arrays. */
function checkInBody(overrides: Record<string, unknown> = {}) {
  return {
    condition: "ok",
    note: null,
    medicationAdherence: "regular",
    observations: [],
    ...overrides,
  };
}

integration("T08 check-ins, observations and confirmations", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("checkins");
    operator = createOperatorAssignmentService({ sql: db.sql, config: { nurseEmailDomain: "nurse.invalid" } });
  }, 90_000);

  afterAll(async () => {
    await db?.close();
  });

  test("drafts are patient-private, one per local day, status-filtered and invisible to staff", async () => {
    const app = appFor();
    const patient = await registerPatient("drafts-a@example.com", "Drafts A");
    const other = await registerPatient("drafts-b@example.com", "Drafts B");
    const nurse = await setupNurse("Draft Primary", "draft.primary@nurse.invalid", "NUR-T08-DRAFT-1");
    await assignPrimary(patient, nurse);

    const created = await expectStatus(await createCheckIn(app, patient, checkInBody()), 201);
    expect(created.data).toMatchObject({
      patientId: patient.patientId,
      condition: "ok",
      note: null,
      medicationAdherence: "regular",
      status: "draft",
      version: 0,
      supersedesCheckInId: null,
      observations: [],
    });
    expect(created.data.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(created.data.timeZone).toBe("Asia/Jakarta");
    expect(created.data.submittedAt).toBeNull();

    const duplicate = await createCheckIn(app, patient, checkInBody({ note: "Second draft same day" }));
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as any).error.details?.reason).toBe("DRAFT_EXISTS");

    const drafts = await expectStatus(
      await app.handle(request("/api/v1/check-ins?status=draft", "GET", { cookie: patient.cookie })),
      200,
    );
    expect(drafts.data.items).toHaveLength(1);
    expect(drafts.data.items[0].id).toBe(created.data.id);

    const submittedOnly = await expectStatus(
      await app.handle(request("/api/v1/check-ins?status=submitted", "GET", { cookie: patient.cookie })),
      200,
    );
    expect(submittedOnly.data.items).toEqual([]);

    const invalidStatus = await app.handle(
      request("/api/v1/check-ins?status=archived", "GET", { cookie: patient.cookie }),
    );
    expect(invalidStatus.status).toBe(422);

    const own = await expectStatus(await app.handle(request("/api/v1/check-ins", "GET", { cookie: patient.cookie })), 200);
    expect(own.data.items).toHaveLength(1);
    expect(own.data.items[0].id).toBe(created.data.id);

    const otherList = await expectStatus(
      await app.handle(request("/api/v1/check-ins", "GET", { cookie: other.cookie })),
      200,
    );
    expect(otherList.data.items).toEqual([]);

    const staffList = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/check-ins`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(staffList.data.items).toEqual([]);
    expect((await app.handle(request(`/api/v1/check-ins/${created.data.id}`, "GET", { cookie: nurse.cookie }))).status).toBe(404);

    const nurseEdit = await updateCheckIn(app, nurse as any, created.data.id, "PUT", {
      expectedVersion: 0,
      ...checkInBody({ condition: "complaint" }),
    });
    expect(nurseEdit.status).toBe(403);
    const nurseCreate = await app.handle(
      authed("POST", "/api/v1/check-ins", checkInBody(), nurse, randomUUID()),
    );
    expect(nurseCreate.status).toBe(403);
  }, 90_000);

  test("draft edits are versioned, PATCH preserves omitted fields, and submission freezes parent and children", async () => {
    const app = appFor();
    const patient = await registerPatient("submit-a@example.com", "Submit A");
    const nurse = await setupNurse("Submit Primary", "submit.primary@nurse.invalid", "NUR-T08-SUBMIT-1");
    await assignPrimary(patient, nurse);

    const created = await expectStatus(
      await createCheckIn(app, patient, checkInBody({ observations: [VALID_OBSERVATIONS[0]] })),
      201,
    );
    const updated = await expectStatus(
      await updateCheckIn(app, patient, created.data.id, "PUT", {
        expectedVersion: 0,
        condition: "complaint",
        note: "Patient note",
        medicationAdherence: "missed_once",
        observations: VALID_OBSERVATIONS,
      }),
      200,
    );
    expect(updated.data).toMatchObject({
      condition: "complaint",
      note: "Patient note",
      medicationAdherence: "missed_once",
      version: 1,
    });
    expect(updated.data.observations).toHaveLength(2);
    const originalObservationIds = updated.data.observations.map((row: any) => row.id).sort();

    // A note-only PATCH must leave condition, medication, and child arrays untouched.
    const noteOnly = await expectStatus(
      await updateCheckIn(app, patient, created.data.id, "PATCH", { expectedVersion: 1, note: "Updated note" }),
      200,
    );
    expect(noteOnly.data).toMatchObject({
      condition: "complaint",
      note: "Updated note",
      medicationAdherence: "missed_once",
      version: 2,
    });
    expect(noteOnly.data.observations.map((row: any) => row.id).sort()).toEqual(originalObservationIds);

    // PATCH without an editable field is rejected by the strict schema.
    const emptyPatch = await updateCheckIn(app, patient, created.data.id, "PATCH", { expectedVersion: 2 });
    expect(emptyPatch.status).toBe(422);

    // Array replacement happens only when the field is present.
    const observationsOnly = await expectStatus(
      await updateCheckIn(app, patient, created.data.id, "PATCH", {
        expectedVersion: 2,
        observations: [VALID_OBSERVATIONS[1]],
      }),
      200,
    );
    expect(observationsOnly.data).toMatchObject({
      condition: "complaint",
      note: "Updated note",
      medicationAdherence: "missed_once",
      version: 3,
    });
    expect(observationsOnly.data.observations).toHaveLength(1);
    expect(observationsOnly.data.observations[0].type).toBe("heart_rate_bpm");

    const incompletePut = await updateCheckIn(app, patient, created.data.id, "PUT", {
      expectedVersion: 3,
      condition: "complaint",
      note: "Missing observations",
      medicationAdherence: "missed_once",
    });
    expect(incompletePut.status).toBe(422);

    const staleSubmit = await submitCheckIn(app, patient, created.data.id, 0);
    expect(staleSubmit.status).toBe(409);
    expect(((await staleSubmit.json()) as any).error.details?.currentVersion).toBe(3);

    const submitKey = randomUUID();
    const submitted = await expectStatus(await submitCheckIn(app, patient, created.data.id, 3, submitKey), 200);
    expect(submitted.data).toMatchObject({ status: "submitted", version: 4 });
    expect(submitted.data.submittedAt).not.toBeNull();

    // The exact original retry key replays the known submitted version.
    const replay = await expectStatus(await submitCheckIn(app, patient, created.data.id, 3, submitKey), 200);
    expect(replay.data).toMatchObject({ status: "submitted", version: 4, submittedAt: submitted.data.submittedAt });

    // A fresh key must not ignore expectedVersion against a submitted row.
    const staleFresh = await submitCheckIn(app, patient, created.data.id, 3);
    expect(staleFresh.status).toBe(409);
    expect(((await staleFresh.json()) as any).error.details?.currentVersion).toBe(4);
    const currentFresh = await expectStatus(await submitCheckIn(app, patient, created.data.id, 4), 200);
    expect(currentFresh.data).toMatchObject({ status: "submitted", version: 4, submittedAt: submitted.data.submittedAt });

    const outbox = (await db.sql`
      SELECT count(*)::int AS count FROM public.outbox_events
      WHERE aggregate_type = 'check_in' AND aggregate_id = ${created.data.id}
        AND event_type = 'check_in.submitted'
    `) as unknown as Array<{ count: number }>;
    expect(outbox[0].count).toBe(1);

    const frozenEdit = await updateCheckIn(app, patient, created.data.id, "PATCH", {
      expectedVersion: 4,
      condition: "ok",
    });
    expect(frozenEdit.status).toBe(409);

    const staffHistory = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/check-ins`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(staffHistory.data.items).toHaveLength(1);
    expect(staffHistory.data.items[0].status).toBe("submitted");
    expect(staffHistory.data.items[0].medicationAdherence).toBe("missed_once");

    const summary = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/summary`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(summary.data.latestCheckIn).toMatchObject({
      id: created.data.id,
      condition: "complaint",
      localDate: submitted.data.localDate,
      submittedAt: submitted.data.submittedAt,
    });

    const list = await expectStatus(
      await app.handle(request("/api/v1/patients?scope=assigned", "GET", { cookie: nurse.cookie })),
      200,
    );
    const listed = list.data.items.find((row: any) => row.id === patient.patientId);
    expect(listed.latestCheckIn).toMatchObject({
      id: created.data.id,
      condition: "complaint",
      localDate: submitted.data.localDate,
      submittedAt: submitted.data.submittedAt,
    });

    await expectRejects(
      db.sql`
        INSERT INTO public.check_in_observations (check_in_id, patient_id, type, value, unit, observed_at, source)
        VALUES (${created.data.id}, ${patient.patientId}, 'weight_kg', 70, 'kg', now(), 'check_in')
      `,
      "child insert after submit",
    );
    await expectRejects(
      db.sql`UPDATE public.check_in_observations SET value = 99 WHERE check_in_id = ${created.data.id}`,
      "observation update after submit",
    );
    await expectRejects(
      db.sql`DELETE FROM public.check_in_observations WHERE check_in_id = ${created.data.id}`,
      "observation delete after submit",
    );
    await expectRejects(
      db.sql`UPDATE public.medication_adherence SET status = 'none' WHERE check_in_id = ${created.data.id}`,
      "medication update after submit",
    );
    await expectRejects(
      db.sql`DELETE FROM public.medication_adherence WHERE check_in_id = ${created.data.id}`,
      "medication delete after submit",
    );
    await expectRejects(
      db.sql`UPDATE public.check_ins SET condition = 'ok' WHERE id = ${created.data.id}`,
      "submitted parent update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.check_ins WHERE id = ${created.data.id}`,
      "submitted parent delete",
    );
    await expectRejects(db.sql`TRUNCATE public.medication_adherence`, "child truncate");
  }, 90_000);

  test("measurements are typed, positive, precisely bounded and never invented", async () => {
    const app = appFor();
    const patient = await registerPatient("validation-a@example.com", "Validation A");

    const missing = await expectStatus(await createCheckIn(app, patient, checkInBody()), 201);
    expect(missing.data.observations).toEqual([]);
    const count = (await db.sql`
      SELECT count(*)::int AS count FROM public.check_in_observations WHERE check_in_id = ${missing.data.id}
    `) as unknown as Array<{ count: number }>;
    expect(count[0].count).toBe(0);

    const wrongUnit = await createCheckIn(app, patient, checkInBody({
      observations: [{ ...VALID_OBSERVATIONS[0], unit: "bpm" }],
    }));
    expect(wrongUnit.status).toBe(422);

    const upperUnit = await createCheckIn(app, patient, checkInBody({
      observations: [{ ...VALID_OBSERVATIONS[0], unit: "C" }],
    }));
    expect(upperUnit.status).toBe(422);

    const absentValue = await createCheckIn(app, patient, checkInBody({
      observations: [{ type: "temperature_c", unit: "c", observedAt: "2026-11-13T01:15:00Z" }],
    }));
    expect(absentValue.status).toBe(422);

    const zero = await createCheckIn(app, patient, checkInBody({
      observations: [{ ...VALID_OBSERVATIONS[0], value: 0 }],
    }));
    expect(zero.status).toBe(422);

    const tooLarge = await createCheckIn(app, patient, checkInBody({
      observations: [{ ...VALID_OBSERVATIONS[0], value: 100000 }],
    }));
    expect(tooLarge.status).toBe(422);

    const tooPrecise = await createCheckIn(app, patient, checkInBody({
      observations: [{ ...VALID_OBSERVATIONS[0], value: 36.8123 }],
    }));
    expect(tooPrecise.status).toBe(422);

    const duplicate = await createCheckIn(app, patient, checkInBody({
      observations: [VALID_OBSERVATIONS[1], { ...VALID_OBSERVATIONS[1], value: 73 }],
    }));
    expect(duplicate.status).toBe(422);

    const nonUtc = await createCheckIn(app, patient, checkInBody({
      observations: [{ ...VALID_OBSERVATIONS[0], observedAt: "2026-11-13T01:15:00+07:00" }],
    }));
    expect(nonUtc.status).toBe(422);

    // Strict approved body: no missing fields, no client identity, no legacy
    // free-form condition, no medication arrays, no unknown keys.
    for (const invalid of [
      { note: null, medicationAdherence: "regular", observations: [] },
      { condition: "ok", medicationAdherence: "regular", observations: [] },
      { condition: "ok", note: null, observations: [] },
      { condition: "ok", note: null, medicationAdherence: "regular" },
      checkInBody({ condition: "stable" }),
      checkInBody({ medicationAdherence: [{ medicationName: "x", taken: true }] }),
      checkInBody({ patientId: patient.patientId }),
      checkInBody({ status: "draft" }),
      checkInBody({ localDate: "2026-11-13" }),
      checkInBody({ timeZone: "Asia/Jakarta" }),
    ]) {
      const response = await createCheckIn(app, patient, invalid as Record<string, unknown>);
      expect(response.status).toBe(422);
    }
  }, 90_000);

  test("corrections create new submitted-bound check-ins and preserve the original", async () => {
    const app = appFor();
    const patient = await registerPatient("correction-a@example.com", "Correction A");
    const other = await registerPatient("correction-b@example.com", "Correction B");
    const nurse = await setupNurse("Correction Primary", "correction.primary@nurse.invalid", "NUR-T08-CORR-1");
    await assignPrimary(patient, nurse);

    const original = await expectStatus(await createCheckIn(app, patient, checkInBody()), 201);
    await expectStatus(await submitCheckIn(app, patient, original.data.id, 0), 200);

    const otherOriginal = await expectStatus(await createCheckIn(app, other, checkInBody()), 201);
    await expectStatus(await submitCheckIn(app, other, otherOriginal.data.id, 0), 200);

    const correction = await expectStatus(
      await createCheckIn(app, patient, checkInBody({
        condition: "complaint",
        note: "Corrected note",
        medicationAdherence: "missed_once",
        supersedesCheckInId: original.data.id,
      })),
      201,
    );
    expect(correction.data.id).not.toBe(original.data.id);
    expect(correction.data).toMatchObject({
      supersedesCheckInId: original.data.id,
      status: "draft",
      condition: "complaint",
      medicationAdherence: "missed_once",
    });

    const preserved = await expectStatus(
      await app.handle(request(`/api/v1/check-ins/${original.data.id}`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(preserved.data).toMatchObject({ status: "submitted", condition: "ok" });

    const third = await registerPatient("correction-c@example.com", "Correction C");
    const crossPatient = await createCheckIn(app, third, checkInBody({
      supersedesCheckInId: otherOriginal.data.id,
    }));
    expect(crossPatient.status).toBe(404);

    const draftPredecessor = await db.sql.begin(async (tx) => {
      const [row] = (await tx`
        INSERT INTO public.check_ins
          (patient_id, local_date, time_zone, condition, note, medication_adherence, status, version)
        VALUES (${patient.patientId}, '2020-01-01', 'Asia/Jakarta', 'complaint', null, 'regular', 'draft', 0)
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      await tx`INSERT INTO public.medication_adherence (check_in_id, status) VALUES (${row.id}, 'regular')`;
      return row.id;
    });
    const draftBound = await createCheckIn(app, patient, checkInBody({
      supersedesCheckInId: draftPredecessor,
    }));
    expect(draftBound.status).toBe(409);
  }, 90_000);

  test("self and current-primary reads are exact; unrelated, intake, visit and revoked grants are denied", async () => {
    const app = appFor();
    const patient = await registerPatient("scope-a@example.com", "Scope A");
    const other = await registerPatient("scope-b@example.com", "Scope B");
    const primary = await setupNurse("Scope Primary", "scope.primary.t08@nurse.invalid", "NUR-T08-SCOPE-1");
    const unrelated = await setupNurse("Scope Unrelated", "scope.unrelated.t08@nurse.invalid", "NUR-T08-SCOPE-2");
    const intake = await setupNurse("Scope Intake", "scope.intake.t08@nurse.invalid", "NUR-T08-SCOPE-3");
    const visit = await setupNurse("Scope Visit", "scope.visit.t08@nurse.invalid", "NUR-T08-SCOPE-4");
    await assignPrimary(patient, primary);
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id)
      VALUES (${intake.staffId}, ${patient.patientId}, 'request_intake', ${randomUUID()})
    `;
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id)
      VALUES (${visit.staffId}, ${patient.patientId}, 'visit', ${randomUUID()})
    `;

    const created = await expectStatus(
      await createCheckIn(app, patient, checkInBody({ observations: [VALID_OBSERVATIONS[0]] })),
      201,
    );
    const submitted = await expectStatus(await submitCheckIn(app, patient, created.data.id, 0), 200);
    const observationId = created.data.observations[0].id;

    for (const actor of [primary]) {
      await expectStatus(
        await app.handle(request(`/api/v1/patients/${patient.patientId}/check-ins`, "GET", { cookie: actor.cookie })),
        200,
      );
      await expectStatus(
        await app.handle(request(`/api/v1/patients/${patient.patientId}/observations`, "GET", { cookie: actor.cookie })),
        200,
      );
      await expectStatus(
        await app.handle(request(`/api/v1/patients/${patient.patientId}/assessments`, "GET", { cookie: actor.cookie })),
        200,
      );
    }

    for (const actor of [unrelated, intake, visit]) {
      const checkIns = await app.handle(
        request(`/api/v1/patients/${patient.patientId}/check-ins`, "GET", { cookie: actor.cookie }),
      );
      expect(checkIns.status).toBe(404);
      const observations = await app.handle(
        request(`/api/v1/patients/${patient.patientId}/observations`, "GET", { cookie: actor.cookie }),
      );
      expect(observations.status).toBe(404);
      const confirm = await confirmObservation(app, actor, observationId, { expectedVersion: submitted.data.version });
      expect(confirm.status).toBe(404);
    }

    expect((await app.handle(request(`/api/v1/check-ins/${created.data.id}`, "GET", { cookie: other.cookie }))).status).toBe(404);
    expect((await app.handle(request(`/api/v1/patients/${patient.patientId}/check-ins`, "GET", { cookie: other.cookie }))).status).toBe(404);
    expect(
      (await app.handle(request(`/api/v1/patients/${patient.patientId}/observations`, "GET", { cookie: other.cookie }))).status,
    ).toBe(404);
    const patientConfirm = await app.handle(
      authed("POST", `/api/v1/observations/${observationId}/confirm`, { expectedVersion: submitted.data.version }, patient, randomUUID()),
    );
    expect(patientConfirm.status).toBe(403);

    await db.sql`
      UPDATE public.patient_access_grants SET revoked_at = now()
      WHERE staff_id = ${primary.staffId} AND patient_id = ${patient.patientId} AND basis = 'primary'
    `;
    const revoked = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/check-ins`, "GET", { cookie: primary.cookie }),
    );
    expect(revoked.status).toBe(404);
    const revokedConfirm = await confirmObservation(app, primary, observationId, { expectedVersion: submitted.data.version });
    expect(revokedConfirm.status).toBe(404);
  }, 90_000);

  test("observation history separates patient-reported values from nurse confirmations", async () => {
    const app = appFor();
    const patient = await registerPatient("observe-a@example.com", "Observe A");
    const primary = await setupNurse("Observe Primary", "observe.primary@nurse.invalid", "NUR-T08-OBS-1");
    await assignPrimary(patient, primary);

    const created = await expectStatus(
      await createCheckIn(app, patient, checkInBody({ observations: VALID_OBSERVATIONS })),
      201,
    );
    const submitted = await expectStatus(await submitCheckIn(app, patient, created.data.id, 0), 200);
    const observed = submitted.data.observations.find((row: any) => row.type === "temperature_c");
    const otherObserved = submitted.data.observations.find((row: any) => row.type === "heart_rate_bpm");
    expect(observed.value).toBe(36.8);
    expect(observed.source).toBe("patient_check_in");

    const before = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/observations?type=temperature_c`, "GET", { cookie: primary.cookie }),
      ),
      200,
    );
    expect(before.data.history.items).toHaveLength(1);
    expect(before.data.latestObservation).toMatchObject({
      id: observed.id,
      checkInId: created.data.id,
      type: "temperature_c",
      value: 36.8,
      unit: "c",
      observedAt: observed.observedAt,
      source: "patient_check_in",
    });
    expect(before.data.lastConfirmed).toBeNull();
    expect(before.data.trend).toEqual({ status: "unavailable", reason: "G02_NOT_APPROVED" });
    for (const alias of ["items", "page", "latestPatientObservation", "lastConfirmedObservation"]) {
      expect(before.data).not.toHaveProperty(alias);
    }

    const wrongVersion = await confirmObservation(app, primary, observed.id, {
      expectedVersion: 0,
      note: "Wrong workflow version",
    });
    expect(wrongVersion.status).toBe(409);

    // Confirm the later-measured heart rate first so the lastConfirmed
    // projection can only be correct if it orders by confirmation time.
    const firstConfirmation = await expectStatus(
      await confirmObservation(app, primary, otherObserved.id, {
        expectedVersion: submitted.data.version,
        note: "Nurse observed the heart rate",
      }),
      201,
    );
    expect(firstConfirmation.data).toMatchObject({
      observationId: otherObserved.id,
      checkInId: created.data.id,
      patientId: patient.patientId,
      checkInVersion: submitted.data.version,
      value: 72,
      unit: "bpm",
      observedAt: otherObserved.observedAt,
      note: "Nurse observed the heart rate",
      confirmedByStaffId: primary.staffId,
    });
    expect(firstConfirmation.data).not.toHaveProperty("observation");
    expect(firstConfirmation.data).not.toHaveProperty("confirmedBy");

    const confirmKey = randomUUID();
    const confirmed = await expectStatus(
      await confirmObservation(app, primary, observed.id, {
        expectedVersion: submitted.data.version,
        note: "Nurse observed the reported value",
      }, confirmKey),
      201,
    );
    expect(confirmed.data).toMatchObject({
      observationId: observed.id,
      checkInId: created.data.id,
      patientId: patient.patientId,
      checkInVersion: submitted.data.version,
      value: 36.8,
      unit: "c",
      observedAt: observed.observedAt,
      confirmedByStaffId: primary.staffId,
    });

    const replay = await expectStatus(
      await confirmObservation(app, primary, observed.id, {
        expectedVersion: submitted.data.version,
        note: "Nurse observed the reported value",
      }, confirmKey),
      201,
    );
    expect(replay.data.id).toBe(confirmed.data.id);

    const freshReplay = await confirmObservation(app, primary, observed.id, {
      expectedVersion: submitted.data.version,
      note: "Nurse observed the reported value",
    });
    expect(freshReplay.status).toBe(200);
    expect(((await freshReplay.json()) as any).data.id).toBe(confirmed.data.id);

    const different = await confirmObservation(app, primary, observed.id, {
      expectedVersion: submitted.data.version,
      note: "A different confirmation decision",
    });
    expect(different.status).toBe(409);
    expect(((await different.json()) as any).error.details?.reason).toBe("CONFIRMATION_EXISTS");

    const patientView = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/observations?type=temperature_c`, "GET", { cookie: patient.cookie }),
      ),
      200,
    );
    expect(patientView.data.history.items[0].id).toBe(observed.id);
    expect(patientView.data.history.items[0]).not.toHaveProperty("confirmationNote");
    expect(patientView.data.lastConfirmed).toMatchObject({
      value: 36.8,
      unit: "c",
      observedAt: observed.observedAt,
      confirmedAt: confirmed.data.confirmedAt,
      confirmedByStaffId: primary.staffId,
      observationId: observed.id,
      checkInId: created.data.id,
    });
    expect(patientView.data.lastConfirmed).not.toHaveProperty("note");
    expect(patientView.data.lastConfirmed).not.toHaveProperty("observation");
    expect(patientView.data.latestObservation.observedAt).toBe(observed.observedAt);

    // No type filter: latestObservation is the newest measurement, while
    // lastConfirmed is the newest confirmation (temperature, confirmed last).
    const allTypes = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/observations`, "GET", { cookie: patient.cookie }),
      ),
      200,
    );
    expect(allTypes.data.latestObservation.id).toBe(otherObserved.id);
    expect(allTypes.data.lastConfirmed.observationId).toBe(observed.id);

    const firstPage = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/observations?limit=1`, "GET", { cookie: primary.cookie }),
      ),
      200,
    );
    expect(firstPage.data.history.items).toHaveLength(1);
    expect(firstPage.data.history.page.hasMore).toBe(true);
    expect(firstPage.data.history.page.nextCursor).not.toBeNull();
    const secondPage = await expectStatus(
      await app.handle(
        request(
          `/api/v1/patients/${patient.patientId}/observations?limit=1&cursor=${encodeURIComponent(firstPage.data.history.page.nextCursor)}`,
          "GET",
          { cookie: primary.cookie },
        ),
      ),
      200,
    );
    expect(secondPage.data.history.items[0].id).not.toBe(firstPage.data.history.items[0].id);

    const invalidType = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/observations?type=blood_pressure`, "GET", { cookie: primary.cookie }),
    );
    expect(invalidType.status).toBe(422);

    await expectRejects(
      db.sql`
        INSERT INTO public.observation_confirmations (
          observation_id, check_in_id, patient_id, observation_type, observation_value,
          observation_unit, observation_observed_at, check_in_version, staff_id
        ) VALUES (
          ${otherObserved.id}, ${created.data.id}, ${patient.patientId}, 'heart_rate_bpm', 72,
          'bpm', ${otherObserved.observedAt}::timestamptz, 99, ${primary.staffId}
        )
      `,
      "confirmation with wrong workflow version",
    );
    await expectRejects(
      db.sql`UPDATE public.observation_confirmations SET note = 'mutated' WHERE observation_id = ${observed.id}`,
      "confirmation update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.observation_confirmations WHERE observation_id = ${observed.id}`,
      "confirmation delete",
    );
  }, 90_000);

  test("create and update idempotency replay exact requests and reject changed bodies", async () => {
    const app = appFor();
    const patient = await registerPatient("idempotent-a@example.com", "Idempotent A");
    const nurse = await setupNurse("Idempotent Primary", "idempotent.primary@nurse.invalid", "NUR-T08-IDEM-1");
    await assignPrimary(patient, nurse);

    const createKey = randomUUID();
    const first = await expectStatus(await createCheckIn(app, patient, checkInBody(), createKey), 201);
    const replay = await expectStatus(await createCheckIn(app, patient, checkInBody(), createKey), 201);
    expect(replay.data.id).toBe(first.data.id);
    const counts = (await db.sql`
      SELECT count(*)::int AS count FROM public.check_ins WHERE patient_id = ${patient.patientId}
    `) as unknown as Array<{ count: number }>;
    expect(counts[0].count).toBe(1);

    const reused = await createCheckIn(app, patient, checkInBody({ note: "Changed body" }), createKey);
    expect(reused.status).toBe(409);
    expect(((await reused.json()) as any).error.code).toBe("IDEMPOTENCY_CONFLICT");

    const updateBody = {
      expectedVersion: 0,
      condition: "complaint",
      note: "Idempotent update",
      medicationAdherence: "none",
      observations: [VALID_OBSERVATIONS[1]],
    };
    const updateKey = randomUUID();
    const updated = await expectStatus(
      await updateCheckIn(app, patient, first.data.id, "PUT", updateBody, updateKey),
      200,
    );
    const updateReplay = await expectStatus(
      await updateCheckIn(app, patient, first.data.id, "PUT", updateBody, updateKey),
      200,
    );
    expect(updateReplay.data).toMatchObject({
      id: updated.data.id,
      version: updated.data.version,
      condition: "complaint",
      medicationAdherence: "none",
    });
    const changedReplay = await updateCheckIn(app, patient, first.data.id, "PUT", {
      ...updateBody,
      note: "Changed replay body",
      expectedVersion: updated.data.version,
    }, updateKey);
    expect(changedReplay.status).toBe(409);
    expect(((await changedReplay.json()) as any).error.code).toBe("IDEMPOTENCY_CONFLICT");

    // A submitted check-in stays the list/summary projection while a newer
    // correction draft exists; drafts never leak into either view.
    await expectStatus(await submitCheckIn(app, patient, first.data.id, updated.data.version), 200);
    const correctionDraft = await expectStatus(
      await createCheckIn(app, patient, checkInBody({
        condition: "ok",
        note: "Draft correction",
        medicationAdherence: "regular",
        supersedesCheckInId: first.data.id,
      })),
      201,
    );
    expect(correctionDraft.data.status).toBe("draft");

    const list = await expectStatus(
      await app.handle(request("/api/v1/patients?scope=assigned", "GET", { cookie: nurse.cookie })),
      200,
    );
    const listed = list.data.items.find((row: any) => row.id === patient.patientId);
    expect(listed.latestCheckIn).toMatchObject({
      condition: "complaint",
      submittedAt: expect.any(String),
    });
    const summary = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/summary`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(summary.data.latestCheckIn).toMatchObject({
      condition: "complaint",
      submittedAt: listed.latestCheckIn.submittedAt,
    });

    const draftOnly = await registerPatient("idempotent-b@example.com", "Idempotent B");
    await assignPrimary(draftOnly, nurse);
    await expectStatus(await createCheckIn(app, draftOnly, checkInBody()), 201);
    const draftOnlyList = await expectStatus(
      await app.handle(request("/api/v1/patients?scope=assigned", "GET", { cookie: nurse.cookie })),
      200,
    );
    const draftOnlyRow = draftOnlyList.data.items.find((row: any) => row.id === draftOnly.patientId);
    expect(draftOnlyRow.latestCheckIn).toBeNull();
  }, 90_000);
});
