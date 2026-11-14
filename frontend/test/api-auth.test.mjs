import { test } from "bun:test";
import assert from "node:assert/strict";

// Synthetic protocol fixtures, never evidence of a live server or browser session.
const requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const key = "1cc54131-069b-470f-9750-601bccbbdd21";
const loginData = (role = "nurse") => ({
  account: { id: "e7252d86-af4d-465b-b242-27fa26040f17", email: "synthetic@example.invalid", status: "active", roles: [role] },
  session: { csrfToken: "synthetic-csrf", expiresAt: "2026-11-15T00:00:00.000Z" },
  access: { scopes: role === "nurse" ? ["nurse:directory"] : ["patient:self"], accessContexts: [] },
});
const sessionData = (role = "nurse") => ({ ...loginData(role), displayTimeZone: "Asia/Jakarta", expiresAt: "2026-11-15T00:00:00.000Z", capabilities: { clinicalScoring: { state: "gated", gate: "G02" } } });
const ok = (data) => new Response(JSON.stringify({ data, requestId }), { headers: { "content-type": "application/json" } });
const failed = (status, code) => new Response(JSON.stringify({ error: { code, message: "private sql/password text", requestId, details: { password: "secret", currentVersion: 7 } } }), { status });
const identity = (value) => value;
async function load(name) {
  const implementation = await import(`../lib/api/${name}.ts`).catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  });
  assert.ok(implementation, `Missing ${name} implementation`);
  return implementation;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("transport unwraps data with same-origin credentials, no-store and abort signal", async () => {
  const { createApiClient } = await load("client");
  const controller = new AbortController();
  const client = createApiClient({ fetch: async (url, init) => {
    assert.equal(url, "/api/v1/auth/session");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.signal, controller.signal);
    return ok({ value: 3 });
  } });
  assert.deepEqual(await client.request("/api/v1/auth/session", identity, { signal: controller.signal }), { value: 3 });
});

test("transport rejects arbitrary origins and traversal before fetching", async () => {
  const { createApiClient } = await load("client");
  let calls = 0;
  const client = createApiClient({ fetch: async () => { calls++; return ok({}); } });
  for (const path of ["https://evil.invalid/api/v1/auth/session", "//evil.invalid/api/v1/auth/session", "/api/v1/../private", "/api/v1/%2e%2e/private", "/api/v1/\\evil", "/other"]) {
    await assert.rejects(client.request(path, identity), (error) => error.code === "CLIENT_CONFIG_ERROR");
  }
  assert.equal(calls, 0);
});

test("bare 413 becomes sanitized typed payload error", async () => {
  const { createApiClient, ApiError } = await load("client");
  const client = createApiClient({ fetch: async () => new Response("private proxy HTML", { status: 413 }) });
  await assert.rejects(client.request("/api/v1/auth/session", identity), (error) => error instanceof ApiError && error.status === 413 && error.code === "PAYLOAD_TOO_LARGE" && !JSON.stringify(error).includes("private"));
});

test("structured errors retain only safe metadata, never server messages or details", async () => {
  const { createApiClient } = await load("client");
  const client = createApiClient({ fetch: async () => failed(409, "VERSION_CONFLICT") });
  await assert.rejects(client.request("/api/v1/auth/session", identity), (error) => {
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.requestId, requestId);
    assert.equal(error.details, undefined);
    assert.ok(!error.message.includes("private"));
    assert.ok(!JSON.stringify(error).includes("secret"));
    return true;
  });
});

test("malformed success fails closed; malformed errors honor status and Retry-After", async () => {
  const { createApiClient } = await load("client");
  const client = createApiClient({ fetch: async () => new Response("not JSON", { status: 200 }) });
  await assert.rejects(client.request("/api/v1/auth/session", identity), (error) => error.code === "INVALID_RESPONSE");
  const limited = createApiClient({ fetch: async () => new Response("html", { status: 429, headers: { "retry-after": "12" } }) });
  await assert.rejects(limited.request("/api/v1/auth/session", identity), (error) => error.code === "RATE_LIMITED" && error.retryAfterSeconds === 12);
});

