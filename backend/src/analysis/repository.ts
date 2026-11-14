import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import type { AuthContext } from "../auth/policy";
import { requireKnowledgeNurse } from "../knowledge/repository";
import { AppError } from "../http/errors";
import { isoTimestamp } from "../http/time";
import { parseStrict } from "../http/request";
import { requirePrimaryScope, requireSelfOrPrimaryScope } from "../clinical/policy";
import { canonicalRequestHash } from "../http/idempotency";
import {
  analysisInputSnapshotSchema,
  analysisResponseSchema,
  analysisReviewResponseSchema,
  analysisPublicationResponseSchema,
  analysisSummarySchema,
  type AnalysisClaimInput,
  type AnalysisInputSnapshot,
} from "./schemas";

export const ANALYSIS_PROMPT_VERSION = "forcare-condition-v1" as const;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_LEASE_MS = 90_000;

export class AnalysisLeaseLostError extends Error {
  constructor() { super("Analysis job lease is no longer current"); this.name = "AnalysisLeaseLostError"; }
}

export type AnalysisJobRow = {
  id: string; patient_id: string; check_in_id: string; requested_by: string;
  prompt_version: string; locale: "id" | "en"; input_hash: string;
  input_snapshot: unknown; status: "queued" | "running" | "awaiting_review" | "failed" | "completed";
  analysis_id: string | null; error_code: string | null; attempt_count: number;
  max_attempts: number; lease_owner: string | null; lease_token: string | null;
  lease_expires_at: Date | string | null; version: number;
  created_at: Date | string; updated_at: Date | string;
};

export type AnalysisRow = {
  id: string; lineage_id: string; revision_number: number; supersedes_id: string | null;
  patient_id: string; check_in_id: string; status: "draft" | "in_review" | "approved" | "rejected" | "published";
  model_provider: string; model_id: string; prompt_version: string; input_hash: string;
  input_snapshot: unknown; retrieved_chunk_ids: string[]; version: number; created_by: string;
  created_at: Date | string; updated_at: Date | string; job_id: string | null;
  finalized_at: Date | string | null;
};

export function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {};
}

export function analysisJobDto(row: AnalysisJobRow) {
  return {
    id: row.id, patientId: row.patient_id, checkInId: row.check_in_id,
    status: row.status, analysisId: row.analysis_id, errorCode: row.error_code,
    version: row.version,
  };
}

export async function requireAnalysisNurse(
  sql: SQL,
  auth: AuthContext,
  config: Parameters<typeof requireKnowledgeNurse>[2],
) {
  if (auth.role !== "nurse" || !auth.staffId) {
    throw new AppError("FORBIDDEN", "Primary nurse access is required", 403);
  }
  await requireKnowledgeNurse(sql, auth.staffId, config, auth.accountId);
}

export async function requireAnalysisPatientScope(
  sql: SQL,
  auth: AuthContext,
  patientId: string,
  config: Parameters<typeof requireKnowledgeNurse>[2],
) {
  await requireAnalysisNurse(sql, auth, config);
  await requirePrimaryScope(sql, auth, patientId);
}

export async function lockAnalysisPatientScope(
  sql: SQL,
  auth: AuthContext,
  patientId: string,
  config: Parameters<typeof requireKnowledgeNurse>[2],
) {
  await requireAnalysisNurse(sql, auth, config);
  const patients = await sql`SELECT id FROM public.patients WHERE id = ${patientId} FOR SHARE`;
  if (!patients.length) throw new AppError("NOT_FOUND", "Patient not found", 404);
  await requirePrimaryScope(sql, auth, patientId);
}

