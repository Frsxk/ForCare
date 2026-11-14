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
  return sql`UPDATE knowledge_documents SET status = 'approved', approved_by = ${staffId}, approved_at = now() WHERE id = ${documentId}`;
}
async function approveCorpus(sql: SQL, corpusId: string) {
  return sql`UPDATE knowledge_corpora SET status = 'approved', approved_by = ${staffId}, approved_at = now() WHERE id = ${corpusId}`;
}

async function waitForDatabaseBlock(
  observer: SQL,
  contenderPid: number,
  holderPid: number,
  contenderSettled: () => boolean,
) {
  for (;;) {
    const [activity] = await observer`
      SELECT state, wait_event_type, ${holderPid} = ANY (pg_blocking_pids(pid)) AS blocked_by_holder
      FROM pg_stat_activity WHERE pid = ${contenderPid}
    `;
    if (activity?.blocked_by_holder) {
      expect(activity).toMatchObject({ state: "active", wait_event_type: "Lock", blocked_by_holder: true });
      return;
    }
    if (contenderSettled()) throw new Error("contender finished without blocking on the holder");
  }
}

async function runContendedStatements(
  hold: (sql: SQL) => unknown,
  contend: (sql: SQL) => unknown,
  expectedErrno?: string,
) {
  const holder = await db.sql.reserve();
  let contender: typeof holder | undefined;
  let observer: typeof holder | undefined;
  let holderTransaction = false;
  let outcome: Promise<unknown> | undefined;
  try {
    contender = await db.sql.reserve();
    observer = await db.sql.reserve();
    const [{ pid: holderPid }] = await holder`SELECT pg_backend_pid() AS pid`;
    const [{ pid: contenderPid }] = await contender`SELECT pg_backend_pid() AS pid`;
    await holder`BEGIN`;
    holderTransaction = true;
    await hold(holder);

    // Materialize every thenable before expect() so no lazy Bun Query enters it.
    outcome = Promise.resolve(contend(contender));
    let contenderSettled = false;
    void outcome.then(
      () => { contenderSettled = true; },
      () => { contenderSettled = true; },
    );
    await waitForDatabaseBlock(observer, contenderPid, holderPid, () => contenderSettled);
    await holder`COMMIT`;
    holderTransaction = false;
    if (expectedErrno === undefined) {
      await outcome;
    } else {
      await expect(outcome).rejects.toMatchObject({ errno: expectedErrno });
    }
    outcome = undefined;
  } finally {
    try {
      if (holderTransaction) {
        await holder`ROLLBACK`;
        holderTransaction = false;
      }
      // Keep the rejection observed without waiting on it during cleanup; an
      // external lock holder could otherwise keep this reservation occupied.
      if (outcome) void outcome.catch(() => {});
    } finally {
      await Promise.all([holder.release(), contender?.release(), observer?.release()]);
    }
  }
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
    await runContendedStatements(
      (sql) => sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${ids.corpusId}, 'New draft', 1, 'Synthetic', ${"b".repeat(64)})`,
      (sql) => approveCorpus(sql, ids.corpusId),
      "23514",
    );
    let [corpus] = await db.sql`SELECT status FROM knowledge_corpora WHERE id = ${ids.corpusId}`;
    expect(corpus.status).toBe("draft");
    expect((await db.sql`SELECT id FROM knowledge_documents WHERE corpus_id = ${ids.corpusId}`).length).toBe(2);

    const other = await draft();
    await approveDocument(db.sql, other.documentId);
    await runContendedStatements(
      (sql) => approveCorpus(sql, other.corpusId),
      (sql) => sql`INSERT INTO knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${other.corpusId}, 'Late', 1, 'Synthetic', ${"c".repeat(64)})`,
      "55000",
    );
    [corpus] = await db.sql`SELECT status FROM knowledge_corpora WHERE id = ${other.corpusId}`;
    expect(corpus.status).toBe("approved");
    expect((await db.sql`SELECT id FROM knowledge_documents WHERE corpus_id = ${other.corpusId}`).length).toBe(1);
  }, 30_000);

  test("READ COMMITTED: chunk insert and document approval serialize in both orders", async () => {
    const ids = await draft();
    await runContendedStatements(
      (sql) => sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${ids.documentId}, 1, 'Synthetic second')`,
      (sql) => approveDocument(sql, ids.documentId),
    );
    expect((await db.sql`SELECT id FROM knowledge_chunks WHERE document_id = ${ids.documentId}`).length).toBe(2);
    expect((await db.sql`SELECT status FROM knowledge_documents WHERE id = ${ids.documentId}`)[0].status).toBe("approved");

    const other = await draft();
    await runContendedStatements(
      (sql) => approveDocument(sql, other.documentId),
      (sql) => sql`INSERT INTO knowledge_chunks (document_id, ordinal, content) VALUES (${other.documentId}, 1, 'Late')`,
      "55000",
    );
    expect((await db.sql`SELECT id FROM knowledge_chunks WHERE document_id = ${other.documentId}`).length).toBe(1);
    expect((await db.sql`SELECT status FROM knowledge_documents WHERE id = ${other.documentId}`)[0].status).toBe("approved");
  }, 30_000);

  test("READ COMMITTED: document retirement and corpus approval serialize in both orders", async () => {
    const ids = await draft();
    await approveDocument(db.sql, ids.documentId);
    await runContendedStatements(
      (sql) => sql`UPDATE knowledge_documents SET status = 'retired' WHERE id = ${ids.documentId}`,
      (sql) => approveCorpus(sql, ids.corpusId),
      "23514",
    );
    let [corpus] = await db.sql`SELECT status FROM knowledge_corpora WHERE id = ${ids.corpusId}`;
    expect(corpus.status).toBe("draft");
    expect((await db.sql`SELECT status FROM knowledge_documents WHERE id = ${ids.documentId}`)[0].status).toBe("retired");

    const other = await draft();
    await approveDocument(db.sql, other.documentId);
    await runContendedStatements(
      (sql) => approveCorpus(sql, other.corpusId),
      (sql) => sql`UPDATE knowledge_documents SET status = 'retired' WHERE id = ${other.documentId}`,
    );
    [corpus] = await db.sql`SELECT status FROM knowledge_corpora WHERE id = ${other.corpusId}`;
    expect(corpus.status).toBe("approved");
    const [row] = await db.sql`SELECT status FROM knowledge_documents WHERE id = ${other.documentId}`;
    expect(row.status).toBe("retired");
  }, 30_000);
});
