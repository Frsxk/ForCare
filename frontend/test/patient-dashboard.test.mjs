import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { patientAge, PatientDashboardVitals, PatientDashboardProgress } from "../components/patient-live-pages";

const booking = {
  status: "submitted", createdAt: "2026-11-14T01:00:00Z", submittedAt: "2026-11-14T02:00:00Z",
  startsAt: "2026-11-15T17:05:00Z", decidedAt: null, decisionReason: null,
  nurse: { displayName: "Perawat server" }, events: [],
};

test("age follows the session calendar birthday rather than the host date", () => {
  const now = new Date("2026-11-15T17:05:00Z");
  assert.equal(patientAge("1990-11-16", now, "Asia/Jakarta"), 36);
  assert.equal(patientAge("1990-11-16", now, "UTC"), 35);
  assert.equal(patientAge("1990-11-17", now, "Asia/Jakarta"), 35);
  assert.equal(patientAge("2000-02-29", new Date("2026-02-28T12:00:00Z"), "UTC"), 25);
  assert.equal(patientAge("2000-02-29", new Date("2026-03-01T12:00:00Z"), "UTC"), 26);
  for (const invalid of ["1990-02-30", "2027-01-01", "", "unknown"]) assert.equal(patientAge(invalid, now, "UTC"), null);
});

test("home vitals keep four slots and preserve a measured half of blood pressure", () => {
  const checkIn = { observations: [
    { type: "bp_diastolic_mmhg", value: 81 }, { type: "spo2_pct", value: 97 }, { type: "weight_kg", value: 64 },
  ], medicationAdherence: "missed_once" };
  const html = renderToStaticMarkup(createElement(PatientDashboardVitals, { checkIn }));
  assert.equal([...html.matchAll(/class="vital-item"/g)].length, 4);
  assert.match(html, /—\/81/);
  assert.match(html, /Terlewat sekali/);
  assert.doesNotMatch(html, /Saturasi|Berat badan|97|64|36,8|120\/80/);
  const empty = renderToStaticMarkup(createElement(PatientDashboardVitals));
  assert.equal([...empty.matchAll(/class="vital-item"/g)].length, 4);
  assert.doesNotMatch(empty, /Teratur|bpm|°C/);
});

test("pending and draft progress never claim an accepted visit", () => {
  for (const status of ["draft", "submitted"]) {
    const html = renderToStaticMarkup(createElement(PatientDashboardProgress, { booking: { ...booking, status, submittedAt: status === "draft" ? null : booking.submittedAt }, timeZone: "Asia/Jakarta" }));
    assert.equal([...html.matchAll(/<li /g)].length, 3);
    assert.equal([...html.matchAll(/aria-current="step"/g)].length, 1);
    assert.doesNotMatch(html, />Jadwal dikonfirmasi</);
    assert.match(html, /Kunjungan belum dikonfirmasi/);
    assert.match(html, /16 Nov 2026 · 00.05 WIB/);
    assert.doesNotMatch(html, /2026-11-15T|booking\./);
  }
});

test("terminal progress retains server reasons and never shows a confirmed visit", () => {
  for (const status of ["rejected", "cancelled"]) {
    const reason = "Alasan keputusan dari server";
    const html = renderToStaticMarkup(createElement(PatientDashboardProgress, { booking: { ...booking, status, decisionReason: status === "rejected" ? reason : null, events: [{ action: `booking.${status}`, reason }] }, timeZone: "UTC" }));
    assert.match(html, /Alasan keputusan dari server/);
    assert.doesNotMatch(html, />Jadwal dikonfirmasi</);
    assert.equal([...html.matchAll(/aria-current="step"/g)].length, 1);
  }
});

test("accepted progress presents a localized confirmed schedule", () => {
  const html = renderToStaticMarkup(createElement(PatientDashboardProgress, { booking: { ...booking, status: "accepted", decidedAt: "2026-11-14T03:00:00Z" }, timeZone: "Asia/Makassar" }));
  assert.match(html, />Jadwal dikonfirmasi</);
  assert.match(html, /16 Nov 2026 · 01.05 WITA/);
  assert.match(html, /Pengajuan diterima perawat/);
  assert.equal([...html.matchAll(/class="step-complete"/g)].length, 2);
});