/** Exact submitted/current heads and patient-safe input; DB repeats these checks. */
export async function createInputSnapshot(
  sql: SQL,
  input: { patientId: string; checkInId: string; locale: "id" | "en" },
): Promise<AnalysisInputSnapshot> {
  const rows = await sql`
    WITH current_medical AS (
      SELECT id, payload FROM public.medical_record_versions
      WHERE patient_id = ${input.patientId}
      ORDER BY revision_number DESC LIMIT 1
    ), current_sources AS (
      SELECT DISTINCT ON (lineage_id) id
      FROM public.clinical_source_documents
      WHERE patient_id = ${input.patientId} AND status = 'approved'
        AND medical_record_version_id = (SELECT id FROM current_medical)
        AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      ORDER BY lineage_id, revision_number DESC
    ), current_orders AS (
      SELECT DISTINCT ON (lineage_id) id, source_document_id, status, effective_from, effective_to
      FROM public.care_orders
      WHERE patient_id = ${input.patientId}
        AND medical_record_version_id = (SELECT id FROM current_medical)
        AND status <> 'draft'
      ORDER BY lineage_id, revision_number DESC
    ), observations AS (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'observationId', o.id, 'type', o.type, 'value', o.value, 'unit', o.unit,
        'observedAt', to_char(o.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) ORDER BY o.type, o.id), '[]'::jsonb) AS value
      FROM public.check_in_observations o WHERE o.check_in_id = ${input.checkInId}
    ), corpus AS (
      SELECT id, version FROM public.knowledge_corpora
      WHERE name = 'forcare-homecare-basics' AND status = 'approved'
        AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      ORDER BY version DESC, id LIMIT 1
    )
    SELECT ci.patient_id, ci.condition, ci.note, ci.medication_adherence,
      m.id AS medical_record_version_id, m.payload AS medical_payload,
      (SELECT value FROM observations) AS observations,
      coalesce((SELECT jsonb_agg(id::text ORDER BY id::text) FROM current_sources), '[]'::jsonb) AS source_ids,
      coalesce((SELECT jsonb_agg(o.id::text ORDER BY o.id::text) FROM current_orders o
        WHERE o.status = 'active' AND o.source_document_id IN (SELECT id FROM current_sources)
          AND EXISTS (SELECT 1 FROM public.care_orders bound WHERE bound.id = o.id
            AND bound.effective_from <= now() AND (bound.effective_to IS NULL OR bound.effective_to > now()))),
        '[]'::jsonb) AS order_ids,
      c.id AS corpus_id, c.version AS corpus_version
    FROM public.check_ins ci
    JOIN current_medical m ON true
    LEFT JOIN corpus c ON true
    WHERE ci.id = ${input.checkInId} AND ci.patient_id = ${input.patientId}
      AND ci.status = 'submitted'
  `;
  const row = rows[0];
  if (!row) throw new AppError("INVALID_TRANSITION", "A submitted check-in with a current medical record is required", 409);
  if (!row.corpus_id) throw new AppError("GATE_UNAVAILABLE", "Approved knowledge corpus is unavailable", 503, { gate: "G05" });
  const medicalRecord = jsonObject(row.medical_payload);
  delete medicalRecord.internalNote;
  const snapshot = parseStrict(analysisInputSnapshotSchema, {
    locale: input.locale,
    medicalRecordVersionId: row.medical_record_version_id,
    medicalRecord,
    checkIn: {
      condition: row.condition, note: row.note,
      medicationAdherence: row.medication_adherence, observations: row.observations,
    },
    sourceIds: row.source_ids, orderIds: row.order_ids,
    corpusId: row.corpus_id, corpusVersion: row.corpus_version,
  });
  // Application checks the same conservative current-head/phantom protocol used by triggers.
  await sql`LOCK TABLE public.medical_record_versions, public.clinical_source_documents, public.care_orders IN SHARE MODE`;
  await sql`SELECT public.forcare_analysis_assert_context(${input.patientId}, ${input.checkInId}, (${JSON.stringify(snapshot)}::text)::jsonb)`;
  return snapshot;
}

