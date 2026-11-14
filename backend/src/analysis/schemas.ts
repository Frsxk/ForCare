import { z } from "zod";
import { isoUtcSchema, medicalObservationSchema } from "../clinical/schemas";

const uuid = z.string().uuid();
const counter = z.number().int().min(0).max(2_147_483_647);
const revision = counter.min(1);
const text = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0, "must not be blank");
const uniqueIds = (max: number) => z.array(uuid).max(max).refine((ids) => new Set(ids).size === ids.length, "duplicate reference");

export const analysisLocaleSchema = z.enum(["id", "en"]);
export const analysisStatusSchema = z.enum(["draft", "in_review", "approved", "rejected", "published"]);
export const analysisJobStatusSchema = z.enum(["queued", "running", "awaiting_review", "failed", "completed"]);
export const analysisClaimTypeSchema = z.enum(["observation_summary", "concern", "suggestion", "care_note"]);
export const analysisReviewDecisionSchema = z.enum(["approve", "reject", "changes_requested"]);
export const analysisJobErrorCodeSchema = z.enum([
  "INSUFFICIENT_EVIDENCE", "INVALID_MODEL_OUTPUT", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED",
  "PROVIDER_AUTH_FAILED", "PROVIDER_SAFETY_BLOCKED", "PROVIDER_UNAVAILABLE", "STALE_CONTEXT",
  "SCOPE_REVOKED", "ATTEMPTS_EXHAUSTED", "INTERNAL_ERROR",
]);

export const analysisGenerateSchema = z.object({
  promptVersion: z.literal("forcare-condition-v1"),
  locale: analysisLocaleSchema,
}).strict();

// Original public evidence shape. clinical_chunk_id is internal only.
export const analysisEvidenceSchema = z.object({
  checkInId: uuid,
  observationId: uuid.optional(),
  orderId: uuid.optional(),
  sourceDocumentId: uuid.optional(),
  sourceVersion: revision.optional(),
  knowledgeChunkId: uuid.optional(),
}).strict().refine(
  (value) => (value.sourceDocumentId === undefined) === (value.sourceVersion === undefined),
  "sourceDocumentId and sourceVersion must be supplied together",
);

export const analysisClaimInputSchema = z.object({
  text: text(4000),
  claimType: analysisClaimTypeSchema,
  evidence: z.array(analysisEvidenceSchema).min(1).max(20),
}).strict();
export const analysisClaimSchema = analysisClaimInputSchema.extend({ claimId: uuid }).strict();
export const analysisModelOutputSchema = z.object({ claims: z.array(analysisClaimInputSchema).min(1).max(50) }).strict();
export const analysisRevisionSchema = z.object({
  expectedVersion: counter,
  revisionNumber: revision,
  claims: z.array(analysisClaimInputSchema).min(1).max(50),
}).strict();

const reviewComment = text(4000).nullable();
export const analysisReviewSchema = z.object({
  decision: analysisReviewDecisionSchema,
  comment: reviewComment,
  expectedVersion: counter,
  revisionNumber: revision,
}).strict().refine((value) => value.decision === "approve" || value.comment !== null, "nonapproval requires a comment");
export const analysisPublishSchema = z.object({ expectedVersion: counter, revisionNumber: revision, reviewId: uuid }).strict();

export const analysisReviewResponseSchema = z.object({
  id: uuid,
  analysisId: uuid,
  revisionNumber: revision,
  decision: analysisReviewDecisionSchema,
  comment: reviewComment,
  reviewerStaffId: uuid,
  decidedAt: isoUtcSchema,
  version: counter,
}).strict().refine((value) => value.decision === "approve" || value.comment !== null, "nonapproval requires a comment");
export const analysisPublicationResponseSchema = z.object({
  id: uuid,
  analysisId: uuid,
  revisionNumber: revision,
  reviewId: uuid,
  publishedBy: uuid,
  publishedAt: isoUtcSchema,
}).strict();

const jobFields = {
  id: uuid, patientId: uuid, checkInId: uuid, status: analysisJobStatusSchema,
  analysisId: uuid.nullable(), errorCode: analysisJobErrorCodeSchema.nullable(), version: counter,
};
export const analysisQueuedResponseSchema = z.object({
  ...jobFields, status: z.literal("queued"), analysisId: z.null(), errorCode: z.null(), version: z.literal(0),
}).strict();
export const analysisJobResponseSchema = z.object(jobFields).strict().superRefine((value, context) => {
  const saved = value.status === "awaiting_review" || value.status === "completed";
  if (saved !== (value.analysisId !== null)) context.addIssue({ code: "custom", path: ["analysisId"], message: "only saved results have an analysisId" });
  if ((value.status === "failed") !== (value.errorCode !== null)) context.addIssue({ code: "custom", path: ["errorCode"], message: "only failed jobs have an errorCode" });
});

