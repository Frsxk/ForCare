import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { SQL } from "bun";
import { ZodError } from "zod";
import type { GeminiDraftResult } from "../ai/gemini-model";
import { GeminiDraftModelError } from "../ai/gemini-model";
import type { AuthConfig } from "../config";
import type { KnowledgeSearchChunk } from "../knowledge/schemas";
import { AppError } from "../http/errors";
import { isoTimestamp } from "../http/time";
import { parseStrict } from "../http/request";
import { analysisInputSnapshotSchema, analysisModelOutputSchema, type AnalysisInputSnapshot } from "./schemas";
import {
  failJob, heartbeatJob, readAnalysis, readJob, saveJobResult,
  AnalysisLeaseLostError,
  type AnalysisJobRow, type ClaimToSave,
} from "./repository";

export const ANALYSIS_REVIEW_GATE = "nurse-analysis-review-v1";
export const ANALYSIS_CHECKPOINT_NAMESPACE = "";

export class AnalysisWorkerError extends Error {
  constructor(readonly errorCode: string, message = "Analysis generation failed") {
    super(message);
    this.name = "AnalysisWorkerError";
  }
}

type ModelProvider = {
  invoke(messages: [string, string][], options?: { signal?: AbortSignal }): Promise<GeminiDraftResult>;
};
type Retrieved = KnowledgeSearchChunk & { content: string };
type ClinicalSourceContext = {
  sourceDocumentId: string; sourceVersion: number; kind: string; title: string; body: string;
};
type CareOrderContext = {
  orderId: string; sourceDocumentId: string; sourceVersion: number; kind: string;
  payload: unknown; effectiveFrom: string; effectiveTo: string | null;
};

const GraphState = Annotation.Root({
  jobId: Annotation<string>(),
  leaseToken: Annotation<string>(),
  snapshot: Annotation<AnalysisInputSnapshot>(),
  retrieved: Annotation<Retrieved[]>(),
  clinicalSources: Annotation<ClinicalSourceContext[]>(),
  careOrders: Annotation<CareOrderContext[]>(),
  generated: Annotation<GeminiDraftResult | null>(),
  claims: Annotation<ClaimToSave[]>(),
  analysisId: Annotation<string | null>(),
  gateId: Annotation<string | null>(),
  reviewId: Annotation<string | null>(),
  decision: Annotation<string | null>(),
});

type GraphStateValues = typeof GraphState.State;

export type ReviewInterrupt = {
  gate: typeof ANALYSIS_REVIEW_GATE;
  analysisId: string;
  revisionNumber: number;
  gateId: string;
};

function buildMessages(
  snapshot: AnalysisInputSnapshot,
  retrieved: Retrieved[],
  checkInId: string,
  clinicalSources: ClinicalSourceContext[],
  careOrders: CareOrderContext[],
) {
  const context = {
    locale: snapshot.locale,
    checkInId,
    medicalRecordVersionId: snapshot.medicalRecordVersionId,
    medicalRecord: snapshot.medicalRecord,
    checkIn: snapshot.checkIn,
    sourceIds: snapshot.sourceIds,
    orderIds: snapshot.orderIds,
    clinicalSources,
    careOrders,
    sources: retrieved.map(({ chunkId, title, version, ordinal, content }) => ({ chunkId, title, version, ordinal, content })),
  };
  const language = snapshot.locale === "id" ? "Indonesian" : "English";
  return [
    ["system", `Write a cited nursing draft in ${language}. Return JSON only: {"claims":[{"text":"...","claimType":"observation_summary|concern|suggestion|care_note","evidence":[{"checkInId":"...","observationId":"...","orderId":"...","sourceDocumentId":"...","sourceVersion":1,"knowledgeChunkId":"..."}]}]}. Summarize only supplied facts and retrieved education. Do not diagnose, prescribe, calculate risk, invent facts, or make emergency promises. Every claim requires at least one evidence object, and every evidence object MUST include checkInId equal to the supplied check-in id. Add observationId, orderId, sourceDocumentId with sourceVersion, or knowledgeChunkId only when citing that exact supplied item. Use only the exact UUIDs supplied and never invent identifiers. The draft has no clinical authority and is not approved.`],
    ["human", JSON.stringify(context)],
  ] as [string, string][];
}

