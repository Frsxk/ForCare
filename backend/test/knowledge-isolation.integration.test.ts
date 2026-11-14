import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";

const integration = process.env.FORCARE_TEST_DATABASE_URL ? describe : describe.skip;
let db: DisposableDatabase;
let staffId: string;

async function draft() {
  const [c] = await db.sql`INSERT INTO knowledge_corpora (name, version, owner) VALUES (${randomUUID()}, 1, 'synthetic') RETURNING id`;
  const [d] = await db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${c.id}, 'Synthetic', 1, 'Synthetic', ${"a".repeat(64)}) RETURNING id`;
  const [k] = await db.sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${d.id}, 0, 'Synthetic') RETURNING id`;
  return { corpusId: c.id as string, documentId: d.id as string, chunkId: k.id as string };
}
async function approveDocument(sql: SQL, documentId: string) {
  await sql`UPDATE knowledge_documents SET status = 'approved', approved_by = ${staffId}, approved_at = now() WHERE id = ${documentId}`;
}
async function approveCorpus(sql: SQL, corpusId: string) {
  await sql`UPDATE knowledge_corpora SET status = 'approved', approved_by = ${staffId}, approved_at = now() WHERE id = ${corpusId}`;
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { open, promise };
}

integration("knowledge mutation isolation (real PostgreSQL)", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("knowledge_isolation");
    const nurse = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
      email: "isolation@nurse.invalid", passwordHash: "synthetic-unused-hash", staffCode: "T10-ISO",
      displayName: "Synthetic isolation nurse", approvalReference: "synthetic-only-not-clinical-validation",
      operator: "synthetic-test", nurseDomain: "nurse.invalid",
    }));
    staffId = nurse.staffId;
  }, 90_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  test("rejects reviewer REPEATABLE READ approval after an unseen draft member commits", async () => {
    const ids = await draft();
    await approveDocument(db.sql, ids.documentId);
    await db.sql.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      await tx`SELECT * FROM knowledge_documents WHERE corpus_id = ${ids.corpusId}`;
      await db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${ids.corpusId}, 'Unseen draft', 1, 'Synthetic', ${"b".repeat(64)})`;
      await expect(approveCorpus(tx, ids.corpusId)).rejects.toMatchObject({ errno: "0A000" });
    });
    const [c] = await db.sql`SELECT status FROM knowledge_corpora WHERE id = ${ids.corpusId}`;
    expect(c.status).toBe("draft");
  }, 30_000);

  test("all knowledge insertion/update paths reject unsupported snapshot isolation", async () => {
    const ids = await draft();
    const operations = [
      (tx: SQL) => tx`INSERT INTO knowledge_corpora (name, version, owner) VALUES (${randomUUID()}, 1, 'synthetic')`,
      (tx: SQL) => tx`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${ids.corpusId}, 'Other', 1, 'Synthetic', ${"b".repeat(64)})`,
      (tx: SQL) => tx`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${ids.documentId}, 1, 'Other')`,
      (tx: SQL) => approveCorpus(tx, ids.corpusId),
      (tx: SQL) => approveDocument(tx, ids.documentId),
      (tx: SQL) => tx`UPDATE knowledge_chunks SET content = 'Other' WHERE id = ${ids.chunkId}`,
    ];
    for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
      for (const operation of operations) {
        await expect(db.sql.begin(async (tx) => {
          await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await operation(tx);
        })).rejects.toMatchObject({ errno: "0A000" });
      }
    }
  }, 30_000);

  test("READ COMMITTED: inserted draft membership prevents corpus approval; approved corpus rejects insertion", async () => {
    const ids = await draft();
    await approveDocument(db.sql, ids.documentId);
    const locked = gate(); const release = gate();
    const inserting = db.sql.begin(async (tx) => {
      await tx`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${ids.corpusId}, 'New draft', 1, 'Synthetic', ${"b".repeat(64)})`;
      locked.open(); await release.promise;
    }).then((value) => value);
    await locked.promise;
    const approval = approveCorpus(db.sql, ids.corpusId);
    const rejected = () => expect(approval).rejects.toMatchObject({ errno: "23514" });
    release.open(); await inserting; await rejected();

    const other = await draft(); await approveDocument(db.sql, other.documentId);
    const approved = gate(); const commit = gate();
    const approving = db.sql.begin(async (tx) => { await approveCorpus(tx, other.corpusId); approved.open(); await commit.promise; }).then((value) => value);
    await approved.promise;
    const insert = db.sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${other.corpusId}, 'Late', 1, 'Synthetic', ${"c".repeat(64)})`;
    const pending = Promise.resolve(insert);
    const denied = () => expect(pending).rejects.toMatchObject({ errno: "55000" });
    commit.open(); await approving; await denied();
  }, 30_000);

  test("READ COMMITTED: chunk insert and document approval serialize in both orders", async () => {
    const ids = await draft(); const locked = gate(); const release = gate();
    const inserting = db.sql.begin(async (tx) => {
      await tx`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${ids.documentId}, 1, 'Synthetic second')`;
      locked.open(); await release.promise;
    }).then((value) => value);
    await locked.promise;
    const approval = approveDocument(db.sql, ids.documentId);
    const done = Promise.resolve(approval);
    release.open(); await inserting; await done;
    expect((await db.sql`SELECT id FROM knowledge_chunks WHERE document_id = ${ids.documentId}`).length).toBe(2);

    const other = await draft(); const approved = gate(); const commit = gate();
    const approving = db.sql.begin(async (tx) => { await approveDocument(tx, other.documentId); approved.open(); await commit.promise; }).then((value) => value);
    await approved.promise;
    const insert = db.sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${other.documentId}, 1, 'Late')`;
    const pending = Promise.resolve(insert);
    const denied = () => expect(pending).rejects.toMatchObject({ errno: "55000" });
    commit.open(); await approving; await denied();
  }, 30_000);

  test("READ COMMITTED: document retirement and corpus approval serialize in both orders", async () => {
    const ids = await draft(); await approveDocument(db.sql, ids.documentId);
    const locked = gate(); const release = gate();
    const retiring = db.sql.begin(async (tx) => {
      await tx`UPDATE knowledge_documents SET status = 'retired' WHERE id = ${ids.documentId}`;
      locked.open(); await release.promise;
    }).then((value) => value);
    await locked.promise;
    const pending = approveCorpus(db.sql, ids.corpusId);
    const denied = () => expect(pending).rejects.toMatchObject({ errno: "23514" });
    release.open(); await retiring; await denied();

    const other = await draft(); await approveDocument(db.sql, other.documentId);
    const approved = gate(); const commit = gate();
    const approving = db.sql.begin(async (tx) => { await approveCorpus(tx, other.corpusId); approved.open(); await commit.promise; }).then((value) => value);
    await approved.promise;
    const retire = db.sql`UPDATE knowledge_documents SET status = 'retired' WHERE id = ${other.documentId}`;
    const done = Promise.resolve(retire);
    commit.open(); await approving; await done;
    const [row] = await db.sql`SELECT status FROM knowledge_documents WHERE id = ${other.documentId}`;
    expect(row.status).toBe("retired");
  }, 30_000);
});
