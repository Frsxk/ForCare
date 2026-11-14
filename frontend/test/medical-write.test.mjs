import { test } from "bun:test";
import assert from "node:assert/strict";
import { createApiClient } from "../lib/api/client";
import * as medical from "../lib/api/nurse";
const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072", otherId = "cb24dd80-d0ca-439a-b563-58ab724a3bea";
const requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const payload = { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null, allergies: [], procedures: [], complaints: null, observations: [], internalNote: null };
const record = { id: otherId, patientId, revisionNumber: 1, supersedesId: null, sourceReference: "Source", payload, recordedAt: "2026-11-14T01:00:00Z", enteredBy: otherId, version: 0 };
const response = data => new Response(JSON.stringify({ data, requestId }));
const failure = status => new Response(JSON.stringify({ error: { code: status === 409 ? "VERSION_CONFLICT" : "FORBIDDEN", requestId } }), { status });
const clientFor = fetch => { const api = createApiClient({ fetch }); api.setCsrfToken("csrf"); return api; };
test("session registry retains exact uncertain intent across patient navigation and isolates/destroys state", async () => {
 assert.equal(typeof medical.MedicalWriteRegistry, "function");
 let current = true;
 const registry = new medical.MedicalWriteRegistry(clientFor(async () => { throw Error("lost"); }), () => current);
 const writer = registry.patient(patientId), intent = medical.prepareMedicalRecord(patientId, null, "Source", payload);
 await writer.send(intent);
 assert.equal(registry.patient(patientId), writer); assert.equal(registry.patient(otherId).getSnapshot().status, "idle");
 assert.equal(registry.patient(patientId).getSnapshot().intent, intent);
 current = false; registry.clear();
 assert.equal(writer.getSnapshot().status, "idle"); assert.equal(writer.getSnapshot().intent, undefined);
 assert.throws(() => registry.patient(patientId));
});
test("retry after uncertain delivery cannot unlock a replacement on a later 4xx", async () => {
 let count = 0;
 const writer = new medical.MedicalWriteController(clientFor(async () => { if (++count === 1) throw Error("lost"); return failure(409); }), () => true);
 const intent = medical.prepareMedicalRecord(patientId, null, "Source", payload);
 await writer.send(intent); await writer.send(intent);
 assert.equal(writer.getSnapshot().status, "uncertain"); assert.equal(writer.getSnapshot().intent, intent); assert.throws(() => writer.reset());
});
test("definitive first-attempt 4xx permits corrected intent with a new key", async () => {
 const writer = new medical.MedicalWriteController(clientFor(async () => failure(422)), () => true);
 const intent = medical.prepareMedicalRecord(patientId, null, "Source", payload);
 await writer.send(intent); assert.equal(writer.getSnapshot().status, "rejected"); writer.reset();
 assert.notEqual(medical.prepareMedicalRecord(patientId, null, "Corrected source", payload).idempotencyKey, intent.idempotencyKey);
});
test("403 verification after committed write remains uncertain and reconciliation reads never write", async () => {
 const methods = [];
 const writer = new medical.MedicalWriteController(clientFor(async (_url, init) => { methods.push(init.method); return init.method === "POST" ? response(record) : failure(403); }), () => true);
 await writer.send(medical.prepareMedicalRecord(patientId, null, "Source", payload));
 assert.equal(writer.getSnapshot().status, "uncertain"); await writer.reconcile();
 assert.equal(writer.getSnapshot().status, "uncertain"); assert.deepEqual(methods, ["POST", "GET", "GET"]);
});
test("session invalidation ignores late writes and does not start a stale verification read", async () => {
 let resolve, current = true; const methods = [];
 const writer = new medical.MedicalWriteController(clientFor(async (_url, init) => { methods.push(init.method); return new Promise(r => { resolve = r; }); }), () => current);
 const pending = writer.send(medical.prepareMedicalRecord(patientId, null, "Source", payload));
 current = false; writer.dispose(); resolve(response(record)); await pending;
 assert.equal(writer.getSnapshot().status, "idle"); assert.deepEqual(methods, ["POST"]);
});
test("snapshot normalization matches authoritative trimmed text without dropping values", () => {
 const intent = medical.prepareMedicalRecord(patientId, null, " Source ", { ...payload, primaryDiagnosis: " Source diagnosis ", observations: [{ type: " measurement ", value: " zero ", unit: " kg " }] });
 const input = JSON.parse(intent.body);
 assert.equal(input.payload.primaryDiagnosis, "Source diagnosis"); assert.deepEqual(input.payload.observations, [{ type: "measurement", value: "zero", unit: "kg" }]);
});

test("patient-retained controller refuses another patient's intent before transport", async () => {
 const methods = [];
 const registry = new medical.MedicalWriteRegistry(clientFor(async (_url, init) => { methods.push(init.method); return response(record); }), () => true);
 await assert.rejects(() => registry.patient(patientId).send(medical.prepareMedicalRecord(otherId, null, "Source", payload)));
 assert.deepEqual(methods, []);
});
test("a timeout 408 cannot prove that a medical write was rejected", async () => {
 const writer = new medical.MedicalWriteController(clientFor(async () => failure(408)), () => true);
 await writer.send(medical.prepareMedicalRecord(patientId, null, "Source", payload));
 assert.equal(writer.getSnapshot().status, "uncertain"); assert.throws(() => writer.reset());
});
test("read-only reconciliation verifies the retained payload before replacement is permitted", async () => {
 let lost = true; const methods = [];
 const writer = new medical.MedicalWriteController(clientFor(async (url, init) => {
  methods.push(init.method);
  if (lost) { lost = false; throw Error("lost"); }
  return response(url.includes("?") ? { items: [record], page: { nextCursor: null, hasMore: false } } : record);
 }), () => true);
 await writer.send(medical.prepareMedicalRecord(patientId, null, "Source", payload)); await writer.reconcile();
 assert.equal(writer.getSnapshot().status, "verified"); assert.equal(writer.getSnapshot().record.id, record.id);
 assert.deepEqual(methods, ["POST", "GET", "GET"]); writer.reset();
});
