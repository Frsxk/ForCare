import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const ui = await import("../components/medical-snapshot-panel").catch(() => null);
const payload = { primaryDiagnosis: "Source diagnosis", secondaryDiagnoses: ["Line one\nline two"], admittedAt: "2026-11-14T01:00:00.123Z", dischargedAt: null, allergies: ["Recorded allergy"], procedures: [], complaints: null, observations: [{ type: "measurement", value: 0, unit: "kg", observedAt: "2026-11-14T01:00:00Z" }, { type: "text", value: "0" }, { type: "unspecified" }], internalNote: "Internal source note" };
test("medical editor renders every full snapshot field with accessible labels and immutable correction context", () => {
 assert.ok(ui, "Medical snapshot editor must exist");
 const draft = ui.medicalDraft({ payload, sourceReference: "Source reference" });
 const html = renderToStaticMarkup(createElement(ui.MedicalSnapshotForm, { draft, onChange() {}, onSubmit() {}, revisionNumber: 4, disabled: false }));
 for (const field of ["sourceReference", ...Object.keys(payload)]) assert.match(html, new RegExp(`name="${field}"`));
 assert.match(html, /<label/); assert.match(html, /revisi 4/); assert.match(html, /UTC/); assert.match(html, /koreksi/i);
 assert.deepEqual(ui.snapshotFromDraft(draft), payload);
});
test("blank initial editor explicitly creates complete nullable and array fields, never invented clinical facts", () => {
 assert.ok(ui);
 const draft = ui.medicalDraft(null);
 assert.deepEqual(ui.snapshotFromDraft(draft), { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null, allergies: [], procedures: [], complaints: null, observations: [], internalNote: null });
 assert.equal(draft.sourceReference, "");
 assert.throws(() => ui.snapshotFromDraft({ ...draft, observations: '[{"type":"fact","unknown":true}]' }));
 assert.throws(() => ui.snapshotFromDraft({ ...draft, admittedAt: "2026-02-30T01:00:00Z" }));
 assert.throws(() => ui.snapshotFromDraft({ ...draft, allergies: '[" "]' }));
});