export async function insertAnalysisJob(
  sql: SQL,
  input: { patientId: string; checkInId: string; requestedBy: string; snapshot: AnalysisInputSnapshot },
): Promise<AnalysisJobRow> {
  const rows = await sql`
    INSERT INTO public.analysis_jobs (
      patient_id, check_in_id, requested_by, prompt_version, locale, input_hash, input_snapshot, max_attempts
    ) VALUES (
      ${input.patientId}, ${input.checkInId}, ${input.requestedBy}, ${ANALYSIS_PROMPT_VERSION},
      ${input.snapshot.locale}, ${canonicalRequestHash(input.snapshot)}, (${JSON.stringify(input.snapshot)}::text)::jsonb,
      ${DEFAULT_MAX_ATTEMPTS}
    ) RETURNING *
  ` as unknown as AnalysisJobRow[];
  return rows[0]!;
}

export async function readJob(sql: SQL, id: string): Promise<AnalysisJobRow | null> {
  const rows = await sql`SELECT * FROM public.analysis_jobs WHERE id = ${id} LIMIT 1` as unknown as AnalysisJobRow[];
  return rows[0] ?? null;
}

export async function readAnalysis(sql: SQL, id: string): Promise<AnalysisRow | null> {
  const rows = await sql`SELECT * FROM public.analyses WHERE id = ${id} LIMIT 1` as unknown as AnalysisRow[];
  return rows[0] ?? null;
}

export type ClaimToSave = AnalysisClaimInput & { clinicalChunkId?: string };

/** All membership is inserted before deferred finalization; there is no post-commit append. */
export async function insertAnalysisSnapshot(
  sql: SQL,
  input: {
    job?: AnalysisJobRow;
    predecessor?: AnalysisRow;
    claims: ClaimToSave[];
    modelProvider: string;
    modelId: string;
  },
): Promise<AnalysisRow> {
  const predecessor = input.predecessor;
  const job = input.job;
  if (!job && !predecessor) throw new Error("analysis requires a job or predecessor");
  const patientId = job?.patient_id ?? predecessor!.patient_id;
  const checkInId = job?.check_in_id ?? predecessor!.check_in_id;
  const snapshot = job ? parseStrict(analysisInputSnapshotSchema, job.input_snapshot) : parseStrict(analysisInputSnapshotSchema, predecessor!.input_snapshot);
  const inputHash = job?.input_hash ?? predecessor!.input_hash;
  const retrieved = [...new Set(input.claims.flatMap((claim) => claim.evidence.flatMap((evidence) => evidence.knowledgeChunkId ? [evidence.knowledgeChunkId] : [])))].sort();
  const analysisId = randomUUID();
  const rows = await sql`
    INSERT INTO public.analyses (
      id, lineage_id, revision_number, supersedes_id, patient_id, check_in_id,
      status, model_provider, model_id, prompt_version, input_hash, input_snapshot,
      retrieved_chunk_ids, version, created_by, job_id
    ) VALUES (
      ${analysisId}, ${predecessor?.lineage_id ?? analysisId}, ${predecessor ? predecessor.revision_number + 1 : 1},
      ${predecessor?.id ?? null}, ${patientId}, ${checkInId}, 'draft',
      ${input.modelProvider}, ${input.modelId}, ${ANALYSIS_PROMPT_VERSION}, ${inputHash},
      (${JSON.stringify(snapshot)}::text)::jsonb, ${`{${retrieved.join(",")}}`}::uuid[], 0,
      ${job?.requested_by ?? predecessor!.created_by}, ${job?.id ?? null}
    ) RETURNING *
  ` as unknown as AnalysisRow[];
  const analysis = rows[0]!;
  for (const [ordinal, claim] of input.claims.entries()) {
    const claimRows = await sql`
      INSERT INTO public.analysis_claims (analysis_id, ordinal, claim_type, text, patient_facing)
      VALUES (${analysis.id}, ${ordinal}, ${claim.claimType}, ${claim.text}, true)
      RETURNING id
    `;
    const claimId = claimRows[0]!.id as string;
    for (const evidence of claim.evidence) {
      await sql`
        INSERT INTO public.analysis_evidence (
          claim_id, analysis_id, check_in_id, patient_id, observation_id, order_id,
          source_document_id, source_version, clinical_chunk_id, knowledge_chunk_id
        ) VALUES (
          ${claimId}, ${analysis.id}, ${checkInId}, ${patientId},
          ${evidence.observationId ?? null}, ${evidence.orderId ?? null},
          ${evidence.sourceDocumentId ?? null}, ${evidence.sourceVersion ?? null},
          ${(claim as ClaimToSave).clinicalChunkId ?? null}, ${evidence.knowledgeChunkId ?? null}
        )
      `;
    }
  }
  return analysis;
}