test("network and abort failures are typed without retrying", async () => {
  const { createApiClient } = await load("client");
  let calls = 0;
  const client = createApiClient({ fetch: async () => { calls++; throw new TypeError("private network location"); } });
  await assert.rejects(client.request("/api/v1/auth/session", identity), (error) => error.code === "NETWORK_ERROR" && !error.message.includes("private"));
  assert.equal(calls, 1);
  const aborted = createApiClient({ fetch: async () => { throw new DOMException("aborted", "AbortError"); } });
  await assert.rejects(aborted.request("/api/v1/auth/session", identity), (error) => error.code === "REQUEST_ABORTED");
});

test("unsafe auth writes require in-memory CSRF and authenticated 401 clears it", async () => {
  const { createApiClient } = await load("client");
  let calls = 0;
  let expired = 0;
  const client = createApiClient({ onUnauthorized: () => expired++, fetch: async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get("x-csrf-token"), "synthetic-csrf");
    assert.equal(init.body, "{}");
    return failed(401, "SESSION_EXPIRED");
  } });
  await assert.rejects(client.request("/api/v1/auth/logout", identity, { method: "POST", json: {}, empty: true }), (error) => error.code === "CSRF_REQUIRED");
  assert.equal(calls, 0);
  client.setCsrfToken("synthetic-csrf");
  await assert.rejects(client.request("/api/v1/auth/logout", identity, { method: "POST", json: {}, empty: true }), (error) => error.status === 401);
  assert.equal(expired, 1);
  await assert.rejects(client.request("/api/v1/auth/logout", identity, { method: "POST", json: {} }), (error) => error.code === "CSRF_REQUIRED");
  assert.equal(calls, 1);
});

test("an old authenticated 401 cannot invalidate a newly installed session", async () => {
  const { createApiClient } = await load("client");
  const old = deferred();
  let expired = 0;
  const client = createApiClient({ fetch: () => old.promise, onUnauthorized: () => expired++ });
  client.setCsrfToken("old");
  const pending = client.request("/api/v1/auth/session", identity);
  client.setCsrfToken("new");
  old.resolve(failed(401, "UNAUTHENTICATED"));
  await assert.rejects(pending);
  assert.equal(expired, 0);
});

test("domain write intent snapshots body and reuses exact key without automatic retries", async () => {
  const { createApiClient, prepareWrite } = await load("client");
  const body = { expectedVersion: 2, phone: "+620000" };
  const intent = prepareWrite("/api/v1/me/profile", "PATCH", body, key);
  body.phone = "changed";
  let calls = 0;
  const client = createApiClient({ fetch: async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get("idempotency-key"), key);
    assert.equal(new Headers(init.headers).get("x-csrf-token"), "csrf");
    assert.equal(init.body, '{"expectedVersion":2,"phone":"+620000"}');
    return failed(409, "VERSION_CONFLICT");
  } });
  client.setCsrfToken("csrf");
  await assert.rejects(client.write(intent, identity));
  assert.equal(calls, 1);
  await assert.rejects(client.write(intent, identity));
  assert.equal(calls, 2);
  assert.ok(Object.isFrozen(intent));
  assert.throws(() => prepareWrite("/api/v1/me/profile", "PATCH", {}, " bad-key "));
});

test("auth decoder follows actual login/session access shape and fails closed on roles", async () => {
  const { decodeLogin, decodeSession, canUseNurseWorkspace } = await load("contracts");
  assert.deepEqual(decodeLogin(loginData()), loginData());
  assert.deepEqual(decodeSession(sessionData()), sessionData());
  assert.equal(canUseNurseWorkspace(sessionData()), true);
  const patient = sessionData("patient");
  patient.access.scopes.push("nurse:directory");
  assert.equal(canUseNurseWorkspace(patient), false);
  assert.equal(canUseNurseWorkspace({ ...sessionData(), access: { scopes: [], accessContexts: [] } }), false);
  assert.throws(() => decodeSession({ ...sessionData(), account: { ...sessionData().account, roles: ["admin"] } }));
  assert.throws(() => decodeSession({ ...sessionData(), access: { patientIds: [] } }));
  const withContext = sessionData();
  withContext.access.accessContexts = [{ basis: "primary", patientId: "e7252d86-af4d-465b-b242-27fa26040f17", expiresAt: null }];
  assert.equal(decodeSession(withContext).access.accessContexts[0].expiresAt, null);
});

test("bootstrap starts checking and authenticated 401 yields anonymous, never a demo", async () => {
  const { SessionController } = await load("session");
  const controller = new SessionController({ fetch: async () => failed(401, "UNAUTHENTICATED") });
  assert.equal(controller.getSnapshot().status, "checking");
  await controller.refresh();
  assert.equal(controller.getSnapshot().status, "anonymous");
});

