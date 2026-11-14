import { test } from "bun:test";
import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client";
import * as homecare from "../lib/api/homecare";
import { SessionController } from "../lib/api/session";
import { getPatientWorkspace, getNurseWorkspace } from "../lib/api/workspaces";

const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072";
const nurseId = "cb24dd80-d0ca-439a-b563-58ab724a3bea";
const bookingId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const otherId = "c312c603-7d47-4c90-9d66-c387e391a988";
const priorityId = "0bca4a7f-a181-4515-a433-306f45d4e104";
const requestId = "ffbeb937-c80c-4644-bb19-a3c0ee634e80";
const time = "2026-11-14T01:00:00.000Z";
const later = "2026-11-15T01:00:00.000Z";
const intake = { complaint: "Keluhan pasien", otherComplaint: null, history: null, consciousness: null, conditions: [], observations: [], note: null, consent: true };
const booking = {
  id: bookingId, patientId, nurseId, nurse: { id: nurseId, displayName: "Perawat", staffCode: "N01" },
  slotId: null, availabilityVersionId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", status: "draft", version: 0,
  intake, profileSnapshot: null, visitId: null, priorityRequestId: null, decisionReason: null, submittedAt: null, decidedAt: null, cancelledAt: null,
  createdAt: time, updatedAt: time, events: [],
};
const priority = { id: priorityId, bookingId, patientId, nurseId, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", statement: "Waktu di luar jam", status: "pending", reason: null, version: 0, reviewedAt: null, createdAt: time };
const availability = { nurseId, version: 0, current: null };
const availabilityInput = { timeZone: "Asia/Jakarta", slotMinutes: 60, bufferMinutes: 0, effectiveFrom: later, effectiveTo: "2026-11-16T01:00:00.000Z", windows: [{ weekday: 1, startMinute: 540, endMinute: 1020 }], slots: [{ startsAt: later, endsAt: "2026-11-15T02:00:00.000Z" }] };
const configuredAvailability = { nurseId, version: 1, current: { id: otherId, version: 1, ...availabilityInput, slots: [{ id: bookingId, ...availabilityInput.slots[0] }] } };
const response = (data, status = 200) => new Response(JSON.stringify({ data, requestId }), { status });
const failure = (status, code = "NETWORK_ERROR") => new Response(JSON.stringify({ error: { code, requestId } }), { status });
const clientFor = fetch => { const client = createApiClient({ fetch }); client.setCsrfToken("csrf"); return client; };
test("strict projections retain nullable privacy fields and reject unknown fields or false observations", () => {
  assert.equal(homecare.decodeAvailabilitySlots({ nurseId, timeZone: null, items: [], page: { nextCursor: null, hasMore: false } }).timeZone, null);
  assert.throws(() => homecare.decodeAvailabilitySlots({ nurseId, timeZone: null, items: [], page: { nextCursor: null, hasMore: false }, unexpected: true }));
  assert.throws(() => homecare.decodeAvailabilitySlots({ nurseId, timeZone: null, items: [], page: { nextCursor: null, hasMore: false, unexpected: true } }));
  assert.throws(() => homecare.decodeAvailabilitySlots({ nurseId, timeZone: null, items: [{ id: otherId, nurseId, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", availabilityVersionId: bookingId, availabilityVersion: 1 }], page: { nextCursor: null, hasMore: false } }));
  const decoded = homecare.decodeHomecareBooking({ ...booking, intake: { ...intake, consent: false }, priorityRequestId: null });
  assert.equal(decoded.intake.consent, false);
  assert.equal(homecare.decodeHomecareBooking({ ...booking, intake: null }).intake, null);
  assert.throws(() => homecare.decodeHomecareBooking({ ...booking, patientOccupancy: "other" }));
  assert.throws(() => homecare.decodeHomecareBooking({ ...booking, intake: { ...intake, observations: [{ type: "temperature_c", value: 0, unit: "c", observedAt: time }] } }));
  assert.throws(() => homecare.decodeHomecareBooking({ ...booking, intake: { ...intake, conditions: ["none", "weak"] } }));
  assert.throws(() => homecare.decodeHomecareBooking({ ...booking, events: [{ id: otherId, action: "draft", version: 0, reason: null, data: {}, createdAt: time, intake }] }));
  assert.deepEqual(homecare.decodeAvailability(availability).current, null);
  const decodedAvailability = homecare.decodeAvailability(configuredAvailability);
  assert.deepEqual(decodedAvailability, configuredAvailability);
  assert.equal(decodedAvailability.current.effectiveFrom, availabilityInput.effectiveFrom);
  assert.equal(decodedAvailability.current.effectiveTo, availabilityInput.effectiveTo);
  assert.ok(!Object.hasOwn(decodedAvailability.current, "startsAt"));
  assert.ok(!Object.hasOwn(decodedAvailability.current, "endsAt"));
  assert.deepEqual(decodedAvailability.current.slots[0], { id: bookingId, startsAt: availabilityInput.slots[0].startsAt, endsAt: availabilityInput.slots[0].endsAt });
  assert.throws(() => homecare.decodeAvailability({ ...configuredAvailability, unexpected: true }));
  assert.throws(() => homecare.decodeAvailability({ ...configuredAvailability, current: { ...configuredAvailability.current, startsAt: later } }));
  assert.equal(homecare.decodePriorityRequest({ ...priority, patient: { displayName: "Pasien", recordNumber: null } }).patient.recordNumber, null);
});

test("every builder selects frozen route fields and validates state rather than passing arbitrary input", () => {
  const create = homecare.prepareBookingCreate(nurseId, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake });
  assert.deepEqual(JSON.parse(create.intent.body), { nurseId, slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake });
  assert.equal(homecare.prepareBookingUpdate(booking, { intake: { ...intake, note: "Catatan" } }).intent.method, "PATCH");
  assert.deepEqual(JSON.parse(homecare.prepareBookingSubmit({ ...booking, version: 2 }).intent.body), { expectedVersion: 2 });
  assert.equal(JSON.parse(homecare.prepareBookingCancellation(booking, "Alasan").intent.body).reason, "Alasan");
  assert.equal(homecare.prepareNurseBookingCancellation({ ...booking, status: "submitted" }, "Alasan").intent.path, `/api/v1/bookings/${bookingId}/cancel`);
  assert.equal(JSON.parse(homecare.prepareNurseBookingDecision({ ...booking, status: "submitted" }, { decision: "accept", reason: null }).intent.body).decision, "accept");
  assert.throws(() => homecare.prepareNurseBookingDecision({ ...booking, status: "submitted" }, { decision: "reject", reason: null }));
  assert.equal(homecare.prepareNurseBookingReschedule({ ...booking, status: "accepted", visitId: otherId }, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", reason: "Disepakati", patientAgreed: true }).actor, "nurse");
  assert.deepEqual(JSON.parse(homecare.preparePriorityRequestCreate(booking, "Di luar jam").intent.body), { bookingId, statement: "Di luar jam" });
  assert.throws(() => homecare.preparePriorityRequestCreate(booking, "Di luar jam", { startsAt: later, endsAt: "2026-11-15T02:00:00.000Z" }));
  assert.deepEqual(JSON.parse(homecare.preparePriorityRequestReview(priority, { decision: "accept_availability", reason: "Tersedia", available: true }).intent.body), { expectedVersion: 0, decision: "accept_availability", reason: "Tersedia", available: true });
  const preparedAvailability = JSON.parse(homecare.prepareAvailabilityWrite(availability, availabilityInput).intent.body);
  assert.deepEqual(preparedAvailability, { expectedVersion: 0, ...availabilityInput });
  assert.ok(!Object.hasOwn(preparedAvailability, "startsAt"));
  assert.ok(!Object.hasOwn(preparedAvailability, "endsAt"));
  assert.deepEqual(preparedAvailability.slots, availabilityInput.slots);
  const replacement = JSON.parse(homecare.prepareAvailabilityWrite(homecare.decodeAvailability(configuredAvailability), availabilityInput).intent.body);
  assert.deepEqual(replacement, { expectedVersion: 1, ...availabilityInput });
  assert.throws(() => homecare.prepareAvailabilityWrite(availability, { ...availabilityInput, slots: [availabilityInput.slots[0]], extra: true }));
  assert.throws(() => homecare.prepareAvailabilityWrite(availability, { ...availabilityInput, effectiveFrom: availabilityInput.effectiveTo }));
});

test("bounded cursor reads bind filters and cancellation and do not expose private nurse drafts", async () => {
  const calls = [];
  const api = homecare.createHomecareApi(clientFor(async (url, init) => {
    calls.push({ url, signal: init.signal });
    if (url.startsWith("/api/v1/nurses/")) return response({ nurseId, timeZone: "Asia/Jakarta", items: [], page: { nextCursor: null, hasMore: false } });
    return response({ items: [], page: { nextCursor: null, hasMore: false } });
  }));
  const controller = new AbortController();
  await api.slots(nurseId, { from: time, to: later, cursor: "opaque", limit: 100 }, controller.signal);
  await api.myBookings({ status: "draft", cursor: "patient-cursor", limit: 1 });
  await api.bookings({ status: "submitted", search: "Rafi", cursor: "nurse-cursor" });
  await api.schedule({ from: time, to: later, limit: 20 });
  await api.myPriorityRequests({ cursor: "own", limit: 20 });
  await api.priorityRequests({ cursor: "nurse", limit: 20 });
  assert.equal(calls.length, 6);
  assert.equal(calls[0].signal, controller.signal);
  const slotQuery = new URLSearchParams(calls[0].url.split("?")[1]);
  assert.equal(slotQuery.get("limit"), "100"); assert.equal(slotQuery.get("cursor"), "opaque");
  assert.match(calls[1].url, /status=draft/); assert.match(calls[1].url, /cursor=patient-cursor/); assert.match(calls[1].url, /limit=1/);
  assert.match(calls[2].url, /status=submitted/); assert.match(calls[2].url, /search=Rafi/); assert.match(calls[3].url, /schedule\?/);
  assert.throws(() => api.bookings({ status: "draft" }));
  const callsBeforeInvalidRead = calls.length;
  await assert.rejects(async () => { await api.slots(nurseId, { from: time, to: later, limit: 101 }); });
  assert.equal(calls.length, callsBeforeInvalidRead);
});

test("schedule requires positive UTC bounds within 31 days before issuing a request", async () => {
  const calls = [];
  const accepted = { ...booking, status: "accepted", visitId: otherId };
  const page = { items: [accepted], page: { nextCursor: "next-schedule", hasMore: true } };
  const api = homecare.createHomecareApi(clientFor(async (url, init) => {
    calls.push({ url, signal: init.signal });
    return response(page);
  }), nurseId);
  const maximumTo = "2026-12-15T01:00:00.000Z";
  assert.throws(() => api.schedule());
  assert.equal(calls.length, 0);
  for (const options of [
    undefined,
    {},
    { from: time },
    { to: later },
    { from: time, to: time },
    { from: later, to: time },
    { from: time, to: "2026-12-15T01:00:00.001Z" },
    { from: "2026-11-14T08:00:00.000+07:00", to: later },
    { from: time, to: "invalid" },
  ]) {
    assert.throws(() => api.schedule(options));
    assert.equal(calls.length, 0);
  }
  const controller = new AbortController();
  const result = await api.schedule({ from: time, to: maximumTo, cursor: "schedule-cursor", limit: 100 }, controller.signal);
  assert.deepEqual(result, page);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, controller.signal);
  const url = new URL(calls[0].url, "https://forcare.test");
  assert.equal(url.pathname, "/api/v1/schedule");
  assert.deepEqual(Object.fromEntries(url.searchParams), { from: time, to: maximumTo, cursor: "schedule-cursor", limit: "100" });
});

test("foreign receipts stay uncertain and retained intents cannot be replaced", async () => {
  let methods = [];
  const controller = new homecare.HomecareWriteController(clientFor(async (_url, init) => { methods.push(init.method); return response({ ...booking, patientId: otherId }); }), "patient", () => true, () => patientId);
  const operation = homecare.prepareBookingCreate(nurseId, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake });
  await controller.send(operation);
  assert.equal(controller.getSnapshot().status, "uncertain"); assert.deepEqual(methods, ["POST"]);

  const replacement = homecare.prepareBookingCreate(nurseId, {
    slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z",
    intake: { ...intake, note: "Changed while unresolved" },
  }, operation.intent.idempotencyKey);
  await assert.rejects(controller.send(replacement));
  assert.deepEqual(methods, ["POST"]);
  await controller.send(operation);
  assert.deepEqual(methods, ["POST", "POST"]);
  assert.equal(controller.getSnapshot().status, "uncertain");
  assert.equal(controller.getSnapshot().operation, operation);

  const unknownOwnerPayload = { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake };
  const unknownOwner = new homecare.HomecareWriteController(clientFor(async () => response(booking)), "patient", () => true);
  await unknownOwner.send(homecare.prepareBookingCreate(nurseId, unknownOwnerPayload));
  assert.equal(unknownOwner.getSnapshot().status, "uncertain");
});

test("late successful write responses do not start reads or change state after suspension; invalidation wipes payload", async () => {
  let resolve, signal;
  let current = true;
  const methods = [];
  const controller = new homecare.HomecareWriteController(clientFor(async (_url, init) => { methods.push(init.method); signal = init.signal; return new Promise(r => resolve = r); }), "patient", () => current);
  const operation = homecare.prepareBookingCreate(nurseId, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake });
  const pending = controller.send(operation);
  current = false; controller.suspend();
  assert.equal(controller.getSnapshot().status, "uncertain"); assert.equal(signal.aborted, true);
  resolve(response(booking)); await pending;
  assert.equal(controller.getSnapshot().status, "uncertain"); assert.deepEqual(methods, ["POST"]);
  controller.clear(); assert.deepEqual(controller.getSnapshot(), { status: "idle" });
});

test("unknown create reconciliation issues no list/read and exact same-key explicit retry only; replacement stays blocked", async () => {
  let first = true;
  const calls = [];
  const operation = homecare.prepareBookingCreate(nurseId, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake });
  const controller = new homecare.HomecareWriteController(clientFor(async (url, init) => {
    calls.push({ url, method: init.method, key: init.headers.get("idempotency-key"), body: init.body });
    if (first) { first = false; throw Error("lost"); }
    return response(booking);
  }), "patient", () => true, () => patientId);
  await controller.send(operation);
  await controller.reconcile();
  assert.equal(calls.length, 1); assert.equal(controller.getSnapshot().status, "uncertain");
  assert.throws(() => controller.reset());
  await assert.rejects(controller.send(homecare.prepareBookingCreate(nurseId, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake })));
  assert.deepEqual(calls, [{ url: operation.intent.path, method: "POST", key: operation.intent.idempotencyKey, body: operation.intent.body }]);
  await controller.send(operation);
  assert.equal(controller.getSnapshot().status, "verified");
  assert.equal(controller.getSnapshot().result.id, bookingId);
  assert.deepEqual(calls.map(({ url, method, key, body }) => ({ url, method, key, body })), [
    { url: "/api/v1/me/bookings", method: "POST", key: operation.intent.idempotencyKey, body: operation.intent.body },
    { url: "/api/v1/me/bookings", method: "POST", key: operation.intent.idempotencyKey, body: operation.intent.body },
    { url: `/api/v1/me/bookings/${bookingId}`, method: "GET", key: null, body: undefined },
  ]);
  assert.ok(!Object.hasOwn(JSON.parse(calls[1].body), "patientId"));
});

test("a 409 after uncertain delivery remains uncertain and cannot unlock another intent", async () => {
  let first = true;
  const controller = new homecare.HomecareWriteController(clientFor(async () => { if (first) { first = false; throw Error("lost"); } return failure(409, "VERSION_CONFLICT"); }), "patient", () => true);
  const operation = homecare.prepareBookingSubmit(booking);
  await controller.send(operation); await controller.send(operation);
  assert.equal(controller.getSnapshot().status, "uncertain");
  assert.throws(() => controller.reset());
});

test("known stale-target reconciliation performs no replacement write and remains uncertain", async () => {
  let writes = 0;
  const operation = homecare.prepareBookingSubmit(booking);
  const controller = new homecare.HomecareWriteController(clientFor(async (_url, init) => { if (init.method === "POST") writes++; return response({ ...booking, status: "cancelled", version: 2, intake: null }); }), "patient", () => true);
  await controller.send(operation);
  await controller.reconcile();
  assert.equal(controller.getSnapshot().status, "uncertain"); assert.equal(writes, 1);
});

test("known update reconciliation only reads; foreign identity stays unresolved", async () => {
  for (const result of [{ ...booking, patientId: otherId, version: 1, intake: { ...intake, note: "Disimpan" } }, { ...booking, version: 1, intake: { ...intake, note: "Disimpan" } }]) {
    const calls = [];
    const operation = homecare.prepareBookingUpdate(booking, { intake: { ...intake, note: "Disimpan" } });
    const controller = new homecare.HomecareWriteController(clientFor(async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === "PATCH") return new Response("not-json", { status: 200 });
      return response(result);
    }), "patient", () => true);
    await controller.send(operation);
    assert.equal(controller.getSnapshot().status, "uncertain");
    await controller.reconcile();
    if (result.patientId === patientId) assert.equal(controller.getSnapshot().status, "verified"); else assert.equal(controller.getSnapshot().status, "uncertain");
    assert.deepEqual(calls.map(call => call.method), ["PATCH", "GET"]);
    assert.ok(calls.every(call => call.url === `/api/v1/me/bookings/${bookingId}`));
  }
});

