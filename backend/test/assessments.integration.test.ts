import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/password";
import { capabilitySnapshot } from "../src/capabilities";
import { createOperatorAssignmentService } from "../src/patients/operator-service";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request } from "./fixtures/test-app";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;

const PATIENT_PASSWORD = "synthetic-min8-password";
const NURSE_PASSWORD = "synthetic-nurse-password";

const INSTRUMENT_COLUMNS = [
  "approved_at",
  "approved_by",
  "code",
  "created_at",
  "definition",
  "g02_evidence_ref",
  "id",
  "name",
  "status",
  "updated_at",
  "version",
].sort();

const RUN_COLUMNS = [
  "computed_at",
  "created_at",
  "id",
  "inputs",
  "instrument_id",
  "patient_id",
  "reviewed_by",
  "score",
  "source_check_in_id",
  "status",
  "unavailable_reason",
  "updated_at",
].sort();

let db: DisposableDatabase;
let operator: ReturnType<typeof createOperatorAssignmentService>;

type Registered = { cookie: string; csrf: string; patientId: string; accountId: string };
type Nurse = { cookie: string; csrf: string; staffId: string; accountId: string };

function appFor() {
  return createTestApp(db.sql, { ip: `127.0.0.${Math.floor(Math.random() * 200) + 1}` }).app;
}

let phoneSequence = 0;

async function registerPatient(email: string, fullName = "Assessment Patient"): Promise<Registered> {
  const app = appFor();
  const phone = `+62812${String(10_000_000 + phoneSequence++).slice(-8)}`;
  const response = await app.handle(
    jsonRequest("/api/v1/auth/register", "POST", {
      fullName,
      birthDate: "1989-08-02",
      gender: "male",
      email,
      phone,
      password: PATIENT_PASSWORD,
    }),
  );
  const bodyText = await response.text();
  expect({ status: response.status, body: bodyText }).toMatchObject({ status: 201 });
  const body = JSON.parse(bodyText) as any;
  return {
    cookie: cookieFrom(response),
    csrf: body.data.session.csrfToken,
    patientId: body.data.patientProfile.id,
    accountId: body.data.account.id,
  };
}

