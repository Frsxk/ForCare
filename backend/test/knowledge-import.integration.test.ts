import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDisposableDatabase, testAuthConfig } from "./fixtures/disposable-database";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { importFixedKnowledgeCorpus } from "../src/knowledge/corpus-import";
import { FIXED_CORPUS_NAME, FIXED_CORPUS_OWNER, FIXED_KNOWLEDGE_DOCUMENTS } from "../src/knowledge/corpus";
import { parseKnowledgeCorpusArgs } from "../scripts/knowledge-corpus";

const integration = process.env.FORCARE_TEST_DATABASE_URL ? describe : describe.skip;

describe("fixed corpus CLI input boundary", () => {
  test("accepts only no arguments or explicit approver, never files/URLs/content", () => {
    expect(parseKnowledgeCorpusArgs([])).toEqual({});
    expect(parseKnowledgeCorpusArgs(["--approve-by", "explicit-staff-id"])).toEqual({ approveBy: "explicit-staff-id" });
    for (const args of [["--file", "/some/file"], ["--url", "https://source.invalid"], ["--approve"], ["--approve-by"], ["--approve-by", "--file"], ["--approve-by", "id", "extra"]]) {
      expect(() => parseKnowledgeCorpusArgs(args)).toThrow();
    }
  });
});

integration("fixed corpus importer fail-closed (real PostgreSQL)", () => {
  test("real CLI repeats draft and rejects missing signer or extended membership", async () => {
    const db = await createDisposableDatabase("knowledge_cli");
    try {
      const url = new URL(db.url);
      const env = { ...process.env, DATABASE_HOST: url.hostname, DATABASE_PORT: url.port,
        POSTGRES_DB: decodeURIComponent(url.pathname.slice(1)), POSTGRES_USER: decodeURIComponent(url.username),
        POSTGRES_PASSWORD: decodeURIComponent(url.password), HOST: "127.0.0.1", AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
        AUTH_LOCAL_HTTP_TEST: "true", AUTH_NURSE_EMAIL_DOMAIN: "nurse.invalid", AUTH_SESSION_SECRET: testAuthConfig().sessionSecret };
      const cli = async (args: string[] = []) => {
        const child = Bun.spawn([process.execPath, "run", "scripts/knowledge-corpus.ts", ...args], {
          cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, exit };
      };
      const first = await cli(); expect(first.exit).toBe(0);
      expect(first.stderr).toContain("Synthetic fixture approval is NOT real clinical validation");
      const initial = JSON.parse(first.stdout); expect(initial.status).toBe("draft");
      expect(JSON.parse((await cli()).stdout)).toEqual(initial);
      const nurse = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
        email: "cli@nurse.invalid", passwordHash: "synthetic-unused", staffCode: "T10-CLI", displayName: "Synthetic CLI nurse",
        approvalReference: "synthetic-approval", operator: "synthetic-test", nurseDomain: "nurse.invalid",
      }));
      await expect(Promise.resolve(db.sql`UPDATE staff SET identity_approval_ref = NULL WHERE id = ${nurse.staffId}`)).rejects.toMatchObject({ errno: "23502" });
      const noProvenance = await cli(["--approve-by", randomUUID()]); expect(noProvenance.exit).toBe(1); expect(noProvenance.stderr).toContain("FORBIDDEN");
      expect((await db.sql`SELECT status FROM knowledge_corpora WHERE id = ${initial.corpusId}`)[0].status).toBe("draft");
      await db.sql`UPDATE staff SET identity_approval_ref = 'synthetic-approval' WHERE id = ${nurse.staffId}`;
      await db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${initial.corpusId}, 'Unapproved extra member', 1, 'unreviewed', ${"e".repeat(64)})`;
      const extended = await cli(["--approve-by", nurse.staffId]); expect(extended.exit).toBe(1); expect(extended.stderr).toContain("VERSION_CONFLICT");
      const statuses = await db.sql`SELECT status FROM knowledge_documents WHERE corpus_id = ${initial.corpusId}`;
      expect(statuses.every((row: { status: string }) => row.status === "draft")).toBe(true);
    } finally { await db.close(); }
  }, 90_000);

  test("does not approve a preexisting forged body/checksum even with valid membership shape", async () => {
    const db = await createDisposableDatabase("knowledge_forged");
    try {
      const [c] = await db.sql`INSERT INTO knowledge_corpora (name, version, owner) VALUES (${FIXED_CORPUS_NAME}, 1, ${FIXED_CORPUS_OWNER}) RETURNING id`;
      for (const expected of FIXED_KNOWLEDGE_DOCUMENTS) {
        const [d] = await db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${c.id}, ${expected.title}, ${expected.version}, 'forged immutable body', ${expected.checksum}) RETURNING id`;
        for (const [ordinal, content] of expected.chunks.entries()) await db.sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${d.id}, ${ordinal}, ${content})`;
      }
      await expect(importFixedKnowledgeCorpus({ sql: db.sql, config: testAuthConfig() })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
      const [saved] = await db.sql`SELECT status, approved_by FROM knowledge_corpora WHERE id = ${c.id}`;
      expect(saved.status).toBe("draft"); expect(saved.approved_by).toBeNull();
    } finally { await db.close(); }
  }, 90_000);
});
