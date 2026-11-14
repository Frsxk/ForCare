import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const moduleUrl = new URL("../src/analysis/schemas.ts", import.meta.url);
async function schemas() {
  expect(existsSync(moduleUrl), "analysis schemas must exist").toBe(true);
  return import("../src/analysis/schemas");
}
const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const evidence = { checkInId: id };
const claim = { text: "Keluhan dilaporkan pasien.", claimType: "observation_summary" as const, evidence: [evidence] };
const generation = { promptVersion: "forcare-condition-v1" as const, locale: "id" as const };
const review = { decision: "approve" as const, comment: null, expectedVersion: 1, revisionNumber: 1 };
const publication = { expectedVersion: 2, revisionNumber: 1, reviewId: id };
const job = { id, patientId: id, checkInId: id, status: "queued" as const, analysisId: null, errorCode: null, version: 0 as const };
const timestamp = "2026-11-14T01:02:03.004Z";

describe("analysis strict DTO checkpoint (no database)", () => {
  test("retains literal enums and generation body, with no actor or model selectors", async () => {
    const s = await schemas();
    expect(s.analysisStatusSchema.options).toEqual(["draft", "in_review", "approved", "rejected", "published"]);
    expect(s.analysisJobStatusSchema.options).toEqual(["queued", "running", "awaiting_review", "failed", "completed"]);
    expect(s.analysisClaimTypeSchema.options).toEqual(["observation_summary", "concern", "suggestion", "care_note"]);
    expect(s.analysisReviewDecisionSchema.options).toEqual(["approve", "reject", "changes_requested"]);
    expect(s.analysisGenerateSchema.parse(generation)).toEqual(generation);
    expect(s.analysisGenerateSchema.safeParse({ ...generation, locale: "en" }).success).toBe(true);
    for (const patch of [{ locale: "id-ID" }, { promptVersion: "v2" }, { locale: null }, { patientId: id }, { modelId: "model" }, { createdBy: id }, { prompt: "override" }]) {
      expect(s.analysisGenerateSchema.safeParse({ ...generation, ...patch }).success).toBe(false);
    }
    expect(s.analysisGenerateSchema.safeParse({ locale: "id" }).success).toBe(false);
  });

  test("requires explicit bounded evidence, preserves original optional source fields", async () => {
    const s = await schemas();
    expect(s.analysisEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(s.analysisEvidenceSchema.parse({ ...evidence, observationId: id, orderId: id, sourceDocumentId: id, sourceVersion: 1, knowledgeChunkId: id }))
      .toEqual({ ...evidence, observationId: id, orderId: id, sourceDocumentId: id, sourceVersion: 1, knowledgeChunkId: id });
    for (const value of [{}, { checkInId: "latest" }, { ...evidence, sourceVersion: 1 }, { ...evidence, sourceDocumentId: id }, { ...evidence, sourceDocumentId: id, sourceVersion: "1" }, { ...evidence, observationId: null }, { ...evidence, clinicalChunkId: id }, { ...evidence, patientId: id }]) {
      expect(s.analysisEvidenceSchema.safeParse(value).success).toBe(false);
    }
    expect(s.analysisRevisionSchema.parse({ expectedVersion: 0, revisionNumber: 1, claims: [claim] }))
      .toEqual({ expectedVersion: 0, revisionNumber: 1, claims: [claim] });
    for (const value of [{ ...claim, evidence: [] }, { ...claim, evidence: Array(21).fill(evidence) }, { ...claim, text: " " }, { ...claim, text: "x".repeat(4001) }, { ...claim, claimType: "diagnosis" }, { ...claim, claimId: id }, { ...claim, actorId: id }, { ...claim, score: 1 }]) {
      expect(s.analysisClaimInputSchema.safeParse(value).success).toBe(false);
    }
    expect(s.analysisModelOutputSchema.safeParse({ claims: [claim] }).success).toBe(true);
    expect(s.analysisModelOutputSchema.safeParse({ claims: [claim], approvedBy: id }).success).toBe(false);
    for (const claims of [[], Array(51).fill(claim)]) {
      expect(s.analysisRevisionSchema.safeParse({ expectedVersion: 0, revisionNumber: 1, claims }).success).toBe(false);
    }
  });

  test("uses exact review/publication bodies, nonapproval comments and integer concurrency", async () => {
    const s = await schemas();
    expect(s.analysisReviewSchema.parse(review)).toEqual(review);
    expect(s.analysisPublishSchema.parse(publication)).toEqual(publication);
    for (const decision of ["reject", "changes_requested"]) {
      expect(s.analysisReviewSchema.safeParse({ ...review, decision }).success).toBe(false);
      expect(s.analysisReviewSchema.safeParse({ ...review, decision, comment: "Perbaiki kutipan." }).success).toBe(true);
    }
    for (const patch of [{ comment: undefined }, { comment: " " }, { comment: "x".repeat(4001) }, { expectedVersion: "1" }, { expectedVersion: -1 }, { revisionNumber: 0 }, { revisionNumber: 1.5 }, { reviewerStaffId: id }, { gateId: id }]) {
      expect(s.analysisReviewSchema.safeParse({ ...review, ...patch }).success).toBe(false);
    }
    for (const patch of [{ reviewId: "latest" }, { publishedBy: id }, { reviewDecision: "approve" }, { expectedVersion: Infinity }]) {
      expect(s.analysisPublishSchema.safeParse({ ...publication, ...patch }).success).toBe(false);
    }
  });

  test("polling distinguishes actual snapshots and typed failures from processing", async () => {
    const s = await schemas();
    expect(s.analysisQueuedResponseSchema.parse(job)).toEqual(job);
    expect(s.analysisJobResponseSchema.parse({ ...job, status: "running", version: 1 })).toEqual({ ...job, status: "running", version: 1 });
    expect(s.analysisJobResponseSchema.safeParse({ ...job, status: "awaiting_review", analysisId: other, version: 2 }).success).toBe(true);
    expect(s.analysisJobResponseSchema.safeParse({ ...job, status: "failed", errorCode: "INSUFFICIENT_EVIDENCE", version: 2 }).success).toBe(true);
    for (const patch of [{ analysisId: id }, { status: "draft" }, { status: "awaiting_review" }, { status: "completed" }, { status: "failed" }, { errorCode: "PROVIDER_TIMEOUT" }, { inputSnapshot: {} }, { score: 1 }]) {
      expect(s.analysisJobResponseSchema.safeParse({ ...job, ...patch }).success).toBe(false);
    }
  });

  test("literal response claims and human decision DTOs contain no hidden input or clinical score", async () => {
    const s = await schemas();
    const reviewDto = { id, analysisId: other, revisionNumber: 1, decision: "approve" as const, comment: null, reviewerStaffId: id, decidedAt: timestamp, version: 2 };
    const publicationDto = { id, analysisId: other, revisionNumber: 1, reviewId: id, publishedBy: id, publishedAt: timestamp };
    expect(s.analysisReviewResponseSchema.parse(reviewDto)).toEqual(reviewDto);
    expect(s.analysisPublicationResponseSchema.parse(publicationDto)).toEqual(publicationDto);
    const response = { id, patientId: id, checkInId: id, status: "draft" as const, revisionNumber: 1, supersedesId: null, version: 0, claims: [{ claimId: id, ...claim }], reviews: [], publication: null, createdAt: timestamp, updatedAt: timestamp };
    expect(s.analysisResponseSchema.parse(response)).toEqual(response);
    for (const patch of [{ inputSnapshot: {} }, { internalNote: "private" }, { riskScore: 0 }, { status: "awaiting_review" }]) {
      expect(s.analysisResponseSchema.safeParse({ ...response, ...patch }).success).toBe(false);
    }
    expect(s.analysisPatientResponseSchema.safeParse(response).success).toBe(false);
    expect(s.analysisPatientResponseSchema.safeParse({ ...response, status: "published", publication: { ...publicationDto, analysisId: id } }).success).toBe(true);
    expect(s.analysisPatientResponseSchema.safeParse({ ...response, status: "published", publication: publicationDto }).success).toBe(false);
    expect(s.analysisReviewResponseSchema.safeParse({ ...reviewDto, decidedAt: "2026-02-30T00:00:00.000Z" }).success).toBe(false);
    expect(s.analysisReviewResponseSchema.safeParse({ ...reviewDto, gateId: id }).success).toBe(false);
  });

  test("validates the server-only exact provenance shape and excludes identifiers and notes", async () => {
    const s = await schemas();
    const observation = { observationId: id, type: "temperature_c" as const, value: 37, unit: "c" as const, observedAt: timestamp };
    const input = {
      locale: "id" as const, medicalRecordVersionId: id,
      medicalRecord: { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null, allergies: [], procedures: [], complaints: null, observations: [] },
      checkIn: { condition: "ok" as const, note: null, medicationAdherence: "regular" as const, observations: [observation] },
      sourceIds: [id], orderIds: [other], corpusId: id, corpusVersion: 1,
    };
    expect(s.analysisInputSnapshotSchema.parse(input)).toEqual(input);
    for (const patch of [{ internalNote: "private" }, { patientName: "Synthetic" }, { corpusVersion: "1" }, { sourceIds: [id, id] }, { orderIds: Array(51).fill(id) }, { medicalRecord: { ...input.medicalRecord, internalNote: null } }, { medicalRecord: { ...input.medicalRecord, admittedAt: timestamp, dischargedAt: "2026-11-13T01:02:03.004Z" } }, { checkIn: { ...input.checkIn, observations: [observation, observation] } }, { checkIn: { ...input.checkIn, observations: [{ ...observation, unit: "pct" }] } }, { checkIn: { ...input.checkIn, observations: [{ ...observation, value: "37" }] } }]) {
      expect(s.analysisInputSnapshotSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
    for (const [schema, body] of [[s.analysisGenerateSchema, generation], [s.analysisReviewSchema, review], [s.analysisPublishSchema, publication]] as const) {
      for (const key of Object.keys(body)) {
        const missing: Record<string, unknown> = { ...body };
        delete missing[key];
        expect(schema.safeParse(missing).success).toBe(false);
      }
    }
  });

  test("list/cursor schemas reject unsafe selectors and preserve millisecond UUID ties", async () => {
    const s = await schemas();
    expect(s.analysisListQuerySchema.parse({ patientId: id, status: "draft", cursor: "opaque" })).toEqual({ patientId: id, status: "draft", cursor: "opaque" });
    expect(s.analysisCursorSchema.safeParse({ createdAt: timestamp, id }).success).toBe(true);
    for (const query of [{ patientId: "bad" }, { status: "queued" }, { patientId: id, staffId: id }, { cursor: "x".repeat(1001) }]) {
      expect(s.analysisListQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(s.analysisListResponseSchema.parse({ items: [], page: { nextCursor: null, hasMore: false } })).toEqual({ items: [], page: { nextCursor: null, hasMore: false } });
  });
});

async function sql(file: string) {
  const url = new URL(`../migrations/${file}`, import.meta.url);
  expect(existsSync(url), `${file} must exist`).toBe(true);
  return Bun.file(url).text();
}

describe("analysis/review migration declarations (not executed SQL invariants)", () => {
  test("preserves original tables, exact references and workflow enums", async () => {
    const a = await sql("0007_analysis.sql");
    const r = await sql("0008_reviews.sql");
    for (const name of ["analyses", "analysis_claims", "analysis_evidence", "analysis_jobs", "analysis_job_attempts"]) expect(a).toContain(`CREATE TABLE public.${name} (`);
    for (const name of ["analysis_reviews", "analysis_publications", "analysis_review_gates"]) expect(r).toContain(`CREATE TABLE public.${name} (`);
    expect(a).toContain("'draft', 'in_review', 'approved', 'rejected', 'published'");
    expect(a).toContain("'queued', 'running', 'awaiting_review', 'failed', 'completed'");
    expect(a).toContain("REFERENCES public.check_in_observations (id, check_in_id) ON DELETE RESTRICT");
    expect(a).toContain("REFERENCES public.clinical_source_documents (id, revision_number, patient_id) ON DELETE RESTRICT");
    expect(a).toContain("REFERENCES public.knowledge_chunks (id) ON DELETE RESTRICT");
    expect(a).toContain("UNIQUE (id, check_in_id, patient_id)");
    expect(r).toContain("REFERENCES public.analysis_reviews (id, analysis_id, analysis_revision_number, decision) ON DELETE RESTRICT");
    expect(r).toContain("review_decision = 'approve'");
    expect(a + r).not.toMatch(/\btimestamptz(?!\(3\))/);
    expect(a + r).not.toMatch(/(?:CREATE EXTENSION|CREATE SCHEMA|INSERT INTO public\.knowledge|\bscore\s+(?:numeric|integer))/i);
  });

  test("declares transaction sealing, deferred total evidence, current provenance and serialized lineage", async () => {
    const a = await sql("0007_analysis.sql");
    for (const fragment of ["construction_xid", "pg_current_xact_id()", "finalized_at", "DEFERRABLE INITIALLY DEFERRED", "every analysis claim requires evidence", "retrieved chunks must exactly equal knowledge evidence", "analysis revision must supersede the latest same-bound head", "transaction_isolation", "read committed", "LOCK TABLE public.medical_record_versions", "FOR UPDATE", "FOR SHARE", "sourceIds", "orderIds", "internalNote", "status = 'submitted'", "REVOKE ALL ON TABLE"]) expect(a).toContain(fragment);
    for (const name of ["analyses", "analysis_claims", "analysis_evidence", "analysis_job_attempts"]) expect(a).toContain(`BEFORE TRUNCATE ON public.${name}`);
    for (const name of ["analysis_claims", "analysis_evidence", "analysis_job_attempts"]) expect(a).toContain(`BEFORE UPDATE OR DELETE ON public.${name}`);
    expect(a).toContain("BEFORE INSERT ON public.analysis_claims");
    expect(a).toContain("BEFORE INSERT ON public.analysis_evidence");
  });

  test("declares append-only exact-version review/gate/publication workflow", async () => {
    const r = await sql("0008_reviews.sql");
    for (const fragment of ["expected_version", "gate_id", "checkpoint_id", "'waiting', 'decided', 'reconciled'", "UNIQUE (analysis_id, analysis_revision_number, reviewer_staff_id)", "UNIQUE (id, analysis_id, analysis_revision_number, decision)", "UNIQUE (analysis_id, analysis_revision_number)", "DEFERRABLE INITIALLY DEFERRED", "changes_requested", "review gate must be reconciled before publication", "REVOKE ALL ON TABLE"]) expect(r).toContain(fragment);
    for (const name of ["analysis_reviews", "analysis_publications"]) {
      expect(r).toContain(`BEFORE UPDATE OR DELETE ON public.${name}`);
      expect(r).toContain(`BEFORE TRUNCATE ON public.${name}`);
    }
  });
});
