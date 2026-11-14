import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionController } from "../lib/api/session";
const stores = await import("../lib/api/workspaces").catch(() => null);
const getPatientWorkspace = c => { assert.ok(stores, "Session-lifetime workspace stores required"); return stores.getPatientWorkspace(c); };
const getNurseWorkspace = c => { assert.ok(stores, "Session-lifetime workspace stores required"); return stores.getNurseWorkspace(c); };
import { prepareCheckIn, preparePatientContact } from "../lib/api/patient";
import { prepareMedicalRecord } from "../lib/api/nurse";
import * as patientUi from "../components/patient-live-pages";
const ContactEditor = props => { assert.equal(typeof patientUi.ContactEditor, "function"); return createElement(patientUi.ContactEditor, props); };
const id = "da5fca18-0822-4001-b503-dd2fb9fca072", accountId = "c312c603-7d47-4c90-9d66-c387e391a988", requestId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const profile = { role: "patient", id, accountId, fullName: "Server Patient", birthDate: "1990-01-01", gender: "male", phone: "08123456789", addressLine: null, emergencyContactName: null, emergencyContactPhone: null, recordNumber: null, primaryNurse: null, version: 0 };
const input = { condition: "ok", note: null, medicationAdherence: "regular", observations: [] };
const payload = { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null, allergies: [], procedures: [], complaints: null, observations: [], internalNote: null };
const ok = data => new Response(JSON.stringify({ data, requestId }));
function fixture(role = "patient") {
 let session = { account: { id: accountId, email: "fixture@example.invalid", roles: [role], status: "active" }, session: { csrfToken: "csrf", expiresAt: "2026-11-15T00:00:00Z" }, access: { scopes: [role === "patient" ? "patient:self" : "nurse:directory"], accessContexts: [] }, displayTimeZone: "Asia/Jakarta", expiresAt: "2026-11-15T00:00:00Z", capabilities: {} };
 let logout = () => { throw Error("offline"); }, read = () => ok(profile); const writes = [];
 const controller = new SessionController({ fetch: async (url, init) => {
  if (url.endsWith("auth/session")) return ok(session);
  if (url.endsWith("auth/logout")) return logout();
  if (init.method === "GET") return read();
  writes.push({ body: init.body, key: init.headers.get("idempotency-key") }); throw Error("lost write response");
 } });
 return { controller, writes, setLogout: fn => logout = fn, setRead: fn => read = fn, switchAccount: () => session = { ...session, account: { ...session.account, id }, session: { ...session.session, csrfToken: "other" } } };
}
async function patient(f) { await f.controller.refresh(); const w = getPatientWorkspace(f.controller); await w.profile.load(w.api.profile); return w; }
function formValues(html) {
 return Array.from(html.matchAll(/<input\b[^>]*\bvalue="([^"]*)"[^>]*>|<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g), match => match[1] ?? match[2]);
}
test("temporary boundary detach retains exact patient intent and forbids replacement", async () => {
 const f = fixture(), workspace = await patient(f), disconnect = workspace.scope.connect(), writer = workspace.writer(id), operation = prepareCheckIn(id, input);
 await writer.send(operation); disconnect();
 const returned = getPatientWorkspace(f.controller); assert.equal(returned, workspace);
 await returned.profile.load(returned.api.profile); assert.equal(returned.writer(id), writer); assert.equal(writer.getSnapshot().operation, operation);
 assert.throws(() => writer.reset()); await assert.rejects(writer.send(prepareCheckIn(id, input)));
 await writer.send(operation); assert.deepEqual(f.writes[0], f.writes[1]);
});
test("logout pending and failure suspend preserved intent until same session is verified", async () => {
 const f = fixture(), workspace = await patient(f), writer = workspace.writer(id), operation = prepareCheckIn(id, input);
 await writer.send(operation); let reject; f.setLogout(() => new Promise((_, r) => reject = r)); const pending = f.controller.logout();
 assert.equal(workspace.scope.isCurrent(), false); await assert.rejects(writer.send(operation)); assert.equal(writer.getSnapshot().operation, operation);
 reject(Error("offline")); await assert.rejects(pending); assert.equal(workspace.scope.isCurrent(), false); await assert.rejects(writer.send(operation));
 await f.controller.refresh(); assert.equal(getPatientWorkspace(f.controller), workspace); assert.equal(workspace.scope.isCurrent(), true);
 await writer.send(operation); assert.deepEqual(f.writes[0], f.writes[1]);
});
test("confirmed logout, account switch and expiry wipe retained patient payloads", async () => {
 for (const ending of ["logout", "switch", "expiry"]) {
  const f = fixture(), workspace = await patient(f), writer = workspace.writer(id); await writer.send(prepareCheckIn(id, input));
  if (ending === "logout") { f.setLogout(() => new Response(null, { status: 204 })); await f.controller.logout(); }
  if (ending === "switch") { f.switchAccount(); await f.controller.refresh(); }
  if (ending === "expiry") { f.setRead(() => new Response(JSON.stringify({ error: { code: "SESSION_EXPIRED", requestId } }), { status: 401 })); await assert.rejects(workspace.api.profile()); }
  assert.equal(writer.getSnapshot().status, "idle"); assert.equal(workspace.scope.isCurrent(), false);
 }
});
test("nurse detours preserve patient-keyed intents while logout failure suspends them", async () => {
 const f = fixture("nurse"); await f.controller.refresh(); const workspace = getNurseWorkspace(f.controller), detach = workspace.scope.connect();
 const writer = workspace.medical.patient(id), intent = prepareMedicalRecord(id, null, "Server source", payload); await writer.send(intent); detach();
 assert.equal(getNurseWorkspace(f.controller).medical.patient(id), writer); assert.equal(writer.getSnapshot().intent, intent);
 await assert.rejects(f.controller.logout()); await writer.send(intent); assert.equal(f.writes.length, 1); assert.equal(writer.getSnapshot().intent, intent);
 await f.controller.refresh(); await writer.send(intent); assert.deepEqual(f.writes[0], f.writes[1]);
 f.setLogout(() => new Response(null, { status: 204 })); await f.controller.logout(); assert.equal(writer.getSnapshot().status, "idle");
});
test("logout during in-flight reconciliation retains uncertainty and discards its late readback", async () => {
 const f = fixture(), workspace = await patient(f), writer = workspace.writer(id);
 const operation = preparePatientContact(profile, { ...profile, phone: "08129998888" });
 // Reconciliation can also be in flight when auth becomes uncertain.
 await writer.send(operation);
 let resolve;
 f.setRead(() => new Promise(r => resolve = r));
 const pending = writer.reconcile();
 await assert.rejects(f.controller.logout());
 assert.equal(writer.getSnapshot().status, "uncertain"); assert.equal(writer.getSnapshot().operation, operation);
 resolve(ok({ ...profile, phone: "08129998888", version: 1 })); await pending;
 assert.equal(writer.getSnapshot().status, "uncertain");
 await f.controller.refresh(); assert.equal(workspace.scope.isCurrent(), true);
});
test("role-specific stores cannot be accessed by the other role", async () => {
 const f = fixture(); await f.controller.refresh(); assert.throws(() => getNurseWorkspace(f.controller));
 const n = fixture("nurse"); await n.controller.refresh(); assert.throws(() => getPatientWorkspace(n.controller));
});
test("contact recovery from shared writer updates cache and returned form without reversing contacts", async () => {
 const f = fixture(), previous = { ...profile, addressLine: "Old address" };
 f.setRead(() => ok(previous));
 const workspace = await patient(f), writer = workspace.writer(id), next = { ...previous, phone: "08129998888", addressLine: "Recovered address", version: 1 };
 const operation = preparePatientContact(previous, next); await writer.send(operation);
 let html = renderToStaticMarkup(createElement(ContactEditor, { profile: previous, writer, reload: () => {} }));
 assert.ok(formValues(html).includes(next.phone)); assert.ok(formValues(html).includes(next.addressLine));
 f.setRead(() => ok(next)); await writer.reconcile();
 assert.deepEqual(workspace.profile.getSnapshot(), { status: "ready", data: next });
 html = renderToStaticMarkup(createElement(ContactEditor, { profile: workspace.profile.getSnapshot().data, writer, reload: () => {} }));
 const values = formValues(html);
 assert.ok(values.includes(next.phone)); assert.ok(values.includes(next.addressLine));
 assert.ok(!values.includes(previous.phone)); assert.ok(!values.includes(previous.addressLine));
 assert.match(html, /disabled=""[^>]*>Simpan kontak/); assert.equal(f.writes.length, 1);
});
