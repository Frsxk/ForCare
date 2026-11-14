import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionController } from "../lib/api/session";

const requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const data = (role) => ({
  account: { id: "synthetic-account", email: "synthetic@example.invalid", status: "active", roles: [role] },
  session: { csrfToken: "synthetic-csrf", expiresAt: "2026-11-15T00:00:00.000Z" },
  access: { scopes: role === "nurse" ? ["nurse:directory"] : ["patient:self"], accessContexts: [] },
  displayTimeZone: "Asia/Jakarta", expiresAt: "2026-11-15T00:00:00.000Z", capabilities: {},
});
async function render(controller) {
  const modules = await Promise.all([
    import("../components/session-provider.tsx").catch(() => null),
    import("../components/auth-boundary.tsx").catch(() => null),
  ]);
  assert.ok(modules.every(Boolean), "Session provider and auth boundary must exist");
  const [{ SessionProvider }, { AuthBoundary }] = modules;
  return renderToStaticMarkup(createElement(SessionProvider, { controller },
    createElement(AuthBoundary, null, createElement("div", null, "FAKE_CLINICAL_DASHBOARD"))));
}

test("SSR bootstrap renders only session checking, never fake clinical route children", async () => {
  const html = await render(new SessionController());
  assert.match(html, /Memeriksa sesi/);
  assert.doesNotMatch(html, /FAKE_CLINICAL_DASHBOARD|type="password"/);
});

test("anonymous UI has labeled accessible email/password fields and no role selector", async () => {
  const controller = new SessionController({ fetch: async () => new Response(null, { status: 401 }) });
  await controller.refresh();
  const html = await render(controller);
  assert.match(html, /for="login-email"/);
  assert.match(html, /id="login-email"[^>]*type="email"/);
  assert.match(html, /autoComplete="username"/i);
  assert.match(html, /for="login-password"/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="current-password"/i);
  assert.doesNotMatch(html, /<select|FAKE_CLINICAL_DASHBOARD/);
});

for (const role of ["patient"]) {
  test(`${role} session sees an honest integration placeholder, not the teammate's mock workspace`, async () => {
    const controller = new SessionController({ fetch: async () => new Response(JSON.stringify({ data: data(role), requestId })) });
    await controller.refresh();
    const html = await render(controller);
    assert.match(html, /Anda sudah masuk/);
    assert.match(html, /belum terhubung/);
    assert.match(html, /Keluar/);
    assert.doesNotMatch(html, /FAKE_CLINICAL_DASHBOARD|risiko tinggi|Data Pasien/);
    if (role === "patient") {
      assert.match(html, /akun pasien/i);
      assert.doesNotMatch(html, /Akun perawat/);
    }
  });
}

test("nurse without the directory permission is not mislabeled as a patient", async () => {
  const session = data("nurse");
  session.access.scopes = [];
  const controller = new SessionController({ fetch: async () => new Response(JSON.stringify({ data: session, requestId })) });
  await controller.refresh();
  const html = await render(controller);
  assert.match(html, /Akses ruang kerja perawat belum diberikan/);
  assert.doesNotMatch(html, /menggunakan akun pasien|FAKE_CLINICAL_DASHBOARD/);
});

test("ambiguous logout is visibly uncertain and offers explicit session recheck", async () => {
  const controller = new SessionController({ fetch: async (url) => {
    if (url.endsWith("logout")) throw new TypeError("private transport information");
    return new Response(JSON.stringify({ data: data("nurse"), requestId }));
  } });
  await controller.refresh();
  await assert.rejects(controller.logout());
  const html = await render(controller);
  assert.match(html, /Keluar belum dapat dipastikan/);
  assert.match(html, /Periksa sesi lagi/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /private transport information|Anda telah keluar/);
});

test("session bootstrap failure offers explicit retry instead of demo or false login", async () => {
  const controller = new SessionController({ fetch: async () => { throw new TypeError("offline"); } });
  await controller.refresh();
  const html = await render(controller);
  assert.match(html, /role="alert"/);
  assert.match(html, /Periksa sesi lagi/);
  assert.doesNotMatch(html, /FAKE_CLINICAL_DASHBOARD|Anda sudah masuk/);
});

test("next config installs the server-only fixed-origin rewrite", async () => {
  const config = (await import("../next.config.ts")).default;
  assert.equal(typeof config.rewrites, "function");
  const previous = process.env.FORCARE_BACKEND_ORIGIN;
  try {
    process.env.FORCARE_BACKEND_ORIGIN = "http://backend:3001";
    assert.deepEqual(await config.rewrites(), [{ source: "/api/v1/:path*", destination: "http://backend:3001/api/v1/:path*" }]);
    process.env.FORCARE_BACKEND_ORIGIN = "https://backend.invalid/path";
    await assert.rejects(async () => config.rewrites());
  } finally {
    if (previous === undefined) delete process.env.FORCARE_BACKEND_ORIGIN;
    else process.env.FORCARE_BACKEND_ORIGIN = previous;
  }
});
