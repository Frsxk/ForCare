import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientLiveShell, PatientUnavailable, PatientLivePage } from "../components/patient-live-pages";
import { SessionProvider } from "../components/session-provider";
import { PatientWorkspaceProvider } from "../components/patient-workspace-provider";
import { SessionController } from "../lib/api/session";
const profile = { role: "patient", id: "da5fca18-0822-4001-b503-dd2fb9fca072", accountId: "c312c603-7d47-4c90-9d66-c387e391a988", fullName: "Nama Aman Server", birthDate: "1990-01-01", gender: "male", phone: "08123456789", addressLine: null, emergencyContactName: null, emergencyContactPhone: null, recordNumber: "RM-SERVER", primaryNurse: null, version: 0 };
async function authenticatedController() {
 const session = { account: { id: profile.accountId, email: "patient@example.invalid", roles: ["patient"], status: "active" }, session: { csrfToken: "csrf", expiresAt: "2026-11-15T00:00:00Z" }, access: { scopes: ["patient:self"], accessContexts: [] }, displayTimeZone: "Asia/Jakarta", expiresAt: "2026-11-15T00:00:00Z", capabilities: {} };
 const controller = new SessionController({ fetch: async () => new Response(JSON.stringify({ data: session, requestId: "ed2e4ce9-4774-4260-b242-27fa26040f17" })) });
 await controller.refresh(); return controller;
}
test("live shell uses server patient identity with responsive teammate classes and route navigation", async () => {
 const controller = await authenticatedController();
 const html = renderToStaticMarkup(createElement(SessionProvider, { controller }, createElement(PatientLiveShell, { section: "dashboard", profile }, createElement("p", null, "LIVE_CHILD"))));
 assert.match(html, /Nama Aman Server/); assert.match(html, /RM-SERVER/); assert.match(html, /LIVE_CHILD/); assert.match(html, /patient-header-inner/); assert.match(html, /patient-nav/); assert.match(html, /aria-label="Buka menu"/); assert.match(html, /href="\/pasien\/check-in"/); assert.match(html, /aria-current="page"/);
 assert.doesNotMatch(html, /Ilham|Dinda|HC-0014|Obat A|internalNote|inputSnapshot|risiko tinggi/);
 assert.match(html, /images%2Fforcare-brand.png|\/images\/forcare-brand.png/);
 assert.match(html, />Keluar<\/button>/);
});
for (const section of ["homecare", "booking", "notifications"]) test(`${section} is explicitly unavailable with no fake saves or editable fixtures`, () => {
 const html = renderToStaticMarkup(createElement(PatientUnavailable, { section })); assert.match(html, /belum tersedia/);
 if (section === "homecare") assert.match(html, /href="\/pasien\/homecare\/pesan"/); assert.doesNotMatch(html, /<form|<input|<button|HC-0014|Dinda|Berhasil/);
});
test("patient logout remains reachable while own profile is loading or failed", async () => {
 const controller = await authenticatedController();
 const { getPatientWorkspace } = await import("../lib/api/workspaces");
 const workspace = getPatientWorkspace(controller);
 const render = () => renderToStaticMarkup(createElement(SessionProvider, { controller }, createElement(PatientWorkspaceProvider, null, createElement(PatientLivePage, { section: "profile" }))));
 assert.match(render(), />Keluar<\/button>/);
 await workspace.profile.load(async () => { throw Error("offline"); });
 const html = render(); assert.match(html, /role="alert"/); assert.match(html, />Keluar<\/button>/);
});
test("all patient routes select live integration instead of rendering preserved demo components", async () => {
 for (const route of ["", "check-in/", "panduan/", "profil/", "profil/kontak/", "homecare/", "homecare/pesan/", "notifikasi/"]) { const source = await readFile(new URL(`../app/pasien/${route}page.tsx`, import.meta.url), "utf8"); assert.match(source, /patient-live-pages/); assert.match(source, /PatientLivePage/); }
 const source = await readFile(new URL("../components/patient-live-pages.tsx", import.meta.url), "utf8"); assert.match(source, /patient-dashboard.css/); assert.match(source, /patient-checkin-page.css/); assert.doesNotMatch(source, /localStorage|window.alert|setTimeout|inputSnapshot|internalNote/);
});
