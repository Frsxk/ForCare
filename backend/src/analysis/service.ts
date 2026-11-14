import type { SQL } from "bun";
import type { AuthConfig } from "../config";
import type { AuthContext } from "../auth/policy";
import { writeAuditEvent, writeOutboxEvent } from "../http/audit";
import { decodeCursor, encodeCursor, hashFilter, type CursorBinding } from "../http/cursor";
import { AppError } from "../http/errors";
import { canonicalRequestHash, findIdempotencyReceipt, lockIdempotencyScope, storeIdempotencyReceipt, type IdempotencyScope } from "../http/idempotency";
import { isUuid, parseStrict } from "../http/request";
import { isoTimestamp } from "../http/time";
import { requireSelfOrPrimaryScope } from "../clinical/policy";
import {
  analysisGenerateSchema, analysisJobResponseSchema, analysisListQuerySchema, analysisListResponseSchema,
  analysisPatientResponseSchema, analysisPublishSchema, analysisQueuedResponseSchema, analysisResponseSchema,
  analysisReviewSchema, analysisRevisionSchema,
  type AnalysisGenerate, type AnalysisListQuery, type AnalysisPublish, type AnalysisReview, type AnalysisRevision,
} from "./schemas";
import {
  analysisDto, analysisJobDto, completeJob, createInputSnapshot, currentPrimaryPatientIds, insertAnalysisJob,
  insertAnalysisSnapshot, listAnalysisRows, lockAnalysisPatientScope, readAnalysis, readJob,
  requireAnalysisNurse, requireAnalysisPatientScope, scopedAnalysis, summaryDto,
  type AnalysisJobRow, type AnalysisRow, type ClaimToSave,
} from "./repository";

export type AnalysisMutationMeta = { requestId: string; key: string };
export type ServiceResult<T> = { data: T; statusCode: number };

export type AnalysisService = {
  generate(auth: AuthContext, checkInId: string, input: AnalysisGenerate, meta: AnalysisMutationMeta): Promise<ServiceResult<unknown>>;
  getJob(auth: AuthContext, id: string): Promise<unknown>;
  get(auth: AuthContext, id: string): Promise<unknown>;
  list(auth: AuthContext, query: AnalysisListQuery): Promise<unknown>;
  revise(auth: AuthContext, id: string, input: AnalysisRevision, meta: AnalysisMutationMeta): Promise<ServiceResult<unknown>>;
  review(auth: AuthContext, id: string, input: AnalysisReview, meta: AnalysisMutationMeta): Promise<ServiceResult<unknown>>;
  publish(auth: AuthContext, id: string, input: AnalysisPublish, meta: AnalysisMutationMeta): Promise<ServiceResult<unknown>>;
};

function requireUuid(id: string, message = "Analysis not found") {
  if (!isUuid(id)) throw new AppError("NOT_FOUND", message, 404);
}

function requireVersion(actual: number, expected: number, currentRevision?: number, expectedRevision?: number) {
  if (actual !== expected || (currentRevision !== undefined && currentRevision !== expectedRevision)) {
    throw new AppError("VERSION_CONFLICT", "Analysis workflow version conflict", 409, { currentVersion: actual });
  }
}

function scopeFor(auth: AuthContext, method: string, resourceKey: string, key: string, requestHash: string): IdempotencyScope {
  return { accountId: auth.accountId, sessionId: auth.sessionId, method, resourceKey, key, requestHash };
}

function reviewDto(row: Record<string, any>) {
  return {
    id: row.id, analysisId: row.analysis_id, revisionNumber: row.analysis_revision_number,
    decision: row.decision, comment: row.comment, reviewerStaffId: row.reviewer_staff_id,
    decidedAt: isoTimestamp(row.decided_at), version: row.version,
  };
}

function publicationDto(row: Record<string, any>) {
  return {
    id: row.id, analysisId: row.analysis_id, revisionNumber: row.analysis_revision_number,
    reviewId: row.review_id, publishedBy: row.published_by, publishedAt: isoTimestamp(row.published_at),
  };
}

