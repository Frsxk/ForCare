import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { SessionProvider } from "../components/session-provider.tsx";
import { AuthBoundary } from "../components/auth-boundary.tsx";
import { SessionController } from "../lib/api/session.ts";
import { decodeRegistration } from "../lib/api/contracts.ts";

// Synthetic protocol fixtures; not evidence of a live registration or browser.
const requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const account = { id: "synthetic-patient", email: "synthetic@example.invalid", status: "active", roles: ["patient"] };
const session = { csrfToken: "synthetic-csrf", expiresAt: "2026-11-15T00:00:00.000Z" };
const registration = { account, patientProfile: { id: "synthetic-profile", fullName: "Synthetic Patient", recordNumber: null }, session };
const sessionData = { account, session, access: { scopes: ["patient:self"], accessContexts: [] }, displayTimeZone: "Asia/Jakarta", expiresAt: session.expiresAt, capabilities: {} };
const input = { fullName: "Synthetic Patient", birthDate: "2000-01-01", gender: "female", email: account.email, phone: "+620000", password: "synthetic-only-password" };
const ok = (data, status = 200) => new Response(JSON.stringify({ data, requestId }), { status });
const failed = (status, code) => new Response(JSON.stringify({ error: { code, requestId } }), { status });
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("registration decoder follows the distinct patient/session DTO and rejects role escalation", () => {
  assert.deepEqual(decodeRegistration(registration), registration);
  assert.throws(() => decodeRegistration({ ...registration, account: { ...account, roles: ["nurse"] } }));
  assert.throws(() => decodeRegistration({ ...registration, patientProfile: undefined }));
  assert.throws(() => decodeRegistration({ ...registration, patientProfile: { ...registration.patientProfile, recordNumber: "unexpected" } }));
});

test("registration posts exact fields with no role and confirms the issued cookie by GET", async () => {
  const calls = [];
  const controller = new SessionController({ fetch: async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, "same-origin");
    if (url.endsWith("register")) {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), input);
      assert.equal(new Headers(init.headers).get("x-csrf-token"), null);
      return ok(registration, 201);
    }
    assert.equal(init.method, "GET");
    return ok(sessionData);
  } });
  await controller.register({ ...input, role: "nurse", extra: "discard" });
  assert.deepEqual(calls, ["/api/v1/auth/register", "/api/v1/auth/session"]);
  assert.equal(controller.getSnapshot().status, "authenticated");
  assert.equal(controller.getSnapshot().session.account.roles[0], "patient");
});

for (const kind of ["network", "malformed", "server", "session-network", "session-401", "wrong-session"]) {
  test(`registration ${kind} remains uncertain and blocks blind retry`, async () => {
    let writes = 0;
    const controller = new SessionController({ fetch: async (url) => {
      if (url.endsWith("register")) {
        writes++;
        if (kind === "network") throw new TypeError("private transport text");
        if (kind === "malformed") return ok({});
        if (kind === "server") return failed(500, "INTERNAL");
        return ok(registration, 201);
      }
      if (kind === "session-401") return failed(401, "UNAUTHENTICATED");
      if (kind === "wrong-session") return ok({ ...sessionData, account: { ...account, id: "another-account" } });
      throw new TypeError("offline");
    } });
    await assert.rejects(controller.register(input));
    assert.notEqual(controller.getSnapshot().status, "authenticated");
    assert.equal(controller.isRegistrationUncertain(), true);
    await assert.rejects(controller.register(input));
    assert.equal(writes, 1);
    assert.ok(!JSON.stringify(controller.getSnapshot()).includes(input.password));
  });
}

test("a definitive registration validation failure allows a corrected explicit submission", async () => {
  let calls = 0;
  const controller = new SessionController({ fetch: async () => { calls++; return failed(422, "VALIDATION_FAILED"); } });
  await assert.rejects(controller.register(input));
  assert.equal(controller.isRegistrationUncertain(), false);
  await assert.rejects(controller.register(input));
  assert.equal(calls, 2);
});

test("registration exposes and submits only female or male gender values", () => {
  const forms = source("../components/auth-pages.tsx");
  const select = forms.match(/<select id="register-gender"[\s\S]*?<\/select>/)?.[0];
  assert.ok(select, "registration gender select is present");
  const values = [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
  assert.deepEqual(values, ["female", "male"]);
  assert.match(select, />Perempuan</);
  assert.match(select, />Laki-laki</);
  assert.match(forms, /gender !== "male" && gender !== "female"\) return/);
  assert.match(source("../lib/api/contracts.ts"), /gender: "male" \| "female";/);
});

