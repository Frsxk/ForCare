/**
 * Live end-to-end smoke for the Stop-3 analysis pipeline.
 *
 * Requires an explicit disposable `_test` database (FORCARE_TEST_DATABASE_URL)
 * and a project Gemini key (GOOGLE_API_KEY). It provisions synthetic data only,
 * runs ONE real model generation through the durable worker, approves and
 * publishes as a synthetic nurse, then reads the patient projection.
 *
 * Prints a JSON evidence object. Never prints the key, database URL or model text.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createGeminiDraftModel } from "../src/ai/gemini-model";
import { createAnalysisService } from "../src/analysis/service";
import { createAnalysisWorker } from "../src/analysis/worker";
import { createOperatorAssignmentService } from "../src/patients/operator-service";
import { importFixedKnowledgeCorpus } from "../src/knowledge/corpus-import";
import { csrfHashFromToken, deriveCsrfToken } from "../src/auth/crypto";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { readTestDatabaseTarget } from "../test/fixtures/test-database-target";
import { createDisposableDatabase, testAuthConfig } from "../test/fixtures/disposable-database";

const apiKey = process.env.GOOGLE_API_KEY?.trim();
if (!apiKey) throw new Error("GOOGLE_API_KEY is required");
readTestDatabaseTarget(process.env); // fails closed without an explicit disposable target
const config = testAuthConfig();
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };

function authFor(accountId: string, staffId: string | null, patientId: string | null, role: "nurse" | "patient") {
  const token = deriveCsrfToken("a".repeat(64));
  return {
    sessionId: randomUUID(), accountId, staffId, patientId, role, email: `${role}@example.invalid`,
    staffCode: staffId ? "SYNTH-NURSE" : null, displayName: `Synthetic ${role}`, displayTimeZone: "UTC",
    csrfToken: token, csrfHashHex: csrfHashFromToken(token), expiresAt: "2099-01-01T00:00:00Z",
  };
}
const meta = () => ({ requestId: randomUUID(), key: randomUUID() });

const db = await createDisposableDatabase("analysis_live");
const poolUrl = new URL(db.url);
const pool = new Pool({
  host: poolUrl.hostname, port: Number(poolUrl.port), database: poolUrl.pathname.slice(1),
  user: decodeURIComponent(poolUrl.username), password: decodeURIComponent(poolUrl.password), max: 2,
});
const saver = new PostgresSaver(pool);

try {
  await saver.setup();
  const nurse = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
    email: "live@nurse.invalid", passwordHash: "synthetic-unused", staffCode: "SYNTH-LIVE-NURSE",
    displayName: "Synthetic live nurse", approvalReference: "synthetic-test-only",
    operator: "synthetic-test", nurseDomain: "nurse.invalid",
  }));
  const account = await db.sql`INSERT INTO accounts (email_normalized, password_hash, status)
    VALUES ('live-patient@example.invalid', 'synthetic-unused', 'active') RETURNING id`;
  await db.sql`INSERT INTO account_roles (account_id, role) VALUES (${account[0]!.id}, 'patient')`;
  const patientRow = await db.sql`INSERT INTO patients (account_id, full_name, birth_date, gender, phone)
    VALUES (${account[0]!.id}, 'Synthetic Live Patient', '1955-04-02', 'undisclosed', '+620****0002') RETURNING id`;
  const patientId = patientRow[0]!.id as string;
  await createOperatorAssignmentService({ sql: db.sql, config: { nurseEmailDomain: "nurse.invalid" } })
    .assignPrimaryNurse({ patientId, nurseId: nurse.staffId, expectedVersion: 0, operator: "synthetic-test", approvalReference: "synthetic-primary-only" });

  const corpus = await importFixedKnowledgeCorpus({ sql: db.sql, config, approveBy: nurse.staffId });
  evidence.corpusVersion = corpus.corpusVersion ?? null;
  const chunk = await db.sql`SELECT k.id FROM knowledge_chunks k JOIN knowledge_documents d ON d.id = k.document_id
    WHERE d.corpus_id = ${corpus.corpusId} ORDER BY k.ordinal LIMIT 1`;
  const knowledgeChunkId = chunk[0]!.id as string;

  const medical = await db.sql`INSERT INTO medical_record_versions (patient_id, revision_number, entered_by, source_reference, payload)
    VALUES (${patientId}, 1, ${nurse.staffId}, 'synthetic-live', (${JSON.stringify({
      primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null,
      allergies: [], procedures: [], complaints: null, observations: [], internalNote: "must never reach the model",
    })}::text)::jsonb) RETURNING id`;
  const source = await db.sql`INSERT INTO clinical_source_documents (lineage_id, revision_number, patient_id,
    medical_record_version_id, kind, title, body, checksum, created_by)
    VALUES (${randomUUID()}, 1, ${patientId}, ${medical[0]!.id}, 'danger_sign', 'Synthetic source',
      'Synthetic clinical source used for evidence binding only', ${"a".repeat(64)}, ${nurse.staffId}) RETURNING id`;
  const sourceId = source[0]!.id as string;
  await db.sql`INSERT INTO clinical_source_chunks (document_id, ordinal, content) VALUES (${sourceId}, 0, 'synthetic source')`;
  await db.sql`UPDATE clinical_source_documents SET status = 'approved', approved_by = ${nurse.staffId}, approved_at = now(), version = 1 WHERE id = ${sourceId}`;
  const order = await db.sql`INSERT INTO care_orders (lineage_id, revision_number, patient_id, medical_record_version_id,
    kind, source_document_id, source_version, payload, effective_from, entered_by)
    VALUES (${randomUUID()}, 1, ${patientId}, ${medical[0]!.id}, 'care', ${sourceId}, 1,
      '{"instructions":"Synthetic existing instruction"}'::jsonb, now() - interval '1 hour', ${nurse.staffId}) RETURNING id`;
  const orderId = order[0]!.id as string;
  await db.sql`UPDATE care_orders SET status = 'active', published_by = ${nurse.staffId}, published_at = now(), version = 1 WHERE id = ${orderId}`;

  const checkin = await db.sql.begin(async (tx) => {
    const inserted = await tx`INSERT INTO check_ins (patient_id, local_date, time_zone, condition, note, medication_adherence)
      VALUES (${patientId}, CURRENT_DATE, 'UTC', 'complaint', 'Demam sejak kemarin, makan berkurang.', 'missed_once') RETURNING id`;
    const id = inserted[0]!.id as string;
    await tx`INSERT INTO medication_adherence (check_in_id, status) VALUES (${id}, 'missed_once')`;
    await tx`INSERT INTO check_in_observations (check_in_id, patient_id, type, value, unit, observed_at)
      VALUES (${id}, ${patientId}, 'temperature_c', 37.9, 'c', now())`;
    await tx`UPDATE check_ins SET status = 'submitted', submitted_at = now(), version = 1 WHERE id = ${id}`;
    return id;
  });

  const nurseAuth = authFor(nurse.accountId, nurse.staffId, null, "nurse");
  const patientAuth = authFor(account[0]!.id as string, null, patientId, "patient");
  for (const [index, context] of [nurseAuth, patientAuth].entries()) {
    await db.sql`INSERT INTO sessions (id, account_id, token_hash, csrf_hash, expires_at)
      VALUES (${context.sessionId}, ${context.accountId}, ${Buffer.alloc(32, index + 1)}, ${Buffer.alloc(32, 3)}, '2099-01-01T00:00:00Z')`;
  }

  const model = createGeminiDraftModel({ apiKey, timeoutMs: 60000 });
  const worker = createAnalysisWorker({
    sql: db.sql, checkpointer: saver, setupCheckpointer: async () => { await saver.setup(); }, model, config,
    owner: `live-smoke-${process.pid}`, leaseMs: 120000,
  });

  const service = createAnalysisService({ sql: db.sql, config });
  const queued = await service.generate(nurseAuth, checkin, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
  evidence.jobStatus = queued.statusCode;
  const jobId = (queued.data as { id: string }).id;
  evidence.workerOutcome = await worker.runNext();
  const job = await service.getJob(nurseAuth, jobId) as { status: string; analysisId: string | null; errorCode: string | null };
  evidence.job = { status: job.status, hasAnalysis: Boolean(job.analysisId), errorCode: job.errorCode };
  if (job.status !== "awaiting_review" || !job.analysisId) {
    const dbg = await db.sql`SELECT id, status, attempt_count, max_attempts, error_code, lease_owner, lease_expires_at FROM analysis_jobs`;
    const att = await db.sql`SELECT attempt_number, outcome, error_code FROM analysis_job_attempts ORDER BY attempt_number`;
    console.error("DIAGNOSTIC outcome=", JSON.stringify(evidence.workerOutcome), "jobs=", JSON.stringify(dbg), "attempts=", JSON.stringify(att), "jobId=", jobId);
    throw new Error(`job did not reach review: ${job.status}/${job.errorCode}`);
  }

  const analysis = await service.get(nurseAuth, job.analysisId) as {
    status: string; revisionNumber: number; version: number; claims: Array<{ text: string; claimType: string; evidence: unknown[] }>;
  };
  evidence.draft = {
    status: analysis.status, revisionNumber: analysis.revisionNumber, claimCount: analysis.claims.length,
    claimsWithEvidence: analysis.claims.filter((claim) => claim.evidence.length > 0).length,
    claimTypes: [...new Set(analysis.claims.map((claim) => claim.claimType))],
    leakedInternalNote: JSON.stringify(analysis).includes("must never reach the model"),
    hasNumericScore: /"(score|riskScore|observedScore)"\s*:/.test(JSON.stringify(analysis)),
  };

  const review = await service.review(nurseAuth, job.analysisId,
    { decision: "approve", comment: null, expectedVersion: analysis.version, revisionNumber: analysis.revisionNumber }, meta());
  evidence.reviewStatus = review.statusCode;
  const reconciled = await worker.reconcileAnalysis(job.analysisId);
  evidence.reconciled = reconciled;
  const approved = await service.get(nurseAuth, job.analysisId) as { status: string; version: number };
  evidence.afterReview = approved.status;

  const published = await service.publish(nurseAuth, job.analysisId,
    { expectedVersion: approved.version, revisionNumber: analysis.revisionNumber, reviewId: (review.data as { id: string }).id }, meta());
  evidence.publishStatus = published.statusCode;
  const patientView = await service.get(patientAuth, job.analysisId) as { status: string; claims: Array<{ text: string }> };
  evidence.patientProjection = {
    status: patientView.status, claimCount: patientView.claims.length,
    leaksSnapshot: JSON.stringify(patientView).includes("inputSnapshot"),
    leaksInternalNote: JSON.stringify(patientView).includes("must never reach the model"),
  };

  const persisted = await db.sql`SELECT model_id, model_provider FROM analyses WHERE id = ${job.analysisId}`;
  evidence.model = { id: persisted[0]?.model_id ?? null, provider: persisted[0]?.model_provider ?? null };
  evidence.ok = evidence.workerOutcome === "interrupted"
    && (evidence.draft as { claimsWithEvidence: number }).claimsWithEvidence > 0
    && evidence.afterReview === "approved"
    && (evidence.patientProjection as { status: string }).status === "published"
    && !(evidence.draft as { hasNumericScore: boolean }).hasNumericScore;
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) throw new Error("Analysis live smoke did not satisfy publication assertions");
} finally {
  await saver.end().catch(() => {});
  await pool.end().catch(() => {});
  await db.close().catch(() => {});
}
