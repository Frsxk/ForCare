import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { hashPassword } from "../src/auth/password";
import { deriveCsrfToken, csrfHashFromToken, SESSION_COOKIE_NAME } from "../src/auth/crypto";
import { createOperatorAssignmentService } from "../src/patients/operator-service";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { importFixedKnowledgeCorpus } from "../src/knowledge/corpus-import";
import { createAnalysisService } from "../src/analysis/service";
import { createAnalysisWorker } from "../src/analysis/worker";
import { createAnalysisScheduler } from "../src/analysis/scheduler";

import { acquireJob, failJob, heartbeatJob, saveJobResult } from "../src/analysis/repository";
import { createApp } from "../src/app";
import { createAuthService } from "../src/auth/service";
import { createRateLimiters } from "../src/http/rate-limit";
import { createDisposableDatabase, testAuthConfig, type DisposableDatabase } from "./fixtures/disposable-database";

const integration = process.env.FORCARE_TEST_DATABASE_URL ? describe : describe.skip;
const config = testAuthConfig();
let db: DisposableDatabase;
let saver: PostgresSaver;
let pool: Pool;
let nurse: { accountId: string; staffId: string };
let patient: { id: string; accountId: string };
let checkInId: string;
let knowledgeChunkId: string;
let sourceId: string;
let orderId: string;
let observationId: string;
let nurseAuth: any;
let patientAuth: any;
let worker: ReturnType<typeof createAnalysisWorker>;
let modelCalls = 0;
let capturedContext: any;

function authFor(accountId: string, staffId: string | null, patientId: string | null, role: "nurse" | "patient") {
  const token = deriveCsrfToken("a".repeat(64));
  return { sessionId: randomUUID(), accountId, staffId, patientId, role, email: `${role}@example.invalid`,
    staffCode: staffId ? "SYNTH-NURSE" : null, displayName: `Synthetic ${role}`, displayTimeZone: "UTC",
    csrfToken: token, csrfHashHex: csrfHashFromToken(token), expiresAt: "2099-01-01T00:00:00Z" };
}
const meta = () => ({ requestId: randomUUID(), key: randomUUID() });

async function insertSubmittedCheckin(note: string) {
  return db.sql.begin(async (tx) => {
    const inserted = await tx`INSERT INTO check_ins (patient_id, local_date, time_zone, condition, note,
      medication_adherence) VALUES (${patient.id}, CURRENT_DATE, 'UTC', 'complaint', ${note}, 'regular') RETURNING id`;
    const id = inserted[0]!.id as string;
    await tx`INSERT INTO medication_adherence (check_in_id, status) VALUES (${id}, 'regular')`;
    const observation = await tx`INSERT INTO check_in_observations (check_in_id, patient_id, type, value, unit, observed_at)
      VALUES (${id}, ${patient.id}, 'temperature_c', 36.8, 'c', now()) RETURNING id`;
    await tx`UPDATE check_ins SET status = 'submitted', submitted_at = now(), version = 1 WHERE id = ${id}`;
    return { id, observationId: observation[0]!.id as string };
  });
}

