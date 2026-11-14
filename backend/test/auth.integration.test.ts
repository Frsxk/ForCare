import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/password";
import { FixedWindowRateLimiter } from "../src/http/rate-limit";
import { MAX_REQUEST_BODY_BYTES } from "../src/http/request";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request, TEST_ORIGIN } from "./fixtures/test-app";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;

let db: DisposableDatabase;

const PATIENT_PASSWORD = "synthetic-min8-password";

function registrationBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    fullName: "Synthetic Patient",
    birthDate: "1990-03-12",
    gender: "female",
    email,
    phone: "+6281234567890",
    password: PATIENT_PASSWORD,
    ...overrides,
  };
}

async function register(
  app: ReturnType<typeof createTestApp>["app"],
  email: string,
  overrides: Record<string, unknown> = {},
  ip = "127.0.0.1",
) {
  return app.handle(jsonRequest("/api/v1/auth/register", "POST", registrationBody(email, overrides), { "user-agent": `test/${ip}` }));
}

async function login(
  app: ReturnType<typeof createTestApp>["app"],
  email: string,
  password = PATIENT_PASSWORD,
  ip = "127.0.0.1",
) {
  return app.handle(jsonRequest("/api/v1/auth/login", "POST", { email, password }, { "user-agent": `test/${ip}` }));
}

