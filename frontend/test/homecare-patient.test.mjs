import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomecareQuotaStatus, HomecareReviewScreening, bookingReviewParity, formFor, initialBookingFlow, intakeFor, validatePatientBooking } from "../components/homecare-patient";
import { createApiClient } from "../lib/api/client";
import { HomecareWriteController, prepareBookingCreate, prepareBookingUpdate, preparePriorityRequestCreate } from "../lib/api/homecare";
const uid = () => crypto.randomUUID();
const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072";
const nurseId = "d5a7e10f-cd20-4c62-a495-30eacac36df1";
const nurse = { id: nurseId, displayName: "Nurse API", staffCode: "N-API" };
const values = { complaint: "Keluhan yang dilaporkan", otherComplaint: "Keluhan tambahan", history: "Riwayat dari pasien", consciousness: "alert", conditions: ["weak"], values: { temperature_c: "37.2" }, observationTimes: { temperature_c: "2026-11-15T01:00" }, note: "Tangga di depan" };

test("homecare restoration keeps baseline layout slots and declares detail before selecting it", () => {
  const source = readFileSync(new URL("../components/homecare-patient.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../components/homecare-booking-flow.css", import.meta.url), "utf8");
  const history = source.slice(source.indexOf("export function HomecareHistory"), source.indexOf("function BookingIntakeView"));
  assert.ok(history.indexOf("const detail =") < history.indexOf("const selected ="));
  assert.match(history, /homecare\.myBooking\(selectedBookingId, signal\)/);
  for (const slot of ["patient-homecare-heading", "patient-homecare-layout", "homecare-request-list", "homecare-detail-card", "booking-title", "booking-stepper", "booking-layout", "booking-summary", "date-choices", "time-choices"]) assert.ok(source.includes(`className="${slot}"`), slot);
  assert.match(source, /form="booking-flow"[^>]*type="submit"/);
  assert.doesNotMatch(css, /\.homecare-live-content\{[^}]*margin:0/);
  assert.doesNotMatch(css, /@media\(min-width:701px\)[^{]*\{[^]*?\.summary-actions\{display:none/);
});

test("screening review retains the explicit edit affordance and every optional measurement", () => {
  const allValues = { temperature_c: "37.2", heart_rate_bpm: "78", bp_systolic_mmhg: "120", bp_diastolic_mmhg: "80", weight_kg: "61", spo2_pct: "98" };
  const form = { ...values, values: allValues, observationTimes: Object.fromEntries(Object.keys(allValues).map(type => [type, "2026-11-15T01:00"])) };
  const intake = intakeFor(form, true);
  assert.equal(intake.observations.length, 6);
  assert.deepEqual(intakeFor(formFor(intake), true), intake);
  const markup = renderToStaticMarkup(createElement(HomecareReviewScreening, { intake, onEdit: () => {} }));
  assert.match(markup, /aria-label="Ubah screening"/);
  for (const label of ["Suhu tubuh", "Detak jantung", "Tekanan sistolik", "Tekanan diastolik", "Berat badan", "Saturasi oksigen"]) assert.ok(markup.includes(label));
});

test("screening restoration retains every input without inventing omitted measurements", () => {
  const form = formFor(null);
  assert.equal(form.values.temperature_c, undefined);
  assert.equal(form.observationTimes.temperature_c, undefined);
  assert.throws(() => intakeFor(form, false, undefined), /keluhan utama/);
  assert.throws(() => intakeFor({ ...form, ...values, observationTimes: {} }, false), /waktu UTC/);
  const intake = intakeFor({ ...form, ...values }, true);
  assert.deepEqual(intake.observations, [{ type: "temperature_c", value: 37.2, unit: "c", observedAt: "2026-11-15T01:00:00.000Z" }]);
  assert.equal(intake.otherComplaint, "Keluhan tambahan");
  assert.equal(intake.note, "Tangga di depan");
  assert.equal(intake.consent, true);
  const restored = formFor(intake);
  assert.equal(restored.otherComplaint, "Keluhan tambahan");
  assert.equal(restored.note, "Tangga di depan");
  assert.equal(restored.values.bp_systolic_mmhg, undefined);
  assert.deepEqual(intakeFor(restored, true), intake);
});

function draft(payload, id) {
  return { ...payload, id, patientId, nurseId, nurse, availabilityVersionId: uid(), status: "draft", version: 0, visitId: null, profileSnapshot: null, priorityRequestId: null, decisionReason: null, submittedAt: null, decidedAt: null, cancelledAt: null, createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z", events: [] };
}
const response = (data, status = 200) => new Response(JSON.stringify({ data, requestId: uid() }), { status });
function fixture(respond) {
  const payload = { slotId: uid(), startsAt: "2026-11-20T02:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z", intake: intakeFor(values, true) };
  const ids = [uid(), uid()], calls = [];
  let current = draft({ nurseId, ...payload }, ids[0]);
  const client = createApiClient({ fetch: async (url, init) => {
    const call = { url, method: init.method, key: init.headers.get("idempotency-key"), body: init.body };
    calls.push(call);
    return respond(call, { current, payload, ids });
  } });
  client.setCsrfToken("csrf");
  const controller = new HomecareWriteController(client, "patient", () => true, () => patientId);
  return { calls, payload, ids, controller, create: () => prepareBookingCreate(nurseId, payload), updateId: () => { current = draft({ nurseId, ...payload }, ids[1]); return ids[1]; } };
}

test("an ordinary slot can create its first draft before saved-slot submission checks", async () => {
  const f = fixture((_call, { current }) => response(current));
  const interval = { nurseId, slotId: f.payload.slotId, startsAt: f.payload.startsAt, endsAt: f.payload.endsAt };
  const now = Date.parse("2026-11-19T00:00:00Z");
  assert.throws(() => validatePatientBooking(null, interval, false, null, now), /Simpan pilihan slot/);
  validatePatientBooking(null, interval, false, null, now, false);
  await f.controller.send(f.create());
  const state = f.controller.getSnapshot();
  assert.equal(state.status, "verified");
  assert.equal(state.result.id, f.ids[0]);
  assert.equal(state.result.status, "draft");
  assert.equal(state.result.slotId, interval.slotId);
  assert.deepEqual(state.result.intake, f.payload.intake);
  validatePatientBooking(state.result, interval, false, null, now);
  assert.throws(() => validatePatientBooking(state.result, { ...interval, slotId: uid() }, false, null, now), /Simpan pilihan slot/);
});

test("retained UI consumer retries the identical create without an extra or replacement write", async () => {
  const f = fixture(() => { throw new Error("network ended"); });
  const create = f.create();
  await f.controller.send(create);
  assert.equal(f.controller.getSnapshot().status, "uncertain");
  assert.equal(f.controller.getSnapshot().operation.intent.idempotencyKey, create.intent.idempotencyKey);
  await f.controller.send(f.controller.getSnapshot().operation);
  assert.equal(f.controller.getSnapshot().status, "uncertain");
  assert.deepEqual(f.calls, [create, create].map(operation => ({
    url: operation.intent.path,
    method: operation.intent.method,
    key: operation.intent.idempotencyKey,
    body: operation.intent.body,
  })));
});

test("booking recovery uses the URL target unless a retained write owns a different draft", async () => {
  const f = fixture(() => { throw new Error("network ended"); });
  const requested = f.ids[1];
  const opening = initialBookingFlow(f.controller.getSnapshot(), requested);
  assert.equal(opening.target, requested);
  assert.equal(opening.retainedForm, null);
  assert.equal(opening.error, "");

  const original = draft(f.payload, f.ids[0]);
  const operation = prepareBookingUpdate(original, { nurseId, ...f.payload });
  await f.controller.send(operation);
  assert.equal(f.controller.getSnapshot().status, "uncertain");
  const recovery = initialBookingFlow(f.controller.getSnapshot(), requested);
  assert.equal(recovery.target, original.id);
  assert.equal(recovery.step, 4);
  assert.match(recovery.error, /permintaan tertahan/);
  assert.deepEqual(recovery.retainedForm.form, formFor(f.payload.intake));
  assert.deepEqual(recovery.retainedForm.interval, { nurseId, slotId: f.payload.slotId, startsAt: f.payload.startsAt, endsAt: f.payload.endsAt });
  assert.equal(recovery.retainedForm.consent, true);

  const reopening = initialBookingFlow(f.controller.getSnapshot(), original.id);
  assert.equal(reopening.target, original.id);
  assert.equal(reopening.error, "");
  assert.equal(initialBookingFlow(f.controller.getSnapshot(), null).target, original.id);
});

test("explicit availability statement sends only after a verified same-interval draft exists", async () => {
  const statement = "Keluarga tidak tersedia pada slot";
  const f = fixture((call, { current, ids }) => {
    if (call.url === "/api/v1/me/bookings") {
      assert.equal(call.method, "POST");
      return response(current, 201);
    }
    if (call.url === `/api/v1/me/bookings/${current.id}`) {
      assert.equal(call.method, "GET");
      return response(current);
    }
    if (call.url === "/api/v1/me/priority-requests") {
      assert.equal(call.method, "POST");
      const body = JSON.parse(call.body);
      return response({ id: ids[1], bookingId: current.id, patientId, nurseId, startsAt: current.startsAt, endsAt: current.endsAt, statement: body.statement, status: "pending", reason: null, version: 0, reviewedAt: null, createdAt: current.updatedAt }, 201);
    }
    if (call.url === `/api/v1/me/priority-requests/${ids[1]}`) {
      assert.equal(call.method, "GET");
      return response({ id: ids[1], bookingId: current.id, patientId, nurseId, startsAt: current.startsAt, endsAt: current.endsAt, statement, status: "pending", reason: null, version: 0, reviewedAt: null, createdAt: current.updatedAt });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  });
  const create = f.create();
  await f.controller.send(create);
  assert.equal(f.controller.getSnapshot().status, "verified");
  const item = f.controller.getSnapshot().result;
  assert.equal(item.id, f.ids[0]);
  assert.equal(item.status, "draft");

  f.controller.reset();
  const operation = preparePriorityRequestCreate(item, statement);
  await f.controller.send(operation);
  assert.equal(f.controller.getSnapshot().status, "verified");
  const request = f.controller.getSnapshot().result;
  assert.equal(request.id, f.ids[1]);
  assert.equal(request.bookingId, item.id);
  assert.equal(request.startsAt, item.startsAt);
  assert.equal(request.endsAt, item.endsAt);
  assert.equal(request.statement, statement);
  assert.equal(request.status, "pending");
  assert.deepEqual(JSON.parse(f.calls[2].body), { bookingId: item.id, statement });
  assert.deepEqual(f.calls, [
    { url: "/api/v1/me/bookings", method: "POST", key: create.intent.idempotencyKey, body: create.intent.body },
    { url: `/api/v1/me/bookings/${item.id}`, method: "GET", key: null, body: undefined },
    { url: "/api/v1/me/priority-requests", method: "POST", key: operation.intent.idempotencyKey, body: operation.intent.body },
    { url: `/api/v1/me/priority-requests/${request.id}`, method: "GET", key: null, body: undefined },
  ]);
});

test("saved-draft review renders changed-field values and an unsaved warning only when parity differs", () => {
  const intake = intakeFor(values, true);
  const item = draft({ nurseId, slotId: uid(), startsAt: "2026-11-20T02:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z", intake }, uid());
  const form = formFor(intake);
  const interval = { nurseId, slotId: item.slotId, startsAt: item.startsAt, endsAt: item.endsAt };
  assert.equal(bookingReviewParity(item, form, interval, true), true);
  const changedForm = { ...form, note: "Catatan yang berbeda" };
  const changedIntake = intakeFor(changedForm, true);
  assert.notDeepEqual(changedIntake, intake);
  assert.equal(bookingReviewParity(item, changedForm, interval, true), false);
  for (const mutate of [
    next => { next.complaint = "Keluhan utama berubah"; },
    next => { next.otherComplaint = "Keluhan tambahan berubah"; },
    next => { next.history = "Riwayat berubah"; },
    next => { next.consciousness = "drowsy"; },
    next => { next.conditions = ["pale"]; },
    next => { next.values = { ...next.values, temperature_c: "38.1" }; },
    next => { next.observationTimes = { ...next.observationTimes, temperature_c: "2026-11-15T02:00" }; },
  ]) {
    const next = formFor(intake);
    mutate(next);
    assert.equal(bookingReviewParity(item, next, interval, true), false);
  }
  assert.equal(bookingReviewParity(item, form, interval, false), false);
  assert.equal(bookingReviewParity(item, form, { ...interval, nurseId: uid() }, true), false);
  assert.equal(bookingReviewParity(item, form, { ...interval, startsAt: "2026-11-20T04:00:00.000Z" }, true), false);

  const changed = renderToStaticMarkup(createElement(HomecareReviewScreening, { intake: changedIntake, changed: true }));
  assert.match(changed, /<div class="review-unsaved-warning" role="status">/);
  assert.match(changed, /<dt>Keluhan utama<\/dt><dd>Keluhan yang dilaporkan<\/dd>/);
  assert.match(changed, /<dt>Keluhan tambahan<\/dt><dd>Keluhan tambahan<\/dd>/);
  assert.match(changed, /<dt>Riwayat kondisi harian<\/dt><dd>Riwayat dari pasien<\/dd>/);
  assert.match(changed, /<dt>Kesadaran<\/dt><dd>Sadar penuh<\/dd>/);
  assert.match(changed, /<dt>Kondisi fisik<\/dt><dd>Lemas<\/dd>/);
  assert.match(changed, /<dt>Suhu tubuh<\/dt><dd>37.2 °C · 2026-11-15T01:00:00.000Z \(UTC\)<\/dd>/);
  assert.match(changed, /<dt>Catatan untuk perawat<\/dt><dd>Catatan yang berbeda<\/dd>/);
  const unchanged = renderToStaticMarkup(createElement(HomecareReviewScreening, { intake }));
  assert.doesNotMatch(unchanged, /class="review-unsaved-warning"|role="status"/);
  assert.match(unchanged, /<dt>Catatan untuk perawat<\/dt><dd>Tangga di depan<\/dd>/);
});

test("manual submit needs exact live approval and review quota is never invented", () => {
  const item = draft({ nurseId, slotId: null, startsAt: "2026-11-20T02:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z", intake: intakeFor(values, true) }, uid());
  const interval = { nurseId, slotId: null, startsAt: item.startsAt, endsAt: item.endsAt };
  const now = Date.parse("2026-11-15T00:00:00.000Z");
  assert.throws(() => validatePatientBooking(item, interval, true, null, now), /Persetujuan perawat/);
  const approval = { id: uid(), bookingId: item.id, patientId, nurseId, startsAt: item.startsAt, endsAt: item.endsAt, statement: "Alasan interval manual", status: "availability_accepted", reason: "Perawat dapat hadir", version: 1, reviewedAt: "2026-11-15T00:30:00.000Z", createdAt: item.updatedAt };
  validatePatientBooking(item, interval, true, approval, now);
  assert.throws(() => validatePatientBooking(item, { ...interval, endsAt: "2026-11-20T04:00:00.000Z" }, true, approval, now), /persis sama/);
  assert.match(renderToStaticMarkup(createElement(HomecareQuotaStatus, { count: null })), /Memeriksa batas 3/);
  assert.match(renderToStaticMarkup(createElement(HomecareQuotaStatus, { count: 3 })), /Batalkan pengajuan aktif/);
});
