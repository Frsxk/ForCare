import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import type { AuthContext } from "../src/auth/policy";
import { createAuthService } from "../src/auth/service";
import { deriveCsrfToken, csrfHashFromToken } from "../src/auth/crypto";
import { toErrorResponse } from "../src/http/errors";
import { createRateLimiters } from "../src/http/rate-limit";
import { assertAllowedOrigin } from "../src/http/request";
import { knowledgeSearchResponseSchema } from "../src/knowledge/schemas";
import { createDisposableDatabase, testAuthConfig, type DisposableDatabase } from "./fixtures/disposable-database";

const integration = process.env.FORCARE_TEST_DATABASE_URL ? describe : describe.skip;
const config = testAuthConfig();
let db: DisposableDatabase;
let nurse: { accountId: string; staffId: string };
let auth: AuthContext;
const query = { query: "cuci tangan", locale: "id" as const, limit: 20 };
async function modules() {
  for (const path of ["service", "repository", "corpus-import", "routes"]) {
    expect(existsSync(new URL(`../src/knowledge/${path}.ts`, import.meta.url)), `${path} must exist`).toBe(true);
  }
  return {
    ...await import("../src/knowledge/service"), ...await import("../src/knowledge/repository"),
    ...await import("../src/knowledge/corpus-import"), ...await import("../src/knowledge/routes"),
  };
}
integration("controlled knowledge corpus and lexical service (real PostgreSQL)", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("knowledge_service");
    nurse = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
      email: "knowledge@nurse.invalid", passwordHash: "synthetic-unused-hash", staffCode: "T10-KNOW",
      displayName: "Synthetic knowledge nurse", approvalReference: "synthetic-not-clinical-validation",
      operator: "synthetic-test", nurseDomain: "nurse.invalid",
    }));
    const csrfToken = deriveCsrfToken("a".repeat(64));
    auth = { sessionId: randomUUID(), accountId: nurse.accountId, staffId: nurse.staffId, role: "nurse",
      email: "knowledge@nurse.invalid", staffCode: "T10-KNOW", displayName: "Synthetic knowledge nurse",
      displayTimeZone: "Asia/Jakarta", patientId: null, csrfToken, csrfHashHex: csrfHashFromToken(csrfToken),
      expiresAt: "2099-01-01T00:00:00Z" };
  }, 90_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  test("fresh import defaults to DRAFT, repeat verifies identity, explicit active nurse approval enables bilingual search", async () => {
    const { importFixedKnowledgeCorpus, createKnowledgeService, retrieveKnowledge } = await modules();
    const service = createKnowledgeService({ sql: db.sql, config });
    const draft = await importFixedKnowledgeCorpus({ sql: db.sql, config });
    expect(draft.status).toBe("draft");
    expect(draft.documentIds).toHaveLength(2);
    const repeat = await importFixedKnowledgeCorpus({ sql: db.sql, config });
    expect(repeat).toEqual(draft);
    await expect(service.search(auth, query)).rejects.toMatchObject({ code: "GATE_UNAVAILABLE", status: 503 });
    await expect(Promise.resolve(db.sql`UPDATE knowledge_corpora SET status = 'approved' WHERE id = ${draft.corpusId}`))
      .rejects.toMatchObject({ errno: "23514" });
    const approved = await importFixedKnowledgeCorpus({ sql: db.sql, config, approveBy: nurse.staffId });
    expect(approved.status).toBe("approved");
    expect(await importFixedKnowledgeCorpus({ sql: db.sql, config, approveBy: nurse.staffId })).toEqual(approved);
    const result = await service.search(auth, query);
    expect(knowledgeSearchResponseSchema.parse(result)).toEqual(result);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((c) => c.corpusId === approved.corpusId)).toBe(true);
    expect((await service.search(auth, { ...query, query: "handwashing", locale: "en" })).chunks.length).toBeGreaterThan(0);
    expect((await service.search(auth, { ...query, query: "jatuh" })).chunks.length).toBeGreaterThan(0);
    expect(await service.search(auth, { ...query, query: "xylophonenevermatch" })).toEqual({ chunks: [], corpusVersion: 1 });
    const bound = await db.sql.begin((tx) => retrieveKnowledge(tx, query));
    expect(bound.corpusId).toBe(approved.corpusId);
    expect(bound.chunks[0]?.chunkId).toBe(result.chunks[0]?.chunkId);
    const [audit] = await db.sql`SELECT actor_account_id FROM audit_events WHERE action = 'knowledge.corpus.approved' AND subject_id = ${approved.corpusId}`;
    expect(audit.actor_account_id).toBe(nurse.accountId);
    const stored = await db.sql`SELECT body FROM knowledge_documents WHERE corpus_id = ${approved.corpusId}`;
    expect(stored.some((d: { body: string }) => d.body.includes("https://www.who.int/news-room/fact-sheets/detail/falls"))).toBe(true);
    expect(stored.some((d: { body: string }) => d.body.includes("https://www.cdc.gov/clean-hands/about/index.html"))).toBe(true);
  }, 30_000);

  test("service and route fail closed for strict bodies, patients, disabled nurse, CSRF and Origin", async () => {
    const { createKnowledgeService, knowledgeRoutes } = await modules();
    const knowledge = createKnowledgeService({ sql: db.sql, config });
    await expect(knowledge.search(auth, { ...query, patientId: randomUUID() } as any)).rejects.toMatchObject({ code: "UNKNOWN_FIELD", status: 422 });
    await expect(knowledge.search({ ...auth, role: "patient" }, query)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const authService = { ...createAuthService({ sql: db.sql, config }), authenticate: async () => auth };
    const app = new Elysia().onRequest(({ request }) => {
      try { assertAllowedOrigin(request, config.allowedOrigins); } catch (e) { return toErrorResponse(request, e); }
    }).onError(({ request, error }) => toErrorResponse(request, error))
      .use(knowledgeRoutes({ auth: authService, knowledge, config, rateLimiters: createRateLimiters() }));
    const send = (body: unknown, headers: Record<string, string> = {}) => app.handle(new Request("http://localhost/api/v1/knowledge/search", {
      method: "POST", headers: { origin: config.allowedOrigins[0]!, "content-type": "application/json", "x-csrf-token": auth.csrfToken, ...headers }, body: JSON.stringify(body),
    }));
    expect((await send(query)).status).toBe(200);
    let denied = await send({ ...query, url: "https://untrusted.invalid" });
    expect(denied.status).toBe(422); expect((await denied.json() as any).error.code).toBe("UNKNOWN_FIELD");
    denied = await send(query, { "x-csrf-token": "wrong" }); expect(denied.status).toBe(403);
    expect((await denied.json() as any).error.code).toBe("CSRF_INVALID");
    denied = await send(query, { origin: "https://untrusted.invalid" }); expect(denied.status).toBe(403);
    expect((await denied.json() as any).error.code).toBe("ORIGIN_REJECTED");
    await db.sql`UPDATE staff SET active = false WHERE id = ${nurse.staffId}`;
    try {
      await expect(knowledge.search(auth, query)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      denied = await send(query); expect(denied.status).toBe(403);
      await expect((await modules()).importFixedKnowledgeCorpus({ sql: db.sql, config, approveBy: nurse.staffId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally { await db.sql`UPDATE staff SET active = true WHERE id = ${nurse.staffId}`; }
  }, 30_000);

  test("DB rejects mutation, deletion and late membership; retired documents are filtered before ranking", async () => {
    const { importFixedKnowledgeCorpus, createKnowledgeService } = await modules();
    const imported = await importFixedKnowledgeCorpus({ sql: db.sql, config });
    const documentId = imported.documentIds[0]!;
    const [chunk] = await db.sql`SELECT id FROM knowledge_chunks WHERE document_id = ${documentId}`;
    const mutations = [
      () => db.sql`UPDATE knowledge_documents SET body = 'changed' WHERE id = ${documentId}`,
      () => db.sql`UPDATE knowledge_documents SET corpus_id = ${randomUUID()} WHERE id = ${documentId}`,
      () => db.sql`UPDATE knowledge_chunks SET content = 'changed' WHERE id = ${chunk.id}`,
      () => db.sql`UPDATE knowledge_corpora SET version = 2 WHERE id = ${imported.corpusId}`,
      () => db.sql`DELETE FROM knowledge_chunks WHERE id = ${chunk.id}`,
      () => db.sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${documentId}, 99, 'late')`,
      () => db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${imported.corpusId}, 'Late', 1, 'late', ${"c".repeat(64)})`,
    ];
    for (const mutate of mutations) await expect(Promise.resolve(mutate())).rejects.toMatchObject({ errno: "55000" });
    await db.sql`UPDATE knowledge_documents SET status = 'retired' WHERE title = 'Mencegah jatuh / Preventing falls' AND corpus_id = ${imported.corpusId}`;
    const service = createKnowledgeService({ sql: db.sql, config });
    expect((await service.search(auth, { ...query, query: "jatuh" })).chunks).toEqual([]);
    expect((await service.search(auth, query)).chunks.length).toBeGreaterThan(0);
    await expect(importFixedKnowledgeCorpus({ sql: db.sql, config, approveBy: nurse.staffId })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  }, 30_000);

  test("selects latest approved fixed-name revision every call, excludes drafts and retired corpus", async () => {
    const { createKnowledgeService } = await modules();
    const service = createKnowledgeService({ sql: db.sql, config });
    const [corpus] = await db.sql`INSERT INTO knowledge_corpora (name, version, owner) VALUES ('forcare-homecare-basics', 2, 'synthetic') RETURNING id`;
    const [doc] = await db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${corpus.id}, 'Synthetic latest', 1, 'synthetic', ${"d".repeat(64)}) RETURNING id`;
    await db.sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${doc.id}, 0, 'cuci tangan synthetic latest')`;
    expect((await service.search(auth, query)).corpusVersion).toBe(1);
    await db.sql`UPDATE knowledge_documents SET status = 'approved', approved_by = ${nurse.staffId}, approved_at = now() WHERE id = ${doc.id}`;
    await db.sql`UPDATE knowledge_corpora SET status = 'approved', approved_by = ${nurse.staffId}, approved_at = now() WHERE id = ${corpus.id}`;
    const result = await service.search(auth, query);
    expect(result.corpusVersion).toBe(2); expect(result.chunks).toHaveLength(1); expect(result.chunks[0]?.corpusId).toBe(corpus.id);
    await db.sql`UPDATE knowledge_corpora SET status = 'retired' WHERE id = ${corpus.id}`;
    expect((await service.search(auth, query)).corpusVersion).toBe(1);
    await db.sql`UPDATE knowledge_corpora SET status = 'retired' WHERE name = 'forcare-homecare-basics' AND version = 1`;
    await expect(service.search(auth, query)).rejects.toMatchObject({ code: "GATE_UNAVAILABLE", status: 503 });
  }, 30_000);
});