async function setupNurse(label: string, email: string, staffCode: string): Promise<Nurse> {
  const passwordHash = await hashPassword(NURSE_PASSWORD);
  const provisioned = await db.sql.begin((tx) =>
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

async function columnMap(table: string) {
  const rows = (await db.sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
  return new Map(rows.map((row) => [row.column_name, row]));
}

async function insertApprovedInstrument(code: string, staffId: string) {
  const [row] = (await db.sql`
    INSERT INTO public.assessment_instruments (
      code, version, name, status, definition, approved_by, approved_at, g02_evidence_ref
    ) VALUES (
      ${code}, 1, ${`Synthetic ${code}`}, 'approved', '{"synthetic":true}'::jsonb, ${staffId}, now(), 'synthetic-software-test-only'
    )
    RETURNING id, code, version
  `) as unknown as Array<{ id: string; code: string; version: number }>;
  return row;
}

async function insertDraftCheckIn(patientId: string, localDate: string) {
  return db.sql.begin(async (tx) => {
    const [row] = (await tx`
      INSERT INTO public.check_ins (patient_id, local_date, time_zone, condition, medication_adherence, status)
      VALUES (${patientId}, ${localDate}::date, 'Asia/Jakarta', 'ok', 'none', 'draft')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await tx`INSERT INTO public.medication_adherence (check_in_id, status) VALUES (${row.id}, 'none')`;
    return row;
  });
}

integration("T09 assessments preserve the original versioned nullable contract", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("assessments");
    operator = createOperatorAssignmentService({ sql: db.sql, config: { nurseEmailDomain: "nurse.invalid" } });
  }, 90_000);

  afterAll(async () => {
    await db?.close();
  });

  test("schema has the original instrument/run columns, nullable provenance and no legacy draft shapes", async () => {
    const instruments = await columnMap("assessment_instruments");
    expect([...instruments.keys()].sort()).toEqual(INSTRUMENT_COLUMNS);
    expect(instruments.get("version")?.data_type).toBe("integer");
    expect(instruments.get("approved_by")?.is_nullable).toBe("YES");
    expect(instruments.get("approved_at")?.is_nullable).toBe("YES");
    expect(instruments.get("g02_evidence_ref")?.is_nullable).toBe("YES");
    expect(instruments.get("definition")?.is_nullable).toBe("NO");

    const runs = await columnMap("assessment_runs");
    expect([...runs.keys()].sort()).toEqual(RUN_COLUMNS);
    expect(runs.get("instrument_id")?.is_nullable).toBe("YES");
    expect(runs.get("source_check_in_id")?.is_nullable).toBe("YES");
    expect(runs.get("score")?.is_nullable).toBe("YES");
    expect(runs.get("unavailable_reason")?.is_nullable).toBe("YES");
    expect(runs.get("computed_at")?.is_nullable).toBe("YES");
    expect(runs.get("reviewed_by")?.is_nullable).toBe("YES");
    expect(runs.get("inputs")?.is_nullable).toBe("NO");
  }, 90_000);

  test("cursor timestamps use the same millisecond precision as JavaScript serialization", async () => {
    const rows = await db.sql`
      SELECT table_name, column_name, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('medical_record_versions', 'clinical_source_documents', 'care_orders',
          'check_ins', 'check_in_observations', 'observation_confirmations', 'assessment_instruments', 'assessment_runs')
        AND data_type = 'timestamp with time zone'
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.datetime_precision).toBe(3);
  });

  test("instrument versions require approval provenance once approved and stay immutable", async () => {
    await db.sql`
      INSERT INTO public.assessment_instruments (code, version, name, status, definition)
      VALUES ('synthetic_t09_proposed', 1, 'Synthetic proposed', 'proposed', '{"synthetic":true}'::jsonb)
    `;
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_instruments (code, version, name, status, definition)
        VALUES ('synthetic_t09_draft', 1, 'Synthetic draft', 'draft', '{"synthetic":true}'::jsonb)
      `,
      "legacy draft instrument status",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_instruments (code, version, name, status, definition)
        VALUES ('synthetic_t09_proposed', 1, 'Synthetic duplicate', 'proposed', '{"synthetic":true}'::jsonb)
      `,
      "duplicate instrument code/version",
    );
    await db.sql`
      INSERT INTO public.assessment_instruments (code, version, name, status, definition)
      VALUES ('synthetic_t09_proposed', 2, 'Synthetic proposed v2', 'proposed', '{"synthetic":true}'::jsonb)
    `;
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_instruments (code, version, name, status, definition)
        VALUES ('synthetic_t09_bad_approval', 1, 'Synthetic bad approval', 'approved', '{"synthetic":true}'::jsonb)
      `,
      "approved instrument without approval provenance",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_instruments (code, version, name, status, definition)
        VALUES ('synthetic_t09_bad_retired', 1, 'Synthetic bad retired', 'retired', '{"synthetic":true}'::jsonb)
      `,
      "retired instrument without approval provenance",
    );

    const nurse = await setupNurse(
      "T09 Instrument Nurse",
      `assess.instrument.${randomUUID().slice(0, 8)}@nurse.invalid`,
      "NUR-T09-INST-1",
    );
    await expectRejects(
      db.sql`INSERT INTO public.assessment_instruments
        (code, version, name, status, definition, approved_by, approved_at)
        VALUES ('synthetic_missing_g02', 1, 'Missing G02 evidence', 'approved', '{}'::jsonb, ${nurse.staffId}, now())`,
      "approved instrument without G02 evidence",
    );
    const instrument = await insertApprovedInstrument("synthetic_t09_immutable", nurse.staffId);

    await expectRejects(
      db.sql`UPDATE public.assessment_instruments SET definition = '{"changed":true}'::jsonb WHERE id = ${instrument.id}`,
      "instrument definition update",
    );
    await expectRejects(
      db.sql`UPDATE public.assessment_instruments SET version = 9 WHERE id = ${instrument.id}`,
      "instrument version update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.assessment_instruments WHERE id = ${instrument.id}`,
      "instrument delete",
    );

    await db.sql`UPDATE public.assessment_instruments SET status = 'retired' WHERE id = ${instrument.id}`;
    const [retired] = (await db.sql`
      SELECT status, approved_by, approved_at FROM public.assessment_instruments WHERE id = ${instrument.id}
    `) as unknown as Array<{ status: string; approved_by: string | null; approved_at: string | null }>;
    expect(retired.status).toBe("retired");
    expect(retired.approved_by).toBe(nurse.staffId);
    expect(retired.approved_at).not.toBeNull();
    await expectRejects(
      db.sql`UPDATE public.assessment_instruments SET approved_by = NULL, approved_at = NULL WHERE id = ${instrument.id}`,
      "retiring must not erase approval provenance",
    );
  }, 90_000);

  test("run status integrity binds unavailable rows without an instrument and source check-ins to the same patient", async () => {
    const patient = await registerPatient("assess-run-a@example.com", "Assess Run A");
    const other = await registerPatient("assess-run-b@example.com", "Assess Run B");
    const nurse = await setupNurse(
      "T09 Run Nurse",
      `assess.run.${randomUUID().slice(0, 8)}@nurse.invalid`,
      "NUR-T09-RUN-1",
    );
    const ownCheckIn = await insertDraftCheckIn(patient.patientId, "2026-11-11");
    const otherCheckIn = await insertDraftCheckIn(other.patientId, "2026-11-11");

    await db.sql`
      INSERT INTO public.assessment_runs (
        patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
      ) VALUES (
        ${patient.patientId}, NULL, NULL, 'unavailable', 'G02_NOT_APPROVED', NULL, '{"synthetic":true}'::jsonb
      )
    `;
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, NULL, 'recorded', NULL, 10, '{"synthetic":true}'::jsonb
        )
      `,
      "legacy recorded run status",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, NULL, 'unavailable', 'G02_NOT_APPROVED', 10, '{"synthetic":true}'::jsonb
        )
      `,
      "unavailable run carrying a score",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, NULL, 'unavailable', '', NULL, '{"synthetic":true}'::jsonb
        )
      `,
      "unavailable run without a reason",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, NULL, 'available', NULL, 42.5, '{"synthetic":true}'::jsonb
        )
      `,
      "available run without an instrument",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, NULL, 'available', NULL, NULL, '{"synthetic":true}'::jsonb
        )
      `,
      "available run without a score",
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, NULL, 'unavailable', 'G02_NOT_APPROVED', NULL, '[]'::jsonb
        )
      `,
      "inputs must be a JSON object",
    );

    const [proposed] = (await db.sql`
      INSERT INTO public.assessment_instruments (code, version, name, status, definition)
      VALUES ('synthetic_t09_proposed_run', 1, 'Synthetic proposed run', 'proposed', '{"synthetic":true}'::jsonb)
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, ${proposed.id}, NULL, 'available', NULL, 42.5, '{"synthetic":true}'::jsonb
        )
      `,
      "available run with a proposed instrument",
    );

    const approved = await insertApprovedInstrument("synthetic_t09_run_approved", nurse.staffId);
    const [available] = (await db.sql`
      INSERT INTO public.assessment_runs (
        patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
      ) VALUES (
        ${patient.patientId}, ${approved.id}, ${ownCheckIn.id}, 'available', NULL, 42.5, '{"synthetic":true}'::jsonb
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    await expectRejects(
      db.sql`
        INSERT INTO public.assessment_runs (
          patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs
        ) VALUES (
          ${patient.patientId}, NULL, ${otherCheckIn.id}, 'unavailable', 'G02_NOT_APPROVED', NULL, '{"synthetic":true}'::jsonb
        )
      `,
      "cross-patient source check-in binding",
    );
    await expectRejects(
      db.sql`UPDATE public.assessment_runs SET score = 99 WHERE id = ${available.id}`,
      "assessment run update",
    );
    await expectRejects(
      db.sql`DELETE FROM public.assessment_runs WHERE id = ${available.id}`,
      "assessment run delete",
    );
  }, 90_000);

  test("API stays non-numeric for self/primary even when an approved available row exists", async () => {
    const app = appFor();
    const patient = await registerPatient("assess-api-a@example.com", "Assess API A");
    const other = await registerPatient("assess-api-b@example.com", "Assess API B");
    const nurse = await setupNurse(
      "T09 API Primary",
      `assess.api.${randomUUID().slice(0, 8)}@nurse.invalid`,
      "NUR-T09-API-1",
    );
    const unrelated = await setupNurse(
      "T09 API Unrelated",
      `assess.api.un.${randomUUID().slice(0, 8)}@nurse.invalid`,
      "NUR-T09-API-2",
    );
    await assignPrimary(patient, nurse);

    const instrument = await insertApprovedInstrument("synthetic_t09_api", nurse.staffId);
    await db.sql`
      INSERT INTO public.assessment_runs (
        patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs, computed_at, reviewed_by, created_at
      ) VALUES (
        ${patient.patientId}, ${instrument.id}, NULL, 'available', NULL, 42.5, '{"syntheticSource":"t09"}'::jsonb, now(), ${nurse.staffId}, '2026-11-13T12:00:00.123456Z'::timestamptz
      )
    `;
    await db.sql`
      INSERT INTO public.assessment_runs (
        patient_id, instrument_id, source_check_in_id, status, unavailable_reason, score, inputs, created_at
      ) VALUES (
        ${patient.patientId}, NULL, NULL, 'unavailable', 'G02_NOT_APPROVED', NULL, '{"syntheticSource":"t09"}'::jsonb, '2026-11-13T12:00:00.123456Z'::timestamptz
      )
    `;

    const selfView = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/assessments`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(selfView.data).toMatchObject({
      patientId: patient.patientId,
      score: { status: "unavailable", reason: "G02_NOT_APPROVED" },
      lastConfirmedAssessment: null,
      trend: { status: "unavailable", reason: "G02_NOT_APPROVED" },
    });
    expect(Object.keys(selfView.data.score).sort()).toEqual(["reason", "status"]);
    expect(Object.keys(selfView.data.trend).sort()).toEqual(["reason", "status"]);
    expect(selfView.data.history.items).toHaveLength(2);
    for (const item of selfView.data.history.items) {
      expect(item).not.toHaveProperty("score");
      expect(item).not.toHaveProperty("inputs");
      expect(item).not.toHaveProperty("version");
      expect(Object.values(item).every((value) => typeof value !== "number")).toBe(true);
    }
    expect(selfView.data.history.items.some((item: any) => item.instrumentId === null)).toBe(true);
    expect(selfView.data.history.items.some((item: any) => item.instrumentId === instrument.id)).toBe(true);

    const primaryView = await expectStatus(
      await app.handle(request(`/api/v1/patients/${patient.patientId}/assessments`, "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(primaryView.data.score).toEqual({ status: "unavailable", reason: "G02_NOT_APPROVED" });
    expect(primaryView.data.lastConfirmedAssessment).toBeNull();

    expect(
      (await app.handle(request(`/api/v1/patients/${patient.patientId}/assessments`, "GET", { cookie: unrelated.cookie }))).status,
    ).toBe(404);
    expect(
      (await app.handle(request(`/api/v1/patients/${patient.patientId}/assessments`, "GET", { cookie: other.cookie }))).status,
    ).toBe(404);

    const firstPage = await expectStatus(
      await app.handle(
        request(`/api/v1/patients/${patient.patientId}/assessments?limit=1`, "GET", { cookie: nurse.cookie }),
      ),
      200,
    );
    expect(firstPage.data.history.items).toHaveLength(1);
    expect(firstPage.data.history.page.hasMore).toBe(true);
    expect(typeof firstPage.data.history.page.nextCursor).toBe("string");
    const secondPage = await expectStatus(
      await app.handle(
        request(
          `/api/v1/patients/${patient.patientId}/assessments?limit=1&cursor=${encodeURIComponent(firstPage.data.history.page.nextCursor)}`,
          "GET",
          { cookie: nurse.cookie },
        ),
      ),
      200,
    );
    expect(secondPage.data.history.items).toHaveLength(1);
    expect(secondPage.data.history.page.hasMore).toBe(false);
    expect(secondPage.data.history.page.nextCursor).toBeNull();

    const raw = JSON.stringify(selfView);
    expect(raw).not.toContain("42.5");
    expect(raw).not.toContain("42.500");
    expect(raw).not.toContain("syntheticSource");
    expect(raw).not.toContain('"score":42');

    const capabilities = capabilitySnapshot();
    expect(capabilities.clinicalScoring).toEqual({ state: "gated", gate: "G02" });
    expect(capabilities.assessments).toMatchObject({ state: "gated", gate: "G02" });
  }, 90_000);
});