integration("Stop-3 durable analysis and review (real PostgreSQL)", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("analysis_pipeline");
    nurse = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
      email: "analysis@nurse.invalid", passwordHash: "synthetic-unused", staffCode: "SYNTH-NURSE",
      displayName: "Synthetic analysis nurse", approvalReference: "synthetic-test-only",
      operator: "synthetic-test", nurseDomain: "nurse.invalid",
    }));
    const accounts = await db.sql`INSERT INTO accounts (email_normalized, password_hash, status) VALUES
      ('analysis-patient@example.invalid', ${await hashPassword("synthetic-password")}, 'active') RETURNING id`;
    await db.sql`INSERT INTO account_roles (account_id, role) VALUES (${accounts[0]!.id}, 'patient')`;
    const patients = await db.sql`INSERT INTO patients (account_id, full_name, birth_date, gender, phone)
      VALUES (${accounts[0]!.id}, 'Synthetic Patient', '1990-01-01', 'undisclosed', '+620000000001') RETURNING id`;
    patient = { id: patients[0]!.id, accountId: accounts[0]!.id };
    const assignment = createOperatorAssignmentService({ sql: db.sql, config: { nurseEmailDomain: "nurse.invalid" } });
    await assignment.assignPrimaryNurse({ patientId: patient.id, nurseId: nurse.staffId, expectedVersion: 0,
      operator: "synthetic-test", approvalReference: "synthetic-primary-only" });
    const imported = await importFixedKnowledgeCorpus({ sql: db.sql, config, approveBy: nurse.staffId });
    const knowledge = await db.sql`SELECT k.id FROM knowledge_chunks k JOIN knowledge_documents d ON d.id = k.document_id
      WHERE d.corpus_id = ${imported.corpusId} ORDER BY k.ordinal LIMIT 1`;
    knowledgeChunkId = knowledge[0]!.id;
    const medical = await db.sql`INSERT INTO medical_record_versions (patient_id, revision_number, entered_by, source_reference, payload)
      VALUES (${patient.id}, 1, ${nurse.staffId}, 'synthetic-test', (${JSON.stringify({
        primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null,
        allergies: [], procedures: [], complaints: null, observations: [], internalNote: "must never reach model or patient",
      })}::text)::jsonb) RETURNING id`;
    const source = await db.sql`INSERT INTO clinical_source_documents (lineage_id, revision_number, patient_id,
      medical_record_version_id, kind, title, body, checksum, created_by)
      VALUES (${randomUUID()}, 1, ${patient.id}, ${medical[0]!.id}, 'danger_sign', 'Synthetic source',
        'Synthetic clinical source for evidence binding only', ${"a".repeat(64)}, ${nurse.staffId}) RETURNING id`;
    sourceId = source[0]!.id;
    await db.sql`INSERT INTO clinical_source_chunks (document_id, ordinal, content) VALUES (${sourceId}, 0, 'synthetic source')`;
    await db.sql`UPDATE clinical_source_documents SET status = 'approved', approved_by = ${nurse.staffId}, approved_at = now(), version = 1 WHERE id = ${sourceId}`;
    const order = await db.sql`INSERT INTO care_orders (lineage_id, revision_number, patient_id, medical_record_version_id,
      kind, source_document_id, source_version, payload, effective_from, entered_by)
      VALUES (${randomUUID()}, 1, ${patient.id}, ${medical[0]!.id}, 'care', ${sourceId}, 1,
        '{"instructions":"Synthetic existing instruction"}'::jsonb, now() - interval '1 hour', ${nurse.staffId}) RETURNING id`;
    orderId = order[0]!.id;
    await db.sql`UPDATE care_orders SET status = 'active', published_by = ${nurse.staffId}, published_at = now(), version = 1 WHERE id = ${orderId}`;
    const checkin = await db.sql.begin(async (tx) => {
      const inserted = await tx`INSERT INTO check_ins (patient_id, local_date, time_zone, condition, note,
        medication_adherence) VALUES (${patient.id}, CURRENT_DATE, 'UTC', 'complaint',
        'Synthetic check-in note', 'regular') RETURNING id`;
      const id = inserted[0]!.id as string;
      await tx`INSERT INTO medication_adherence (check_in_id, status) VALUES (${id}, 'regular')`;
      const observation = await tx`INSERT INTO check_in_observations (check_in_id, patient_id, type, value, unit, observed_at)
        VALUES (${id}, ${patient.id}, 'temperature_c', 36.8, 'c', now()) RETURNING id`;
      await tx`UPDATE check_ins SET status = 'submitted', submitted_at = now(), version = 1 WHERE id = ${id}`;
      return { id, observationId: observation[0]!.id as string };
    });
    checkInId = checkin.id;
    observationId = checkin.observationId;
    nurseAuth = authFor(nurse.accountId, nurse.staffId, null, "nurse");
    patientAuth = authFor(patient.accountId, null, patient.id, "patient");
    for (const context of [nurseAuth, patientAuth]) {
      await db.sql`INSERT INTO sessions (id, account_id, token_hash, csrf_hash, expires_at)
        VALUES (${context.sessionId}, ${context.accountId}, ${Buffer.alloc(32, context.role === "nurse" ? 1 : 2)},
          ${Buffer.alloc(32, 3)}, '2099-01-01T00:00:00Z')`;
    }
    const url = new URL(db.url);
    pool = new Pool({ host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), max: 2 });
    saver = new PostgresSaver(pool);
    await saver.setup();
    const model = { invoke: async (messages: [string, string][]) => {
      modelCalls++;
      const context = JSON.parse(messages[1]![1]);
      capturedContext = context;
      return { provider: "google-ai-studio" as const, modelId: "synthetic-model", usedFallback: false,
        content: JSON.stringify({ claims: [{ text: "Keluhan dilaporkan pada check-in.", claimType: "observation_summary",
          evidence: [{ checkInId: context.checkInId, observationId: context.checkIn.observations[0].observationId,
            sourceDocumentId: sourceId, sourceVersion: 1, orderId, knowledgeChunkId }] }] }) };
    } };
    worker = createAnalysisWorker({ sql: db.sql, checkpointer: saver, setupCheckpointer: async () => { await saver.setup(); }, model, config });
  }, 90_000);

  afterAll(async () => {
    await saver?.end().catch(() => {});
    await pool?.end().catch(() => {});
    await db?.close();
  }, 30_000);

  test("durable queue, exact snapshot, real interrupt and checkpoint binding", async () => {
    const service = createAnalysisService({ sql: db.sql, config });
    const queued = await service.generate(nurseAuth, checkInId, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    expect(queued.statusCode).toBe(202);
    const jobId = (queued.data as any).id as string;
    const replay = await service.generate(nurseAuth, checkInId, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    expect((replay.data as any).id).not.toBe(jobId); // A different key is a new explicit request.
    const jobs = await db.sql`SELECT input_snapshot, input_snapshot->'medicalRecord' AS medical FROM analysis_jobs WHERE id = ${jobId}`;
    expect(jobs[0]!.medical.internalNote).toBeUndefined();
    await expect(service.getJob(patientAuth, jobId)).rejects.toMatchObject({ status: 403 });
    expect(await worker.runNext()).toBe("interrupted");
    expect(capturedContext.clinicalSources).toHaveLength(1); expect(capturedContext.careOrders).toHaveLength(1);
    expect(JSON.stringify(capturedContext)).not.toContain("internalNote");
    const running = await service.getJob(nurseAuth, jobId);
    expect((running as any).status).toBe("awaiting_review");
    const analysisId = (running as any).analysisId as string;
    const gate = (await db.sql`SELECT * FROM analysis_review_gates WHERE analysis_id = ${analysisId}`)[0]!;
    expect(gate.thread_id).toBe(jobId);
    expect(gate.checkpoint_id).toBeTruthy();
    const checkpoints = await db.sql`SELECT count(*)::int AS count FROM checkpoints WHERE thread_id = ${jobId}`;
    expect(checkpoints[0]!.count).toBeGreaterThan(0);
    const draft = await service.get(nurseAuth, analysisId) as any;
    expect(draft.status).toBe("in_review"); expect(draft.version).toBe(1);
    expect(JSON.stringify(draft)).not.toContain("internalNote");
    await expect(service.get(patientAuth, analysisId)).rejects.toMatchObject({ status: 404 });
    const secondJob = await acquireJob(db.sql, "another-worker");
    expect(secondJob?.id).not.toBe(jobId);
    if (secondJob) await failJob(db.sql, secondJob, "INSUFFICIENT_EVIDENCE");
  }, 60_000);

  test("resume persists no approval or publication, then patient projection is safe", async () => {
    const service = createAnalysisService({ sql: db.sql, config });
    const saved = (await db.sql`SELECT a.*, g.id AS gate_id FROM analyses a JOIN analysis_review_gates g ON g.analysis_id = a.id ORDER BY a.created_at LIMIT 1`)[0]!;
    const analysisId = saved.id as string;
    await expect(service.review(nurseAuth, analysisId, { decision: "approve", comment: null, expectedVersion: 0, revisionNumber: 1 }, meta()))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const reviewed = await service.review(nurseAuth, analysisId, { decision: "approve", comment: null, expectedVersion: 1, revisionNumber: 1 }, meta());
    expect(reviewed.statusCode).toBe(201); expect((reviewed.data as any).version).toBe(2);
    await expect(service.review(nurseAuth, analysisId, { decision: "reject", comment: "Duplicate", expectedVersion: 2, revisionNumber: 1 }, meta()))
      .rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    // A second worker construction simulates a restart at the persisted interrupt.
    const restarted = createAnalysisWorker({ sql: db.sql, checkpointer: saver, setupCheckpointer: async () => {},
      model: { invoke: async () => { throw new Error("must not regenerate"); } }, config });
    expect(await restarted.reconcileAnalysis(analysisId)).toBe(true);
    const afterReview = await service.get(nurseAuth, analysisId) as any;
    expect(afterReview.status).toBe("approved"); expect(afterReview.publication).toBeNull();
    await expect(service.publish(patientAuth, analysisId, { expectedVersion: 2, revisionNumber: 1, reviewId: (reviewed.data as any).id }, meta()))
      .rejects.toThrow();
    const published = await service.publish(nurseAuth, analysisId, { expectedVersion: 2, revisionNumber: 1, reviewId: (reviewed.data as any).id }, meta());
    expect(published.statusCode).toBe(200);
    const patientView = await service.get(patientAuth, analysisId) as any;
    expect(patientView.status).toBe("published"); expect(patientView.reviews).toEqual([]);
    expect(JSON.stringify(patientView)).not.toContain("internalNote");
    expect(JSON.stringify(patientView)).not.toContain("synthetic-model");
    expect(JSON.stringify(patientView)).not.toContain("clinicalChunkId");
    const job = await service.getJob(nurseAuth, (await db.sql`SELECT job_id FROM analyses WHERE id = ${analysisId}`)[0]!.job_id) as any;
    expect(job.status).toBe("completed");
    const listed = await service.list(patientAuth, {}) as any;
    expect(listed.items.some((item: any) => item.id === analysisId)).toBe(true);
  }, 60_000);

  test("human corrections have fresh ID/gate and do not transfer approval", async () => {
    const service = createAnalysisService({ sql: db.sql, config });
    const fresh = await insertSubmittedCheckin("Synthetic correction check-in");
    const queued = await service.generate(nurseAuth, fresh.id, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    expect(await worker.runNext()).toBe("interrupted");
    const originalId = (await service.getJob(nurseAuth, (queued.data as any).id) as any).analysisId as string;
    const original = (await db.sql`SELECT * FROM analyses WHERE id = ${originalId}`)[0]!;
    const revised = await service.revise(nurseAuth, original.id, { expectedVersion: 1, revisionNumber: 1,
      claims: [{ text: "Koreksi manusia dengan bukti.", claimType: "care_note", evidence: [{ checkInId: fresh.id, observationId: fresh.observationId, knowledgeChunkId }] }] }, meta());
    expect(revised.statusCode).toBe(201);
    const correction = revised.data as any;
    expect(correction.id).not.toBe(original.id); expect(correction.revisionNumber).toBe(2);
    expect(correction.supersedesId).toBe(original.id); expect(correction.reviews).toEqual([]);
    expect(correction.status).toBe("in_review"); expect(correction.version).toBe(1);
    const gate = (await db.sql`SELECT * FROM analysis_review_gates WHERE analysis_id = ${correction.id}`)[0]!;
    expect(gate.id).not.toBe((await db.sql`SELECT id FROM analysis_review_gates WHERE analysis_id = ${original.id}`)[0]!.id);
    await service.review(nurseAuth, correction.id, { decision: "reject", comment: "Synthetic rejection", expectedVersion: 1, revisionNumber: 2 }, meta());
    expect(await worker.reconcileAnalysis(correction.id)).toBe(true);
    expect(((await service.get(nurseAuth, correction.id)) as any).status).toBe("rejected");
    await expect(service.get(patientAuth, correction.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.revise(nurseAuth, original.id, { expectedVersion: 0, revisionNumber: 1,
      claims: [{ text: "Another", claimType: "care_note", evidence: [{ checkInId: fresh.id }] }] }, meta()))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  }, 30_000);

  test("invalid model evidence fails with a receipt and no analysis", async () => {
    const service = createAnalysisService({ sql: db.sql, config });
    const queued = await service.generate(nurseAuth, checkInId, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    const bad = createAnalysisWorker({ sql: db.sql, checkpointer: saver, setupCheckpointer: async () => {},
      model: { invoke: async () => ({ provider: "google-ai-studio" as const, modelId: "bad", usedFallback: false,
        content: JSON.stringify({ claims: [{ text: "Bad evidence", claimType: "concern", evidence: [{ checkInId, observationId: randomUUID() }] }] }) }) }, config });
    expect(await bad.runNext()).toBe("failed");
    const job = await service.getJob(nurseAuth, (queued.data as any).id) as any;
    expect(job.status).toBe("failed"); expect(job.errorCode).toBe("INVALID_MODEL_OUTPUT");
    expect(job.analysisId).toBeNull();
    const attempts = await db.sql`SELECT outcome, error_code FROM analysis_job_attempts WHERE job_id = ${job.id}`;
    expect(attempts[0]).toMatchObject({ outcome: "failed", error_code: "INVALID_MODEL_OUTPUT" });
    expect(modelCalls).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("scheduler skips a stale decided revision and still resumes a later gate and generates queued work", async () => {
    const service = createAnalysisService({ sql: db.sql, config });
    const fresh = await insertSubmittedCheckin("Synthetic scheduler gate");
    const queued = await service.generate(nurseAuth, fresh.id, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    expect(await worker.runNext()).toBe("interrupted");
    const originalId = (await service.getJob(nurseAuth, (queued.data as any).id) as any).analysisId as string;
    await service.review(nurseAuth, originalId, { decision: "changes_requested", comment: "Synthetic correction required", expectedVersion: 1, revisionNumber: 1 }, meta());
    const revised = await service.revise(nurseAuth, originalId, { expectedVersion: 2, revisionNumber: 1,
      claims: [{ text: "Synthetic corrected claim", claimType: "care_note", evidence: [{ checkInId: fresh.id, knowledgeChunkId }] }] }, meta());
    const revisedId = (revised.data as any).id as string;
    await service.review(nurseAuth, revisedId, { decision: "reject", comment: "Synthetic rejection", expectedVersion: 1, revisionNumber: 2 }, meta());
    await expect(worker.reconcileAnalysis(originalId)).rejects.toThrow();
    const pending = await insertSubmittedCheckin("Synthetic queued work after stale gate");
    const pendingJob = await service.generate(nurseAuth, pending.id, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    const failures: string[] = [];
    const scheduler = createAnalysisScheduler({ sql: db.sql, worker, onError: stage => { failures.push(stage); } });
    await scheduler.tick();
    await scheduler.stop();
    expect(failures).toEqual(["review_reconciliation"]);
    expect((await db.sql`SELECT state FROM analysis_review_gates WHERE analysis_id = ${originalId}`)[0]!.state).toBe("decided");
    expect((await db.sql`SELECT state FROM analysis_review_gates WHERE analysis_id = ${revisedId}`)[0]!.state).toBe("reconciled");
    expect((await service.getJob(nurseAuth, (pendingJob.data as any).id) as any).status).toBe("awaiting_review");
    expect((await db.sql`SELECT count(*)::int AS count FROM analysis_publications WHERE analysis_id IN (${originalId}, ${revisedId})`)[0]!.count).toBe(0);
  }, 60_000);

  test("routes enforce auth/CSRF/strict bodies and idempotency conflicts", async () => {
    const password = "synthetic-route-password";
    await db.sql`UPDATE accounts SET password_hash = ${await hashPassword(password)} WHERE id = ${nurse.accountId}`;
    const auth = createAuthService({ sql: db.sql, config });
    const login = await auth.login({ email: "analysis@nurse.invalid", password }, { ip: "127.0.0.1", userAgent: "synthetic-test", requestId: randomUUID() });
    const session = await db.sql`SELECT id, csrf_hash FROM sessions WHERE account_id = ${nurse.accountId} ORDER BY created_at DESC LIMIT 1`;
    const token = login.token;
    const routeAuth = { ...nurseAuth, sessionId: session[0]!.id, csrfToken: (login.data as any).session.csrfToken } as any;
    const analysis = createAnalysisService({ sql: db.sql, config });
    const app = createApp(async () => {}, { auth, analysis, config, rateLimiters: createRateLimiters() });
    const send = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: config.allowedOrigins[0]!,
        "content-type": "application/json", "x-csrf-token": routeAuth.csrfToken, "idempotency-key": randomUUID(), ...headers }, body: JSON.stringify(body),
    }));
    let response = await send(`/api/v1/check-ins/${checkInId}/analyses`, { promptVersion: "forcare-condition-v1", locale: "id" }, { "x-csrf-token": "wrong" });
    expect(response.status).toBe(403);
    response = await send(`/api/v1/check-ins/${checkInId}/analyses`, { promptVersion: "forcare-condition-v1", locale: "id", patientId: patient.id });
    expect(response.status).toBe(422);
    response = await send(`/api/v1/check-ins/${checkInId}/analyses`, { promptVersion: "forcare-condition-v1", locale: "id" }, { "idempotency-key": "" });
    expect(response.status).toBe(400); expect((await response.json() as any).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const key = randomUUID();
    const created = await send(`/api/v1/check-ins/${checkInId}/analyses`, { promptVersion: "forcare-condition-v1", locale: "id" }, { "idempotency-key": key });
    expect(created.status).toBe(202);
    const first = (await created.json() as any).data;
    const replayed = await send(`/api/v1/check-ins/${checkInId}/analyses`, { promptVersion: "forcare-condition-v1", locale: "id" }, { "idempotency-key": key });
    expect((await replayed.json() as any).data).toEqual(first);
    const conflict = await send(`/api/v1/check-ins/${checkInId}/analyses`, { promptVersion: "forcare-condition-v1", locale: "en" }, { "idempotency-key": key });
    expect(conflict.status).toBe(409); expect((await conflict.json() as any).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await analysis.getJob(routeAuth, first.id)).toMatchObject({ status: "queued" });
  }, 30_000);

  test("revoked primary scope cannot read or replay, and lease heartbeats retain receipt identity", async () => {
    const service = createAnalysisService({ sql: db.sql, config });
    const older = await acquireJob(db.sql, "route-queue-drain");
    if (older) await failJob(db.sql, older, "INSUFFICIENT_EVIDENCE");
    const queued = await service.generate(nurseAuth, checkInId, { promptVersion: "forcare-condition-v1", locale: "id" }, meta());
    const lease = await acquireJob(db.sql, "heartbeat-test", 5000);
    expect(lease?.id).toBe((queued.data as any).id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const renewed = await db.sql.begin(async (tx) => {
      return heartbeatJob(tx, lease!, 5000);
    });
    expect(renewed.version).toBe(lease!.version + 1);
    expect(renewed.lease_token).toBe(lease!.lease_token);
    await failJob(db.sql, renewed, "INSUFFICIENT_EVIDENCE");
    await expect(db.sql.begin((tx) => saveJobResult(tx, { job: lease!, modelProvider: "synthetic-test", modelId: "stale",
      claims: [{ text: "Must not save", claimType: "care_note", evidence: [{ checkInId }] }] }))).rejects.toThrow("lease");
    const attempts = await db.sql`SELECT attempt_number, lease_token, outcome FROM analysis_job_attempts WHERE job_id = ${lease!.id}`;
    expect(attempts).toHaveLength(1); expect(attempts[0]!.lease_token).toBe(lease!.lease_token);
    await db.sql`UPDATE patient_access_grants SET revoked_at = now() WHERE patient_id = ${patient.id} AND staff_id = ${nurse.staffId} AND revoked_at IS NULL`;
    try {
      await expect(service.getJob(nurseAuth, lease!.id)).rejects.toMatchObject({ status: 404 });
      const prior = await db.sql`SELECT key FROM idempotency_keys WHERE account_id = ${nurse.accountId} AND resource_key LIKE '%/analyses' LIMIT 1`;
      if (prior[0]) {
        await expect(service.generate(nurseAuth, checkInId, { promptVersion: "forcare-condition-v1", locale: "id" },
          { requestId: randomUUID(), key: prior[0].key })).rejects.toMatchObject({ status: 404 });
      }
    } finally {
      await db.sql`UPDATE patient_access_grants SET revoked_at = NULL WHERE patient_id = ${patient.id} AND staff_id = ${nurse.staffId}`;
    }
  }, 30_000);
});
