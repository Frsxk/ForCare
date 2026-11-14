import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApiClient } from "../lib/api/client";
import { createAnalysisApi, decodeAnalysis, decodeAnalysisJob, prepareAnalysisGeneration, prepareAnalysisPublication, prepareAnalysisReview, prepareAnalysisRevision, AnalysisWriteController } from "../lib/api/analysis";

const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072";
const checkInId = "cb24dd80-d0ca-439a-b563-58ab724a3bea";
const analysisId = "1cc54131-069b-470f-9750-601bccbbdd21";
const revisionId = "e7252d86-af4d-465b-b242-27fa26040f17";
const reviewId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const requestId = "46ac1db1-56a0-49fa-982a-15fe91d4b2ce";
const key = "f605672e-1bee-4f14-b112-56e580ff00e3";
const date = "2026-11-14T01:00:00.000Z";
const evidence = [{ checkInId, observationId: "702d230f-bb20-4c47-9e96-4f99ac9bb802", sourceDocumentId: "0e08bc65-6846-4dd3-a4cc-f60c172439e9", sourceVersion: 2, knowledgeChunkId: "42ba3662-7833-4b58-a7a1-7a14b764d437" }];
const claims = [{ claimId: "b67253b8-a5ed-48b3-a28f-63a43c920159", text: "Pasien melaporkan keluhan.", claimType: "observation_summary", evidence }];
const analysis = { id: analysisId, patientId, checkInId, status: "in_review", revisionNumber: 2, supersedesId: null, version: 1, createdAt: date, updatedAt: date, claims, reviews: [], publication: null };
const ok = data => new Response(JSON.stringify({ data, requestId }), { headers: { "content-type": "application/json" } });

test("analysis decoder preserves claim/evidence identity and fails closed on wrong patient, check-in or revision bindings", () => {
  assert.deepEqual(decodeAnalysis(analysis), analysis);
  for (const invalid of [
    { ...analysis, claims: [{ ...claims[0], evidence: [{ checkInId: revisionId }] }] },
    { ...analysis, claims: [{ ...claims[0], evidence: [] }] },
    { ...analysis, claims: [{ ...claims[0], clinicalChunkId: patientId }] },
    { ...analysis, reviews: [{ id: reviewId, analysisId, revisionNumber: 1, decision: "approve", comment: null, reviewerStaffId: patientId, decidedAt: date, version: 0 }] },
    { ...analysis, status: "published" },
  ]) assert.throws(() => decodeAnalysis(invalid));
  assert.throws(() => decodeAnalysisJob({ id: analysisId, patientId, checkInId, status: "awaiting_review", analysisId: null, errorCode: null, version: 0 }));
});

test("generation and every mutation target the verified endpoint and bind the current immutable revision and workflow version", () => {
  assert.equal(prepareAnalysisGeneration(patientId, checkInId, "id", key).path, `/api/v1/check-ins/${checkInId}/analyses`);
  assert.deepEqual(JSON.parse(prepareAnalysisGeneration(patientId, checkInId, "id", key).body), { promptVersion: "forcare-condition-v1", locale: "id" });
  const revision = prepareAnalysisRevision({ ...analysis, status: "draft" }, [{ text: "Edited", claimType: "care_note", evidence }], key);
  assert.equal(revision.path, `/api/v1/analyses/${analysisId}/revisions`);
  assert.deepEqual(JSON.parse(revision.body), { expectedVersion: 1, revisionNumber: 2, claims: [{ text: "Edited", claimType: "care_note", evidence }] });
  assert.equal(prepareAnalysisReview(analysis, "changes_requested", "Perlu koreksi", key).path, `/api/v1/analyses/${analysisId}/reviews`);
  assert.throws(() => prepareAnalysisReview(analysis, "changes_requested", null));
  assert.throws(() => prepareAnalysisPublication({ ...analysis, status: "approved" }, reviewId));
});

test("review and publication require the exact approving review of this revision; no approval implies publication", () => {
  const review = { id: reviewId, analysisId, revisionNumber: 2, decision: "approve", comment: null, reviewerStaffId: patientId, decidedAt: date, version: 0 };
  const approved = { ...analysis, status: "approved", version: 2, reviews: [review] };
  const intent = prepareAnalysisPublication(approved, reviewId, key);
  assert.equal(intent.path, `/api/v1/analyses/${analysisId}/publish`);
  assert.deepEqual(JSON.parse(intent.body), { expectedVersion: 2, revisionNumber: 2, reviewId });
  assert.throws(() => prepareAnalysisPublication(approved, patientId));
  assert.throws(() => prepareAnalysisPublication({ ...approved, reviews: [{ ...review, decision: "changes_requested" }] }, reviewId));
});

