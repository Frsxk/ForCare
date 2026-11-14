import { test } from "bun:test";
import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client";
import { SessionController } from "../lib/api/session";
import { SessionScope } from "../lib/api/scoped-resource";
import { PatientWriteController, createPatientApi, decodePatientGuide, decodePublishedAnalysis, decodePatientProfile, prepareCheckIn, prepareCheckInSubmit, preparePatientContact, checkInValuesEqual } from "../lib/api/patient";
const ownId = "da5fca18-0822-4001-b503-dd2fb9fca072", id = "cb24dd80-d0ca-439a-b563-58ab724a3bea", accountId = "c312c603-7d47-4c90-9d66-c387e391a988", requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const time = "2026-11-14T01:00:00Z";
const input = { condition: "complaint", note: "Catatan saya", medicationAdherence: "missed_once", observations: [{ type: "weight_kg", value: 60.5, unit: "kg", observedAt: time }, { type: "temperature_c", value: 37.1, unit: "c", observedAt: time }] };
const record = { ...input, id, patientId: ownId, status: "draft", version: 0, localDate: "2026-11-14", timeZone: "Asia/Jakarta", createdAt: time, updatedAt: time, submittedAt: null, supersedesCheckInId: null };
const profile = { role: "patient", id: ownId, accountId, fullName: "Nama dari server", birthDate: "1990-01-01", gender: "male", phone: "08123456789", addressLine: null, emergencyContactName: null, emergencyContactPhone: null, recordNumber: null, primaryNurse: null, version: 0 };
const response = data => new Response(JSON.stringify({ data, requestId }));
const failure = status => new Response(JSON.stringify({ error: { code: status === 409 ? "VERSION_CONFLICT" : "FORBIDDEN", requestId } }), { status });
const client = fetch => { const api = createApiClient({ fetch }); api.setCsrfToken("csrf"); return api; };
test("exact create/edit/submit contract includes scalar adherence, observations and expectedVersion only when needed", () => {
 const create = prepareCheckIn(ownId, { ...input, note: " Catatan saya ", patientId: id, status: "submitted" });
 const body = JSON.parse(create.intent.body);
 assert.equal(create.intent.path, "/api/v1/check-ins"); assert.deepEqual(Object.keys(body).sort(), ["condition", "medicationAdherence", "note", "observations"]); assert.equal(body.note, input.note);
 const edit = prepareCheckIn(ownId, input, record); assert.equal(edit.intent.method, "PUT"); assert.equal(JSON.parse(edit.intent.body).expectedVersion, 0);
 assert.deepEqual(JSON.parse(prepareCheckInSubmit(ownId, record).intent.body), { expectedVersion: 0 });
 assert.throws(() => prepareCheckInSubmit(id, record)); assert.throws(() => prepareCheckIn(ownId, input, { ...record, status: "submitted" }));
 assert.equal(checkInValuesEqual(input, { ...input, observations: [...input.observations].reverse() }), true);
});
test("duplicate types, wrong units, invalid precision and invalid IDs are not silently repaired", () => {
 for (const observations of [[input.observations[0], input.observations[0]], [{ ...input.observations[0], unit: "KG" }], [{ ...input.observations[0], value: 1.0001 }]]) assert.throws(() => prepareCheckIn(ownId, { ...input, observations }));
 assert.throws(() => prepareCheckIn(` ${ownId}`, input));
});
test("create then versioned edit then explicit submit each verify with exact-target GET", async () => {
 let stored, writes = [], reads = [];
 const api = client(async (url, init) => {
  if (init.method === "GET") { reads.push(url); return response(stored); }
  const body = JSON.parse(init.body); writes.push({ url, method: init.method, body, key: init.headers.get("idempotency-key") });
  stored = !stored ? record : url.endsWith("submit") ? { ...stored, status: "submitted", version: stored.version + 1, submittedAt: time } : { ...stored, ...body, version: stored.version + 1 };
  return response(stored);
 });
 const writer = new PatientWriteController(api, ownId, () => true);
 await writer.send(prepareCheckIn(ownId, input)); assert.equal(writer.getSnapshot().status, "verified");
 writer.reset(); await writer.send(prepareCheckIn(ownId, { ...input, note: "Diperbarui" }, stored)); assert.equal(writer.getSnapshot().status, "verified");
 writer.reset(); await writer.send(prepareCheckInSubmit(ownId, stored)); assert.equal(writer.getSnapshot().status, "verified"); assert.equal(stored.status, "submitted");
 assert.deepEqual(writes.map(w => w.method), ["POST", "PUT", "POST"]); assert.deepEqual(writes[2].body, { expectedVersion: 1 }); assert.equal(new Set(writes.map(w => w.key)).size, 3); assert.deepEqual(reads, Array(3).fill(`/api/v1/check-ins/${id}`));
});
test("uncertain delivery retains exact body/key and later 4xx cannot unlock replacement", async () => {
 const calls = []; let count = 0;
 const writer = new PatientWriteController(client(async (url, init) => { calls.push({ url, body: init.body, key: init.headers.get("idempotency-key") }); if (++count === 1) throw Error("lost"); return failure(409); }), ownId, () => true);
 const operation = prepareCheckIn(ownId, input);
 await writer.send(operation); assert.equal(writer.getSnapshot().status, "uncertain");
 assert.throws(() => writer.reset()); await assert.rejects(writer.send(prepareCheckIn(ownId, input)));
 await writer.send(operation); assert.equal(writer.getSnapshot().status, "uncertain"); assert.equal(writer.getSnapshot().operation, operation); assert.deepEqual(calls[0], calls[1]);
});
test("successful write followed by verification 403 or 404 stays uncertain; reconciliation never writes", async () => {
 for (const status of [403, 404]) {
  const methods = []; const writer = new PatientWriteController(client(async (_url, init) => { methods.push(init.method); return init.method === "POST" ? response(record) : failure(status); }), ownId, () => true);
  await writer.send(prepareCheckIn(ownId, input)); assert.equal(writer.getSnapshot().status, "uncertain"); await writer.reconcile(); assert.equal(writer.getSnapshot().status, "uncertain"); assert.deepEqual(methods, ["POST", "GET", "GET"]);
 }
});
test("explicit exact-key retry recovers unknown create; no automatic retry or list-based inference", async () => {
 const methods = []; let count = 0;
 const writer = new PatientWriteController(client(async (_url, init) => { methods.push(init.method); if (++count === 1) throw Error("lost"); return response(record); }), ownId, () => true);
 const operation = prepareCheckIn(ownId, input); await writer.send(operation); await writer.reconcile(); assert.deepEqual(methods, ["POST"]); assert.equal(writer.getSnapshot().status, "uncertain");
 await writer.send(operation); assert.equal(writer.getSnapshot().status, "verified"); assert.deepEqual(methods, ["POST", "POST", "GET"]);
});
test("first-attempt 4xx is rejected, but timeout 408 is uncertain", async () => {
 for (const [status, expected] of [[422, "rejected"], [409, "rejected"], [408, "uncertain"]]) { const writer = new PatientWriteController(client(async () => failure(status)), ownId, () => true); await writer.send(prepareCheckIn(ownId, input)); assert.equal(writer.getSnapshot().status, expected); }
});
test("session invalidation aborts mutation and discards late results without verification GET", async () => {
 let current = true, resolve, signal; const methods = [];
 const writer = new PatientWriteController(client(async (_url, init) => { methods.push(init.method); signal = init.signal; return new Promise(r => { resolve = r; }); }), ownId, () => current);
 const pending = writer.send(prepareCheckIn(ownId, input)); current = false; writer.clear(); assert.equal(signal.aborted, true); resolve(response(record)); await pending; assert.equal(writer.getSnapshot().status, "idle"); assert.deepEqual(methods, ["POST"]);
});
test("patient-bound writer and reads reject another patient", async () => {
 const calls = []; const api = client(async (url, init) => { calls.push(init.method); return response({ ...record, patientId: id }); });
 const writer = new PatientWriteController(api, ownId, () => true); await assert.rejects(writer.send(prepareCheckIn(id, input))); assert.equal(calls.length, 0);
 await assert.rejects(createPatientApi(api).checkIn(ownId, id), /Respons server/);
});
test("profile contacts use actual versioned PATCH endpoint and verify readback", async () => {
 const methods = [], next = { ...profile, phone: "08129998888", version: 1 };
 const api = client(async (_url, init) => { methods.push(init.method); return response(next); });
 const writer = new PatientWriteController(api, ownId, () => true), operation = preparePatientContact(profile, next);
 assert.equal(operation.intent.path, "/api/v1/me/profile"); assert.equal(operation.intent.method, "PATCH"); assert.deepEqual(Object.keys(JSON.parse(operation.intent.body)).sort(), ["addressLine", "emergencyContactName", "emergencyContactPhone", "expectedVersion", "phone"]);
 await writer.send(operation); assert.equal(writer.getSnapshot().status, "verified"); assert.deepEqual(methods, ["PATCH", "GET"]);
});
test("patient projections expose active orders and published claims only, dropping private fields", () => {
 const guide = decodePatientGuide({ patientId: ownId, sources: [{ id, title: "Instructions", body: "Visible", revisionNumber: 1, approvedAt: time, internalNote: "SECRET" }], orders: [{ id, kind: "care", status: "active", instructions: "Visible order", items: [{ type: "care", text: "Visible item" }], effectiveFrom: time, effectiveTo: null, internalNote: "SECRET" }], inputSnapshot: "SECRET" }, ownId);
 assert.doesNotMatch(JSON.stringify(guide), /SECRET|inputSnapshot|internalNote/);
 const published = { id, patientId: ownId, checkInId: id, status: "published", revisionNumber: 1, reviews: [], publication: { analysisId: id, revisionNumber: 1, publishedAt: time }, claims: [{ claimId: id, text: "Approved claim" }], inputSnapshot: "SECRET", provider: "SECRET" };
 assert.doesNotMatch(JSON.stringify(decodePublishedAnalysis(published, ownId)), /SECRET|provider|inputSnapshot/);
 assert.throws(() => decodePublishedAnalysis({ ...published, status: "draft" }, ownId)); assert.throws(() => decodePublishedAnalysis({ ...published, reviews: [{ comment: "SECRET" }] }, ownId)); assert.throws(() => decodePublishedAnalysis(published, id));
 assert.equal(decodePatientProfile(profile).id, ownId);
});
test("verification mismatch preserves uncertainty and an old receipt cannot verify a new create", async () => {
 let count = 0;
 const writer = new PatientWriteController(client(async (_url, init) => { if (++count > 2) throw Error("lost"); return response(record); }), ownId, () => true);
 await writer.send(prepareCheckIn(ownId, input)); assert.equal(writer.getSnapshot().status, "verified");
 await writer.send(prepareCheckIn(ownId, input)); assert.equal(writer.getSnapshot().status, "uncertain"); await writer.reconcile(); assert.equal(count, 3); assert.equal(writer.getSnapshot().status, "uncertain");
 const mismatch = new PatientWriteController(client(async (_url, init) => response(init.method === "POST" ? record : { ...record, note: "Changed elsewhere" })), ownId, () => true);
 await mismatch.send(prepareCheckIn(ownId, input)); assert.equal(mismatch.getSnapshot().status, "uncertain"); assert.throws(() => mismatch.reset());
});
test("read-only reconciliation recovers committed versioned edit and profile writes", async () => {
 for (const operation of [prepareCheckIn(ownId, input, record), preparePatientContact(profile, { ...profile, phone: "08129998888" })]) {
  let count = 0; const methods = [];
  const stored = operation.kind === "profile" ? { ...profile, phone: "08129998888", version: 1 } : { ...record, version: 1 };
  const writer = new PatientWriteController(client(async (_url, init) => { methods.push(init.method); if (++count === 1) throw Error("lost"); return response(stored); }), ownId, () => true);
  await writer.send(operation); assert.equal(writer.getSnapshot().status, "uncertain"); await writer.reconcile(); assert.equal(writer.getSnapshot().status, "verified"); assert.deepEqual(methods, [operation.intent.method, "GET"]);
 }
});
test("scoped reads are discarded after session invalidation", async () => {
 const session = { account: { id: accountId, email: "patient@example.invalid", roles: ["patient"], status: "active" }, session: { csrfToken: "csrf", expiresAt: "2026-11-15T00:00:00Z" }, access: { scopes: ["patient:self"], accessContexts: [] }, capabilities: {}, displayTimeZone: "Asia/Jakarta", expiresAt: "2026-11-15T00:00:00Z" };
 let resolve, signal;
 const controller = new SessionController({ fetch: async url => url.endsWith("logout") ? new Response(null, { status: 204 }) : response(session) }); await controller.refresh();
 const scope = new SessionScope(controller); const disconnect = scope.connect(); const resource = scope.resource();
 const pending = resource.load(s => { signal = s; return new Promise(r => { resolve = r; }); }); await controller.logout(); assert.equal(signal.aborted, true); resolve(record); await pending; assert.equal(resource.getSnapshot().status, "idle"); disconnect();
});