export async function saveJobResult(
  sql: SQL,
  input: { job: AnalysisJobRow; claims: ClaimToSave[]; modelProvider: string; modelId: string },
): Promise<AnalysisRow> {
  const existing = await sql`SELECT * FROM public.analyses WHERE job_id = ${input.job.id} LIMIT 1` as unknown as AnalysisRow[];
  if (existing[0]) return existing[0];
  const locked = await sql`SELECT * FROM public.analysis_jobs WHERE id = ${input.job.id} FOR UPDATE` as unknown as AnalysisJobRow[];
  const current = locked[0];
  if (!current || current.status !== "running" || current.lease_token !== input.job.lease_token
    || current.lease_owner !== input.job.lease_owner || !current.lease_expires_at
    || new Date(current.lease_expires_at).getTime() <= Date.now()) {
    throw new AnalysisLeaseLostError();
  }
  input = { ...input, job: current };
  const analysis = await insertAnalysisSnapshot(sql, input);
  // Finalize only after every immutable claim/evidence member exists. The job
  // guard requires this seal before it accepts the result in the same commit.
  await sql`SET CONSTRAINTS public.analyses_finalize, public.analysis_claims_finalize, public.analysis_evidence_finalize IMMEDIATE`;
  const completed = await sql`
    INSERT INTO public.analysis_job_attempts (
      job_id, attempt_number, lease_token, model_provider, model_id, outcome, started_at, finished_at
    ) VALUES (
      ${input.job.id}, ${input.job.attempt_count}, ${input.job.lease_token},
      ${input.modelProvider}, ${input.modelId}, 'succeeded', ${input.job.updated_at}, now()
    ) RETURNING id
  `;
  if (!completed.length) throw new Error("attempt receipt was not inserted");
  await sql`
    UPDATE public.analysis_jobs
    SET status = 'awaiting_review', analysis_id = ${analysis.id}, error_code = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1
    WHERE id = ${input.job.id} AND version = ${input.job.version}
      AND lease_token = ${input.job.lease_token} AND status = 'running'
  `;
  return analysis;
}