integration("identity and session integration", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("auth");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  test("registration creates exactly one patient account, profile and opaque session", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.1" });
    const response = await register(app, "register-success@example.com");
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.data.account.roles).toEqual(["patient"]);
    expect(body.data.account.status).toBe("active");
    expect(body.data.patientProfile.recordNumber).toBeNull();
    expect(body.data.patientProfile.fullName).toBe("Synthetic Patient");
    expect(body.data.session.csrfToken.length).toBeGreaterThan(20);
    expect(body.data.session.expiresAt).toMatch(/Z$/);

    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-forcare_session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Domain=");
    expect(setCookie).not.toContain(PATIENT_PASSWORD);

    const rows = (await db.sql`
      SELECT a.id AS account_id, a.password_hash, a.status, r.role,
             p.id AS patient_id, p.full_name, encode(s.token_hash, 'hex') AS token_hash,
             encode(s.csrf_hash, 'hex') AS csrf_hash, s.expires_at
      FROM public.accounts a
      JOIN public.account_roles r ON r.account_id = a.id
      JOIN public.patients p ON p.account_id = a.id
      JOIN public.sessions s ON s.account_id = a.id
      WHERE a.email_normalized = 'register-success@example.com'
    `) as unknown as Array<any>;
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("patient");
    expect(rows[0].status).toBe("active");
    expect(rows[0].password_hash).toStartWith("$argon2id$");
    expect(rows[0].password_hash).not.toContain(PATIENT_PASSWORD);
    expect(rows[0].token_hash).toHaveLength(64);
    expect(rows[0].csrf_hash).toHaveLength(64);
    expect(JSON.stringify(body)).not.toContain(PATIENT_PASSWORD);
    expect(JSON.stringify(body)).not.toContain(rows[0].token_hash);
  }, 30_000);

  test("duplicate registration is generic and never promotes a nurse-domain signup", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.2" });
    expect((await register(app, "duplicate@example.com")).status).toBe(201);
    const duplicate = await register(app, "DUPLICATE@example.com ");
    expect(duplicate.status).toBe(409);
    const duplicateBody = (await duplicate.json()) as any;
    expect(duplicateBody.error.code).toBe("REGISTRATION_UNAVAILABLE");
    expect(JSON.stringify(duplicateBody)).not.toContain("duplicate@example.com");
    const count = (await db.sql`
      SELECT count(*)::int AS count FROM public.accounts WHERE email_normalized = 'duplicate@example.com'
    `) as unknown as Array<{ count: number }>;
    expect(count[0].count).toBe(1);

    const nurseDomain = await register(app, "public@nurse.invalid");
    expect(nurseDomain.status).toBe(201);
    const nurseBody = (await nurseDomain.json()) as any;
    expect(nurseBody.data.account.roles).toEqual(["patient"]);

    const unknown = await register(app, "unknown-field@example.com", { role: "nurse" });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as any).error.code).toBe("UNKNOWN_FIELD");

    const invalidDate = await register(app, "bad-date@example.com", { birthDate: "1990-02-30" });
    expect(invalidDate.status).toBe(422);
    expect(((await invalidDate.json()) as any).error.code).toBe("VALIDATION_FAILED");
  }, 30_000);

  test("registration rejects unsupported genders without creating identities", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.15" });
    for (const gender of ["other", "undisclosed"]) {
      const email = `restricted-gender-${gender}@example.com`;
      const response = await register(app, email, { gender });
      expect(response.status).toBe(422);
      expect(((await response.json()) as any).error.code).toBe("VALIDATION_FAILED");
    }
    const identities = (await db.sql`
      SELECT count(DISTINCT a.id)::int AS accounts,
             count(DISTINCT p.id)::int AS patients,
             count(DISTINCT s.id)::int AS sessions
      FROM public.accounts a
      LEFT JOIN public.patients p ON p.account_id = a.id
      LEFT JOIN public.sessions s ON s.account_id = a.id
      WHERE a.email_normalized IN (
        'restricted-gender-other@example.com',
        'restricted-gender-undisclosed@example.com'
      )
    `) as unknown as Array<{ accounts: number; patients: number; sessions: number }>;
    expect(identities).toEqual([{ accounts: 0, patients: 0, sessions: 0 }]);
  }, 30_000);

  test("login failures are indistinguishable and disabled/staff-revoked accounts revalidate", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.3" });
    await register(app, "generic-login@example.com");
    const unknown = await login(app, "missing@example.com", "wrong-password");
    const wrong = await login(app, "generic-login@example.com", "wrong-password");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(((await unknown.json()) as any).error).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(((await wrong.json()) as any).error).toMatchObject({ code: "INVALID_CREDENTIALS" });

    await db.sql`UPDATE public.accounts SET status = 'disabled' WHERE email_normalized = 'generic-login@example.com'`;
    expect((await login(app, "generic-login@example.com")).status).toBe(401);

    const passwordHash = await hashPassword("nurse-synthetic-password");
    const nurseEmail = "login-nurse@nurse.invalid";
    const nurse = await db.sql.begin((tx) =>
      provisionNurseInTransaction(tx, {
        email: nurseEmail,
        passwordHash,
        staffCode: "NUR-AUTH-1",
        displayName: "Login Nurse",
        approvalReference: "approval-auth-1",
        operator: "operator-auth",
        nurseDomain: "nurse.invalid",
      }),
    );
    const nurseApp = createTestApp(db.sql, { ip: "100.0.0.4" });
    const nurseLogin = await login(nurseApp.app, nurseEmail, "nurse-synthetic-password");
    expect(nurseLogin.status).toBe(200);
    expect(((await nurseLogin.json()) as any).data.account.roles).toEqual(["nurse"]);
    const nurseCookie = cookieFrom(nurseLogin);

    await db.sql`UPDATE public.staff SET active = false WHERE id = ${nurse.staffId}`;
    const afterStaffDisable = await nurseApp.app.handle(
      request("/api/v1/auth/session", "GET", { cookie: nurseCookie }),
    );
    expect(afterStaffDisable.status).toBe(401);

    await db.sql`UPDATE public.staff SET active = true WHERE id = ${nurse.staffId}`;
    await db.sql`UPDATE public.accounts SET status = 'disabled' WHERE id = ${nurse.accountId}`;
    const afterAccountDisable = await nurseApp.app.handle(
      request("/api/v1/auth/session", "GET", { cookie: nurseCookie }),
    );
    expect(afterAccountDisable.status).toBe(401);
  }, 45_000);

  test("session GET recovers the same CSRF token and logout requires origin, CSRF and revokes server-side", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.5" });
    const registered = await register(app, "session-flow@example.com");
    const registeredBody = (await registered.json()) as any;
    const cookie = cookieFrom(registered);
    const csrf = registeredBody.data.session.csrfToken;

    const session = await app.handle(request("/api/v1/auth/session", "GET", { cookie }));
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as any;
    expect(sessionBody.data.session.csrfToken).toBe(csrf);
    expect(sessionBody.data.capabilities.knowledgeRetrieval.state).toBe("gated");
    expect(sessionBody.data.capabilities.clinicalScoring.state).toBe("gated");
    expect(sessionBody.data.capabilities.dailySummaries.gate).toBe("G02");
    expect(sessionBody.data.capabilities.webPush.gate).toBe("G05");

    const missingOrigin = await app.handle(
      new Request("http://127.0.0.1/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(missingOrigin.status).toBe(403);
    expect(((await missingOrigin.json()) as any).error.code).toBe("ORIGIN_REJECTED");

    const missingCsrf = await app.handle(jsonRequest("/api/v1/auth/logout", "POST", {}, { cookie }));
    expect(missingCsrf.status).toBe(403);
    expect(((await missingCsrf.json()) as any).error.code).toBe("CSRF_INVALID");

    const wrongCsrf = await app.handle(
      jsonRequest("/api/v1/auth/logout", "POST", {}, { cookie, "x-csrf-token": "wrong" }),
    );
    expect(wrongCsrf.status).toBe(403);

    const logout = await app.handle(
      jsonRequest("/api/v1/auth/logout", "POST", {}, { cookie, "x-csrf-token": csrf }),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await app.handle(request("/api/v1/auth/session", "GET", { cookie }));
    expect(after.status).toBe(401);

    const revoked = (await db.sql`
      SELECT s.revoked_at FROM public.sessions s
      JOIN public.accounts a ON a.id = s.account_id
      WHERE a.email_normalized = 'session-flow@example.com'
    `) as unknown as Array<{ revoked_at: Date | string | null }>;
    expect(revoked[0].revoked_at).not.toBeNull();

    const second = await login(app, "session-flow@example.com");
    const secondCookie = cookieFrom(second);
    await db.sql`
      UPDATE public.sessions
      SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      WHERE id = (SELECT id FROM public.sessions ORDER BY created_at DESC LIMIT 1)
    `;
    const expired = await app.handle(request("/api/v1/auth/session", "GET", { cookie: secondCookie }));
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as any).error.code).toBe("SESSION_EXPIRED");
  }, 45_000);

  test("login, session and me/access report only real active grant bases", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.12" });
    const registered = await register(app, "grant-scopes@example.com");
    const patientId = ((await registered.json()) as any).data.patientProfile.id;
    const passwordHash = await hashPassword("nurse-synthetic-password");

    const provision = (email: string, staffCode: string) =>
      db.sql.begin((tx) =>
        provisionNurseInTransaction(tx, {
          email,
          passwordHash,
          staffCode,
          displayName: staffCode,
          approvalReference: `approval-${staffCode}`,
          operator: "operator-grants",
          nurseDomain: "nurse.invalid",
        }),
      );

    const intake = await provision("intake@nurse.invalid", "NUR-GRANT-INTAKE");
    const visit = await provision("visit@nurse.invalid", "NUR-GRANT-VISIT");
    const primary = await provision("primary@nurse.invalid", "NUR-GRANT-PRIMARY");
    const expired = await provision("expired@nurse.invalid", "NUR-GRANT-EXPIRED");
    const revoked = await provision("revoked@nurse.invalid", "NUR-GRANT-REVOKED");

    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_booking_id)
      VALUES (${intake.staffId}, ${patientId}, 'request_intake', ${randomUUID()})
    `;
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis, source_visit_id)
      VALUES (${visit.staffId}, ${patientId}, 'visit', ${randomUUID()})
    `;
    await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
      VALUES (${primary.staffId}, ${patientId}, 'primary')
    `;
    await db.sql`
      INSERT INTO public.patient_access_grants (
        staff_id, patient_id, basis, source_visit_id, granted_at, expires_at
      ) VALUES (
        ${expired.staffId}, ${patientId}, 'visit', ${randomUUID()},
        now() - interval '2 days', now() - interval '1 hour'
      )
    `;
    const revokedGrant = (await db.sql`
      INSERT INTO public.patient_access_grants (staff_id, patient_id, basis)
      VALUES (${revoked.staffId}, ${patientId}, 'primary')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await db.sql`UPDATE public.patient_access_grants SET revoked_at = now() WHERE id = ${revokedGrant[0].id}`;

    const expected = {
      intake: ["nurse:directory", "nurse:request_intake"],
      visit: ["nurse:directory", "nurse:visit"],
      primary: ["nurse:directory", "nurse:assigned"],
      none: ["nurse:directory"],
    } as const;

    const signIn = async (email: string) => {
      const response = await login(app, email, "nurse-synthetic-password");
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      return { cookie: cookieFrom(response), csrf: body.data.session.csrfToken, data: body.data };
    };

    for (const [email, scopes, basis] of [
      ["intake@nurse.invalid", expected.intake, "request_intake"],
      ["visit@nurse.invalid", expected.visit, "visit"],
      ["primary@nurse.invalid", expected.primary, "primary"],
    ] as const) {
      const loggedIn = await signIn(email);
      expect(loggedIn.data.access.scopes).toEqual([...scopes]);
      expect(loggedIn.data.access.accessContexts).toEqual([
        { basis, patientId, expiresAt: null },
      ]);
      expect(loggedIn.data.access.scopes).not.toContain(basis === "primary" ? "nurse:request_intake" : "nurse:assigned");

      const session = await app.handle(
        request("/api/v1/auth/session", "GET", { cookie: loggedIn.cookie }),
      );
      expect(session.status).toBe(200);
      expect(((await session.json()) as any).data.access.scopes).toEqual([...scopes]);

      const access = await app.handle(
        request("/api/v1/me/access", "GET", { cookie: loggedIn.cookie }),
      );
      expect(access.status).toBe(200);
      expect(((await access.json()) as any).data).toEqual({
        scopes: [...scopes],
        accessContexts: [{ basis, patientId, expiresAt: null }],
      });
    }

    for (const [email, scopes] of [
      ["expired@nurse.invalid", expected.none],
      ["revoked@nurse.invalid", expected.none],
    ] as const) {
      const loggedIn = await signIn(email);
      expect(loggedIn.data.access).toEqual({ scopes: [...scopes], accessContexts: [] });

      const session = await app.handle(
        request("/api/v1/auth/session", "GET", { cookie: loggedIn.cookie }),
      );
      expect(((await session.json()) as any).data.access).toEqual({
        scopes: [...scopes],
        accessContexts: [],
      });
      const access = await app.handle(
        request("/api/v1/me/access", "GET", { cookie: loggedIn.cookie }),
      );
      expect(((await access.json()) as any).data).toEqual({
        scopes: [...scopes],
        accessContexts: [],
      });
    }
  }, 60_000);

  test("logout with an optional pushSubscriptionId still revokes only the current session", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.13" });
    await register(app, "logout-push@example.com");
    const signIn = async (ip: string) => {
      const response = await login(app, "logout-push@example.com", PATIENT_PASSWORD, ip);
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      return { cookie: cookieFrom(response), csrf: body.data.session.csrfToken };
    };
    const first = await signIn("100.0.0.14");
    const second = await signIn("100.0.0.15");
    const pushSubscriptionId = randomUUID();

    const logout = await app.handle(
      jsonRequest(
        "/api/v1/auth/logout",
        "POST",
        { pushSubscriptionId },
        { cookie: first.cookie, "x-csrf-token": first.csrf },
      ),
    );
    expect(logout.status).toBe(204);

    const current = await app.handle(request("/api/v1/auth/session", "GET", { cookie: first.cookie }));
    expect(current.status).toBe(401);
    const other = await app.handle(request("/api/v1/auth/session", "GET", { cookie: second.cookie }));
    expect(other.status).toBe(200);

    const sessions = (await db.sql`
      SELECT s.revoked_at
      FROM public.sessions s
      JOIN public.accounts a ON a.id = s.account_id
      WHERE a.email_normalized = 'logout-push@example.com'
      ORDER BY s.created_at, s.id
    `) as unknown as Array<{ revoked_at: Date | string | null }>;
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((row) => row.revoked_at !== null)).toHaveLength(1);

    const audit = (await db.sql`
      SELECT coalesce(after::text, '') AS after_text
      FROM public.audit_events
      WHERE action = 'session.logout' AND subject_id = (
        SELECT id FROM public.accounts WHERE email_normalized = 'logout-push@example.com'
      )
    `) as unknown as Array<{ after_text: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0].after_text).not.toContain(pushSubscriptionId);
  }, 45_000);

  test("enforces approved login and registration rate limits with Retry-After", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.6" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(app, "rate-limit@example.com", "wrong-password");
      expect(response.status).toBe(401);
    }
    const blockedLogin = await login(app, "rate-limit@example.com", "wrong-password");
    expect(blockedLogin.status).toBe(429);
    expect(Number(blockedLogin.headers.get("retry-after"))).toBeGreaterThan(0);

    const registerApp = createTestApp(db.sql, { ip: "100.0.0.7" }).app;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await register(registerApp, `rate-register-${attempt}@example.com`)).status).toBe(201);
    }
    const blockedRegistration = await register(registerApp, "rate-register-blocked@example.com");
    expect(blockedRegistration.status).toBe(429);
    expect(Number(blockedRegistration.headers.get("retry-after"))).toBeGreaterThan(0);
  }, 45_000);

  test("bounds pre-auth login work per IP even when every email differs", async () => {
    const { app } = createTestApp(db.sql, {
      ip: "100.0.0.8",
      rateLimiters: {
        loginIp: new FixedWindowRateLimiter({ limit: 3, windowMs: 15 * 60_000 }),
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await login(app, `missing-${attempt}@example.com`, "wrong-password");
      expect(response.status).toBe(401);
    }
    const blocked = await login(app, "another-missing@example.com", "wrong-password");
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as any).error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const malformed = await app.handle(new Request("http://127.0.0.1/api/v1/auth/login", {
      method: "POST", headers: { origin: TEST_ORIGIN, "content-type": "application/json" }, body: "{",
    }));
    expect(malformed.status).toBe(429);
  }, 30_000);

  test("native HTTP applies the structured body cap without app.handle", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.10" });
    app.listen({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: (await import("../src/http/request")).MAX_TRANSPORT_BODY_BYTES });
    try {
      const response = await fetch(`http://127.0.0.1:${app.server!.port}/api/v1/auth/login`, {
        method: "POST", headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: "missing@example.invalid", password: "x".repeat(40_000) }),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally { await app.stop(); }
  }, 30_000);

  test("oversized login body returns a structured 413 before credentials are checked", async () => {
    const { app } = createTestApp(db.sql, { ip: "100.0.0.9" });
    const response = await app.handle(
      new Request("http://127.0.0.1/api/v1/auth/login", {
        method: "POST",
        headers: {
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as any).error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: expect.stringContaining("32768"),
    });
  }, 30_000);
});