function validateHumanEvidence(predecessor: AnalysisRow, claims: ClaimToSave[]) {
  const storedChunks: unknown = predecessor.retrieved_chunk_ids;
  const predecessorChunks = typeof storedChunks === "string"
    ? storedChunks.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : storedChunks as string[];
  const allowedKnowledge = new Set(predecessorChunks);
  const usedKnowledge = new Set(claims.flatMap((claim) => claim.evidence.flatMap((evidence) => evidence.knowledgeChunkId ? [evidence.knowledgeChunkId] : [])));
  if (usedKnowledge.size !== allowedKnowledge.size || [...usedKnowledge].some((id) => !allowedKnowledge.has(id))) {
    throw new AppError("VALIDATION_FAILED", "Revision must preserve and cite the exact retrieved knowledge set", 422);
  }
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      if (evidence.knowledgeChunkId && !allowedKnowledge.has(evidence.knowledgeChunkId)) {
        throw new AppError("VALIDATION_FAILED", "Revision evidence must use the predecessor's retrieved knowledge", 422);
      }
    }
  }
  // Trigger and FK enforcement remains authoritative for exact references.
}

export function createAnalysisService(options: {
  sql: SQL;
  config: AuthConfig;
  reconcileReview?: (analysisId: string) => Promise<void>;
}): AnalysisService {
  const { sql, config } = options;

  async function idempotent<T>(
    auth: AuthContext,
    method: string,
    path: string,
    meta: AnalysisMutationMeta,
    body: unknown,
    authorize: (tx: SQL) => Promise<void>,
    action: (tx: SQL) => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    const requestHash = canonicalRequestHash(body);
    const scope = scopeFor(auth, method, path, meta.key, requestHash);
    await authorize(sql);
    const existing = await findIdempotencyReceipt(sql, scope);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request", 409);
      return { data: existing.response as T, statusCode: existing.statusCode };
    }
    return sql.begin(async (tx) => {
      await lockIdempotencyScope(tx, scope);
      const replay = await findIdempotencyReceipt(tx, scope);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request", 409);
        await authorize(tx);
        return { data: replay.response as T, statusCode: replay.statusCode };
      }
      await authorize(tx);
      const result = await action(tx);
      await storeIdempotencyReceipt(tx, scope, result.statusCode, result.data);
      return result;
    });
  }

  async function lockedAnalysis(tx: SQL, auth: AuthContext, id: string, patientView = false): Promise<AnalysisRow> {
    const rows = await tx`SELECT * FROM public.analyses WHERE id = ${id} FOR UPDATE` as unknown as AnalysisRow[];
    const row = rows[0];
    if (!row) throw new AppError("NOT_FOUND", "Analysis not found", 404);
    await requireSelfOrPrimaryScope(tx, auth, row.patient_id);
    await requireAnalysisNurse(tx, auth, config);
    if (patientView) throw new AppError("FORBIDDEN", "Primary nurse access is required", 403);
    return row;
  }

  return {
    async generate(auth, checkInId, input, meta) {
      requireUuid(checkInId, "Check-in not found");
      const parsed = parseStrict(analysisGenerateSchema, input);
      const checkins = await sql`SELECT patient_id FROM public.check_ins WHERE id = ${checkInId}`;
      if (!checkins[0]) throw new AppError("NOT_FOUND", "Check-in not found", 404);
      const patientId = checkins[0].patient_id as string;
      return idempotent(auth, "POST", `/api/v1/check-ins/${checkInId}/analyses`, meta, parsed,
        async (tx) => { await lockAnalysisPatientScope(tx, auth, patientId, config); },
        async (tx) => {
          const snapshot = await createInputSnapshot(tx, { patientId, checkInId, locale: parsed.locale });
          const job = await insertAnalysisJob(tx, { patientId, checkInId, requestedBy: auth.staffId!, snapshot });
          await writeAuditEvent(tx, { actorAccountId: auth.accountId, action: "analysis_job.created", subjectType: "analysis_job", subjectId: job.id, requestId: meta.requestId, after: { checkInId, patientId } });
          await writeOutboxEvent(tx, { aggregateType: "analysis_job", aggregateId: job.id, eventType: "analysis_job.queued", payload: { attempt: 0 } });
          return { data: analysisQueuedResponseSchema.parse(analysisJobDto(job)), statusCode: 202 };
        });
    },

    async getJob(auth, id) {
      requireUuid(id, "Analysis job not found");
      const job = await readJob(sql, id);
      if (!job) throw new AppError("NOT_FOUND", "Analysis job not found", 404);
      await requireAnalysisPatientScope(sql, auth, job.patient_id, config);
      return analysisJobResponseSchema.parse(analysisJobDto(job));
    },

    async get(auth, id) {
      requireUuid(id);
      const row = await scopedAnalysis(sql, auth, id);
      if (auth.role === "patient") {
        if (row.status !== "published") throw new AppError("NOT_FOUND", "Analysis not found", 404);
        const full = await analysisDto(sql, row) as any;
        const claims = await sql`SELECT id FROM public.analysis_claims WHERE analysis_id = ${id} AND patient_facing ORDER BY ordinal` as Array<{ id: string }>;
        const visible = new Set(claims.map((claim) => claim.id as string));
        return analysisPatientResponseSchema.parse({ ...full, claims: full.claims.filter((claim: any) => visible.has(claim.claimId)), reviews: [] });
      }
      await requireAnalysisNurse(sql, auth, config);
      return analysisResponseSchema.parse(await analysisDto(sql, row));
    },

    async list(auth, query) {
      const parsed = parseStrict(analysisListQuerySchema, query);
      if (parsed.patientId) await requireSelfOrPrimaryScope(sql, auth, parsed.patientId);
      if (auth.role === "nurse") await requireAnalysisNurse(sql, auth, config);
      if (auth.role !== "patient" && auth.role !== "nurse") throw new AppError("FORBIDDEN", "Analysis access is unavailable", 403);
      const patientScopeIds = auth.role === "patient"
        ? [auth.patientId!]
        : parsed.patientId ? undefined : await currentPrimaryPatientIds(sql, auth.staffId!);
      const binding: CursorBinding = {
        accountId: auth.accountId, sessionId: auth.sessionId,
        scope: `analyses:${auth.role}:${parsed.patientId ?? "scoped"}`,
        filterHash: hashFilter(JSON.stringify({ patientId: parsed.patientId, status: parsed.status })),
      };
      const after = parsed.cursor ? decodeCursor(parsed.cursor, binding, config.sessionSecret) : null;
      if (after && !Number.isFinite(Date.parse(after.name))) throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
      const rows = await listAnalysisRows(sql, {
        patientId: parsed.patientId, patientScopeIds, patientView: auth.role === "patient", status: parsed.status,
        afterCreatedAt: after?.name, afterId: after?.id,
      });
      const selected = rows.slice(0, 100);
      const hasMore = rows.length > 100;
      const last = selected.at(-1);
      const nextCursor = hasMore && last ? encodeCursor(binding, { name: isoTimestamp(last.created_at), id: last.id }, config.sessionSecret) : null;
      return analysisListResponseSchema.parse({ items: selected.map(summaryDto), page: { nextCursor, hasMore } });
    },

    async revise(auth, id, input, meta) {
      requireUuid(id);
      const parsed = parseStrict(analysisRevisionSchema, input);
      return idempotent(auth, "POST", `/api/v1/analyses/${id}/revisions`, meta, parsed,
        async (tx) => { await lockedAnalysis(tx, auth, id); },
        async (tx) => {
          const predecessor = await lockedAnalysis(tx, auth, id);
          requireVersion(predecessor.version, parsed.expectedVersion, predecessor.revision_number, parsed.revisionNumber);
          if (predecessor.status !== "draft" && predecessor.status !== "in_review") {
            throw new AppError("INVALID_TRANSITION", "Only an unapproved analysis can be corrected", 409);
          }
          validateHumanEvidence(predecessor, parsed.claims);
          const analysis = await insertAnalysisSnapshot(tx, { predecessor, claims: parsed.claims, modelProvider: predecessor.model_provider, modelId: predecessor.model_id });
          await tx`SET CONSTRAINTS public.analyses_finalize, public.analysis_claims_finalize, public.analysis_evidence_finalize IMMEDIATE`;
          const gate = await tx`INSERT INTO public.analysis_review_gates (
            analysis_id, analysis_revision_number, thread_id, checkpoint_id, checkpoint_namespace
          ) VALUES (${analysis.id}, ${analysis.revision_number}, ${`analysis-revision-${analysis.id}`}, ${`human-revision-${analysis.id}`}, '')
          RETURNING *`;
          await writeAuditEvent(tx, { actorAccountId: auth.accountId, action: "analysis.revision.created", subjectType: "analysis", subjectId: analysis.id, requestId: meta.requestId, after: { supersedesId: id, revisionNumber: analysis.revision_number } });
          await writeOutboxEvent(tx, { aggregateType: "analysis", aggregateId: analysis.id, eventType: "analysis.review_requested", payload: { gateId: gate[0]!.id, revisionNumber: analysis.revision_number } });
          return { data: await analysisDto(tx, (await readAnalysis(tx, analysis.id))!), statusCode: 201 };
        });
    },

    async review(auth, id, input, meta) {
      requireUuid(id);
      const parsed = parseStrict(analysisReviewSchema, input);
      const result = await idempotent(auth, "POST", `/api/v1/analyses/${id}/reviews`, meta, parsed,
        async (tx) => { await lockedAnalysis(tx, auth, id); },
        async (tx) => {
          const analysis = await lockedAnalysis(tx, auth, id);
          requireVersion(analysis.version, parsed.expectedVersion, analysis.revision_number, parsed.revisionNumber);
          if (analysis.status !== "in_review") throw new AppError("INVALID_TRANSITION", "Analysis is not awaiting review", 409);
          const gates = await tx`SELECT * FROM public.analysis_review_gates
            WHERE analysis_id = ${id} AND analysis_revision_number = ${parsed.revisionNumber} AND state = 'waiting' FOR UPDATE`;
          if (!gates[0]) throw new AppError("INVALID_TRANSITION", "A waiting review gate is required", 409);
          const rows = await tx`INSERT INTO public.analysis_reviews (
            analysis_id, analysis_revision_number, reviewer_staff_id, decision, comment, gate_id, expected_version
          ) VALUES (${id}, ${parsed.revisionNumber}, ${auth.staffId}, ${parsed.decision}, ${parsed.comment}, ${gates[0].id}, ${parsed.expectedVersion}) RETURNING *`;
          await writeAuditEvent(tx, { actorAccountId: auth.accountId, action: "analysis.reviewed", subjectType: "analysis", subjectId: id, requestId: meta.requestId, after: { reviewId: rows[0]!.id, decision: parsed.decision, revisionNumber: parsed.revisionNumber } });
          await writeOutboxEvent(tx, { aggregateType: "analysis", aggregateId: id, eventType: "analysis.review_decided", payload: { gateId: gates[0].id, reviewId: rows[0]!.id } });
          return { data: reviewDto(rows[0]!), statusCode: 201 };
        });
      // A persisted decision is authoritative. Graph execution is a receipt only;
      // failure remains visible as an unreconciled gate and is retried by the worker.
      await options.reconcileReview?.(id);
      return result;
    },

    async publish(auth, id, input, meta) {
      requireUuid(id);
      const parsed = parseStrict(analysisPublishSchema, input);
      return idempotent(auth, "POST", `/api/v1/analyses/${id}/publish`, meta, parsed,
        async (tx) => { await lockedAnalysis(tx, auth, id); },
        async (tx) => {
          const analysis = await lockedAnalysis(tx, auth, id);
          const reviews = await tx`SELECT * FROM public.analysis_reviews WHERE id = ${parsed.reviewId}
            AND analysis_id = ${id} AND analysis_revision_number = ${parsed.revisionNumber} AND decision = 'approve'`;
          if (!reviews[0]) throw new AppError("INVALID_TRANSITION", "An approving review of this exact revision is required", 409);
          const gates = await tx`SELECT state FROM public.analysis_review_gates WHERE id = ${reviews[0].gate_id}`;
          if (gates[0]?.state !== "reconciled") throw new AppError("INVALID_TRANSITION", "The review gate has not been reconciled", 409);
          const existing = await tx`SELECT * FROM public.analysis_publications WHERE analysis_id = ${id} AND analysis_revision_number = ${parsed.revisionNumber}`;
          if (existing[0]) {
            if (existing[0].review_id !== parsed.reviewId) throw new AppError("INVALID_TRANSITION", "This revision was published under a different review", 409);
            return { data: publicationDto(existing[0]), statusCode: 200 };
          }
          requireVersion(analysis.version, parsed.expectedVersion, analysis.revision_number, parsed.revisionNumber);
          if (analysis.status !== "approved") throw new AppError("INVALID_TRANSITION", "Only an approved analysis can be published", 409);
          const rows = await tx`INSERT INTO public.analysis_publications (
            analysis_id, analysis_revision_number, review_id, review_decision, published_by, expected_version
          ) VALUES (${id}, ${parsed.revisionNumber}, ${parsed.reviewId}, 'approve', ${auth.staffId}, ${parsed.expectedVersion}) RETURNING *`;
          await completeJob(tx, id);
          await writeAuditEvent(tx, { actorAccountId: auth.accountId, action: "analysis.published", subjectType: "analysis", subjectId: id, requestId: meta.requestId, after: { reviewId: parsed.reviewId, publicationId: rows[0]!.id } });
          await writeOutboxEvent(tx, { aggregateType: "analysis", aggregateId: id, eventType: "analysis.published", payload: { publicationId: rows[0]!.id, revisionNumber: parsed.revisionNumber } });
          return { data: publicationDto(rows[0]!), statusCode: 200 };
        });
    },
  };
}