export async function acquireJob(sql: SQL, owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<AnalysisJobRow | null> {
  if (!owner.trim() || owner.length > 200 || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60_000) {
    throw new Error("invalid worker lease configuration");
  }
  return sql.begin(async (tx) => {
    const candidates = await tx`
      SELECT * FROM public.analysis_jobs
      WHERE status = 'queued' OR (status = 'running' AND lease_expires_at <= now())
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ` as unknown as AnalysisJobRow[];
    const job = candidates[0];
    if (!job) return null;
    if (job.attempt_count >= job.max_attempts) {
      if (job.status === "running") {
        await tx`INSERT INTO public.analysis_job_attempts (
          job_id, attempt_number, lease_token, model_provider, model_id, outcome, error_code, started_at, finished_at
        ) VALUES (${job.id}, ${job.attempt_count}, ${job.lease_token}, 'worker', 'lease-expired', 'lease_expired', 'ATTEMPTS_EXHAUSTED', ${job.updated_at}, now())`;
      }
      const failed = await tx`UPDATE public.analysis_jobs SET status = 'failed', error_code = 'ATTEMPTS_EXHAUSTED',
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, version = version + 1
        WHERE id = ${job.id} RETURNING *` as unknown as AnalysisJobRow[];
      return failed[0]!;
    }
    if (job.status === "running") {
      await tx`INSERT INTO public.analysis_job_attempts (
        job_id, attempt_number, lease_token, model_provider, model_id, outcome, error_code, started_at, finished_at
      ) VALUES (${job.id}, ${job.attempt_count}, ${job.lease_token}, 'worker', 'lease-expired', 'lease_expired', 'STALE_CONTEXT', ${job.updated_at}, now())`;
    }
    const rows = await tx`
      UPDATE public.analysis_jobs SET status = 'running', error_code = NULL,
        attempt_count = attempt_count + 1, lease_owner = ${owner}, lease_token = ${randomUUID()},
        lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
        version = version + 1, updated_at = now()
      WHERE id = ${job.id} RETURNING *
    ` as unknown as AnalysisJobRow[];
    return rows[0]!;
  });
}

export async function heartbeatJob(sql: SQL, job: AnalysisJobRow, leaseMs = DEFAULT_LEASE_MS): Promise<AnalysisJobRow> {
  const rows = await sql`
    UPDATE public.analysis_jobs SET lease_expires_at = now() + (${leaseMs}::text || ' milliseconds')::interval,
      version = version + 1, updated_at = updated_at
    WHERE id = ${job.id} AND version = ${job.version} AND status = 'running'
      AND lease_owner = ${job.lease_owner} AND lease_token = ${job.lease_token}
      AND lease_expires_at > now() RETURNING *
  ` as unknown as AnalysisJobRow[];
  if (!rows[0]) throw new AppError("INVALID_TRANSITION", "Analysis job lease is no longer current", 409);
  return rows[0];
}

export async function failJob(sql: SQL, job: AnalysisJobRow, code: string): Promise<void> {
  await sql.begin(async (tx) => {
    const currentRows = await tx`SELECT * FROM public.analysis_jobs WHERE id = ${job.id} FOR UPDATE` as unknown as AnalysisJobRow[];
    const current = currentRows[0];
    if (!current || current.status !== "running" || current.lease_token !== job.lease_token) return;
    const expired = !current.lease_expires_at || new Date(current.lease_expires_at).getTime() <= Date.now();
    const final = expired || current.attempt_count >= current.max_attempts || ["INSUFFICIENT_EVIDENCE", "INVALID_MODEL_OUTPUT", "PROVIDER_AUTH_FAILED", "PROVIDER_SAFETY_BLOCKED", "STALE_CONTEXT", "SCOPE_REVOKED", "ATTEMPTS_EXHAUSTED"].includes(code);
    await tx`INSERT INTO public.analysis_job_attempts (
      job_id, attempt_number, lease_token, model_provider, model_id, outcome, error_code, started_at, finished_at
    ) VALUES (${current.id}, ${current.attempt_count}, ${current.lease_token}, 'worker', 'analysis',
      ${expired ? "lease_expired" : "failed"}, ${code}, ${current.updated_at}, now())`;
    await tx`UPDATE public.analysis_jobs SET status = ${final ? "failed" : "queued"},
      error_code = ${final ? code : null}, lease_owner = NULL, lease_token = NULL,
      lease_expires_at = NULL, version = version + 1 WHERE id = ${current.id}`;
  });
}

export async function completeJob(sql: SQL, analysisId: string): Promise<void> {
  await sql`UPDATE public.analysis_jobs SET status = 'completed', error_code = NULL, version = version + 1
    WHERE analysis_id = ${analysisId} AND status = 'awaiting_review'`;
}

export async function analysisDto(sql: SQL, row: AnalysisRow): Promise<unknown> {
  const claims = await sql`
    SELECT c.id, c.claim_type, c.text,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'checkInId', e.check_in_id, 'observationId', e.observation_id, 'orderId', e.order_id,
        'sourceDocumentId', e.source_document_id, 'sourceVersion', e.source_version,
        'knowledgeChunkId', e.knowledge_chunk_id
      ) ORDER BY e.id) FROM public.analysis_evidence e WHERE e.claim_id = c.id), '[]'::jsonb) AS evidence
    FROM public.analysis_claims c WHERE c.analysis_id = ${row.id} ORDER BY c.ordinal
  ` as Array<{ id: string; claim_type: string; text: string; evidence: unknown }>;
  const reviews = await sql`SELECT * FROM public.analysis_reviews
    WHERE analysis_id = ${row.id} AND analysis_revision_number = ${row.revision_number} ORDER BY decided_at, id` as Array<Record<string, any>>;
  const publications = await sql`SELECT * FROM public.analysis_publications
    WHERE analysis_id = ${row.id} AND analysis_revision_number = ${row.revision_number}` as Array<Record<string, any>>;
  const publication = publications[0];
  return analysisResponseSchema.parse({
    id: row.id, patientId: row.patient_id, checkInId: row.check_in_id, status: row.status,
    revisionNumber: row.revision_number, supersedesId: row.supersedes_id, version: row.version,
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
    claims: claims.map((claim) => ({
      claimId: claim.id, text: claim.text, claimType: claim.claim_type,
      evidence: (claim.evidence as Array<Record<string, unknown>>).map((evidence) => Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== null))),
    })),
    reviews: reviews.map((review) => analysisReviewResponseSchema.parse({
      id: review.id, analysisId: review.analysis_id, revisionNumber: review.analysis_revision_number,
      decision: review.decision, comment: review.comment, reviewerStaffId: review.reviewer_staff_id,
      decidedAt: isoTimestamp(review.decided_at), version: review.version,
    })),
    publication: publication ? analysisPublicationResponseSchema.parse({
      id: publication.id, analysisId: publication.analysis_id, revisionNumber: publication.analysis_revision_number,
      reviewId: publication.review_id, publishedBy: publication.published_by, publishedAt: isoTimestamp(publication.published_at),
    }) : null,
  });
}

