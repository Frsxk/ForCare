import { test } from "bun:test";
import assert from "node:assert/strict";
import { createApiClient, ApiError } from "../lib/api/client";
import { SessionController } from "../lib/api/session";

const modules = await Promise.all([import("../lib/api/nurse").catch(() => null), import("../lib/api/scoped-resource").catch(() => null)]);
const apiModule = () => { assert.ok(modules[0], "Real nurse DTO/API module is required"); return modules[0]; };
const scopedModule = () => { assert.ok(modules[1], "Session-scoped resource module is required"); return modules[1]; };
const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072";
const recordId = "cb24dd80-d0ca-439a-b563-58ab724a3bea";
const requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const date = "2026-11-14T01:00:00.000Z";
const page = { nextCursor: null, hasMore: false };
const payload = { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null, allergies: [], procedures: [], complaints: null, observations: [], internalNote: null };
const record = { id: recordId, patientId, revisionNumber: 4, supersedesId: null, sourceReference: "Staff supplied source", payload, recordedAt: date, enteredBy: patientId, version: 0 };
const response = data => new Response(JSON.stringify({ data, requestId }));
const session = { account: { id: patientId, email: "test@example.invalid", status: "active", roles: ["nurse"] }, session: { csrfToken: "test-csrf", expiresAt: date }, access: { scopes: ["nurse:directory", "nurse:assigned"], accessContexts: [] }, displayTimeZone: "Asia/Jakarta", expiresAt: date, capabilities: {} };

 test("directory decodes server facts only: null latest check-in and no invented risk, age or visit", () => {
  const { decodePatients } = apiModule();
  assert.deepEqual(decodePatients({ scope: "assigned", items: [{ id: patientId, displayName: "Scoped Patient", recordNumber: null, latestCheckIn: null, nextVisit: null, risk: "high" }], page }), { scope: "assigned", items: [{ id: patientId, displayName: "Scoped Patient", recordNumber: null, latestCheckIn: null, nextVisit: null }], page });
  assert.throws(() => decodePatients({ scope: "all", items: [], page }));
  assert.throws(() => decodePatients({ scope: "assigned", items: [{ id: "RM-001", displayName: "Fixture" }], page }));
  assert.throws(() => decodePatients({ scope: "assigned", items: [], page: { hasMore: true, nextCursor: null } }));
});

test("API always requests assigned scope, encodes search/cursor, and reads real UUID paths", async () => {
  const { createNurseApi } = apiModule(); const calls = [];
  const client = createApiClient({ fetch: async (url, init) => { calls.push([url, init]); return response({ scope: "assigned", items: [], page }); } });
  await createNurseApi(client).patients({ search: "A & B", cursor: "opaque+/=" });
  const url = new URL(calls[0][0], "http://localhost");
  assert.equal(url.pathname, "/api/v1/patients"); assert.equal(url.searchParams.get("scope"), "assigned");
  assert.equal(url.searchParams.get("search"), "A & B"); assert.equal(url.searchParams.get("cursor"), "opaque+/=");
  assert.equal(calls[0][1].cache, "no-store");
  await assert.rejects(async () => createNurseApi(client).detail("mock-rm-id"));
});

test("medical create/correction uses ALL nullable/array fields and latest revisionNumber, never workflow version", () => {
  const { prepareMedicalRecord } = apiModule();
  const first = JSON.parse(prepareMedicalRecord(patientId, null, "Manual source", payload).body);
  assert.deepEqual(first, { expectedVersion: 0, sourceReference: "Manual source", payload });
  const correction = JSON.parse(prepareMedicalRecord(patientId, record, "Correction source", { ...payload, allergies: ["Recorded allergy"], observations: [{ type: "source fact", value: 0 }] }).body);
  assert.equal(correction.expectedVersion, 4); assert.equal(correction.supersedesId, recordId);
  assert.deepEqual(correction.payload.secondaryDiagnoses, []); assert.equal(correction.payload.internalNote, null);
  assert.deepEqual(correction.payload.observations, [{ type: "source fact", value: 0 }]);
});

test("strict snapshot inputs reject missing arrays, nullability mismatch, unknown fields and impossible UTC dates", () => {
  const { prepareMedicalRecord } = apiModule();
  for (const invalid of [{ ...payload, allergies: null }, { ...payload, internalNote: undefined }, { ...payload, risk: 2 }, { ...payload, primaryDiagnosis: "" }, { ...payload, observations: [{ type: "fact", confirmed: true }] }, { ...payload, admittedAt: "2026-02-30T01:00:00Z" }, { ...payload, admittedAt: date, dischargedAt: "2026-11-13T01:00:00Z" }]) {
    assert.throws(() => prepareMedicalRecord(patientId, record, "Source", invalid));
  }
  assert.throws(() => prepareMedicalRecord(patientId, record, " ", payload));
});

test("nurse profile decoder projects source identity, never demo defaults or another role", () => {
  const { decodeNurseProfile } = apiModule();
  const dto = { role: "nurse", id: patientId, accountId: patientId, staffCode: "S-REAL", displayName: "Server Nurse", discipline: "nurse", email: "server@example.invalid", phone: null, displayTimeZone: "Asia/Jakarta", version: 0 };
  assert.deepEqual(decodeNurseProfile(dto), dto);
  assert.throws(() => decodeNurseProfile({ ...dto, role: "patient" }));
  assert.throws(() => decodeNurseProfile({ ...dto, displayName: undefined }));
});