function parseModelJson(content: string) {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  try { return JSON.parse(unfenced) as unknown; }
  catch { throw new AnalysisWorkerError("INVALID_MODEL_OUTPUT", "Model output was not valid JSON"); }
}

export function validateGeneratedClaims(
  raw: unknown,
  snapshot: AnalysisInputSnapshot,
  checkInId: string,
  retrieved: Retrieved[],
): ClaimToSave[] {
  let parsed: ReturnType<typeof analysisModelOutputSchema.parse>;
  try {
    parsed = parseStrict(analysisModelOutputSchema, raw);
  } catch {
    throw new AnalysisWorkerError("INVALID_MODEL_OUTPUT", "Model output did not match the required claim schema");
  }
  const knowledge = new Map(retrieved.map((chunk) => [chunk.chunkId, chunk]));
  const observations = new Set(snapshot.checkIn.observations.map((item) => item.observationId));
  const sources = new Set(snapshot.sourceIds);
  const orders = new Set(snapshot.orderIds);
  for (const claim of parsed.claims) {
    for (const evidence of claim.evidence) {
      if (evidence.checkInId !== checkInId
        || (evidence.observationId && !observations.has(evidence.observationId))
        || (evidence.sourceDocumentId && !sources.has(evidence.sourceDocumentId))
        || (evidence.orderId && !orders.has(evidence.orderId))
        || (evidence.knowledgeChunkId && !knowledge.has(evidence.knowledgeChunkId))) {
        throw new AnalysisWorkerError("INVALID_MODEL_OUTPUT", "Model evidence is outside the bound input");
      }
    }
  }
  return parsed.claims;
}

function workerErrorCode(error: unknown): string {
  if (error instanceof AnalysisWorkerError) return error.errorCode;
  if (error instanceof AnalysisLeaseLostError) return "STALE_CONTEXT";
  if (error instanceof GeminiDraftModelError) {
    return ({
      invalid_configuration: "PROVIDER_UNAVAILABLE", authentication: "PROVIDER_AUTH_FAILED",
      invalid_request: "INVALID_MODEL_OUTPUT", rate_limited: "PROVIDER_RATE_LIMITED",
      safety_refusal: "PROVIDER_SAFETY_BLOCKED", invalid_response: "INVALID_MODEL_OUTPUT",
      timeout: "PROVIDER_TIMEOUT", aborted: "INTERNAL_ERROR", provider_error: "PROVIDER_UNAVAILABLE",
    } as Record<string, string>)[error.code]!;
  }
  if (error instanceof AppError && error.code === "GATE_UNAVAILABLE") return "INSUFFICIENT_EVIDENCE";
  if (error instanceof AppError && error.status === 409) return "STALE_CONTEXT";
  if (error instanceof ZodError) return "INVALID_MODEL_OUTPUT";
  return "INTERNAL_ERROR";
}