export function summaryDto(row: AnalysisRow) {
  return analysisSummarySchema.parse({
    id: row.id, patientId: row.patient_id, checkInId: row.check_in_id, status: row.status,
    revisionNumber: row.revision_number, supersedesId: row.supersedes_id, version: row.version,
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
  });
}

export async function scopedAnalysis(sql: SQL, auth: AuthContext, id: string) {
  const row = await readAnalysis(sql, id);
  if (!row) throw new AppError("NOT_FOUND", "Analysis not found", 404);
  await requireSelfOrPrimaryScope(sql, auth, row.patient_id);
  return row;
}

export async function listAnalysisRows(
  sql: SQL,
  input: { patientId?: string; patientScopeIds?: string[]; patientView: boolean; status?: string; afterCreatedAt?: string; afterId?: string },
): Promise<AnalysisRow[]> {
  return sql`
    SELECT * FROM public.analyses a
    WHERE (${input.patientId ?? null}::uuid IS NULL OR a.patient_id = ${input.patientId ?? null})
      AND (${input.patientScopeIds === undefined} OR a.patient_id = ANY(${`{${(input.patientScopeIds ?? []).join(",")}}`}::uuid[]))
      AND (${!input.patientView} OR a.status = 'published')
      AND (${input.status ?? null}::text IS NULL OR a.status = ${input.status ?? null})
      AND (${input.afterCreatedAt ?? null}::timestamptz IS NULL OR
        (a.created_at, a.id) < (${input.afterCreatedAt ?? null}::timestamptz, ${input.afterId ?? null}::uuid))
    ORDER BY a.created_at DESC, a.id DESC LIMIT 101
  ` as unknown as AnalysisRow[];
}

export async function currentPrimaryPatientIds(sql: SQL, staffId: string): Promise<string[]> {
  const rows = await sql`SELECT p.id FROM public.patients p
    JOIN public.patient_access_grants g ON g.patient_id = p.id
    WHERE p.primary_nurse_id = ${staffId} AND g.staff_id = ${staffId}
      AND g.basis = 'primary' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())`;
  return rows.map((row: { id: string }) => row.id);
}

export function inputHash(snapshot: AnalysisInputSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
