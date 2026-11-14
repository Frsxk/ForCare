import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
const ui = await import("../components/nurse-workspace-pages").catch(() => null);
const getUi = () => { assert.ok(ui, "Real scoped nurse screens must exist"); return ui; };
const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072";
const page = { nextCursor: null, hasMore: false };
const payload = { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null, allergies: [], procedures: [], complaints: null, observations: [], internalNote: null };
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
test("directory renders only loaded scoped patients, honest missing facts and real UUID links", () => {
 const { PatientRows } = getUi();
 const html = render(PatientRows, { patients: [{ id: patientId, displayName: "API Patient", recordNumber: null, latestCheckIn: null, nextVisit: null }] });
 assert.match(html, /API Patient/); assert.match(html, new RegExp(`/pasien-rekam-medis/${patientId}`));
 assert.match(html, /Belum ada check-in/); assert.match(html, /Belum tersedia/);
 assert.doesNotMatch(html, /risiko tinggi|Baik-baik saja|Siti|RM-001/);
});
test("dashboard count is from loaded scoped list, never total or invented scheduling/risk aggregates", () => {
 const { NurseDashboardView } = getUi();
 const html = render(NurseDashboardView, { list: { scope: "assigned", items: [{ id: patientId, displayName: "API Patient", recordNumber: null, latestCheckIn: null, nextVisit: null }], page: { hasMore: true, nextCursor: "next" } } });
 assert.match(html, /1 pasien dimuat/); assert.match(html, /Masih ada halaman berikutnya/);
 assert.match(html, /attention-card/); assert.match(html, /dashboard-grid/);
 assert.match(html, /requests-card/); assert.match(html, /visits-card/); assert.match(html, /upcoming-card/);
 assert.equal((html.match(/class="stat"/g) ?? []).length, 4);
 assert.doesNotMatch(html, /Total pasien|Risiko tinggi|Terjadwal|Selesai<\/span>/);
});
test("missing snapshot is not a diagnosis, allergy clearance or invented normal measurement", () => {
 const { SnapshotView } = getUi(); const html = render(SnapshotView, { record: null });
 assert.match(html, /Belum ada snapshot/); assert.doesNotMatch(html, /Tidak ada alergi|36.5|Normal/);
 const empty = render(SnapshotView, { record: { payload, revisionNumber: 1, sourceReference: "API source", recordedAt: "2026-11-14T01:00:00Z" } });
 assert.match(empty, /API source/); assert.match(empty, /Belum dicatat/); assert.doesNotMatch(empty, /Tidak ada alergi/);
});
test("patient reports remain distinct from nurse confirmations and scoring stays unavailable", () => {
 const { ObservationsView } = getUi(); const html = render(ObservationsView, { data: { latestObservation: { id: patientId, type: "weight_kg", value: 50, unit: "kg", observedAt: "2026-11-14T01:00:00Z" }, lastConfirmed: { value: 49, unit: "kg", observedAt: "2026-11-13T01:00:00Z", confirmedAt: "2026-11-14T01:00:00Z", observationId: "old" }, history: { items: [], page }, trend: { status: "unavailable" } } });
 assert.match(html, /Laporan pasien terbaru/); assert.match(html, /Konfirmasi perawat terakhir/); assert.match(html, /50 kg/); assert.match(html, /49 kg/);
 assert.doesNotMatch(html, /risiko rendah|membaik|skor 0/);
});
test("profile displays server identity without mock care totals or credentials", () => {
 const { ProfileContent } = getUi(); const html = render(ProfileContent, { profile: { displayName: "API Nurse", staffCode: "SERVER-1", discipline: "nurse", email: "api@example.invalid", phone: null, displayTimeZone: "Asia/Jakarta" } });
 assert.match(html, /API Nurse/); assert.match(html, /SERVER-1/); assert.match(html, /Belum dicatat/); assert.doesNotMatch(html, /Siti|Pasien ditangani|Kunjungan hari ini|password/);
});
test("care instructions preserve ordered structured items rather than flattened clinical text", () => {
 const { CareGuideView } = getUi(); const html = render(CareGuideView, { guide: { sources: [], orders: [{ id: patientId, instructions: "Original instructions", items: [{ type: "care", text: "First instruction" }, { type: "care", text: "Second instruction" }], revisionNumber: 1, sourceVersion: 1, sourceDocumentId: patientId }] } });
 assert.match(html, /Original instructions/); assert.match(html, /<ol[^>]*><li>First instruction<\/li><li>Second instruction<\/li><\/ol>/);
});
test("nurse surfaces retain baseline table slots, patient tabs and scoped clinical panels", () => {
 const { PatientRows } = getUi();
 const html = render(PatientRows, { patients: [] });
 for (const heading of ["Usia · JK", "Keluar RS", "Check-in terakhir", "Tingkat risiko", "Kunjungan berikutnya"]) assert.ok(html.includes(heading));
 const source = readFileSync(new URL("../components/nurse-workspace-pages.tsx", import.meta.url), "utf8");
 for (const label of ["Profil Pasien", "Riwayat medis", "Penilaian kondisi", "Riwayat perawatan"]) assert.ok(source.includes(label));
 assert.match(source, /MedicalSnapshotPanel patientId=\{patientId\}/);
 assert.match(source, /PatientAnalysisPanel patientId=\{patientId\}/);
 assert.match(source, /PatientClinicalReads key=\{patientId\}/);
 assert.match(source, /className="patient-checkins-table"/);
 assert.match(source, /className="risk-monitoring-layout"/);
 assert.match(source, /className="medical-record-layout"/);
 assert.match(source, /className="nurse-notifications-main"|nurse-notifications-main/);
 assert.match(source, /className="nurse-profile-shortcuts"/);
 assert.doesNotMatch(source, /dashboard-data|useNurseData|signOutDemo/);
});