test("auth routes preserve teammate visual system without mock handlers, role selection or wrong asset paths", () => {
  const forms = source("../components/auth-pages.tsx");
  assert.match(forms, /auth-layout/);
  assert.match(forms, /controller\.login\(/);
  assert.match(forms, /controller\.register\(/);
  assert.match(forms, /name="fullName"/);
  for (const gender of ["female", "male"]) assert.ok(forms.includes(`value="${gender}"`));
  assert.match(forms, /auth-brand-wordmark/);
  assert.match(source("../components/auth-brand-wordmark.tsx"), /auth-brand-wordmark-for/);
  assert.match(source("../components/auth-brand-wordmark.tsx"), /auth-brand-wordmark-care/);
  assert.match(forms, /\/images\/forcare-logo\.png/);
  assert.doesNotMatch(forms, /backend tersedia|name="role"|localStorage|sessionStorage|console\./);
  assert.match(forms, /password\.value = ""/);
  assert.match(forms, /return \(\) =>/);
  assert.match(source("../components/login-page.tsx"), /export .*LoginPage/);
  assert.match(source("../app/login/page.tsx"), /LoginPage/);
  assert.match(source("../app/daftar/page.tsx"), /RegisterPage/);
});

test("boundary isolates provider trees by exact role and route, with shared logout", () => {
  const boundary = source("../components/auth-boundary.tsx");
  assert.match(boundary, /pathname === "\/daftar" \? <RegisterPage/);
  assert.match(boundary, /pathname === "\/pasien" \|\| pathname\?\.startsWith\("\/pasien\/"\)/);
  assert.match(boundary, /if \(patient && patientRoute\)/);
  assert.match(boundary, /<PatientWorkspaceProvider[^>]*>\{children\}<\/PatientWorkspaceProvider>/);
  assert.match(boundary, /if \(nurse && nurseRoute\)/);
  assert.match(boundary, /<NurseWorkspaceProvider[^>]*>\{children\}<\/NurseWorkspaceProvider>/);
  assert.match(boundary, /href="\/pasien"/);
  assert.match(boundary, /SessionActions/);
  assert.doesNotMatch(boundary, /router\.(push|replace)|redirect\(/);
  const header = source("../components/nurse-header.tsx");
  assert.match(header, /<SessionActions\s*\/>/);
  assert.match(header, /useNurseProfile/);
  assert.doesNotMatch(header, /dashboard-data|nurse\.name/);
});

async function renderRoute(role, pathname) {
  const data = role === "anonymous" ? null : {
    ...sessionData,
    account: { ...account, roles: [role] },
    access: { scopes: role === "nurse" ? ["nurse:directory"] : ["patient:self"], accessContexts: [] },
  };
  const controller = new SessionController({ fetch: async () => data ? ok(data) : failed(401, "UNAUTHENTICATED") });
  await controller.refresh();
  return renderToStaticMarkup(createElement(SessionProvider, { controller },
    createElement(PathnameContext.Provider, { value: pathname },
      createElement(AuthBoundary, null, createElement("div", null, "SYNTHETIC_ROUTE_CHILD")))));
}

test("anonymous /daftar renders registration; other routes render real login", async () => {
  const signup = await renderRoute("anonymous", "/daftar");
  assert.match(signup, /Buat akun ForCare|name="fullName"/);
  assert.doesNotMatch(signup, /SYNTHETIC_ROUTE_CHILD/);
  const login = await renderRoute("anonymous", "/pasien");
  assert.match(login, /id="login-email"/);
  assert.doesNotMatch(login, /SYNTHETIC_ROUTE_CHILD|name="gender"/);
});

for (const [role, pathname, home] of [["patient", "/", "/pasien"], ["nurse", "/pasien", "/"], ["patient", "/login", "/pasien"], ["nurse", "/daftar", "/"], ["patient", "/pasien-rekam-medis", "/pasien"]]) {
  test(`${role} on ${pathname} gets the correct home link, not route children`, async () => {
    const html = await renderRoute(role, pathname);
    assert.match(html, /Anda sudah masuk/);
    assert.ok(html.includes(`href="${home}"`));
    assert.match(html, /Keluar/);
    assert.doesNotMatch(html, /SYNTHETIC_ROUTE_CHILD/);
  });
}

test("matching patient and nurse route children are visible only inside their own provider", async () => {
  assert.match(await renderRoute("patient", "/pasien/check-in"), /SYNTHETIC_ROUTE_CHILD/);
  assert.match(await renderRoute("nurse", "/jadwal-kunjungan"), /SYNTHETIC_ROUTE_CHILD/);
});

test("session recheck after an uncertain delivery cannot unlock blind registration retry", async () => {
  let writes = 0;
  const controller = new SessionController({ fetch: async (url) => {
    if (url.endsWith("register")) { writes++; throw new TypeError("offline"); }
    return failed(401, "UNAUTHENTICATED");
  } });
  await assert.rejects(controller.register(input));
  await controller.refresh();
  assert.equal(controller.isRegistrationUncertain(), true);
  await assert.rejects(controller.register(input));
  assert.equal(writes, 1);
});