test("revision response selects the new immutable ID and revision instead of pretending to mutate its predecessor", async () => {
  const calls = [];
  const client = createApiClient({ fetch: async (url, init) => {
    calls.push({ url, init });
    if (init.method === "POST") return ok({ ...analysis, id: revisionId, status: "draft", revisionNumber: 3, supersedesId: analysisId, version: 0 });
    return ok({ items: [], page: { nextCursor: null, hasMore: false } });
  } });
  client.setCsrfToken("synthetic-csrf");
  const api = createAnalysisApi(client);
  const intent = prepareAnalysisRevision({ ...analysis, status: "draft" }, claims, key);
  const created = await api.revise(patientId, analysisId, intent);
  assert.equal(created.id, revisionId);
  assert.equal(created.revisionNumber, 3);
  await api.list(patientId);
  assert.equal(calls.at(-1).url, `/api/v1/analyses?patientId=${patientId}`);
});

test("job reads preserve generation bindings and await the saved analysis ID", async () => {
  const client = createApiClient({ fetch: async url => {
    if (url.includes("/analysis-jobs/")) return ok({ id: key, patientId, checkInId, status: "awaiting_review", analysisId, errorCode: null, version: 2 });
    return ok(analysis);
  } });
  const api = createAnalysisApi(client);
  assert.equal((await api.job(patientId, checkInId, key)).analysisId, analysisId);
  assert.equal((await api.get(patientId, analysisId)).id, analysisId);
});

test("uncertain analysis write retains the exact intent for reconciliation and never issues a replacement write", async () => {
  let writes = 0;
  const client = createApiClient({ fetch: async () => { writes++; throw new TypeError("lost connection"); } });
  client.setCsrfToken("synthetic-csrf");
  const api = createAnalysisApi(client);
  const intent = prepareAnalysisGeneration(patientId, checkInId, "id", key);
  const controller = new AnalysisWriteController(() => true);
  await controller.send("generate", intent, signal => api.generate(patientId, checkInId, intent, signal));
  assert.equal(controller.getSnapshot().status, "uncertain");
  assert.equal(controller.getSnapshot().intent, intent);
  await assert.rejects(() => controller.send("generate", prepareAnalysisGeneration(patientId, checkInId, "id"), signal => api.generate(patientId, checkInId, intent, signal)));
  assert.equal(writes, 1);
});

test("nurse panel renders the AI origin and current workflow status without implying clinical approval", async () => {
  const { AnalysisReviewView } = await import("../components/patient-analysis");
  const html = renderToStaticMarkup(createElement(AnalysisReviewView, { analysis, checkInId, onChanged: () => {}, write: new AnalysisWriteController(() => true), api: createAnalysisApi(createApiClient()) }));
  assert.match(html, /draf AI/);
  assert.match(html, /Menunggu tinjauan perawat/);
  assert.match(html, /Pasien melaporkan keluhan/);
  assert.match(html, /Tinjau dan setujui/);
  assert.doesNotMatch(html, /Risiko (rendah|tinggi)|dipublikasikan otomatis/);
});

test("published panel reports publication facts and hides editing and review controls", async () => {
  const { AnalysisReviewView } = await import("../components/patient-analysis");
  const review = { id: reviewId, analysisId, revisionNumber: 2, decision: "approve", comment: null, reviewerStaffId: patientId, decidedAt: date, version: 0 };
  const publication = { id: revisionId, analysisId, revisionNumber: 2, reviewId, publishedBy: patientId, publishedAt: date };
  const html = renderToStaticMarkup(createElement(AnalysisReviewView, { analysis: { ...analysis, status: "published", version: 3, reviews: [review], publication }, checkInId, onChanged: () => {}, write: new AnalysisWriteController(() => true), api: createAnalysisApi(createApiClient()) }));
  assert.match(html, /Dipublikasikan/);
  assert.doesNotMatch(html, /Tinjau dan setujui|Simpan revisi|Publikasikan ke pasien/);
});