const summaryFields = {
  id: uuid, patientId: uuid, checkInId: uuid, status: analysisStatusSchema,
  revisionNumber: revision, supersedesId: uuid.nullable(), version: counter,
  createdAt: isoUtcSchema, updatedAt: isoUtcSchema,
};
export const analysisSummarySchema = z.object(summaryFields).strict();
export const analysisResponseSchema = z.object({
  ...summaryFields,
  claims: z.array(analysisClaimSchema).min(1).max(50),
  reviews: z.array(analysisReviewResponseSchema).max(50),
  publication: analysisPublicationResponseSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "published") !== (value.publication !== null)) context.addIssue({ code: "custom", path: ["publication"], message: "publication is required only for published output" });
  if (value.publication && (value.publication.analysisId !== value.id || value.publication.revisionNumber !== value.revisionNumber)) context.addIssue({ code: "custom", path: ["publication"], message: "publication must bind this exact revision" });
  if (value.reviews.some((item) => item.analysisId !== value.id || item.revisionNumber !== value.revisionNumber)) context.addIssue({ code: "custom", path: ["reviews"], message: "reviews must bind this exact revision" });
  if (value.claims.some((item) => item.evidence.some((item) => item.checkInId !== value.checkInId))) context.addIssue({ code: "custom", path: ["claims"], message: "evidence must bind this check-in" });
  if (new Set(value.claims.map((item) => item.claimId)).size !== value.claims.length) context.addIssue({ code: "custom", path: ["claims"], message: "claim IDs must be unique" });
});
// Projection must be populated only from approved patient-facing claims. Do not
// serialize nurse review comments, raw input, prompt, model metadata or evidence text.
export const analysisPatientResponseSchema = analysisResponseSchema.refine(
  (value) => value.status === "published" && value.publication !== null && value.reviews.length === 0,
  "patient projection requires published claims and no private review comments",
);
export const analysisListQuerySchema = z.object({
  patientId: uuid.optional(), status: analysisStatusSchema.optional(), cursor: text(1000).optional(),
}).strict();
export const analysisCursorSchema = z.object({ createdAt: isoUtcSchema, id: uuid }).strict();
export const analysisListResponseSchema = z.object({
  items: z.array(analysisSummarySchema).max(100),
  page: z.object({ nextCursor: text(1000).nullable(), hasMore: z.boolean() }).strict()
    .refine((value) => value.hasMore === (value.nextCursor !== null), "cursor required exactly when more results exist"),
}).strict();

// Server-only validated provenance, never a client request or patient response.
export const analysisMedicalInputSchema = z.object({
  primaryDiagnosis: text(500).nullable(), secondaryDiagnoses: z.array(text(300)).max(50),
  admittedAt: isoUtcSchema.nullable(), dischargedAt: isoUtcSchema.nullable(),
  allergies: z.array(text(200)).max(50), procedures: z.array(text(300)).max(50),
  complaints: text(2000).nullable(), observations: z.array(medicalObservationSchema).max(200),
}).strict().refine(
  (value) => value.admittedAt === null || value.dischargedAt === null || Date.parse(value.dischargedAt) >= Date.parse(value.admittedAt),
  "dischargedAt must not precede admittedAt",
);
const analysisObservationSchema = z.object({
  observationId: uuid,
  type: z.enum(["temperature_c", "heart_rate_bpm", "bp_systolic_mmhg", "bp_diastolic_mmhg", "weight_kg", "spo2_pct"]),
  value: z.number().finite().positive().max(99999.999),
  unit: z.enum(["c", "bpm", "mmhg", "kg", "pct"]),
  observedAt: isoUtcSchema,
}).strict().refine((value) => value.unit === ({ temperature_c: "c", heart_rate_bpm: "bpm", bp_systolic_mmhg: "mmhg", bp_diastolic_mmhg: "mmhg", weight_kg: "kg", spo2_pct: "pct" } as const)[value.type], "unit must match observation type");
export const analysisInputSnapshotSchema = z.object({
  locale: analysisLocaleSchema,
  medicalRecordVersionId: uuid,
  medicalRecord: analysisMedicalInputSchema,
  checkIn: z.object({
    condition: z.enum(["ok", "complaint"]), note: text(4000).nullable(),
    medicationAdherence: z.enum(["regular", "missed_once", "none"]),
    observations: z.array(analysisObservationSchema).max(6).refine(
      (values) => new Set(values.map((value) => value.observationId)).size === values.length
        && new Set(values.map((value) => value.type)).size === values.length,
      "observation IDs and types must be unique",
    ),
  }).strict(),
  sourceIds: uniqueIds(50), orderIds: uniqueIds(50), corpusId: uuid, corpusVersion: revision,
}).strict();

export type AnalysisGenerate = z.infer<typeof analysisGenerateSchema>;
export type AnalysisRevision = z.infer<typeof analysisRevisionSchema>;
export type AnalysisReview = z.infer<typeof analysisReviewSchema>;
export type AnalysisPublish = z.infer<typeof analysisPublishSchema>;
export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;
export type AnalysisClaimInput = z.infer<typeof analysisClaimInputSchema>;
export type AnalysisClaim = z.infer<typeof analysisClaimSchema>;
export type AnalysisModelOutput = z.infer<typeof analysisModelOutputSchema>;
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
export type AnalysisPatientResponse = z.infer<typeof analysisPatientResponseSchema>;
export type AnalysisReviewResponse = z.infer<typeof analysisReviewResponseSchema>;
export type AnalysisPublicationResponse = z.infer<typeof analysisPublicationResponseSchema>;
export type AnalysisJobResponse = z.infer<typeof analysisJobResponseSchema>;
export type AnalysisQueuedResponse = z.infer<typeof analysisQueuedResponseSchema>;
export type AnalysisInputSnapshot = z.infer<typeof analysisInputSnapshotSchema>;
export type AnalysisListQuery = z.infer<typeof analysisListQuerySchema>;
export type AnalysisListResponse = z.infer<typeof analysisListResponseSchema>;
export type AnalysisCursor = z.infer<typeof analysisCursorSchema>;
