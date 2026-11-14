import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientBookingDetail, PatientBookingTimeline } from "../components/homecare-patient";

const createdAt = "2026-11-14T02:00:00.000Z";
const submittedAt = "2026-11-14T03:00:00.000Z";
const decidedAt = "2026-11-14T04:00:00.000Z";
const startsAt = "2026-11-17T02:00:00.000Z";
const endsAt = "2026-11-17T03:30:00.000Z";
const bookingId = "e10a3ef2-2e94-43a8-8594-c3b5db9b733b";
const event = (action, version, reason = null, data = {}) => ({ id: `event-${version}`, action, version, reason, data, createdAt: version > 1 ? decidedAt : version === 1 ? submittedAt : createdAt });
const created = event("booking.created", 0);
const sent = event("booking.submitted", 1);
const booking = (overrides = {}) => ({
  id: bookingId, patientId: "patient", nurseId: "nurse", nurse: { id: "nurse", displayName: "Perawat dari server", staffCode: "N-SERVER" },
  slotId: null, availabilityVersionId: null, startsAt, endsAt, status: "submitted", version: 1,
  intake: null, profileSnapshot: null, visitId: null, priorityRequestId: null, decisionReason: null,
  submittedAt, decidedAt: null, cancelledAt: null, createdAt, updatedAt: submittedAt, events: [sent, created], ...overrides,
});
const timeline = item => renderToStaticMarkup(createElement(PatientBookingTimeline, { booking: item, timeZone: "Asia/Jakarta" }));
const detail = (item, timeZone = "Asia/Jakarta") => renderToStaticMarkup(createElement(PatientBookingDetail, { booking: item, timeZone }));
const count = (html, name) => [...html.matchAll(new RegExp(`class="${name}"`, "g"))].length;

test("submitted renders a completed submission, honest current wait and upcoming decision", () => {
  const html = timeline(booking());
  assert.equal(count(html, "complete"), 1);
  assert.equal(count(html, "current"), 1);
  assert.equal(count(html, "upcoming"), 1);
  assert.equal([...html.matchAll(/aria-current="step"/g)].length, 1);
  assert.match(html, /Menunggu tinjauan perawat/);
  assert.match(html, /10\.00/);
  assert.doesNotMatch(html, /Sedang ditinjau|booking\.|versi|2026-11-14T/);
});

for (const status of ["accepted", "rejected", "cancelled"]) test(`${status} ends the timeline without a pending confirmation or future visit`, () => {
  const action = `booking.${status}`;
  const reason = `Alasan server: ${status}`;
  const events = [event(action, 2, reason), sent, created];
  const item = booking({ status, version: 2, events, decisionReason: reason, decidedAt, cancelledAt: status === "cancelled" ? decidedAt : null });
  const html = timeline(item);
  assert.equal(count(html, "complete"), 2);
  assert.equal(count(html, "current"), 0);
  assert.equal(count(html, "upcoming"), 0);
  assert.ok(html.includes(reason));
  assert.doesNotMatch(html, /aria-current|Menunggu konfirmasi|Belum ada keputusan|Kunjungan terjadwal|booking\./);
  assert.ok(html.indexOf("Pengajuan terkirim") < html.indexOf(reason));
  for (const candidate of [item, { ...item, events: events.map(entry => ({ ...entry, reason: null })) }]) {
    const primary = detail(candidate).split("<details")[0];
    assert.ok(primary.includes(reason));
    assert.equal(primary.indexOf(reason), primary.lastIndexOf(reason), "Decision reason appears once before the audit disclosure");
  }
});

test("cancelling an accepted booking keeps both real decisions in order", () => {
  const html = timeline(booking({ status: "cancelled", version: 3, events: [event("booking.cancelled", 3, "Pasien membatalkan"), sent, event("booking.accepted", 2), created], decidedAt, cancelledAt: decidedAt }));
  assert.equal(count(html, "complete"), 3);
  assert.ok(html.indexOf("diterima perawat") < html.indexOf("Pasien membatalkan"));
  assert.doesNotMatch(html, /class="current"|class="upcoming"/);
});

