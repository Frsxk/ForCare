import type { ApiClient, WriteIntent } from "./client";
import { ApiError, asApiError, prepareWrite } from "./client";
import { patientUuid } from "./nurse";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const result = object(value);
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error("Unknown field");
  return result;
}
function text(value: unknown, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid text");
  return value;
}
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 2_147_483_647) throw new Error("Invalid integer");
  return value as number;
}
function array<T>(value: unknown, decode: (item: unknown) => T, min = 0, max = 50): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error("Invalid array");
  return value.map(decode);
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error("Invalid enum");
  return value as T;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().replace(".000Z", "Z") !== result.replace(".000Z", "Z")) throw new Error("Invalid timestamp");
  return result;
}
function optionalId(value: unknown) { return value === undefined ? undefined : patientUuid(value); }
export function decodeEvidence(value: unknown) {
  const evidence = exact(value, ["checkInId", "observationId", "orderId", "sourceDocumentId", "sourceVersion", "knowledgeChunkId"]);
  const sourceDocumentId = optionalId(evidence.sourceDocumentId);
  const sourceVersion = evidence.sourceVersion === undefined ? undefined : integer(evidence.sourceVersion, 1);
  if ((sourceDocumentId === undefined) !== (sourceVersion === undefined)) throw new Error("Incomplete source evidence");
  return {
    checkInId: patientUuid(evidence.checkInId),
    ...(evidence.observationId === undefined ? {} : { observationId: patientUuid(evidence.observationId) }),
    ...(evidence.orderId === undefined ? {} : { orderId: patientUuid(evidence.orderId) }),
    ...(sourceDocumentId === undefined ? {} : { sourceDocumentId, sourceVersion }),
    ...(evidence.knowledgeChunkId === undefined ? {} : { knowledgeChunkId: patientUuid(evidence.knowledgeChunkId) }),
  };
}
export type AnalysisEvidence = ReturnType<typeof decodeEvidence>;
const claimTypes = ["observation_summary", "concern", "suggestion", "care_note"] as const;
export function decodeClaimInput(value: unknown) {
  const claim = object(value);
  return { text: text(claim.text), claimType: member(claim.claimType, claimTypes), evidence: array(claim.evidence, decodeEvidence, 1, 20) };
}
export type AnalysisClaimInput = ReturnType<typeof decodeClaimInput>;
function decodeClaim(value: unknown) {
  const claim = exact(value, ["claimId", "text", "claimType", "evidence"]);
  return { claimId: patientUuid(claim.claimId), ...decodeClaimInput(claim) };
}
function decodeReview(value: unknown) {
  const review = exact(value, ["id", "analysisId", "revisionNumber", "decision", "comment", "reviewerStaffId", "decidedAt", "version"]);
  const decision = member(review.decision, ["approve", "reject", "changes_requested"] as const);
  const comment = review.comment === null ? null : text(review.comment);
  if (decision !== "approve" && comment === null) throw new Error("Review comment required");
  return {
    id: patientUuid(review.id), analysisId: patientUuid(review.analysisId), revisionNumber: integer(review.revisionNumber, 1),
    decision, comment, reviewerStaffId: patientUuid(review.reviewerStaffId), decidedAt: timestamp(review.decidedAt), version: integer(review.version),
  };
}
export type AnalysisReview = ReturnType<typeof decodeReview>;
function decodePublication(value: unknown) {
  if (value === null) return null;
  const publication = exact(value, ["id", "analysisId", "revisionNumber", "reviewId", "publishedBy", "publishedAt"]);
  return {
    id: patientUuid(publication.id), analysisId: patientUuid(publication.analysisId), revisionNumber: integer(publication.revisionNumber, 1),
    reviewId: patientUuid(publication.reviewId), publishedBy: patientUuid(publication.publishedBy), publishedAt: timestamp(publication.publishedAt),
  };
}
const summaryKeys = ["id", "patientId", "checkInId", "status", "revisionNumber", "supersedesId", "version", "createdAt", "updatedAt"];
function decodeSummary(value: unknown) {
  const analysis = object(value);
  return {
    id: patientUuid(analysis.id), patientId: patientUuid(analysis.patientId), checkInId: patientUuid(analysis.checkInId),
    status: member(analysis.status, ["draft", "in_review", "approved", "rejected", "published"] as const),
    revisionNumber: integer(analysis.revisionNumber, 1), supersedesId: analysis.supersedesId === null ? null : patientUuid(analysis.supersedesId),
    version: integer(analysis.version), createdAt: timestamp(analysis.createdAt), updatedAt: timestamp(analysis.updatedAt),
  };
}
export type AnalysisSummary = ReturnType<typeof decodeSummary>;
export function decodeAnalysis(value: unknown) {
  const analysis = exact(value, [...summaryKeys, "claims", "reviews", "publication"]);
  const result = {
    ...decodeSummary(analysis), claims: array(analysis.claims, decodeClaim, 1, 50), reviews: array(analysis.reviews, decodeReview, 0, 50), publication: decodePublication(analysis.publication),
  };
  if (new Set(result.claims.map(claim => claim.claimId)).size !== result.claims.length) throw new Error("Duplicate claims");
  if (result.claims.some(claim => claim.evidence.some(evidence => evidence.checkInId !== result.checkInId))) throw new Error("Evidence check-in mismatch");
  if (result.reviews.some(review => review.analysisId !== result.id || review.revisionNumber !== result.revisionNumber)) throw new Error("Review revision mismatch");
  if ((result.status === "published") !== (result.publication !== null)) throw new Error("Invalid publication status");
  if (result.publication && (result.publication.analysisId !== result.id || result.publication.revisionNumber !== result.revisionNumber)) throw new Error("Publication revision mismatch");
  return result;
}
export type Analysis = ReturnType<typeof decodeAnalysis>;
export type AnalysisClaim = Analysis["claims"][number];
const jobErrors = ["INSUFFICIENT_EVIDENCE", "INVALID_MODEL_OUTPUT", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH_FAILED", "PROVIDER_SAFETY_BLOCKED", "PROVIDER_UNAVAILABLE", "STALE_CONTEXT", "SCOPE_REVOKED", "ATTEMPTS_EXHAUSTED", "INTERNAL_ERROR"] as const;
export function decodeAnalysisJob(value: unknown) {
  const job = exact(value, ["id", "patientId", "checkInId", "status", "analysisId", "errorCode", "version"]);
  const status = member(job.status, ["queued", "running", "awaiting_review", "failed", "completed"] as const);
  const analysisId = job.analysisId === null ? null : patientUuid(job.analysisId);
  const errorCode = job.errorCode === null ? null : member(job.errorCode, jobErrors);
  if ((status === "awaiting_review" || status === "completed") !== (analysisId !== null) || (status === "failed") !== (errorCode !== null)) throw new Error("Invalid job state");
  return { id: patientUuid(job.id), patientId: patientUuid(job.patientId), checkInId: patientUuid(job.checkInId), status, analysisId, errorCode, version: integer(job.version) };
}
export type AnalysisJob = ReturnType<typeof decodeAnalysisJob>;
export function prepareAnalysisGeneration(patientId: string, checkInId: string, locale: "id" | "en", key?: string): WriteIntent {
  patientUuid(patientId);
  return prepareWrite(`/api/v1/check-ins/${patientUuid(checkInId)}/analyses`, "POST", { promptVersion: "forcare-condition-v1", locale: member(locale, ["id", "en"] as const) }, key);
}
export function prepareAnalysisRevision(analysis: Analysis, claims: AnalysisClaimInput[], key?: string): WriteIntent {
  const current = decodeAnalysis(analysis);
  if (current.status !== "draft" && current.status !== "in_review") throw new Error("Analysis is not editable");
  return prepareWrite(`/api/v1/analyses/${current.id}/revisions`, "POST", { expectedVersion: current.version, revisionNumber: current.revisionNumber, claims: array(claims, decodeClaimInput, 1, 50) }, key);
}
export function prepareAnalysisReview(analysis: Analysis, decision: AnalysisReview["decision"], comment: string | null, key?: string): WriteIntent {
  const current = decodeAnalysis(analysis);
  if (current.status !== "in_review") throw new Error("Analysis is not awaiting review");
  const normalized = comment === null ? null : text(comment.trim());
  if (decision !== "approve" && normalized === null) throw new Error("Review comment required");
  return prepareWrite(`/api/v1/analyses/${current.id}/reviews`, "POST", { decision, comment: normalized, expectedVersion: current.version, revisionNumber: current.revisionNumber }, key);
}
export function prepareAnalysisPublication(analysis: Analysis, reviewId: string, key?: string): WriteIntent {
  const current = decodeAnalysis(analysis), id = patientUuid(reviewId);
  if (current.status !== "approved" || !current.reviews.some(review => review.id === id && review.revisionNumber === current.revisionNumber && review.decision === "approve")) throw new Error("Exact approval required");
  return prepareWrite(`/api/v1/analyses/${current.id}/publish`, "POST", { expectedVersion: current.version, revisionNumber: current.revisionNumber, reviewId: id }, key);
}
function boundJob(patientId: string, checkInId: string, value: unknown) {
  const job = decodeAnalysisJob(value);
  if (job.patientId !== patientId || job.checkInId !== checkInId) throw new Error("Job scope mismatch");
  return job;
}
export function createAnalysisApi(api: ApiClient) {
  return {
    list: (patientId: string, cursor?: string | null, signal?: AbortSignal) => api.request((() => { const parameters = new URLSearchParams({ patientId: patientUuid(patientId) }); if (cursor) parameters.set("cursor", cursor); return `/api/v1/analyses?${parameters}`; })(), value => {
      const page = object(value), pagination = exact(page.page, ["nextCursor", "hasMore"]);
      if (Object.keys(page).some(key => key !== "items" && key !== "page")) throw new Error("Unknown field");
      if (typeof pagination.hasMore !== "boolean" || (pagination.nextCursor !== null && typeof pagination.nextCursor !== "string") || pagination.hasMore !== (pagination.nextCursor !== null)) throw new Error("Invalid pagination");
      const items = array(page.items, decodeSummary, 0, 100);
      if (items.some(item => item.patientId !== patientId)) throw new Error("Patient scope mismatch");
      return { items, page: { nextCursor: pagination.nextCursor, hasMore: pagination.hasMore } };
    }, { signal }),
    get: (patientId: string, id: string, signal?: AbortSignal) => api.request(`/api/v1/analyses/${patientUuid(id)}`, value => { const analysis = decodeAnalysis(value); if (analysis.patientId !== patientId) throw new Error("Patient scope mismatch"); return analysis; }, { signal }),
    job: (patientId: string, checkInId: string, id: string, signal?: AbortSignal) => api.request(`/api/v1/analysis-jobs/${patientUuid(id)}`, value => boundJob(patientId, checkInId, value), { signal }),
    generate: (patientId: string, checkInId: string, intent: WriteIntent, signal?: AbortSignal) => api.write(intent, value => boundJob(patientId, checkInId, value), signal),
    revise: (patientId: string, predecessorId: string, intent: WriteIntent, signal?: AbortSignal) => api.write(intent, value => {
      const analysis = decodeAnalysis(value), body = JSON.parse(intent.body);
      if (analysis.patientId !== patientId || analysis.supersedesId !== predecessorId || analysis.revisionNumber !== body.revisionNumber + 1 || analysis.version !== 0) throw new Error("Revision mismatch");
      return analysis;
    }, signal),
    review: (patientId: string, id: string, intent: WriteIntent, signal?: AbortSignal) => api.write(intent, value => {
      const review = decodeReview(value), body = JSON.parse(intent.body);
      if (review.analysisId !== id || review.revisionNumber !== body.revisionNumber || review.decision !== body.decision || review.comment !== body.comment) throw new Error("Review mismatch");
      patientUuid(patientId); return review;
    }, signal),
    publish: (patientId: string, id: string, intent: WriteIntent, signal?: AbortSignal) => api.write(intent, value => {
      const publication = decodePublication(value), body = JSON.parse(intent.body);
      if (!publication || publication.analysisId !== id || publication.revisionNumber !== body.revisionNumber || publication.reviewId !== body.reviewId) throw new Error("Publication mismatch");
      patientUuid(patientId); return publication;
    }, signal),
  };
}
export type AnalysisOperation = "generate" | "revise" | "review" | "publish";
export type AnalysisWriteState = { status: "idle" | "sending" | "uncertain" | "rejected"; intent?: WriteIntent; operation?: AnalysisOperation; error?: ApiError };
/** One explicit intent per action. Lost responses retain the exact serialized body and key. */
export class AnalysisWriteController {
  private state: AnalysisWriteState = { status: "idle" };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  constructor(private current: () => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: AnalysisWriteState) { this.state = state; this.listeners.forEach(listener => listener()); }
  clear() { this.abort?.abort(); this.set({ status: "idle" }); }
  async send<T>(operation: AnalysisOperation, intent: WriteIntent, write: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!this.current() || this.state.status === "sending") return;
    if (this.state.intent && this.state.intent !== intent && this.state.status === "uncertain") throw new Error("Reconcile the existing write first");
    const abort = new AbortController(); this.abort = abort;
    this.set({ status: "sending", operation, intent });
    let responded = false;
    try {
      const result = await write(abort.signal); responded = true;
      if (this.current() && !abort.signal.aborted) this.set({ status: "idle" });
      return result;
    } catch (error) {
      if (!this.current() || abort.signal.aborted) return;
      const failure = asApiError(error);
      const uncertain = responded || failure.status === 0 || failure.status >= 500 || failure.code === "INVALID_RESPONSE" || failure.code === "REQUEST_ABORTED";
      this.set({ status: uncertain ? "uncertain" : "rejected", operation, intent, error: failure });
    }
  }
}
