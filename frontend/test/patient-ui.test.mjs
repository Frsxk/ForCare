import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientLiveShell, PatientUnavailable, PatientLivePage, PatientGuideSections, patientGuideSections, PatientNotificationList } from "../components/patient-live-pages";
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
});
for (const section of ["homecare", "booking", "notifications"]) test(`${section} is explicitly unavailable with no fake saves or editable fixtures`, () => {
 const html = renderToStaticMarkup(createElement(PatientUnavailable, { section })); assert.match(html, /belum tersedia/);
 if (section === "homecare") assert.match(html, /href="\/pasien\/homecare\/pesan"/); assert.doesNotMatch(html, /<form|<input|HC-0014|Dinda|Berhasil/);
 if (section !== "notifications") assert.doesNotMatch(html, /<button/);
});
test("live notifications restore the original shell with unavailable unread status and disabled mark-all", async () => {
 const controller = await authenticatedController();
 const { getPatientWorkspace } = await import("../lib/api/workspaces");
 await getPatientWorkspace(controller).profile.load(async () => profile);
 const html = renderToStaticMarkup(createElement(SessionProvider, { controller }, createElement(PatientWorkspaceProvider, null, createElement(PatientLivePage, { section: "notifications" }))));
 assert.equal([...html.matchAll(/class="patient-header"/g)].length, 1);
 assert.equal([...html.matchAll(/<h1>Notifikasi<\/h1>/g)].length, 1);
 for (const className of ["notifications-heading", "notification-tabs", "notifications-list", "notifications-empty"]) assert.ok(html.includes(`class="${className}"`));
 assert.match(html, /Status belum dibaca belum tersedia/);
 assert.match(html, /<button type="button" class="mark-all-read" disabled="">Tandai semua dibaca<\/button>/);
 assert.deepEqual([...html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), ["Semua", "Pengajuan", "Kunjungan", "Check-in", "Pengingat"]);
 assert.match(html, /role="tab" aria-selected="true" class="active">Semua/);
 assert.match(html, /Layanan notifikasi belum terhubung/);
 assert.doesNotMatch(html, /0 belum dibaca|notification-row|HC-0014|Dinda|Obat A|Berhasil/);
});
test("notification filter handlers select only an honestly unavailable category without read receipts", () => {
 let filter = "Semua";
 const changes = [];
 const onFilterChange = value => { filter = value; changes.push(value); };
 for (const category of ["Pengajuan", "Kunjungan", "Check-in", "Pengingat", "Semua"]) {
  const view = PatientNotificationList({ filter, onFilterChange });
  const tabs = view.props.children[0].props.children;
  assert.deepEqual(tabs.map(tab => tab.props.children), ["Semua", "Pengajuan", "Kunjungan", "Check-in", "Pengingat"]);
  const clicked = tabs.find(tab => tab.props.children === category);
  assert.equal(clicked.props.type, "button");
  clicked.props.onClick();
  assert.equal(filter, category);
  const updated = PatientNotificationList({ filter, onFilterChange });
  assert.deepEqual(updated.props.children[0].props.children.filter(tab => tab.props["aria-selected"]).map(tab => tab.props.children), [category]);
  const html = renderToStaticMarkup(updated);
  assert.match(html, /Notifikasi belum tersedia/);
  assert.ok(html.includes(category === "Semua" ? "Layanan notifikasi belum terhubung." : `Notifikasi kategori ${category} belum tersedia karena layanan belum terhubung.`));
  assert.match(html, /Tidak ada notifikasi contoh atau status baca lokal/);
  assert.doesNotMatch(html, /notification-row|0 belum dibaca|<form|Berhasil/);
 }
 assert.deepEqual(changes, ["Pengajuan", "Kunjungan", "Check-in", "Pengingat", "Semua"]);
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
test("patient core shell restores section-specific geometry without duplicate booking headings", async () => {
 const controller = await authenticatedController();
 for (const [section, appClass, mainClass] of [["checkin", "checkin-app", "checkin-main"], ["guide", "care-guide-app", "care-guide-main"], ["profile", "patient-profile-app", "patient-profile-main"], ["contact", "contact-edit-app", "contact-edit-main"], ["notifications", "patient-notifications-app", "patient-notifications-main"]]) {
  const html = renderToStaticMarkup(createElement(SessionProvider, { controller }, createElement(PatientLiveShell, { section, profile }, createElement("p", null, "LIVE_CHILD"))));
  assert.ok(html.includes(appClass)); assert.ok(html.includes(mainClass)); assert.match(html, /LIVE_CHILD/);
  assert.doesNotMatch(html, /Catat kondisi|Check-in Hari Ini/);
 }
 for (const section of ["homecare", "booking"]) {
  const html = renderToStaticMarkup(createElement(SessionProvider, { controller }, createElement(PatientLiveShell, { section, profile }, createElement("p", null, "BOOKING_CONTENT"))));
  assert.match(html, /BOOKING_CONTENT/); assert.doesNotMatch(html, /class="patient-main"|patient-welcome|<h1/);
 }
});
const typedGuide = {
 patientId: profile.id,
 sources: ["protocol", "danger_sign", "activity", "diet", "wound_care", "medication"].map((kind, index) => ({ id: `source-${index}`, kind, title: `Judul ${kind}`, body: `Isi ${kind}`, revisionNumber: 1, approvedAt: "2026-11-14T00:00:00Z" })),
 orders: [{ id: "mixed-order", sourceDocumentId: "source-0", kind: "care", instructions: "Instruksi server", effectiveFrom: "2026-11-14", effectiveTo: null, items: ["followup", "first_aid", "device_care", "danger_sign", "activity", "diet", "wound_care", "storage", "medication"].map(type => ({ type, text: `Teks ${type}` })) }],
};
test("guide categories use only source kind and item type, retaining every unmatched instruction", () => {
 const expected = { "Obat": ["storage", "medication"], "Perawatan luka": ["wound_care"], "Makan & minum": ["diet"], "Aktivitas": ["activity"], "Gejala bahaya": ["danger_sign"] };
 const sourceKinds = { "Obat": "medication", "Perawatan luka": "wound_care", "Makan & minum": "diet", "Aktivitas": "activity", "Gejala bahaya": "danger_sign" };
 const allItems = [];
 const allSources = [];
 for (const [category, types] of Object.entries(expected)) {
  const selected = patientGuideSections(typedGuide, category);
  assert.deepEqual(selected.sources.map(source => source.kind), [sourceKinds[category]]);
  assert.deepEqual(selected.orders.flatMap(({ items }) => items.map(item => item.type)), types);
  allItems.push(...selected.orders.flatMap(({ items }) => items)); allSources.push(...selected.sources);
 }
 const other = patientGuideSections(typedGuide, null);
 assert.deepEqual(other.sources.map(source => source.kind), ["protocol"]);
 assert.deepEqual(other.orders.flatMap(({ items }) => items.map(item => item.type)), ["followup", "first_aid", "device_care"]);
 allItems.push(...other.orders.flatMap(({ items }) => items)); allSources.push(...other.sources);
 assert.equal(new Set(allItems).size, typedGuide.orders[0].items.length);
 assert.equal(new Set(allSources).size, typedGuide.sources.length);
 const misleading = { ...typedGuide, orders: [{ ...typedGuide.orders[0], kind: "medication", instructions: "Obat", items: [{ type: "followup", text: "Obat Perawatan luka Makan & minum Aktivitas Gejala bahaya" }] }] };
 for (const category of Object.keys(expected)) assert.equal(patientGuideSections(misleading, category).orders.length, 0);
 assert.equal(patientGuideSections(misleading, null).orders.length, 1);
});
test("typed guide accordions retain original icons and linked source provenance without mixing items", () => {
 for (const [category, icon] of [["Obat", "pill"], ["Perawatan luka", "heart-pulse"], ["Makan & minum", "utensils"], ["Aktivitas", "footprints"], ["Gejala bahaya", "triangle-alert"]]) {
  const html = renderToStaticMarkup(createElement(PatientGuideSections, { data: typedGuide, category }));
  assert.match(html, /class="care-guide-section open"/);
  assert.match(html, /class="care-guide-toggle" aria-expanded="true"/);
  assert.ok(html.includes(`lucide-${icon}`)); assert.match(html, /care-guide-chevron/);
  assert.match(html, /Sumber: Judul protocol/);
  assert.doesNotMatch(html, /Teks followup|Teks first_aid|Teks device_care|Isi protocol/);
 }
 const other = renderToStaticMarkup(createElement(PatientGuideSections, { data: typedGuide, category: null }));
 assert.match(other, /Teks followup/); assert.match(other, /Teks first_aid/); assert.match(other, /Teks device_care/); assert.match(other, /Judul protocol/);
 assert.doesNotMatch(other, /Teks medication|Teks storage|Teks wound_care|Teks diet|Teks activity|Teks danger_sign/);
 const sourceOnly = renderToStaticMarkup(createElement(PatientGuideSections, { data: { ...typedGuide, orders: [] }, category: null }));
 assert.match(sourceOnly, /Isi protocol/);
 const emptyOrder = { ...typedGuide.orders[0], items: [] };
 assert.equal(patientGuideSections({ ...typedGuide, orders: [emptyOrder] }, null).orders[0].order, emptyOrder);
});