test("reschedule retains reason and exact previous/new intervals in localized chronology", () => {
  const reason = "Perubahan jadwal disepakati pasien";
  const nextStart = "2026-11-18T04:15:00.000Z", nextEnd = "2026-11-18T05:45:00.000Z";
  const item = booking({ status: "accepted", version: 3, startsAt: nextStart, endsAt: nextEnd, events: [event("booking.rescheduled", 3, reason, { previousStartsAt: startsAt, previousEndsAt: endsAt, startsAt: nextStart, endsAt: nextEnd, patientAgreed: true }), event("booking.accepted", 2), sent, created] });
  const html = timeline(item);
  assert.equal(count(html, "complete"), 3);
  assert.ok(html.includes(reason));
  for (const clock of ["09.00", "10.30", "11.15", "12.45"]) assert.ok(html.includes(clock), clock);
  assert.match(html, /17 Nov 2026/);
  assert.match(html, /18 Nov 2026/);
  assert.ok(html.indexOf("diterima perawat") < html.indexOf(reason));
  assert.doesNotMatch(html, /booking\.|2026-11-1[78]T|class="upcoming"/);
});

test("all server event kinds use human labels and audit retains version, identity and intake", () => {
  const actions = ["booking.created", "booking.updated", "booking.submitted", "booking.accepted", "booking.rejected", "booking.cancelled", "booking.rescheduled"];
  const html = detail(booking({ status: "cancelled", version: 6, events: actions.map((action, index) => event(action, index)), intake: { complaint: "Keluhan server", otherComplaint: null, history: null, consciousness: "alert", conditions: [], note: null, consent: true, observations: [{ type: "temperature_c", value: 37, unit: "c", observedAt: startsAt }] } }));
  for (const label of ["Draf pengajuan dibuat", "Draf pengajuan diperbarui", "Pengajuan terkirim", "Pengajuan diterima perawat", "Pengajuan ditolak perawat", "Pengajuan dibatalkan", "Jadwal kunjungan diubah"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes(bookingId));
  assert.match(html, /<details class="homecare-booking-disclosure">/);
  assert.match(html, /Versi 6/);
  assert.match(html, /Keluhan server/);
  assert.match(html, /37.*09\.00/);
  assert.doesNotMatch(html, /booking\.|2026-11-\d\dT|HC-0014|Dokter/);
});

test("detail uses the supplied session timezone including cross-date intervals", () => {
  const item = booking({ startsAt: "2026-11-17T15:30:00.000Z", endsAt: "2026-11-17T17:00:00.000Z" });
  const jakarta = detail(item), makassar = detail(item, "Asia/Makassar");
  assert.match(jakarta, /22\.30/);
  assert.match(jakarta, /18 Nov 2026/);
  assert.match(jakarta, /00\.00/);
  assert.match(makassar, /23\.30/);
  assert.match(makassar, /01\.00/);
  assert.doesNotMatch(jakarta, /2026-11-17T|\(UTC\)/);
});

test("draft and event-less terminal states never claim an active review", () => {
  const draft = timeline(booking({ status: "draft", submittedAt: null, events: [created] }));
  assert.equal(count(draft, "current"), 1);
  assert.match(draft, /Draf belum dikirim/);
  assert.doesNotMatch(draft, /Pengajuan terkirim|Menunggu tinjauan|class="upcoming"/);
  const terminal = timeline(booking({ status: "rejected", events: [], decidedAt, decisionReason: "Belum dapat melayani" }));
  assert.match(terminal, /Pengajuan ditolak perawat/);
  assert.match(terminal, /Belum dapat melayani/);
  assert.equal(count(terminal, "current"), 0);
  assert.equal(count(terminal, "upcoming"), 0);
});
