import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/password";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createOperatorAssignmentService } from "../src/patients/operator-service";
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request } from "./fixtures/test-app";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;

let db: DisposableDatabase;
const PATIENT_PASSWORD = "synthetic-min8-password";
const NURSE_PASSWORD = "synthetic-nurse-password";

type Registered = {
  cookie: string;
  csrf: string;
  patientId: string;
  accountId: string;
};

async function registerPatient(
  app: ReturnType<typeof createTestApp>["app"],
  email: string,
  fullName = "Alice Synthetic",
  ip = "127.0.0.1",
): Promise<Registered> {
  const response = await app.handle(
    jsonRequest(
      "/api/v1/auth/register",
      "POST",
      {
        fullName,
        birthDate: "1990-03-12",
        gender: "female",
        email,
        phone: "+6281234567890",
        password: PATIENT_PASSWORD,
      },
      { "user-agent": `test/${ip}` },
    ),
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

async function login(
  app: ReturnType<typeof createTestApp>["app"],
  email: string,
  password: string,
  ip = "127.0.0.1",
): Promise<{ cookie: string; csrf: string; data: any }> {
  const response = await app.handle(
    jsonRequest("/api/v1/auth/login", "POST", { email, password }, { "user-agent": `test/${ip}` }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  return { cookie: cookieFrom(response), csrf: body.data.session.csrfToken, data: body.data };
}

async function provisionTestNurse(
  label: string,
  email: string,
  staffCode: string,
  active = true,
) {
  const passwordHash = await hashPassword(NURSE_PASSWORD);
  const result = await db.sql.begin((tx) =>
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
  if (!active) {
    await db.sql`UPDATE public.staff SET active = false WHERE id = ${result.staffId}`;
  }
  return { ...result, email, label, staffCode };
}

function patchProfile(
  app: ReturnType<typeof createTestApp>["app"],
  cookie: string,
  csrf: string,
  key: string,
  body: unknown,
) {
  return app.handle(
    jsonRequest("/api/v1/me/profile", "PATCH", body, {
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": key,
    }),
  );
}

function databaseEnv(): Record<string, string> {
  const url = new URL(db.url);
  return {
    DATABASE_HOST: url.hostname,
    DATABASE_PORT: url.port,
    POSTGRES_DB: decodeURIComponent(url.pathname.replace(/^\//, "")),
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    AUTH_NURSE_EMAIL_DOMAIN: "nurse.invalid",
  };
}

async function expectRejects(run: Promise<unknown>, message?: string) {
  try {
    await run;
  } catch (error) {
    if (message) expect(String(error)).toContain(message);
    return;
  }
  throw new Error("expected the operation to reject");
}

integration("owned patient profile and scope integration", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("patients");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  test("0002 contains only approved patient-operation objects and enforces append-only audit", async () => {
    const tables = (
      (await db.sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `) as unknown as Array<{ table_name: string }>
    ).map((row) => row.table_name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "accounts",
        "account_roles",
        "staff",
        "sessions",
        "patients",
        "patient_access_grants",
        "audit_events",
        "idempotency_keys",
        "work_items",
        "outbox_events",
      ]),
    );
    // The disposable database applies every approved migration, so later
    // approved slices legitimately exist here (T08 monitoring included).
    // These future patient-operation tables still do not.
    expect(tables).toContain("check_in_observations");
    for (const laterSlice of [
      "visits",
      "bookings",
      "notifications",
    ]) {
      expect(tables).not.toContain(laterSlice);
    }

    const columns = (await db.sql`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `) as unknown as Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>;
    const column = (table: string, name: string) =>
      columns.find((row) => row.table_name === table && row.column_name === name);
    expect(column("patients", "account_id")).toMatchObject({ is_nullable: "NO" });
    expect(column("patients", "nik_encrypted")).toMatchObject({ data_type: "bytea", is_nullable: "YES" });
    expect(column("patients", "record_number")).toMatchObject({ is_nullable: "YES" });
    expect(column("patient_access_grants", "source_booking_id")).toMatchObject({ data_type: "uuid" });
    expect(column("idempotency_keys", "response_json")).toMatchObject({ data_type: "jsonb" });
    expect(column("outbox_events", "attempts")).toMatchObject({ is_nullable: "NO" });

    const indexes = (await db.sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    `) as unknown as Array<{ indexname: string; indexdef: string }>;
    const grantIndex = indexes.find((row) => row.indexname === "patient_access_grants_active_unique_idx");
    expect(grantIndex?.indexdef).toContain("NULLS NOT DISTINCT");
    expect(grantIndex?.indexdef.toLowerCase()).toContain("where (revoked_at is null)");
    const outboxIndex = indexes.find((row) => row.indexname === "outbox_events_version_unique_idx");
    expect(outboxIndex?.indexdef).toContain("payload");
    expect(outboxIndex?.indexdef).toContain("version");

    const triggers = (await db.sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.audit_events'::regclass AND NOT tgisinternal
    `) as unknown as Array<{ tgname: string }>;
    expect(triggers.map((row) => row.tgname).sort()).toEqual([
      "audit_events_reject_truncate",
      "audit_events_reject_update_delete",
    ]);

    const session = (await db.sql`
      SELECT id, account_id FROM public.sessions LIMIT 1
    `) as unknown as Array<{ id: string; account_id: string }>;
    if (session[0]) {
      const other = (await db.sql`
        SELECT id FROM public.accounts WHERE id <> ${session[0].account_id} LIMIT 1
      `) as unknown as Array<{ id: string }>;
      if (other[0]) {
        await expectRejects(
          db.sql`
            INSERT INTO public.idempotency_keys (
              account_id, session_id, method, resource_key, key, request_hash, status_code, response_json, expires_at
            ) VALUES (
              ${other[0].id}, ${session[0].id}, 'PATCH', '/x', ${"k".repeat(32)}, 'hash', 200, '{}'::jsonb, now() + interval '1 hour'
            )
          `,
          "idempotency_keys_session_account_fkey",
        );
      }
    }
  }, 60_000);

  test("profile patch is versioned, contact-only, idempotent and audited without values", async () => {
    const { app } = createTestApp(db.sql, { ip: "110.0.0.1" });
    const registered = await registerPatient(app, "profile-patient@example.com");
    const profileResponse = await app.handle(
      request("/api/v1/me/profile", "GET", { cookie: registered.cookie }),
    );
    expect(profileResponse.status).toBe(200);
    const profile = ((await profileResponse.json()) as any).data;
    expect(profile).toMatchObject({ role: "patient", version: 0, recordNumber: null });
    expect(profile).not.toHaveProperty("nikEncrypted");
    expect(profile).not.toHaveProperty("insuranceProvider");

    const missingKey = await app.handle(
      jsonRequest(
        "/api/v1/me/profile",
        "PATCH",
        { expectedVersion: 0, phone: "+6281111111111" },
        { cookie: registered.cookie, "x-csrf-token": registered.csrf },
      ),
    );
    expect(missingKey.status).toBe(400);
    expect(((await missingKey.json()) as any).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const unknown = await patchProfile(app, registered.cookie, registered.csrf, randomUUID(), {
      expectedVersion: 0,
      fullName: "Changed",
    });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as any).error.code).toBe("UNKNOWN_FIELD");

    const empty = await patchProfile(app, registered.cookie, registered.csrf, randomUUID(), {
      expectedVersion: 0,
    });
    expect(empty.status).toBe(422);

    const key = randomUUID();
    const changedPhone = "+6281999999999";
    const patchBody = {
      expectedVersion: 0,
      phone: changedPhone,
      addressLine: "Synthetic Street 1",
      emergencyContactName: "Synthetic Contact",
    };
    const patched = await patchProfile(app, registered.cookie, registered.csrf, key, patchBody);
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as any;
    expect(patchedBody.data.version).toBe(1);
    expect(patchedBody.data.phone).toBe(changedPhone);

    const replay = await patchProfile(app, registered.cookie, registered.csrf, key, patchBody);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.data).toEqual(patchedBody.data);
    expect(replayBody.requestId).not.toBe(patchedBody.requestId);
    const stored = (await db.sql`
      SELECT phone, version FROM public.patients WHERE id = ${registered.patientId}
    `) as unknown as Array<{ phone: string; version: number }>;
    expect(stored[0]).toEqual({ phone: changedPhone, version: 1 });

    const conflict = await patchProfile(app, registered.cookie, registered.csrf, key, {
      ...patchBody,
      expectedVersion: 1,
      phone: "+6281888888888",
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any).error.code).toBe("IDEMPOTENCY_CONFLICT");

    const stale = await patchProfile(app, registered.cookie, registered.csrf, randomUUID(), {
      expectedVersion: 0,
      phone: "+6281777777777",
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as any;
    expect(staleBody.error.code).toBe("VERSION_CONFLICT");
    expect(staleBody.error.details.currentVersion).toBe(1);

    const audit = (await db.sql`
      SELECT action, after::text AS after_text FROM public.audit_events
      WHERE subject_id = ${registered.patientId} AND action = 'patient.profile.contact_updated'
    `) as unknown as Array<{ action: string; after_text: string }>;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].after_text).toContain("phone");
    expect(audit[0].after_text).not.toContain(changedPhone);
    expect(audit[0].after_text).not.toContain("Synthetic Street");
    expect(audit[0].after_text).not.toContain("Synthetic Contact");

    const logout = await app.handle(
      jsonRequest("/api/v1/auth/logout", "POST", {}, {
        cookie: registered.cookie,
        "x-csrf-token": registered.csrf,
      }),
    );
    expect(logout.status).toBe(204);
    const replayAfterRevocation = await patchProfile(
      app,
      registered.cookie,
      registered.csrf,
      key,
      patchBody,
    );
    expect(replayAfterRevocation.status).toBe(401);
  }, 60_000);

  test("nurse self-profile accepts only phone and never patient contact fields", async () => {
    const nurse = await provisionTestNurse("Profile Nurse", "profile-nurse@nurse.invalid", "NUR-PROFILE");
    const { app } = createTestApp(db.sql, { ip: "110.0.0.2" });
    const nurseLogin = await login(app, nurse.email, NURSE_PASSWORD);

    const rejected = await patchProfile(app, nurseLogin.cookie, nurseLogin.csrf, randomUUID(), {
      expectedVersion: 0,
      addressLine: "Not allowed",
    });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()) as any).error.code).toBe("UNKNOWN_FIELD");

    const patched = await patchProfile(app, nurseLogin.cookie, nurseLogin.csrf, randomUUID(), {
      expectedVersion: 0,
      phone: "+6281222222222",
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).data).toMatchObject({
      role: "nurse",
      phone: "+6281222222222",
      version: 1,
    });
  }, 30_000);

  test("nurse self-profile can explicitly clear phone with null", async () => {
    const nurse = await provisionTestNurse("Null Phone Nurse", "null-phone@nurse.invalid", "NUR-NULL-PHONE");
    const { app } = createTestApp(db.sql, { ip: "110.0.0.12" });
    const nurseLogin = await login(app, nurse.email, NURSE_PASSWORD, "110.0.0.12");

    const set = await patchProfile(app, nurseLogin.cookie, nurseLogin.csrf, randomUUID(), {
      expectedVersion: 0,
      phone: "+6281333333333",
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as any).data.phone).toBe("+6281333333333");

    const cleared = await patchProfile(app, nurseLogin.cookie, nurseLogin.csrf, randomUUID(), {
      expectedVersion: 1,
      phone: null,
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as any).data).toMatchObject({ role: "nurse", phone: null, version: 2 });

    const stored = (await db.sql`
      SELECT phone, version FROM public.staff WHERE id = ${nurse.staffId}
    `) as unknown as Array<{ phone: string | null; version: number }>;
    expect(stored[0]).toEqual({ phone: null, version: 2 });
  }, 30_000);

  test("operator CLI assigns a reviewed record number through the real service", async () => {
    const { app } = createTestApp(db.sql, { ip: "110.0.0.11" });
    const patient = await registerPatient(app, "cli-assignment@example.com", "CLI Assignment", "110.0.0.11");
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "scripts/patient-assignment.ts",
        "record",
        "--patient-id",
        patient.patientId,
        "--record-number",
        "RM-CLI-001",
        "--expected-version",
        "0",
        "--operator",
        "cli-operator",
        "--approval-ref",
        "approval-cli-1",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, ...databaseEnv() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
    expect(result).toMatchObject({ patientId: patient.patientId, version: 1, recordNumber: "RM-CLI-001" });
    expect(stderr).not.toContain("postgresql://");
    const row = (await db.sql`
      SELECT record_number, version FROM public.patients WHERE id = ${patient.patientId}
    `) as unknown as Array<{ record_number: string; version: number }>;
    expect(row[0]).toEqual({ record_number: "RM-CLI-001", version: 1 });

    const duplicate = Bun.spawn(
      [
        process.execPath,
        "run",
        "scripts/patient-assignment.ts",
        "record",
        "--patient-id",
        patient.patientId,
        "--record-number",
        "RM-CLI-002",
        "--expected-version",
        "0",
        "--operator",
        "cli-operator",
        "--approval-ref",
        "approval-cli-2",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, ...databaseEnv() },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [duplicateOut, duplicateErr, duplicateExit] = await Promise.all([
      new Response(duplicate.stdout).text(),
      new Response(duplicate.stderr).text(),
      duplicate.exited,
    ]);
    expect(duplicateExit).not.toBe(0);
    expect(`${duplicateOut}\n${duplicateErr}`).toContain("VERSION_CONFLICT");
  }, 60_000);

  test("nurse directory is active-only, minimal and cursor-paginated", async () => {
    const patient = await registerPatient(
      createTestApp(db.sql, { ip: "110.0.0.3" }).app,
      "directory-patient@example.com",
      "Directory Patient",
      "110.0.0.3",
    );
    const zara = await provisionTestNurse("Zara Active", "zara@nurse.invalid", "NUR-DIR-1");
    const ayu = await provisionTestNurse("Ayu Active", "ayu-dir@nurse.invalid", "NUR-DIR-2");
    const inactive = await provisionTestNurse("Bima Inactive", "bima-dir@nurse.invalid", "NUR-DIR-3", false);
    const domainDrift = await provisionTestNurse("Dewi Drift", "dewi-dir@nurse.invalid", "NUR-DIR-4");
    await db.sql`
      UPDATE public.staff SET provisioning_email_domain = 'other.invalid' WHERE id = ${domainDrift.staffId}
    `;
    const emailDrift = await provisionTestNurse("Eka Email Drift", "eka-dir@nurse.invalid", "NUR-DIR-5");
    await db.sql`
      UPDATE public.accounts SET email_normalized = 'eka-dir@example.com' WHERE id = ${emailDrift.accountId}
    `;
    const unapproved = await provisionTestNurse("Fajar Unapproved", "fajar-dir@nurse.invalid", "NUR-DIR-6");
    await db.sql`UPDATE public.staff SET identity_approval_ref = '' WHERE id = ${unapproved.staffId}`;

    const { app } = createTestApp(db.sql, { ip: "110.0.0.4" });
    const first = await app.handle(
      request("/api/v1/nurses?limit=1", "GET", { cookie: patient.cookie }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.page.hasMore).toBe(true);
    expect(firstBody.data.page.nextCursor).toBeTruthy();
    const row = firstBody.data.items[0];
    expect(Object.keys(row).sort()).toEqual(["active", "displayName", "id", "staffCode", "workingWindowSummary"]);
    expect(row).not.toHaveProperty("email");
    expect(row).not.toHaveProperty("phone");
    expect(row.workingWindowSummary).toBeNull();
    expect(row.active).toBe(true);

    const ids = [row.id];
    let cursor = firstBody.data.page.nextCursor as string | null;
    for (let page = 0; page < 10 && cursor; page += 1) {
      const next = await app.handle(
        request(`/api/v1/nurses?limit=1&cursor=${encodeURIComponent(cursor)}`, "GET", {
          cookie: patient.cookie,
        }),
      );
      expect(next.status).toBe(200);
      const nextBody = (await next.json()) as any;
      expect(nextBody.data.items).toHaveLength(1);
      ids.push(nextBody.data.items[0].id);
      cursor = nextBody.data.page.hasMore ? nextBody.data.page.nextCursor : null;
    }
    expect(cursor).toBeNull();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(zara.staffId);
    expect(ids).toContain(ayu.staffId);
    expect(ids).not.toContain(inactive.staffId);
    expect(ids).not.toContain(domainDrift.staffId);
    expect(ids).not.toContain(emailDrift.staffId);
    expect(ids).not.toContain(unapproved.staffId);

    const nurseLogin = await login(app, zara.email, NURSE_PASSWORD);
    const nurseDirectory = await app.handle(
      request("/api/v1/nurses", "GET", { cookie: nurseLogin.cookie }),
    );
    expect(nurseDirectory.status).toBe(200);

    const patientList = await app.handle(
      request("/api/v1/patients?scope=assigned", "GET", { cookie: patient.cookie }),
    );
    expect(patientList.status).toBe(403);
    const missingScope = await app.handle(
      request("/api/v1/patients", "GET", { cookie: nurseLogin.cookie }),
    );
    expect(missingScope.status).toBe(422);
    expect(((await missingScope.json()) as any).error.code).toBe("SCOPE_REQUIRED");
    const empty = await app.handle(
      request("/api/v1/patients?scope=assigned", "GET", { cookie: nurseLogin.cookie }),
    );
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as any).data.items).toEqual([]);

    const access = await app.handle(request("/api/v1/me/access", "GET", { cookie: nurseLogin.cookie }));
    const accessBody = (await access.json()) as any;
    expect(accessBody.data.scopes).toEqual(["nurse:directory"]);
    expect(accessBody.data.accessContexts).toEqual([]);

    const guessed = randomUUID();
    for (const path of [`/api/v1/patients/${guessed}/summary`, `/api/v1/patients/${guessed}?scope=assigned`]) {
      const response = await app.handle(request(path, "GET", { cookie: nurseLogin.cookie }));
      expect(response.status).toBe(404);
    }
    for (const path of [`/api/v1/patients/${guessed}`, `/api/v1/patients/${guessed}?scope=visit:${randomUUID()}`]) {
      const response = await app.handle(request(path, "GET", { cookie: nurseLogin.cookie }));
      expect(response.status).toBe(path.includes("scope=") ? 503 : 422);
    }
    const tooLarge = await app.handle(
      request("/api/v1/nurses?limit=101", "GET", { cookie: patient.cookie }),
    );
    expect(tooLarge.status).toBe(422);
  }, 60_000);

  test("operator assignment synchronizes record number, primary nurse, grants and audit", async () => {
    const appAndIp = createTestApp(db.sql, { ip: "110.0.0.5" });
    const alice = await registerPatient(appAndIp.app, "alice@example.com", "Alice Synthetic", "110.0.0.5");
    const bob = await registerPatient(appAndIp.app, "bob@example.com", "Bob Synthetic", "110.0.0.6");
    const nurseOne = await provisionTestNurse("Nora One", "nora.one@nurse.invalid", "NUR-AS-1");
    const nurseTwo = await provisionTestNurse("Nora Two", "nora.two@nurse.invalid", "NUR-AS-2");
    const operator = createOperatorAssignmentService({
      sql: db.sql,
      config: { nurseEmailDomain: "nurse.invalid" },
    });

    const record = await operator.assignRecordNumber({
      patientId: alice.patientId,
      recordNumber: "RM-2026-001",
      expectedVersion: 0,
      operator: "synthetic-operator",
      approvalReference: "approval-assignment-1",
    });
    expect(record.version).toBe(1);
    const assignment = await operator.assignPrimaryNurse({
      patientId: alice.patientId,
      nurseId: nurseOne.staffId,
      expectedVersion: 1,
      operator: "synthetic-operator",
      approvalReference: "approval-assignment-2",
    });
    expect(assignment.version).toBe(2);

    const patientRows = (await db.sql`
      SELECT record_number, primary_nurse_id, version FROM public.patients WHERE id = ${alice.patientId}
    `) as unknown as Array<{ record_number: string; primary_nurse_id: string; version: number }>;
    expect(patientRows[0]).toEqual({
      record_number: "RM-2026-001",
      primary_nurse_id: nurseOne.staffId,
      version: 2,
    });
    const grants = (await db.sql`
      SELECT id, staff_id, basis, revoked_at, source_booking_id, source_visit_id
      FROM public.patient_access_grants WHERE patient_id = ${alice.patientId}
    `) as unknown as Array<any>;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      id: assignment.grantId,
      staff_id: nurseOne.staffId,
      basis: "primary",
      revoked_at: null,
      source_booking_id: null,
      source_visit_id: null,
    });

    const auditCount = (await db.sql`
      SELECT count(*)::int AS count FROM public.audit_events
      WHERE subject_id = ${alice.patientId}
        AND action IN ('patient.record_number.assigned', 'patient.primary_nurse.assigned')
    `) as unknown as Array<{ count: number }>;
    expect(auditCount[0].count).toBe(2);
    const outboxCount = (await db.sql`
      SELECT count(*)::int AS count FROM public.outbox_events WHERE aggregate_id = ${alice.patientId}
    `) as unknown as Array<{ count: number }>;
    expect(outboxCount[0].count).toBe(2);

    const nurseOneLogin = await login(appAndIp.app, nurseOne.email, NURSE_PASSWORD, "110.0.0.7");
    const list = await appAndIp.app.handle(
      request("/api/v1/patients?scope=assigned", "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as any;
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      id: alice.patientId,
      displayName: "Alice Synthetic",
      recordNumber: "RM-2026-001",
      latestCheckIn: null,
      nextVisit: null,
    });

    const searchScoped = await appAndIp.app.handle(
      request("/api/v1/patients?scope=assigned&search=bob", "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(((await searchScoped.json()) as any).data.items).toEqual([]);
    const searchRecord = await appAndIp.app.handle(
      request("/api/v1/patients?scope=assigned&search=RM-2026-001", "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(((await searchRecord.json()) as any).data.items).toHaveLength(1);

    const summary = await appAndIp.app.handle(
      request(`/api/v1/patients/${alice.patientId}/summary`, "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(summary.status).toBe(200);
    expect(((await summary.json()) as any).data.activeOrderCount).toBe(0);

    const detail = await appAndIp.app.handle(
      request(`/api/v1/patients/${alice.patientId}?scope=assigned`, "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as any;
    expect(detailBody.data).toMatchObject({
      id: alice.patientId,
      displayName: "Alice Synthetic",
      recordNumber: "RM-2026-001",
      version: 2,
      access: { scope: "assigned" },
      profile: { birthDate: "1990-03-12", gender: "female" },
      primaryNurse: { id: nurseOne.staffId, displayName: "Nora One" },
      availableSections: ["profile", "care_guide"],
    });
    for (const forbidden of ["email", "phone", "nik", "insurance", "internalNote"]) {
      expect(detailBody.data).not.toHaveProperty(forbidden);
    }

    const nurseTwoLogin = await login(appAndIp.app, nurseTwo.email, NURSE_PASSWORD, "110.0.0.8");
    const outOfScope = await appAndIp.app.handle(
      request(`/api/v1/patients/${alice.patientId}?scope=assigned`, "GET", { cookie: nurseTwoLogin.cookie }),
    );
    expect(outOfScope.status).toBe(404);

    const reassigned = await operator.assignPrimaryNurse({
      patientId: alice.patientId,
      nurseId: nurseTwo.staffId,
      expectedVersion: 2,
      operator: "synthetic-operator",
      approvalReference: "approval-assignment-3",
    });
    expect(reassigned.version).toBe(3);
    const afterReassign = (await db.sql`
      SELECT staff_id, revoked_at FROM public.patient_access_grants
      WHERE patient_id = ${alice.patientId}
      ORDER BY granted_at
    `) as unknown as Array<{ staff_id: string; revoked_at: Date | string | null }>;
    expect(afterReassign).toHaveLength(2);
    expect(afterReassign[0]).toMatchObject({ staff_id: nurseOne.staffId });
    expect(afterReassign[0].revoked_at).not.toBeNull();
    expect(afterReassign[1]).toMatchObject({ staff_id: nurseTwo.staffId, revoked_at: null });

    const oldNurseList = await appAndIp.app.handle(
      request("/api/v1/patients?scope=assigned", "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(((await oldNurseList.json()) as any).data.items).toEqual([]);
    const oldNurseDetail = await appAndIp.app.handle(
      request(`/api/v1/patients/${alice.patientId}?scope=assigned`, "GET", { cookie: nurseOneLogin.cookie }),
    );
    expect(oldNurseDetail.status).toBe(404);
    const newDetail = await appAndIp.app.handle(
      request(`/api/v1/patients/${alice.patientId}?scope=assigned`, "GET", { cookie: nurseTwoLogin.cookie }),
    );
    expect(newDetail.status).toBe(200);
    expect(((await newDetail.json()) as any).data.primaryNurse.id).toBe(nurseTwo.staffId);

    await operator.assignPrimaryNurse({
      patientId: bob.patientId,
      nurseId: nurseTwo.staffId,
      expectedVersion: 0,
      operator: "synthetic-operator",
      approvalReference: "approval-assignment-4",
    });

    const pageOne = await appAndIp.app.handle(
      request("/api/v1/patients?scope=assigned&limit=1", "GET", { cookie: nurseTwoLogin.cookie }),
    );
    const pageOneBody = (await pageOne.json()) as any;
    expect(pageOneBody.data.items).toHaveLength(1);
    expect(pageOneBody.data.page.hasMore).toBe(true);
    const pageTwo = await appAndIp.app.handle(
      request(
        `/api/v1/patients?scope=assigned&limit=1&cursor=${encodeURIComponent(pageOneBody.data.page.nextCursor)}`,
        "GET",
        { cookie: nurseTwoLogin.cookie },
      ),
    );
    const pageTwoBody = (await pageTwo.json()) as any;
    expect(pageTwoBody.data.items).toHaveLength(1);
    expect(pageOneBody.data.items[0].id).not.toBe(pageTwoBody.data.items[0].id);

    const secondSession = await login(appAndIp.app, nurseTwo.email, NURSE_PASSWORD, "110.0.0.9");
    const crossSessionCursor = await appAndIp.app.handle(
      request(
        `/api/v1/patients?scope=assigned&limit=1&cursor=${encodeURIComponent(pageOneBody.data.page.nextCursor)}`,
        "GET",
        { cookie: secondSession.cookie },
      ),
    );
    expect(crossSessionCursor.status).toBe(422);
    const tampered = await appAndIp.app.handle(
      request(
        `/api/v1/patients?scope=assigned&limit=1&cursor=${encodeURIComponent(`${pageOneBody.data.page.nextCursor}x`)}`,
        "GET",
        { cookie: nurseTwoLogin.cookie },
      ),
    );
    expect(tampered.status).toBe(422);

    const duplicateRecord = await (async () => {
      try {
        await operator.assignRecordNumber({
          patientId: bob.patientId,
          recordNumber: "RM-2026-001",
          expectedVersion: 1,
          operator: "synthetic-operator",
          approvalReference: "approval-assignment-5",
        });
        return null;
      } catch (error) {
        return error as any;
      }
    })();
    expect(duplicateRecord?.code).toBe("VALIDATION_FAILED");

    const nik = await (async () => {
      try {
        await operator.assignRecordNumber({
          patientId: bob.patientId,
          recordNumber: "1234567890123456",
          expectedVersion: 1,
          operator: "synthetic-operator",
          approvalReference: "approval-assignment-6",
        });
        return null;
      } catch (error) {
        return error as any;
      }
    })();
    expect(nik?.message).toContain("NIK");

    const stale = await (async () => {
      try {
        await operator.assignRecordNumber({
          patientId: alice.patientId,
          recordNumber: "RM-2026-999",
          expectedVersion: 0,
          operator: "synthetic-operator",
          approvalReference: "approval-assignment-7",
        });
        return null;
      } catch (error) {
        return error as any;
      }
    })();
    expect(stale?.code).toBe("VERSION_CONFLICT");

    const auditRedaction = (await db.sql`
      SELECT after::text AS after_text FROM public.audit_events
      WHERE subject_id = ${alice.patientId} AND action = 'patient.primary_nurse.assigned'
    `) as unknown as Array<{ after_text: string }>;
    expect(auditRedaction.length).toBeGreaterThan(0);
    expect(auditRedaction[0].after_text).not.toContain("Alice");
    expect(auditRedaction[0].after_text).not.toContain("RM-2026-001");

    await expectRejects(
      db.sql`
        INSERT INTO public.outbox_events (aggregate_type, aggregate_id, event_type, payload)
        VALUES ('patient', ${alice.patientId}, 'patient.primary_nurse.assigned', '{"version":3}'::jsonb)
      `,
    );

    await db.sql`
      UPDATE public.patient_access_grants
      SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 hour'
      WHERE patient_id = ${bob.patientId} AND revoked_at IS NULL
    `;
    const expiredDetail = await appAndIp.app.handle(
      request(`/api/v1/patients/${bob.patientId}?scope=assigned`, "GET", { cookie: nurseTwoLogin.cookie }),
    );
    expect(expiredDetail.status).toBe(404);
    const expiredList = await appAndIp.app.handle(
      request("/api/v1/patients?scope=assigned", "GET", { cookie: nurseTwoLogin.cookie }),
    );
    expect(
      ((await expiredList.json()) as any).data.items.map((item: any) => item.id),
    ).not.toContain(bob.patientId);
  }, 90_000);

  test("0002 rejects invalid grant source combinations and audit mutation", async () => {
    const app = createTestApp(db.sql, { ip: "110.0.0.10" }).app;
    const patient = await registerPatient(app, "grant-check@example.com", "Grant Check", "110.0.0.10");
    const nurse = await provisionTestNurse("Grant Nurse", "grant.nurse@nurse.invalid", "NUR-GRANT");

    await expectRejects(
      db.sql`
        INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
        VALUES (${nurse.staffId}, ${patient.patientId}, 'request_intake')
      `,
    );
    await expectRejects(
      db.sql`
        INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id)
        VALUES (${nurse.staffId}, ${patient.patientId}, 'primary', ${randomUUID()})
      `,
    );
    const first = (await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
      VALUES (${nurse.staffId}, ${patient.patientId}, 'primary')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await expectRejects(
      db.sql`
        INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
        VALUES (${nurse.staffId}, ${patient.patientId}, 'primary')
      `,
      "patient_access_grants_active_unique_idx",
    );
    await db.sql`UPDATE public.patient_access_grants SET revoked_at = now() WHERE id = ${first[0].id}`;
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
      VALUES (${nurse.staffId}, ${patient.patientId}, 'primary')
    `;

    const auditCount = (await db.sql`
      SELECT count(*)::int AS count FROM public.audit_events WHERE subject_id = ${patient.accountId}
    `) as unknown as Array<{ count: number }>;
    expect(auditCount[0].count).toBeGreaterThan(0);
    await expectRejects(
      db.sql`UPDATE public.audit_events SET action = 'tampered' WHERE subject_id = ${patient.accountId}`,
      "append-only",
    );
    await expectRejects(
      db.sql`DELETE FROM public.audit_events WHERE subject_id = ${patient.accountId}`,
      "append-only",
    );
  }, 60_000);
});