/** Real product graph. Approval is data reconciliation only; publishing is never an edge. */
export function createAnalysisGraph(options: {
  sql: SQL;
  checkpointer: BaseCheckpointSaver;
  model: ModelProvider;
  config: AuthConfig;
  activeJobs?: Map<string, AnalysisJobRow>;
}) {
  const { checkpointer } = options;
  const activeJobs = options.activeJobs ?? new Map<string, AnalysisJobRow>();
  async function loadContext(state: GraphStateValues) {
    const job = await readJob(options.sql, state.jobId);
    if (!job || job.status !== "running" || job.lease_token !== state.leaseToken) {
      throw new AnalysisWorkerError("STALE_CONTEXT", "The generation lease is no longer current");
    }
    return { snapshot: parseStrict(analysisInputSnapshotSchema, job.input_snapshot) };
  }

  async function retrieve(state: GraphStateValues): Promise<Partial<GraphStateValues>> {
    const snapshot = state.snapshot;
    const query = [snapshot.checkIn.note, snapshot.checkIn.condition, snapshot.medicalRecord.primaryDiagnosis, ...(snapshot.medicalRecord.complaints ? [snapshot.medicalRecord.complaints] : [])]
      .filter(Boolean).join(" ").slice(0, 1000) || (snapshot.locale === "id" ? "perawatan di rumah" : "home care");
    const rows = await options.sql`
      WITH search_query AS (SELECT plainto_tsquery('simple', ${query}) AS q)
      SELECT k.id AS chunk_id, d.id AS document_id, d.title, d.version, k.ordinal,
        k.content, ts_rank_cd(k.tsv, q.q)::double precision AS score
      FROM public.knowledge_documents d
      JOIN public.knowledge_chunks k ON k.document_id = d.id
      CROSS JOIN search_query q
      WHERE d.corpus_id = ${snapshot.corpusId} AND d.status = 'approved'
        AND d.approved_by IS NOT NULL AND d.approved_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.knowledge_documents newer
          WHERE newer.corpus_id = d.corpus_id AND newer.title = d.title
            AND newer.status = 'approved' AND newer.version > d.version)
      ORDER BY k.tsv @@ q.q DESC, score DESC, d.id, k.ordinal, k.id LIMIT 20
    `;
    const retrieved: Retrieved[] = rows.map((row: Record<string, any>) => ({
      chunkId: row.chunk_id, documentId: row.document_id, corpusId: snapshot.corpusId,
      title: row.title, version: row.version, ordinal: row.ordinal,
      excerpt: row.content, content: row.content, score: row.score,
    }));
    return { retrieved };
  }

  async function retrieveClinicalContext(state: GraphStateValues) {
    const snapshot = state.snapshot;
    const sources: ClinicalSourceContext[] = await options.sql`
      SELECT s.id AS source_document_id, s.revision_number AS source_version,
        s.kind, s.title, s.body
      FROM public.clinical_source_documents s
      WHERE s.patient_id = (SELECT patient_id FROM public.analysis_jobs WHERE id = ${state.jobId})
        AND s.medical_record_version_id = ${snapshot.medicalRecordVersionId}
        AND s.status = 'approved' AND s.approved_by IS NOT NULL AND s.approved_at IS NOT NULL
        AND s.id = ANY(${`{${snapshot.sourceIds.join(",")}}`}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM public.clinical_source_documents later
          WHERE later.lineage_id = s.lineage_id AND later.revision_number > s.revision_number
            AND later.status IN ('approved', 'retired'))
      ORDER BY s.id
    `;
    const orderRows: Array<Omit<CareOrderContext, "effectiveFrom" | "effectiveTo"> & { effective_from: Date | string; effective_to: Date | string | null }> = await options.sql`
      SELECT o.id AS order_id, o.source_document_id, o.source_version, o.kind, o.payload,
        o.effective_from, o.effective_to
      FROM public.care_orders o
      WHERE o.patient_id = (SELECT patient_id FROM public.analysis_jobs WHERE id = ${state.jobId})
        AND o.medical_record_version_id = ${snapshot.medicalRecordVersionId}
        AND o.id = ANY(${`{${snapshot.orderIds.join(",")}}`}::uuid[])
        AND o.status = 'active' AND o.published_at IS NOT NULL
        AND o.effective_from <= now() AND (o.effective_to IS NULL OR o.effective_to > now())
        AND o.source_document_id = ANY(${`{${snapshot.sourceIds.join(",")}}`}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM public.care_orders later
          WHERE later.lineage_id = o.lineage_id AND later.revision_number > o.revision_number
            AND later.status <> 'draft')
      ORDER BY o.id
    `;
    const orders = orderRows.map(({ effective_from, effective_to, ...order }) => ({
      ...order, effectiveFrom: isoTimestamp(effective_from), effectiveTo: effective_to === null ? null : isoTimestamp(effective_to),
    }));
    if (sources.length !== snapshot.sourceIds.length || orders.length !== snapshot.orderIds.length) {
      throw new AnalysisWorkerError("STALE_CONTEXT", "A bound clinical source or order is no longer current");
    }
    return { clinicalSources: sources, careOrders: orders };
  }

  async function generate(state: GraphStateValues) {
    const job = await readJob(options.sql, state.jobId);
    if (!job) throw new AnalysisWorkerError("STALE_CONTEXT");
    const generated = await options.model.invoke(buildMessages(
      state.snapshot, state.retrieved, job.check_in_id, state.clinicalSources, state.careOrders,
    ));
    return { generated };
  }

  async function validateAndSave(state: GraphStateValues) {
    if (!state.generated) throw new AnalysisWorkerError("INVALID_MODEL_OUTPUT");
    const job = activeJobs.get(state.jobId) ?? await readJob(options.sql, state.jobId);
    if (!job || job.status !== "running" || job.lease_token !== state.leaseToken || !job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= Date.now()) {
      throw new AnalysisWorkerError("STALE_CONTEXT", "The generation lease is no longer current");
    }
    const claims = validateGeneratedClaims(parseModelJson(state.generated.content), state.snapshot, job.check_in_id, state.retrieved);
    const analysis = await options.sql.begin((tx) => saveJobResult(tx, {
      job, claims, modelProvider: state.generated!.provider, modelId: state.generated!.modelId,
    }));
    return { analysisId: analysis.id, claims };
  }

  async function awaitReview(state: GraphStateValues) {
    const decision = interrupt<ReviewInterrupt, { reviewId: string; decision: string }>({
      gate: ANALYSIS_REVIEW_GATE, analysisId: state.analysisId!, revisionNumber: 1, gateId: "",
    });
    const gateRows = await options.sql`SELECT g.*, r.decision AS stored_decision FROM public.analysis_review_gates g
      JOIN public.analysis_reviews r ON r.id = g.review_id
      WHERE g.analysis_id = ${state.analysisId} AND g.state = 'decided' AND g.review_id = ${decision.reviewId}`;
    if (!gateRows[0] || gateRows[0].review_id !== decision.reviewId || gateRows[0].stored_decision !== decision.decision) {
      throw new AnalysisWorkerError("INVALID_MODEL_OUTPUT", "Review resume does not match the persisted decision");
    }
    await options.sql`UPDATE public.analysis_review_gates SET state = 'reconciled', version = version + 1
      WHERE id = ${gateRows[0].id} AND state = 'decided' AND review_id = ${decision.reviewId}`;
    return { gateId: gateRows[0].id, reviewId: decision.reviewId, decision: gateRows[0].stored_decision };
  }

  async function reconcile(state: GraphStateValues) {
    const rows = await options.sql`SELECT status FROM public.analyses WHERE id = ${state.analysisId}`;
    const expected = state.decision === "approve" ? "approved" : state.decision === "reject" ? "rejected" : "draft";
    if (rows[0]?.status !== expected) throw new AnalysisWorkerError("STALE_CONTEXT", "Review workflow does not match the stored decision");
    return {};
  }

  return new StateGraph(GraphState)
    .addNode("load_context", loadContext)
    .addNode("retrieve", retrieve)
    .addNode("retrieve_clinical_context", retrieveClinicalContext)
    .addNode("generate", generate)
    .addNode("validate_and_save", validateAndSave)
    .addNode("await_review", awaitReview)
    .addNode("reconcile", reconcile)
    .addEdge(START, "load_context")
    .addEdge("load_context", "retrieve")
    .addEdge("retrieve", "retrieve_clinical_context")
    .addEdge("retrieve_clinical_context", "generate")
    .addEdge("generate", "validate_and_save")
    .addEdge("validate_and_save", "await_review")
    .addEdge("await_review", "reconcile")
    .addEdge("reconcile", END)
    .compile({ checkpointer });
}

