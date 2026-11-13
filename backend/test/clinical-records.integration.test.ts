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

const SNAPSHOT = {
  primaryDiagnosis: "Synthetic diagnosis A",
  secondaryDiagnoses: [] as string[],
  admittedAt: "2026-11-01T00:00:00Z",
  dischargedAt: null as string | null,
  allergies: [] as string[],
  procedures: ["Synthetic procedure"],
  complaints: null as string | null,
  observations: [
    { type: "blood_pressure", value: "120/80", unit: "mmHg", observedAt: "2026-11-01T01:00:00Z" },
    { type: "temperature", unit: "C" },
  ],
  internalNote: "INTERNAL-ONLY-NOTE",
};

function appFor() {
  return createTestApp(db.sql, { ip: `127.0.0.${Math.floor(Math.random() * 200) + 1}` }).app;
}

async function registerPatient(email: string, fullName = "Clinical Patient"): Promise<Registered> {
  const app = appFor();
  const response = await app.handle(
    jsonRequest("/api/v1/auth/register", "POST", {
      fullName,
      birthDate: "1990-03-12",
      gender: "female",
      email,
      phone: "+6281234567890",
      password: PATIENT_PASSWORD,
    }),
  );
  expect(response.status).toBe(201);
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

async function loginNurse(email: string): Promise<Nurse> {
  const app = appFor();
  const response = await app.handle(jsonRequest("/api/v1/auth/login", "POST", { email, password: NURSE_PASSWORD }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  return {
    cookie: cookieFrom(response),
    csrf: body.data.session.csrfToken,
    staffId: "",
    accountId: body.data.account.id,
    email,
  };
}

async function setupNurse(label: string, email: string, staffCode: string): Promise<Nurse & { login: Nurse }> {
  const provisioned = await provisionNurse(label, email, staffCode);
  const login = await loginNurse(email);
  return { ...login, staffId: provisioned.staffId, accountId: provisioned.accountId, login };
}

async function assignPrimary(patient: Registered, nurse: { staffId: string }, expectedVersion = 0) {
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

async function postMedicalRecord(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Nurse,
  patientId: string,
  body: unknown,
  key = randomUUID(),
) {
  return app.handle(
    authed("POST", `/api/v1/patients/${patientId}/medical-record-versions`, body, actor, key),
  );
}

async function createSnapshot(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Nurse,
  patientId: string,
  expectedVersion = 0,
  supersedesId?: string,
  payload: unknown = SNAPSHOT,
) {
  return postMedicalRecord(app, actor, patientId, {
    expectedVersion,
    sourceReference: "Synthetic source record",
    payload,
    ...(supersedesId ? { supersedesId } : {}),
  });
}

async function createSource(app: ReturnType<typeof createTestApp>["app"], actor: Nurse, body: Record<string, unknown>, key = randomUUID()) {
  return app.handle(authed("POST", "/api/v1/clinical-sources", body, actor, key));
}

async function publishSource(app: ReturnType<typeof createTestApp>["app"], actor: Nurse, id: string, expectedVersion = 0) {
  return app.handle(authed("POST", `/api/v1/clinical-sources/${id}/publish`, { expectedVersion }, actor, randomUUID()));
}

async function patchSource(
  app: ReturnType<typeof createTestApp>["app"],
  actor: Nurse,
  id: string,
  body: Record<string, unknown>,
  key = randomUUID(),
) {
  return app.handle(authed("PATCH", `/api/v1/clinical-sources/${id}`, body, actor, key));
}

async function createOrder(app: ReturnType<typeof createTestApp>["app"], actor: Nurse, body: Record<string, unknown>, key = randomUUID()) {
  return app.handle(authed("POST", "/api/v1/orders", body, actor, key));
}

async function patchOrder(app: ReturnType<typeof createTestApp>["app"], actor: Nurse, id: string, body: Record<string, unknown>, key = randomUUID()) {
  return app.handle(authed("PATCH", `/api/v1/orders/${id}`, body, actor, key));
}

async function publishOrder(app: ReturnType<typeof createTestApp>["app"], actor: Nurse, id: string, status: string, expectedVersion = 0) {
  return app.handle(
    authed("POST", `/api/v1/orders/${id}/publish`, { expectedVersion, status }, actor, randomUUID()),
  );
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

integration("T07 patient-bound clinical records", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("clinical");
    operator = createOperatorAssignmentService({ sql: db.sql, config: { nurseEmailDomain: "nurse.invalid" } });
  }, 90_000);

  afterAll(async () => {
    await db?.close();
  });

  test("primary-nurse scope gates patient, unrelated, intake and visit actors", async () => {
    const app = appFor();
    const patient = await registerPatient("scope-a@example.com", "Scope A");
    const otherPatient = await registerPatient("scope-b@example.com", "Scope B");
    const primary = await setupNurse("Scope Primary", "scope.primary@nurse.invalid", "NUR-CL-SCOPE-1");
    const unrelated = await setupNurse("Scope Unrelated", "scope.unrelated@nurse.invalid", "NUR-CL-SCOPE-2");
    const intake = await setupNurse("Scope Intake", "scope.intake@nurse.invalid", "NUR-CL-SCOPE-3");
    const visit = await setupNurse("Scope Visit", "scope.visit@nurse.invalid", "NUR-CL-SCOPE-4");
    await assignPrimary(patient, primary, 0);
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id)
      VALUES (${intake.staffId}, ${patient.patientId}, 'request_intake', ${randomUUID()})
    `;
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id)
      VALUES (${visit.staffId}, ${patient.patientId}, 'visit', ${randomUUID()})
    `;

    const createdBody = await expectStatus(await createSnapshot(app, primary, patient.patientId), 201);
    const rawSource = await expectStatus(
      await createSource(app, primary, {
        patientId: patient.patientId,
        medicalRecordVersionId: createdBody.data.id,
        kind: "protocol",
        title: "Raw scope source",
        body: "Raw scope source body.",
      }),
      201,
    );

    const patientWrite = await postMedicalRecord(app, patient as unknown as Nurse, patient.patientId, {
      expectedVersion: 0,
      sourceReference: "Patient attempt",
      payload: SNAPSHOT,
    });
    expect(patientWrite.status).toBe(403);
    const patientSourceWrite = await createSource(app, patient as unknown as Nurse, {
      patientId: patient.patientId,
      medicalRecordVersionId: createdBody.data.id,
      kind: "protocol",
      title: "Patient source attempt",
      body: "Blocked.",
    });
    expect(patientSourceWrite.status).toBe(403);

    for (const nurse of [unrelated, intake, visit]) {
      const list = await app.handle(
        request(`/api/v1/patients/${patient.patientId}/medical-record-versions`, "GET", { cookie: nurse.cookie }),
      );
      expect(list.status).toBe(404);
      const raw = await app.handle(
        request(`/api/v1/clinical-sources/${rawSource.data.id}`, "GET", { cookie: nurse.cookie }),
      );
      expect(raw.status).toBe(404);
      const detail = await app.handle(
        request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: nurse.cookie }),
      );
      expect(detail.status).toBe(404);
    }
    const visitSourceWrite = await createSource(app, visit, {
      patientId: patient.patientId,
      medicalRecordVersionId: createdBody.data.id,
      kind: "protocol",
      title: "Visit source attempt",
      body: "Blocked.",
    });
    expect(visitSourceWrite.status).toBe(404);
    const patientRaw = await app.handle(
      request(`/api/v1/clinical-sources/${rawSource.data.id}`, "GET", { cookie: patient.cookie }),
    );
    expect(patientRaw.status).toBe(403);

    const ownList = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/medical-record-versions`, "GET", { cookie: primary.cookie }),
    );
    expect(ownList.status).toBe(200);
    const ownCare = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie }),
    );
    expect(ownCare.status).toBe(200);
    const otherCare = await app.handle(
      request(`/api/v1/patients/${otherPatient.patientId}/care-guide`, "GET", { cookie: patient.cookie }),
    );
    expect(otherCare.status).toBe(404);

    const capabilities = await app.handle(
      request("/api/v1/capabilities", "GET", { cookie: primary.cookie }),
    );
    const capabilityBody = await expectStatus(capabilities, 200);
    expect(capabilityBody.data.clinicalRecords).toEqual({ state: "enabled" });
    expect(capabilityBody.data.clinicalScoring).toMatchObject({ state: "gated", gate: "G02" });
    expect(capabilityBody.data.analysisDrafts).toMatchObject({ state: "gated", gate: "G02" });
    expect(capabilityBody.data.webPush).toMatchObject({ state: "gated", gate: "G05" });
    expect(capabilityBody.data.knowledgeRetrieval).toMatchObject({ state: "gated", gate: "G05" });
  }, 90_000);

  test("medical snapshots are strict, immutable, scoped and cursor paginated", async () => {
    const app = appFor();
    const patient = await registerPatient("snapshot@example.com", "Snapshot Patient");
    const nurse = await setupNurse("Snapshot Nurse", "snapshot.nurse@nurse.invalid", "NUR-CL-SNAP-1");
    await assignPrimary(patient, nurse, 0);

    const missingArray = await createSnapshot(app, nurse, patient.patientId, 0, undefined, {
      ...SNAPSHOT,
      secondaryDiagnoses: undefined,
    });
    expect(missingArray.status).toBe(422);
    const nullArray = await createSnapshot(app, nurse, patient.patientId, 0, undefined, {
      ...SNAPSHOT,
      allergies: null,
    });
    expect(nullArray.status).toBe(422);
    const unknownField = await createSnapshot(app, nurse, patient.patientId, 0, undefined, {
      ...SNAPSHOT,
      derivedScore: 4,
    });
    expect(unknownField.status).toBe(422);
    expect(((await unknownField.json()) as any).error.code).toBe("UNKNOWN_FIELD");

    const first = await createSnapshot(app, nurse, patient.patientId);
    const firstBody = await expectStatus(first, 201);
    expect(firstBody.data).toMatchObject({
      patientId: patient.patientId,
      revisionNumber: 1,
      supersedesId: null,
      version: 0,
      sourceReference: "Synthetic source record",
      enteredBy: nurse.staffId,
    });
    expect(firstBody.data.payload.observations[1]).toEqual({ type: "temperature", unit: "C" });

    const patientRead = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/medical-record-versions/${firstBody.data.id}`, "GET", {
        cookie: patient.cookie,
      }),
    );
    expect(patientRead.status).toBe(403);

    const stale = await createSnapshot(app, nurse, patient.patientId, 0);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error.code).toBe("VERSION_CONFLICT");

    const second = await createSnapshot(app, nurse, patient.patientId, 1, firstBody.data.id);
    const secondBody = await expectStatus(second, 201);
    expect(secondBody.data).toMatchObject({ revisionNumber: 2, supersedesId: firstBody.data.id });

    const list = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/medical-record-versions?limit=1`, "GET", {
        cookie: nurse.cookie,
      }),
    );
    const listBody = await expectStatus(list, 200);
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0].revisionNumber).toBe(2);
    expect(listBody.data.page.hasMore).toBe(true);
    const pageTwo = await app.handle(
      request(
        `/api/v1/patients/${patient.patientId}/medical-record-versions?limit=1&cursor=${encodeURIComponent(listBody.data.page.nextCursor)}`,
        "GET",
        { cookie: nurse.cookie },
      ),
    );
    const pageTwoBody = await expectStatus(pageTwo, 200);
    expect(pageTwoBody.data.items[0].revisionNumber).toBe(1);

    await expectRejects(
      db.sql`UPDATE public.medical_record_versions SET payload = '{}'::jsonb WHERE id = ${firstBody.data.id}`,
      "snapshot update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.medical_record_versions WHERE id = ${firstBody.data.id}`,
      "snapshot delete",
    );
  }, 90_000);

  test("source publication stores deterministic full-text chunks and exposes only the approved patient projection", async () => {
    const app = appFor();
    const patient = await registerPatient("source@example.com", "Source Patient");
    const nurse = await setupNurse("Source Nurse", "source.nurse@nurse.invalid", "NUR-CL-SRC-1");
    await assignPrimary(patient, nurse, 0);
    const snapshot = await expectStatus(await createSnapshot(app, nurse, patient.patientId), 201);

    const body = `${"Synthetic care instruction paragraph. ".repeat(90)}END-OF-SOURCE`;
    const created = await createSource(app, nurse, {
      patientId: patient.patientId,
      medicalRecordVersionId: snapshot.data.id,
      kind: "medication",
      title: "Synthetic medication guide",
      body,
    });
    const source = await expectStatus(created, 201);
    expect(source.data).toMatchObject({
      patientId: patient.patientId,
      medicalRecordVersionId: snapshot.data.id,
      kind: "medication",
      status: "draft",
      revisionNumber: 1,
      approvedBy: null,
      approvedAt: null,
    });
    expect(source.data.chunkCount).toBeGreaterThan(1);

    const draftGuide = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie }),
    );
    expect(((await draftGuide.json()) as any).data.sources).toEqual([]);

    const patientRaw = await app.handle(
      request(`/api/v1/clinical-sources/${source.data.id}`, "GET", { cookie: patient.cookie }),
    );
    expect(patientRaw.status).toBe(403);

    const chunks = (await db.sql`
      SELECT ordinal, content FROM public.clinical_source_chunks
      WHERE document_id = ${source.data.id} ORDER BY ordinal
    `) as unknown as Array<{ ordinal: number; content: string }>;
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(body);
    expect(chunks.every((chunk) => chunk.content.length <= 2000)).toBe(true);

    const stalePublish = await publishSource(app, nurse, source.data.id, 7);
    expect(stalePublish.status).toBe(409);
    expect(((await stalePublish.json()) as any).error.code).toBe("VERSION_CONFLICT");
    const published = await publishSource(app, nurse, source.data.id, 0);
    const publishedBody = await expectStatus(published, 200);
    expect(publishedBody.data.status).toBe("approved");
    expect(publishedBody.data.approvedBy).toBe(nurse.staffId);

    const guide = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie }),
    );
    const guideBody = await expectStatus(guide, 200);
    expect(guideBody.data.sources).toHaveLength(1);
    expect(guideBody.data.sources[0]).toMatchObject({
      id: source.data.id,
      kind: "medication",
      title: "Synthetic medication guide",
      body,
      revisionNumber: 1,
    });
    expect(guideBody.data.sourceVersions).toEqual([{ sourceDocumentId: source.data.id, sourceVersion: 1 }]);
    const serialized = JSON.stringify(guideBody.data);
    for (const forbidden of ["INTERNAL-ONLY-NOTE", "internalNote", "createdBy", "approvedBy", "enteredBy"]) {
      expect(serialized).not.toContain(forbidden);
    }

    await expectRejects(
      db.sql`UPDATE public.clinical_source_documents SET body = 'tampered' WHERE id = ${source.data.id}`,
      "source content update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.clinical_source_documents WHERE id = ${source.data.id}`,
      "source delete",
    );
    await expectRejects(
      db.sql`UPDATE public.clinical_source_chunks SET content = 'tampered' WHERE document_id = ${source.data.id}`,
      "chunk update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.clinical_source_chunks WHERE document_id = ${source.data.id}`,
      "chunk delete",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.clinical_source_chunks (document_id, ordinal, content)
        VALUES (${source.data.id}, 999, 'late chunk')
      `,
      "post-approval chunk insert",
    );
  }, 90_000);

  test("orders keep manual instructions and ordered items, publish explicitly and count current heads", async () => {
    const app = appFor();
    const patient = await registerPatient("orders@example.com", "Orders Patient");
    const nurse = await setupNurse("Orders Nurse", "orders.nurse@nurse.invalid", "NUR-CL-ORD-1");
    await assignPrimary(patient, nurse, 0);
    const snapshot = await expectStatus(await createSnapshot(app, nurse, patient.patientId), 201);
    const source = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot.data.id,
        kind: "medication",
        title: "Order source",
        body: "Use exactly as written in the manually entered order.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurse, source.data.id, 0), 200);

    const base = {
      patientId: patient.patientId,
      sourceDocumentId: source.data.id,
      sourceVersion: 1,
      effectiveFrom: "2026-11-01T00:00:00Z",
    };
    const prescription = await createOrder(app, nurse, {
      ...base,
      kind: "medication",
      payload: { instructions: "Manual text", dose: "10mg" },
    });
    expect(prescription.status).toBe(422);
    expect(((await prescription.json()) as any).error.code).toBe("UNKNOWN_FIELD");
    const badItem = await createOrder(app, nurse, {
      ...base,
      kind: "medication",
      payload: { instructions: "Manual text", items: [{ type: "prescription", text: "nope" }] },
    });
    expect(badItem.status).toBe(422);

    const medication = await expectStatus(
      await createOrder(app, nurse, {
        ...base,
        kind: "medication",
        payload: {
          instructions: "Medication instructions, manually entered.",
          items: [
            { type: "medication", text: "Morning item" },
            { type: "followup", text: "Afternoon item" },
          ],
        },
      }),
      201,
    );
    const followup = await expectStatus(
      await createOrder(app, nurse, {
        ...base,
        kind: "followup",
        payload: { instructions: "Follow-up instructions, manually entered." },
      }),
      201,
    );
    const careItems = [
      { type: "storage", text: "Store item" },
      { type: "wound_care", text: "Wound item" },
      { type: "device_care", text: "Device item" },
      { type: "diet", text: "Diet item" },
      { type: "activity", text: "Activity item" },
      { type: "danger_sign", text: "Danger item" },
      { type: "first_aid", text: "First aid item" },
      { type: "followup", text: "Follow-up item" },
    ];
    const care = await expectStatus(
      await createOrder(app, nurse, {
        ...base,
        kind: "care",
        payload: { instructions: "Care instructions, manually entered.", items: careItems },
      }),
      201,
    );
    expect(care.data.payload.items).toEqual(careItems);
    for (const order of [medication, followup, care]) {
      expect(order.data.medicalRecordVersionId).toBe(snapshot.data.id);
    }

    for (const order of [medication, followup, care]) {
      const published = await expectStatus(await publishOrder(app, nurse, order.data.id, "active"), 200);
      expect(published.data.status).toBe("active");
      expect(published.data.publishedBy).toBe(nurse.staffId);
    }
    const repeat = await expectStatus(await publishOrder(app, nurse, medication.data.id, "active"), 200);
    expect(repeat.data.id).toBe(medication.data.id);
    const different = await publishOrder(app, nurse, medication.data.id, "cancelled", 1);
    expect(different.status).toBe(409);
    expect(((await different.json()) as any).error.code).toBe("INVALID_TRANSITION");

    const guide = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(guide.data.orders.map((order: any) => order.kind).sort()).toEqual(["care", "followup", "medication"]);
    const medicationOrder = guide.data.orders.find((order: any) => order.kind === "medication");
    expect(medicationOrder.instructions).toBe("Medication instructions, manually entered.");
    expect(medicationOrder.items).toEqual([
      { type: "medication", text: "Morning item" },
      { type: "followup", text: "Afternoon item" },
    ]);
    expect(JSON.stringify(guide.data)).not.toContain("publishedBy");
    expect(JSON.stringify(guide.data)).not.toContain("enteredBy");

    const orders = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/orders`, "GET", { cookie: patient.cookie }),
      ),
      200,
    );
    expect(orders.data.items).toHaveLength(3);

    const summary = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/summary`, "GET", { cookie: nurse.cookie }),
      ),
      200,
    );
    expect(summary.data.activeOrderCount).toBe(3);
    const detail = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}?scope=assigned`, "GET", { cookie: nurse.cookie }),
      ),
      200,
    );
    expect(detail.data.availableSections).toEqual(["profile", "care_guide"]);
  }, 90_000);

  test("order revisions are immutable successors and stale competing publication is rejected", async () => {
    const app = appFor();
    const patient = await registerPatient("revisions@example.com", "Revision Patient");
    const nurse = await setupNurse("Revision Nurse", "revision.nurse@nurse.invalid", "NUR-CL-REV-1");
    await assignPrimary(patient, nurse, 0);
    const snapshot = await expectStatus(await createSnapshot(app, nurse, patient.patientId), 201);
    const source = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot.data.id,
        kind: "activity",
        title: "Revision source",
        body: "Revision source body.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurse, source.data.id, 0), 200);
    const order = await expectStatus(
      await createOrder(app, nurse, {
        patientId: patient.patientId,
        kind: "care",
        sourceDocumentId: source.data.id,
        sourceVersion: 1,
        effectiveFrom: "2026-11-01T00:00:00Z",
        payload: { instructions: "Original instructions." },
      }),
      201,
    );

    const stalePatch = await patchOrder(app, nurse, order.data.id, {
      expectedVersion: 9,
      kind: "care",
      sourceDocumentId: source.data.id,
      sourceVersion: 1,
      effectiveFrom: "2026-11-01T00:00:00Z",
      payload: { instructions: "Stale patch." },
    });
    expect(stalePatch.status).toBe(409);

    const revised = await expectStatus(
      await patchOrder(app, nurse, order.data.id, {
        expectedVersion: 0,
        kind: "care",
        sourceDocumentId: source.data.id,
        sourceVersion: 1,
        effectiveFrom: "2026-11-02T00:00:00Z",
        payload: { instructions: "Revised instructions." },
      }),
      201,
    );
    expect(revised.data).toMatchObject({
      patientId: patient.patientId,
      lineageId: order.data.lineageId,
      revisionNumber: 2,
      supersedesId: order.data.id,
      status: "draft",
    });

    const competing = await publishOrder(app, nurse, order.data.id, "active");
    expect(competing.status).toBe(409);
    expect(((await competing.json()) as any).error.code).toBe("VERSION_CONFLICT");

    await expectStatus(await publishOrder(app, nurse, revised.data.id, "active"), 200);
    const currentPatientRead = await expectStatus(
      await app.handle(request(`/api/v1/orders/${revised.data.id}`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(currentPatientRead.data).toMatchObject({
      id: revised.data.id,
      revisionNumber: 2,
      status: "active",
      instructions: "Revised instructions.",
    });
    expect(
      (await app.handle(request(`/api/v1/orders/${order.data.id}`, "GET", { cookie: patient.cookie }))).status,
    ).toBe(404);
    const draftHistory = await expectStatus(
      await app.handle(request(`/api/v1/orders/${order.data.id}`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(draftHistory.data).toMatchObject({ id: order.data.id, revisionNumber: 1, status: "draft" });

    const guide = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(guide.data.orders).toHaveLength(1);
    expect(guide.data.orders[0].id).toBe(revised.data.id);
    expect(guide.data.orders[0].instructions).toBe("Revised instructions.");

    const third = await expectStatus(
      await patchOrder(app, nurse, revised.data.id, {
        expectedVersion: 1,
        kind: "care",
        sourceDocumentId: source.data.id,
        sourceVersion: 1,
        effectiveFrom: "2026-11-03T00:00:00Z",
        payload: { instructions: "Cancelled successor instructions." },
      }),
      201,
    );
    const stillVisible = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(stillVisible.data.orders[0].id).toBe(revised.data.id);
    await expectStatus(await publishOrder(app, nurse, third.data.id, "cancelled"), 200);
    const hidden = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(hidden.data.orders).toEqual([]);
    const nurseOrders = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/orders`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(nurseOrders.data.items).toHaveLength(1);
    expect(nurseOrders.data.items[0]).toMatchObject({ id: third.data.id, status: "cancelled" });

    for (const id of [order.data.id, revised.data.id, third.data.id]) {
      expect(
        (await app.handle(request(`/api/v1/orders/${id}`, "GET", { cookie: patient.cookie }))).status,
      ).toBe(404);
    }
    const activeHistory = await expectStatus(
      await app.handle(request(`/api/v1/orders/${revised.data.id}`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(activeHistory.data).toMatchObject({ id: revised.data.id, revisionNumber: 2, status: "active" });
    const cancelledHistory = await expectStatus(
      await app.handle(request(`/api/v1/orders/${third.data.id}`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(cancelledHistory.data).toMatchObject({ id: third.data.id, revisionNumber: 3, status: "cancelled" });

    const future = await expectStatus(
      await createOrder(app, nurse, {
        patientId: patient.patientId,
        kind: "care",
        sourceDocumentId: source.data.id,
        sourceVersion: 1,
        effectiveFrom: "2030-01-01T00:00:00Z",
        payload: { instructions: "Future instructions." },
      }),
      201,
    );
    await expectStatus(await publishOrder(app, nurse, future.data.id, "active"), 200);
    const expired = await expectStatus(
      await createOrder(app, nurse, {
        patientId: patient.patientId,
        kind: "care",
        sourceDocumentId: source.data.id,
        sourceVersion: 1,
        effectiveFrom: "2025-01-01T00:00:00Z",
        effectiveTo: "2025-02-01T00:00:00Z",
        payload: { instructions: "Expired instructions." },
      }),
      201,
    );
    await expectStatus(await publishOrder(app, nurse, expired.data.id, "active"), 200);
    for (const id of [future.data.id, expired.data.id]) {
      expect(
        (await app.handle(request(`/api/v1/orders/${id}`, "GET", { cookie: patient.cookie }))).status,
      ).toBe(404);
      const staffRead = await expectStatus(
        await app.handle(request(`/api/v1/orders/${id}`, "GET", { cookie: nurse.cookie })),
        200,
      );
      expect(staffRead.data.status).toBe("active");
    }

    await expectRejects(
      db.sql`UPDATE public.care_orders SET payload = '{"instructions":"tampered"}'::jsonb WHERE id = ${third.data.id}`,
      "order content update",
    );
    await expectRejects(
      db.sql`UPDATE public.care_orders SET patient_id = ${randomUUID()} WHERE id = ${third.data.id}`,
      "order patient rebind",
    );
    await expectRejects(
      db.sql`DELETE FROM public.care_orders WHERE id = ${third.data.id}`,
      "order delete",
    );
  }, 90_000);

  test("cross-patient snapshot, source and order bindings are rejected by app and database", async () => {
    const app = appFor();
    const patientA = await registerPatient("binding-a@example.com", "Binding A");
    const patientB = await registerPatient("binding-b@example.com", "Binding B");
    const nurse = await setupNurse("Binding Nurse", "binding.nurse@nurse.invalid", "NUR-CL-BIND-1");
    await assignPrimary(patientA, nurse, 0);
    await assignPrimary(patientB, nurse, 0);
    const snapshotA = await expectStatus(await createSnapshot(app, nurse, patientA.patientId), 201);
    const snapshotB = await expectStatus(await createSnapshot(app, nurse, patientB.patientId), 201);

    const wrongSnapshot = await createSource(app, nurse, {
      patientId: patientA.patientId,
      medicalRecordVersionId: snapshotB.data.id,
      kind: "diet",
      title: "Wrong snapshot",
      body: "Must not bind another patient's snapshot.",
    });
    expect(wrongSnapshot.status).toBe(404);

    const sourceA = await expectStatus(
      await createSource(app, nurse, {
        patientId: patientA.patientId,
        medicalRecordVersionId: snapshotA.data.id,
        kind: "diet",
        title: "Patient A source",
        body: "Patient A source body.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurse, sourceA.data.id, 0), 200);

    const wrongPatientOrder = await createOrder(app, nurse, {
      patientId: patientB.patientId,
      kind: "care",
      sourceDocumentId: sourceA.data.id,
      sourceVersion: 1,
      effectiveFrom: "2026-11-01T00:00:00Z",
      payload: { instructions: "Cross patient" },
    });
    expect(wrongPatientOrder.status).toBe(404);

    await expectRejects(
      db.sql`
        INSERT INTO public.clinical_source_documents (
          lineage_id, revision_number, patient_id, medical_record_version_id,
          kind, title, body, checksum, status, created_by
        ) VALUES (
          ${randomUUID()}, 1, ${patientB.patientId}, ${snapshotA.data.id},
          'diet', 'Cross', 'Cross', ${"a".repeat(64)}, 'draft', ${nurse.staffId}
        )
      `,
      "cross-patient source insert",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.care_orders (
          lineage_id, revision_number, patient_id, medical_record_version_id, kind,
          source_document_id, source_version, payload, effective_from, status, entered_by
        ) VALUES (
          ${randomUUID()}, 1, ${patientB.patientId}, ${snapshotB.data.id}, 'care',
          ${sourceA.data.id}, 1, '{"instructions":"Cross"}'::jsonb, now(), 'draft', ${nurse.staffId}
        )
      `,
      "cross-patient order insert",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.medical_record_versions (
          patient_id, revision_number, supersedes_id, entered_by, source_reference, payload
        ) VALUES (
          ${patientB.patientId}, 2, ${snapshotA.data.id}, ${nurse.staffId}, 'Cross', '{}'::jsonb
        )
      `,
      "cross-patient snapshot successor",
    );
  }, 90_000);

  test("source correction and a new medical record invalidate old pending proposals while history survives", async () => {
    const app = appFor();
    const patient = await registerPatient("correction@example.com", "Correction Patient");
    const nurse = await setupNurse("Correction Nurse", "correction.nurse@nurse.invalid", "NUR-CL-CORR-1");
    await assignPrimary(patient, nurse, 0);
    const snapshot1 = await expectStatus(await createSnapshot(app, nurse, patient.patientId), 201);
    const source1 = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot1.data.id,
        kind: "wound_care",
        title: "Wound source v1",
        body: "Wound care v1.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurse, source1.data.id, 0), 200);
    const pendingOrder = await expectStatus(
      await createOrder(app, nurse, {
        patientId: patient.patientId,
        kind: "care",
        sourceDocumentId: source1.data.id,
        sourceVersion: 1,
        effectiveFrom: "2026-11-01T00:00:00Z",
        payload: { instructions: "Old pending order." },
      }),
      201,
    );

    const snapshot2 = await expectStatus(
      await createSnapshot(app, nurse, patient.patientId, 1, snapshot1.data.id),
      201,
    );
    const staleSourcePublish = await createSource(app, nurse, {
      patientId: patient.patientId,
      medicalRecordVersionId: snapshot1.data.id,
      kind: "wound_care",
      title: "Stale draft",
      body: "Bound to the old medical record.",
    });
    const staleSource = await expectStatus(staleSourcePublish, 201);
    const publishStale = await publishSource(app, nurse, staleSource.data.id, 0);
    expect(publishStale.status).toBe(409);
    expect(((await publishStale.json()) as any).error.code).toBe("VERSION_CONFLICT");

    const source2 = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot2.data.id,
        kind: "wound_care",
        title: "Wound source v2",
        body: "Wound care v2 after correction.",
        supersedesId: source1.data.id,
      }),
      201,
    );
    expect(source2.data).toMatchObject({ revisionNumber: 2, supersedesId: source1.data.id });
    await expectStatus(await publishSource(app, nurse, source2.data.id, 0), 200);

    const oldOrderPublish = await publishOrder(app, nurse, pendingOrder.data.id, "active");
    expect(oldOrderPublish.status).toBe(409);
    expect(((await oldOrderPublish.json()) as any).error.code).toBe("VERSION_CONFLICT");

    const historical = await expectStatus(
      await app.handle(
        request(`/api/v1/clinical-sources/${source1.data.id}`, "GET", { cookie: nurse.cookie }),
      ),
      200,
    );
    expect(historical.data).toMatchObject({ status: "approved", revisionNumber: 1 });
    const oldSnapshot = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/medical-record-versions/${snapshot1.data.id}`, "GET", {
          cookie: nurse.cookie,
        }),
      ),
      200,
    );
    expect(oldSnapshot.data.revisionNumber).toBe(1);

    const newOrder = await expectStatus(
      await createOrder(app, nurse, {
        patientId: patient.patientId,
        kind: "care",
        sourceDocumentId: source2.data.id,
        sourceVersion: 2,
        effectiveFrom: "2026-11-02T00:00:00Z",
        payload: { instructions: "Corrected order." },
      }),
      201,
    );
    await expectStatus(await publishOrder(app, nurse, newOrder.data.id, "active"), 200);
    const guide = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/care-guide`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(guide.data.sources).toHaveLength(1);
    expect(guide.data.sources[0]).toMatchObject({ id: source2.data.id, body: "Wound care v2 after correction." });
    expect(guide.data.orders).toHaveLength(1);
    expect(guide.data.orders[0].id).toBe(newOrder.data.id);
  }, 90_000);

  test("idempotency is fresh-scope-bound and never duplicates clinical rows", async () => {
    const app = appFor();
    const patient = await registerPatient("idem@example.com", "Idempotency Patient");
    const nurseOne = await setupNurse("Idem Nurse One", "idem.one@nurse.invalid", "NUR-CL-IDEM-1");
    const nurseTwo = await setupNurse("Idem Nurse Two", "idem.two@nurse.invalid", "NUR-CL-IDEM-2");
    await assignPrimary(patient, nurseOne, 0);

    const key = randomUUID();
    const recordBody = {
      expectedVersion: 0,
      sourceReference: "Idempotent record",
      payload: SNAPSHOT,
    };
    const created = await postMedicalRecord(app, nurseOne, patient.patientId, recordBody, key);
    const createdBody = await expectStatus(created, 201);
    const replay = await postMedicalRecord(app, nurseOne, patient.patientId, recordBody, key);
    const replayBody = await expectStatus(replay, 201);
    expect(replayBody.data.id).toBe(createdBody.data.id);
    const count = (await db.sql`
      SELECT count(*)::int AS count FROM public.medical_record_versions WHERE patient_id = ${patient.patientId}
    `) as unknown as Array<{ count: number }>;
    expect(count[0].count).toBe(1);

    const conflict = await postMedicalRecord(
      app,
      nurseOne,
      patient.patientId,
      { ...recordBody, sourceReference: "Different request" },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any).error.code).toBe("IDEMPOTENCY_CONFLICT");

    const snapshot = createdBody.data;
    const source = await expectStatus(
      await createSource(app, nurseOne, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot.id,
        kind: "activity",
        title: "Idem source",
        body: "Idem source body.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurseOne, source.data.id, 0), 200);
    const orderKey = randomUUID();
    const orderBody = {
      patientId: patient.patientId,
      kind: "care",
      sourceDocumentId: source.data.id,
      sourceVersion: 1,
      effectiveFrom: "2026-11-01T00:00:00Z",
      payload: { instructions: "Idempotent order." },
    };
    const order = await expectStatus(await createOrder(app, nurseOne, orderBody, orderKey), 201);
    const orderReplay = await expectStatus(await createOrder(app, nurseOne, orderBody, orderKey), 201);
    expect(orderReplay.data.id).toBe(order.data.id);
    const orderCount = (await db.sql`
      SELECT count(*)::int AS count FROM public.care_orders WHERE patient_id = ${patient.patientId}
    `) as unknown as Array<{ count: number }>;
    expect(orderCount[0].count).toBe(1);

    await assignPrimary(patient, nurseTwo, 1);
    const oldNurseReplay = await createOrder(app, nurseOne, orderBody, orderKey);
    expect(oldNurseReplay.status).toBe(404);
    const newNurseRead = await app.handle(
      request(`/api/v1/patients/${patient.patientId}/orders`, "GET", { cookie: nurseTwo.cookie }),
    );
    expect(newNurseRead.status).toBe(200);
  }, 90_000);

  test("source replacement and exact order detail stay scoped, versioned and reject malformed ids", async () => {
    const app = appFor();
    const patient = await registerPatient("repair@example.com", "Repair Patient");
    const otherPatient = await registerPatient("repair.other@example.com", "Other Patient");
    const nurse = await setupNurse("Repair Nurse", "repair.nurse@nurse.invalid", "NUR-CL-REPAIR-1");
    const unrelated = await setupNurse("Repair Unrelated", "repair.unrelated@nurse.invalid", "NUR-CL-REPAIR-2");
    await assignPrimary(patient, nurse, 0);
    const snapshot = await expectStatus(await createSnapshot(app, nurse, patient.patientId), 201);
    const source = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot.data.id,
        kind: "wound_care",
        title: "Repair source v1",
        body: "Repair source body v1.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurse, source.data.id, 0), 200);
    const order = await expectStatus(
      await createOrder(app, nurse, {
        patientId: patient.patientId,
        kind: "care",
        sourceDocumentId: source.data.id,
        sourceVersion: 1,
        effectiveFrom: "2026-11-01T00:00:00Z",
        payload: {
          instructions: "Repair order instructions.",
          items: [{ type: "wound_care", text: "Repair wound item." }],
        },
      }),
      201,
    );

    const staffDraft = await expectStatus(
      await app.handle(request(`/api/v1/orders/${order.data.id}`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(staffDraft.data).toMatchObject({
      id: order.data.id,
      patientId: patient.patientId,
      medicalRecordVersionId: snapshot.data.id,
      lineageId: order.data.lineageId,
      kind: "care",
      sourceDocumentId: source.data.id,
      sourceVersion: 1,
      revisionNumber: 1,
      version: 0,
      status: "draft",
      supersedesId: null,
      enteredBy: nurse.staffId,
      publishedBy: null,
      publishedAt: null,
    });
    expect(staffDraft.data.payload).toEqual({
      instructions: "Repair order instructions.",
      items: [{ type: "wound_care", text: "Repair wound item." }],
    });

    for (const actor of [patient, otherPatient, unrelated]) {
      const hidden = await app.handle(
        request(`/api/v1/orders/${order.data.id}`, "GET", { cookie: actor.cookie }),
      );
      expect(hidden.status).toBe(404);
    }

    await expectStatus(await publishOrder(app, nurse, order.data.id, "active"), 200);
    const patientOrder = await expectStatus(
      await app.handle(request(`/api/v1/orders/${order.data.id}`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(patientOrder.data).toMatchObject({
      id: order.data.id,
      kind: "care",
      revisionNumber: 1,
      version: 1,
      status: "active",
      sourceDocumentId: source.data.id,
      sourceVersion: 1,
      instructions: "Repair order instructions.",
      items: [{ type: "wound_care", text: "Repair wound item." }],
    });
    const patientOrderJson = JSON.stringify(patientOrder.data);
    for (const hidden of [
      nurse.staffId,
      "enteredBy",
      "publishedBy",
      "publishedAt",
      "patientId",
      "lineageId",
      "medicalRecordVersionId",
      "createdAt",
    ]) {
      expect(patientOrderJson).not.toContain(hidden);
    }

    const malformed = "not-a-uuid";
    const malformedChecks: Array<[string, Promise<Response>]> = [
      ["order get", app.handle(request(`/api/v1/orders/${malformed}`, "GET", { cookie: nurse.cookie }))],
      [
        "order patch",
        app.handle(
          authed(
            "PATCH",
            `/api/v1/orders/${malformed}`,
            {
              expectedVersion: 0,
              kind: "care",
              sourceDocumentId: source.data.id,
              sourceVersion: 1,
              payload: { instructions: "Malformed path." },
              effectiveFrom: "2026-11-01T00:00:00Z",
            },
            nurse,
            randomUUID(),
          ),
        ),
      ],
      [
        "order publish",
        app.handle(
          authed(
            "POST",
            `/api/v1/orders/${malformed}/publish`,
            { expectedVersion: 0, status: "active" },
            nurse,
            randomUUID(),
          ),
        ),
      ],
      [
        "source get",
        app.handle(request(`/api/v1/clinical-sources/${malformed}`, "GET", { cookie: nurse.cookie })),
      ],
      [
        "source publish",
        app.handle(
          authed(
            "POST",
            `/api/v1/clinical-sources/${malformed}/publish`,
            { expectedVersion: 0 },
            nurse,
            randomUUID(),
          ),
        ),
      ],
      [
        "source patch",
        app.handle(
          authed(
            "PATCH",
            `/api/v1/clinical-sources/${malformed}`,
            {
              expectedVersion: 0,
              medicalRecordVersionId: snapshot.data.id,
              kind: "wound_care",
              title: "Malformed path",
              body: "Malformed path.",
            },
            nurse,
            randomUUID(),
          ),
        ),
      ],
      [
        "record get",
        app.handle(
          request(`/api/v1/patients/${patient.patientId}/medical-record-versions/${malformed}`, "GET", {
            cookie: nurse.cookie,
          }),
        ),
      ],
      [
        "patient orders",
        app.handle(request(`/api/v1/patients/${malformed}/orders`, "GET", { cookie: nurse.cookie })),
      ],
    ];
    for (const [label, pending] of malformedChecks) {
      const response = await pending;
      const text = await response.text();
      expect({ label, status: response.status, body: text }).toMatchObject({ label, status: 404 });
      expect((JSON.parse(text) as any).error.code).toBe("NOT_FOUND");
    }

    const patchBody = {
      expectedVersion: 1,
      medicalRecordVersionId: snapshot.data.id,
      kind: "wound_care",
      title: "Repair source v2",
      body: "Repair source body v2.",
    };
    const injectedBinding = await patchSource(app, nurse, source.data.id, {
      ...patchBody,
      patientId: otherPatient.patientId,
    });
    expect(injectedBinding.status).toBe(422);
    expect(((await injectedBinding.json()) as any).error.code).toBe("UNKNOWN_FIELD");
    const injectedActor = await patchSource(app, nurse, source.data.id, {
      ...patchBody,
      createdBy: nurse.staffId,
    });
    expect(injectedActor.status).toBe(422);
    expect(((await injectedActor.json()) as any).error.code).toBe("UNKNOWN_FIELD");
    const staleVersion = await patchSource(app, nurse, source.data.id, { ...patchBody, expectedVersion: 0 });
    expect(staleVersion.status).toBe(409);
    expect(((await staleVersion.json()) as any).error.code).toBe("VERSION_CONFLICT");
    expect((await patchSource(app, unrelated, source.data.id, patchBody)).status).toBe(404);
    expect((await patchSource(app, patient as unknown as Nurse, source.data.id, patchBody)).status).toBe(403);

    const revised = await expectStatus(await patchSource(app, nurse, source.data.id, patchBody), 201);
    expect(revised.data.id).not.toBe(source.data.id);
    expect(revised.data).toMatchObject({
      patientId: patient.patientId,
      medicalRecordVersionId: snapshot.data.id,
      lineageId: source.data.lineageId,
      revisionNumber: 2,
      supersedesId: source.data.id,
      kind: "wound_care",
      title: "Repair source v2",
      body: "Repair source body v2.",
      status: "draft",
      version: 0,
      approvedBy: null,
      approvedAt: null,
    });
    expect(revised.data.chunkCount).toBeGreaterThan(0);

    const original = await expectStatus(
      await app.handle(request(`/api/v1/clinical-sources/${source.data.id}`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(original.data).toMatchObject({
      body: "Repair source body v1.",
      status: "approved",
      revisionNumber: 1,
      version: 1,
    });

    const staleSelected = await patchSource(app, nurse, source.data.id, patchBody);
    expect(staleSelected.status).toBe(409);
    expect(((await staleSelected.json()) as any).error.details?.reason).toBe("STALE_LINEAGE_HEAD");

    const draftSource = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot.data.id,
        kind: "activity",
        title: "Unpublished source",
        body: "Unpublished source body.",
      }),
      201,
    );
    const draftPatch = await patchSource(app, nurse, draftSource.data.id, {
      expectedVersion: 0,
      medicalRecordVersionId: snapshot.data.id,
      kind: "activity",
      title: "Unpublished replacement",
      body: "Replacement body.",
    });
    const correctedDraft = await expectStatus(draftPatch, 201);
    expect(correctedDraft.data).toMatchObject({ supersedesId: draftSource.data.id, revisionNumber: 2, status: "draft" });
    expect(correctedDraft.data.id).not.toBe(draftSource.data.id);
    const immutableDraft = await expectStatus(await app.handle(request(`/api/v1/clinical-sources/${draftSource.data.id}`, "GET", { cookie: nurse.cookie })), 200);
    expect(immutableDraft.data).toMatchObject({ body: "Unpublished source body.", status: "draft", version: 0 });
    expect((await publishSource(app, nurse, draftSource.data.id, 0)).status).toBe(409);
    await expectStatus(await publishSource(app, nurse, correctedDraft.data.id, 0), 200);

    const postCorrectedDraft = await expectStatus(await createSource(app, nurse, {
      patientId: patient.patientId, medicalRecordVersionId: snapshot.data.id, kind: "activity",
      title: "Draft mistake", body: "Unpublished original.",
    }), 201);
    const postCorrected = await expectStatus(await createSource(app, nurse, {
      patientId: patient.patientId, medicalRecordVersionId: snapshot.data.id, kind: "activity",
      title: "Corrected before approval", body: "Corrected unpublished content.", supersedesId: postCorrectedDraft.data.id,
    }), 201);
    await expectStatus(await publishSource(app, nurse, postCorrected.data.id, 0), 200);

    await expectStatus(await publishSource(app, nurse, revised.data.id, 0), 200);
    const snapshot2 = await expectStatus(
      await createSnapshot(app, nurse, patient.patientId, 1, snapshot.data.id),
      201,
    );
    const staleMedicalRecord = await patchSource(app, nurse, revised.data.id, {
      expectedVersion: 1,
      medicalRecordVersionId: snapshot.data.id,
      kind: "wound_care",
      title: "Stale medical record binding",
      body: "Bound to the old medical record.",
    });
    expect(staleMedicalRecord.status).toBe(409);
    expect(((await staleMedicalRecord.json()) as any).error.details?.reason).toBe("STALE_MEDICAL_RECORD");

    const reboundBody = {
      expectedVersion: 1,
      medicalRecordVersionId: snapshot2.data.id,
      kind: "wound_care",
      title: "Repair source v3",
      body: "Repair source body v3.",
    };
    const reboundKey = randomUUID();
    const rebound = await expectStatus(await patchSource(app, nurse, revised.data.id, reboundBody, reboundKey), 201);
    expect(rebound.data).toMatchObject({
      revisionNumber: 3,
      supersedesId: revised.data.id,
      medicalRecordVersionId: snapshot2.data.id,
      status: "draft",
    });
    const replay = await expectStatus(await patchSource(app, nurse, revised.data.id, reboundBody, reboundKey), 201);
    expect(replay.data.id).toBe(rebound.data.id);
    const replayConflict = await patchSource(app, nurse, revised.data.id, { ...reboundBody, body: "Different body." }, reboundKey);
    expect(replayConflict.status).toBe(409);
    expect(((await replayConflict.json()) as any).error.code).toBe("IDEMPOTENCY_CONFLICT");
  }, 90_000);

  test("database guards enforce lineage, approval provenance and immutable order content", async () => {
    const app = appFor();
    const patient = await registerPatient("guards@example.com", "Guard Patient");
    const nurse = await setupNurse("Guard Nurse", "guard.nurse@nurse.invalid", "NUR-CL-GUARD-1");
    await assignPrimary(patient, nurse, 0);
    const snapshot = await expectStatus(await createSnapshot(app, nurse, patient.patientId), 201);

    await expectRejects(
      db.sql`
        INSERT INTO public.medical_record_versions (
          patient_id, revision_number, supersedes_id, entered_by, source_reference, payload
        ) VALUES (${patient.patientId}, 2, NULL, ${nurse.staffId}, 'Broken lineage', '{}'::jsonb)
      `,
      "medical record lineage skip",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.clinical_source_documents (
          lineage_id, revision_number, patient_id, medical_record_version_id,
          kind, title, body, checksum, status, created_by, approved_by, approved_at
        ) VALUES (
          ${randomUUID()}, 1, ${patient.patientId}, ${snapshot.data.id},
          'diet', 'Bad approval', 'Body', ${"b".repeat(64)}, 'draft', ${nurse.staffId}, ${nurse.staffId}, now()
        )
      `,
      "draft approval provenance",
    );
    const draftSource = await expectStatus(
      await createSource(app, nurse, {
        patientId: patient.patientId,
        medicalRecordVersionId: snapshot.data.id,
        kind: "diet",
        title: "Guard source",
        body: "Guard source body.",
      }),
      201,
    );
    await expectStatus(await publishSource(app, nurse, draftSource.data.id, 0), 200);
    await expectRejects(
      db.sql`
        INSERT INTO public.care_orders (
          lineage_id, revision_number, patient_id, medical_record_version_id, kind,
          source_document_id, source_version, payload, effective_from, status, entered_by,
          published_by, published_at
        ) VALUES (
          ${randomUUID()}, 1, ${patient.patientId}, ${snapshot.data.id}, 'care',
          ${draftSource.data.id}, 1, '{"instructions":"Bad"}'::jsonb, now(), 'draft', ${nurse.staffId},
          ${nurse.staffId}, now()
        )
      `,
      "draft order publication provenance",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.care_orders (
          lineage_id, revision_number, patient_id, medical_record_version_id, kind,
          source_document_id, source_version, payload, effective_from, status, entered_by
        ) VALUES (
          ${randomUUID()}, 1, ${patient.patientId}, ${snapshot.data.id}, 'care',
          ${draftSource.data.id}, 1, '{"instructions":"Bad"}'::jsonb, now(), 'active', ${nurse.staffId}
        )
      `,
      "active order without publication provenance",
    );
  }, 90_000);
});