test("observation projection keeps latest patient measurement distinct from older confirmed observation", () => {
  const { decodeObservations } = apiModule();
  const latestObservation = { id: recordId, checkInId: patientId, type: "weight_kg", value: 50, unit: "kg", observedAt: date, source: "patient_check_in" };
  const lastConfirmed = { value: 49, unit: "kg", observedAt: "2026-11-13T00:00:00Z", confirmedAt: date, confirmedByStaffId: patientId, observationId: patientId, checkInId: patientId };
  const dto = decodeObservations({ latestObservation, lastConfirmed, history: { items: [latestObservation], page }, trend: { status: "unavailable", reason: "G02_NOT_APPROVED" } });
  assert.equal(dto.latestObservation.value, 50); assert.equal(dto.lastConfirmed.value, 49); assert.equal(dto.trend.status, "unavailable");
});

test("late old-session reads are cleared immediately and cannot repopulate after logout, even when transport ignores abort", async () => {
  const { SessionScope } = scopedModule(); let resolve;
  const controller = new SessionController({ fetch: async url => url.endsWith("logout") ? new Response(null, { status: 204 }) : response(session) });
  await controller.refresh(); const scope = new SessionScope(controller); scope.connect(); const resource = scope.resource();
  const pending = resource.load(() => new Promise(r => { resolve = r; }));
  await controller.logout(); resolve("PRIVATE_OLD_PATIENT"); await pending;
  assert.equal(resource.getSnapshot().status, "idle"); assert.equal(resource.getSnapshot().data, undefined);
  scope.dispose();
});

test("newer search results cannot be overwritten by an older fetch", async () => {
  const { SessionScope } = scopedModule(); let resolve;
  const controller = new SessionController({ fetch: async () => response(session) }); await controller.refresh();
  const scope = new SessionScope(controller); scope.connect(); const resource = scope.resource();
  const old = resource.load(() => new Promise(r => { resolve = r; }));
  await resource.load(async () => "new search"); resolve("old search"); await old;
  assert.equal(resource.getSnapshot().data, "new search"); scope.dispose();
});

test("uncertain medical write retains exact intent/key, reconciles by reads, and explicit retry replays same bytes", async () => {
  const { prepareMedicalRecord, MedicalWriteController } = apiModule();
  const calls = []; let mode = "lost";
  const client = createApiClient({ fetch: async (url, init) => { calls.push({ url, init }); if (init.method === "POST" && mode === "lost") throw new TypeError("lost response"); return response({ ...record, revisionNumber: 1, supersedesId: null, sourceReference: "Manual source" }); } });
  client.setCsrfToken("csrf");
  const intent = prepareMedicalRecord(patientId, null, "Manual source", payload);
  const writer = new MedicalWriteController(client, () => true);
  await writer.send(intent); assert.equal(writer.getSnapshot().status, "uncertain");
  assert.equal(writer.getSnapshot().intent, intent); assert.throws(() => writer.reset());
  mode = "ok"; await writer.send(intent);
  assert.equal(writer.getSnapshot().status, "verified");
  const writes = calls.filter(c => c.init.method === "POST");
  assert.equal(writes.length, 2); assert.equal(writes[0].init.body, writes[1].init.body);
  assert.equal(writes[0].init.headers.get("idempotency-key"), writes[1].init.headers.get("idempotency-key"));
  assert.equal(calls.at(-1).init.method, "GET"); assert.ok(calls.at(-1).url.endsWith(recordId));
});

test("a known successful write with denied readback stays uncertain, not safely rejected", async () => {
  const { prepareMedicalRecord, MedicalWriteController } = apiModule();
  const client = createApiClient({ fetch: async (url, init) => init.method === "POST" ? response({ ...record, revisionNumber: 1, sourceReference: "Manual source" }) : new Response(JSON.stringify({ error: { code: "NOT_FOUND", requestId } }), { status: 404 }) });
  client.setCsrfToken("csrf");
  const writer = new MedicalWriteController(client, () => true);
  const intent = prepareMedicalRecord(patientId, null, "Manual source", payload);
  await writer.send(intent);
  assert.equal(writer.getSnapshot().status, "uncertain");
  assert.equal(writer.getSnapshot().intent, intent);
  assert.throws(() => writer.reset());
});

test("failed readback never claims a write was verified; version conflict is actionable", async () => {
  const { prepareMedicalRecord, MedicalWriteController } = apiModule(); const intent = prepareMedicalRecord(patientId, record, "Source", payload);
  const client = createApiClient({ fetch: async () => { throw new TypeError("offline"); } }); client.setCsrfToken("csrf");
  const writer = new MedicalWriteController(client, () => true); await writer.send(intent);
  assert.equal(writer.getSnapshot().status, "uncertain"); assert.equal(writer.getSnapshot().intent, intent);
  assert.match(new ApiError("VERSION_CONFLICT", 409).message, /Muat ulang/);
});