export type AnalysisWorker = {
  setup(): Promise<void>;
  runNext(owner?: string): Promise<"idle" | "interrupted" | "completed" | "failed">;
  reconcileAnalysis(analysisId: string): Promise<boolean>;
};

export function createAnalysisWorker(options: {
  sql: SQL;
  checkpointer: BaseCheckpointSaver;
  setupCheckpointer: () => Promise<void>;
  model: ModelProvider;
  config: AuthConfig;
  owner?: string;
  leaseMs?: number;
}): AnalysisWorker {
  const activeJobs = new Map<string, AnalysisJobRow>();
  const graph = createAnalysisGraph({ ...options, activeJobs });
  const owner = options.owner ?? `analysis-${process.pid}`;
  const leaseMs = options.leaseMs ?? 90_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 900000) throw new Error("Analysis lease must be 1-900 seconds");

  async function bindInterruptedGate(jobId: string) {
    const job = await readJob(options.sql, jobId);
    if (!job?.analysis_id) throw new AnalysisWorkerError("INTERNAL_ERROR", "Interrupted job has no saved analysis");
    const existing = await options.sql`SELECT id FROM public.analysis_review_gates WHERE analysis_id = ${job.analysis_id}`;
    if (existing.length) return;
    const state = await graph.getState({ configurable: { thread_id: jobId, checkpoint_ns: ANALYSIS_CHECKPOINT_NAMESPACE } });
    const checkpointId = state.config.configurable?.checkpoint_id as string | undefined;
    if (!checkpointId) throw new AnalysisWorkerError("INTERNAL_ERROR", "The persisted interrupt has no checkpoint identity");
    await options.sql`INSERT INTO public.analysis_review_gates (
      analysis_id, analysis_revision_number, thread_id, checkpoint_id, checkpoint_namespace
    ) VALUES (${job.analysis_id}, 1, ${jobId}, ${checkpointId}, ${ANALYSIS_CHECKPOINT_NAMESPACE})
    ON CONFLICT (analysis_id, analysis_revision_number) DO NOTHING`;
  }

  async function reconcileAnalysis(analysisId: string): Promise<boolean> {
    const rows = await options.sql`SELECT g.*, r.decision FROM public.analysis_review_gates g
      JOIN public.analysis_reviews r ON r.id = g.review_id
      WHERE g.analysis_id = ${analysisId} AND g.state = 'decided' ORDER BY g.created_at DESC LIMIT 1`;
    const gate = rows[0];
    if (!gate) return false;
    const analysis = await readAnalysis(options.sql, analysisId);
    if (!analysis) throw new AnalysisWorkerError("STALE_CONTEXT");
    // Current-primary scope is rechecked with the requester's durable staff identity.
    await options.sql`SELECT public.forcare_analysis_assert_current_revision(${analysisId})`;
    const scope = await options.sql`SELECT 1 FROM public.patients p JOIN public.patient_access_grants a ON a.patient_id = p.id
      WHERE p.id = ${analysis.patient_id} AND p.primary_nurse_id = ${analysis.created_by}
        AND a.staff_id = ${analysis.created_by} AND a.basis = 'primary' AND a.revoked_at IS NULL
        AND (a.expires_at IS NULL OR a.expires_at > now())`;
    if (!scope.length) throw new AnalysisWorkerError("SCOPE_REVOKED", "Analysis scope was revoked");
    if (gate.thread_id.startsWith("analysis-revision-")) {
      await options.sql`UPDATE public.analysis_review_gates SET state = 'reconciled', version = version + 1
        WHERE id = ${gate.id} AND state = 'decided'`;
      return true;
    }
    const checkpoint = await graph.getState({ configurable: { thread_id: gate.thread_id, checkpoint_ns: gate.checkpoint_namespace } });
    if (checkpoint.config.configurable?.checkpoint_id !== gate.checkpoint_id) {
      throw new AnalysisWorkerError("STALE_CONTEXT", "Review checkpoint no longer matches its gate");
    }
    await graph.invoke(new Command({ resume: { reviewId: gate.review_id, decision: gate.decision } }), {
      configurable: { thread_id: gate.thread_id, checkpoint_ns: gate.checkpoint_namespace, checkpoint_id: gate.checkpoint_id },
    });
    return true;
  }

  return {
    setup: options.setupCheckpointer,
    async runNext(runOwner = owner) {
      const { acquireJob } = await import("./repository");
      const job = await acquireJob(options.sql, runOwner, leaseMs);
      if (!job) return "idle";
      if (job.status === "failed") return "failed";
      activeJobs.set(job.id, job);
      const heartbeat = setInterval(() => {
        const active = activeJobs.get(job.id);
        if (!active) return;
        void heartbeatJob(options.sql, active, leaseMs)
          .then((updated) => { activeJobs.set(job.id, updated); })
          .catch(() => { activeJobs.delete(job.id); });
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      try {
        const result = await graph.invoke({
          jobId: job.id, leaseToken: job.lease_token!, snapshot: job.input_snapshot as AnalysisInputSnapshot,
          retrieved: [], clinicalSources: [], careOrders: [], generated: null, claims: [], analysisId: null, gateId: null, reviewId: null, decision: null,
        }, { configurable: { thread_id: job.id, checkpoint_ns: ANALYSIS_CHECKPOINT_NAMESPACE } });
        if (Array.isArray((result as any).__interrupt__)) {
          await bindInterruptedGate(job.id);
          return "interrupted";
        }
        return "completed";
      } catch (error) {
        const latest = await readJob(options.sql, job.id);
        if (latest?.status === "awaiting_review") {
          await bindInterruptedGate(job.id);
          return "interrupted";
        }
        await failJob(options.sql, job, workerErrorCode(error));
        return "failed";
      } finally { clearInterval(heartbeat); activeJobs.delete(job.id); }
    },
    reconcileAnalysis,
  };
}