test("login posts email/password only then verifies cookie persistence with session GET", async () => {
  const { SessionController } = await load("session");
  const calls = [];
  const controller = new SessionController({ fetch: async (url, init) => {
    calls.push(url);
    if (url.endsWith("login")) {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { email: "synthetic@example.invalid", password: "synthetic password" });
      assert.equal(new Headers(init.headers).get("x-csrf-token"), null);
      return ok(loginData());
    }
    assert.equal(init.method, "GET");
    return ok(sessionData());
  } });
  await controller.login({ email: "synthetic@example.invalid", password: "synthetic password", role: "admin" });
  assert.deepEqual(calls, ["/api/v1/auth/login", "/api/v1/auth/session"]);
  assert.equal(controller.getSnapshot().status, "authenticated");
});

test("login is not accepted as authenticated when secure cookie was not retained", async () => {
  const { SessionController } = await load("session");
  const controller = new SessionController({ fetch: async (url) => url.endsWith("login") ? ok(loginData()) : failed(401, "UNAUTHENTICATED") });
  await assert.rejects(controller.login({ email: "synthetic@example.invalid", password: "synthetic password" }));
  assert.equal(controller.getSnapshot().status, "anonymous");
});

test("invalid credentials remain anonymous, logout revokes before local clearing", async () => {
  const { SessionController } = await load("session");
  const pending = deferred();
  const controller = new SessionController({ fetch: async (url, init) => {
    if (url.endsWith("login")) return failed(401, "INVALID_CREDENTIALS");
    if (url.endsWith("logout")) {
      assert.equal(init.method, "POST");
      assert.equal(init.body, "{}");
      assert.equal(new Headers(init.headers).get("x-csrf-token"), "synthetic-csrf");
      return pending.promise;
    }
    return ok(sessionData());
  } });
  await assert.rejects(controller.login({ email: "synthetic@example.invalid", password: "bad" }), (error) => error.code === "INVALID_CREDENTIALS");
  assert.equal(controller.getSnapshot().status, "anonymous");
  await controller.refresh();
  const logout = controller.logout();
  assert.equal(controller.getSnapshot().status, "authenticated");
  assert.equal(controller.getSnapshot().loggingOut, true);
  pending.resolve(new Response(null, { status: 204 }));
  await logout;
  assert.equal(controller.getSnapshot().status, "anonymous");
});

test("ambiguous logout failure retains session with honest error and does not retry", async () => {
  const { SessionController } = await load("session");
  let logoutCalls = 0;
  const controller = new SessionController({ fetch: async (url) => {
    if (url.endsWith("logout")) { logoutCalls++; throw new TypeError("offline"); }
    return ok(sessionData());
  } });
  await controller.refresh();
  await assert.rejects(controller.logout());
  assert.equal(controller.getSnapshot().status, "authenticated");
  assert.equal(controller.getSnapshot().loggingOut, false);
  assert.equal(controller.getSnapshot().logoutError.code, "NETWORK_ERROR");
  assert.equal(logoutCalls, 1);
});

test("late bootstrap cannot overwrite a later successful login", async () => {
  const { SessionController } = await load("session");
  const old = deferred();
  let sessionReads = 0;
  const controller = new SessionController({ fetch: async (url) => {
    if (url.endsWith("login")) return ok(loginData());
    if (++sessionReads === 1) return old.promise;
    return ok(sessionData());
  } });
  const bootstrap = controller.refresh();
  await controller.login({ email: "synthetic@example.invalid", password: "synthetic password" });
  old.resolve(failed(401, "UNAUTHENTICATED"));
  await bootstrap;
  assert.equal(controller.getSnapshot().status, "authenticated");
});

test("proxy targets only fixed /api/v1 path and rejects unsafe origin config", async () => {
  const { apiRewrite } = await load("proxy");
  assert.deepEqual(apiRewrite(), { source: "/api/v1/:path*", destination: "http://127.0.0.1:3001/api/v1/:path*" });
  assert.equal(apiRewrite("http://backend:3001").destination, "http://backend:3001/api/v1/:path*");
  for (const value of ["https://user:password@backend.invalid", "https://backend.invalid/other", "https://backend.invalid?url=evil", "https://backend.invalid#fragment", "file:///etc/passwd", " https://backend.invalid"]) assert.throws(() => apiRewrite(value));
});