test("verify write then fresh read and tolerate terminal nurse privacy projection", async () => {
  const terminal = { ...booking, status: "cancelled", version: 1, intake: null, profileSnapshot: null, decisionReason: "Dibatalkan" };
  const calls = [];
  const operation = homecare.prepareNurseBookingCancellation({ ...booking, status: "submitted" }, "Dibatalkan");
  const controller = new homecare.HomecareWriteController(clientFor(async (_url, init) => { calls.push(init.method); return response(terminal); }), "nurse", () => true);
  await controller.send(operation);
  assert.equal(controller.getSnapshot().status, "verified");
  assert.equal(controller.getSnapshot().result.intake, null);
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("priority review and availability replacement reconcile their exact retained targets", async () => {
  const currentAvailability = { nurseId, version: 1, current: { id: otherId, version: 1, ...availabilityInput, slots: [{ id: bookingId, ...availabilityInput.slots[0] }] } };
  for (const [actor, initial, operation, result] of [
    ["nurse", priority, homecare.preparePriorityRequestReview(priority, { decision: "decline", reason: "Tidak tersedia", available: false }), { ...priority, status: "declined", version: 1, reason: "Tidak tersedia", reviewedAt: time }],
    ["nurse", availability, homecare.prepareAvailabilityWrite(availability, availabilityInput), currentAvailability],
  ]) {
    let first = true;
    const calls = [];
    const controller = new homecare.HomecareWriteController(clientFor(async (_url, init) => { calls.push(init.method); if (first) { first = false; throw Error("lost"); } return response(result); }), actor, () => true);
    await controller.send(operation); await controller.reconcile();
    assert.equal(controller.getSnapshot().status, "verified"); assert.deepEqual(calls, initial === priority ? ["POST", "GET"] : ["PUT", "GET"]);
  }
});

test("availability verification compares the exact fresh policy and resource identity", async () => {
  const foreignAvailability = { ...configuredAvailability, nurseId: patientId };
  for (const [scenario, receipt, fresh, expectedStatus] of [
    ["exact fresh policy", configuredAvailability, configuredAvailability, "verified"],
    ["changed buffer", configuredAvailability, { ...configuredAvailability, current: { ...configuredAvailability.current, bufferMinutes: 1 } }, "uncertain"],
    ["changed immutable version ID", configuredAvailability, { ...configuredAvailability, current: { ...configuredAvailability.current, id: requestId } }, "uncertain"],
    ["foreign fresh nurse resource", configuredAvailability, foreignAvailability, "uncertain"],
    ["foreign receipt and fresh nurse resource", foreignAvailability, foreignAvailability, "uncertain"],
  ]) {
    const calls = [];
    const operation = homecare.prepareAvailabilityWrite(availability, availabilityInput);
    const controller = new homecare.HomecareWriteController(clientFor(async (url, init) => {
      calls.push({ url, method: init.method });
      return response(init.method === "PUT" ? receipt : fresh);
    }), "nurse", () => true, () => nurseId);
    await controller.send(operation);
    const state = controller.getSnapshot();
    assert.equal(state.status, expectedStatus, scenario);
    assert.equal(state.operation, operation, scenario);
    assert.deepEqual(calls, [
      { url: "/api/v1/nurses/me/availability", method: "PUT" },
      { url: "/api/v1/nurses/me/availability", method: "GET" },
    ], scenario);
    if (expectedStatus === "verified") {
      assert.deepEqual(state.result, configuredAvailability, scenario);
      assert.equal(state.error, undefined, scenario);
    } else {
      assert.equal(state.result, undefined, scenario);
      assert.equal(state.error.code, "INVALID_RESPONSE", scenario);
      assert.equal(state.error.status, 200, scenario);
      assert.throws(() => controller.reset(), /Resolve retained intent first/, scenario);
      await assert.rejects(controller.send(homecare.prepareAvailabilityWrite(availability, availabilityInput)), /Resolve retained operation first/, scenario);
      assert.equal(controller.getSnapshot(), state, scenario);
      assert.equal(calls.length, 2, scenario);
    }
  }
});

test("both cookie-session workspaces retain Homecare writers across detach and wipe on logout", async () => {
  for (const role of ["patient", "nurse"]) {
    const session = { account: { id: "account", email: "synthetic@example.invalid", roles: [role], status: "active" }, session: { csrfToken: "csrf", expiresAt: "2026-11-16T01:00:00.000Z" }, access: { scopes: [role === "patient" ? "patient:self" : "nurse:directory"], accessContexts: [] }, displayTimeZone: "Asia/Jakarta", expiresAt: "2026-11-16T01:00:00.000Z", capabilities: {} };
    let first = true;
    let logoutAttempts = 0;
    const mutations = [];
    const controller = new SessionController({ fetch: async (_url, init) => {
      if (init.method !== "GET") mutations.push({ url: _url, method: init.method, body: init.body, key: init.headers.get("idempotency-key") });
      if (init.method === "GET") return response(session);
      if (init.method === "POST" && _url.endsWith("auth/logout")) {
        if (++logoutAttempts === 1) throw Error("logout response lost");
        return new Response(null, { status: 204 });
      }
      if (first) { first = false; throw Error("lost"); }
      return response(booking);
    } });
    await controller.refresh();
    const getWorkspace = role === "patient" ? getPatientWorkspace : getNurseWorkspace;
    const workspace = getWorkspace(controller), detach = workspace.scope.connect();
    assert.equal(typeof workspace.homecare.write, "function");
    const writer = workspace.homecareWrites.writer();
    const operation = role === "patient" ? homecare.prepareBookingCreate(nurseId, { slotId: null, startsAt: later, endsAt: "2026-11-15T02:00:00.000Z", intake }) : homecare.prepareAvailabilityWrite(availability, availabilityInput);
    await writer.send(operation);
    assert.equal(writer.getSnapshot().status, "uncertain"); detach();
    assert.equal(getWorkspace(controller), workspace); assert.equal(workspace.homecareWrites.writer(), writer);
    const operationBeforeLogout = writer.getSnapshot().operation;
    workspace.scope.suspend();
    assert.equal(workspace.homecareWrites.writer(), writer);
    await assert.rejects(controller.logout());
    assert.equal(controller.getSnapshot().status, "authenticated");
    assert.equal(controller.getSnapshot().logoutError.status, 0);
    await assert.rejects(writer.send(operationBeforeLogout), /Inactive/);
    assert.equal(mutations.length, 2);
    assert.equal(mutations[1].url, "/api/v1/auth/logout");
    assert.equal(writer.getSnapshot().status, "uncertain");
    assert.equal(writer.getSnapshot().operation, operationBeforeLogout);
    await controller.logout();
    assert.equal(logoutAttempts, 2);
    assert.deepEqual(writer.getSnapshot(), { status: "idle" });
  }
});
