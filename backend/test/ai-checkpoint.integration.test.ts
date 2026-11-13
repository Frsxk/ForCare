import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { readCheckpointTestTarget, type CheckpointTestTarget } from "./fixtures/checkpoint-test-target";
import {
  SYNTHETIC_GATE,
  assertResumableDecision,
  type PublicationRow,
  type SyntheticDecision,
} from "./fixtures/synthetic-publication-store";

/**
 * T03 spike: prove a real PostgreSQL-backed LangGraph interrupt survives process
 * death, can be resumed by a separate process, and cannot produce a duplicate
 * synthetic publication.
 *
 * Everything here is a disposable, synthetic harness. It is not the product
 * domain model and it implements no authorization: the gate checks structural
 * binding between a persisted interrupt and one decision payload only.
 */

const configured = Boolean(process.env.FORCARE_CHECKPOINT_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;
const WORKER_TIMEOUT_MS = 45_000;
const WORKER = new URL("./fixtures/checkpoint-worker.ts", import.meta.url).pathname;

type WorkerJob = {
  mode: "setup" | "start" | "resume";
  threadId?: string;
  draftId?: string;
  draftVersion?: number;
  decision?: SyntheticDecision;
  crashAfter?: "prepare" | "publish";
};

type WorkerResult = {
  pid: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  json: Record<string, any> | null;
};

describe("checkpoint test database target", () => {
  const safe = "postgresql://tester:synthetic-secret-xyz@127.0.0.1:6543/forcare_checkpoint_test";

  test("accepts only an explicit loopback dedicated test database", () => {
    const target = readCheckpointTestTarget({ FORCARE_CHECKPOINT_TEST_DATABASE_URL: safe });
    expect(target.database).toBe("forcare_checkpoint_test");
    expect(target.endpoint).toBe("127.0.0.1:6543");
    expect(target.url).toBe(safe);

    const localhost = readCheckpointTestTarget({
      FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgres://tester:synthetic@localhost:6544/forcare_checkpoint_test_alpha",
    });
    expect(localhost.endpoint).toBe("localhost:6544");
    expect(localhost.database).toBe("forcare_checkpoint_test_alpha");

    const ipv6 = readCheckpointTestTarget({
      FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@[::1]:6545/forcare_checkpoint_test",
    });
    expect(ipv6.database).toBe("forcare_checkpoint_test");
  });

  test("never falls back to DATABASE_URL or another ambient variable", () => {
    expect(() => readCheckpointTestTarget({ DATABASE_URL: safe })).toThrow("FORCARE_CHECKPOINT_TEST_DATABASE_URL");
    expect(() =>
      readCheckpointTestTarget({ DATABASE_URL: safe, POSTGRES_PASSWORD: "synthetic", POSTGRES_DB: "forcare_checkpoint_test" }),
    ).toThrow("FORCARE_CHECKPOINT_TEST_DATABASE_URL");
    expect(() => readCheckpointTestTarget({ FORCARE_CHECKPOINT_TEST_DATABASE_URL: "   " })).toThrow(
      "FORCARE_CHECKPOINT_TEST_DATABASE_URL",
    );
  });

  test("rejects shared, remote, malformed and non-dedicated targets before connecting", () => {
    const rejected: Record<string, string | undefined>[] = [
      // The shared development PostgreSQL on 5432 must never be a target.
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@127.0.0.1:5432/forcare_checkpoint_test" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@localhost:5432/forcare_checkpoint_test" },
      // Non-loopback hosts and default ports.
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@db.internal:6543/forcare_checkpoint_test" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@10.0.0.5:6543/forcare_checkpoint_test" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@127.0.0.1/forcare_checkpoint_test" },
      // Database names that are not the dedicated test prefix.
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@127.0.0.1:6543/forcare" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@127.0.0.1:6543/postgres" },
      // Credentials and URL shapes that could silently retarget the connection.
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://127.0.0.1:6543/forcare_checkpoint_test" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester@127.0.0.1:6543/forcare_checkpoint_test" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic@127.0.0.1:6543/forcare_checkpoint_test?host=db" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "file:///etc/passwd" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "not-a-url" },
      { FORCARE_CHECKPOINT_TEST_DATABASE_URL: "" },
      {},
    ];
    for (const env of rejected) expect(() => readCheckpointTestTarget(env)).toThrow();
  });

  test("reports rejection without echoing the supplied credential", () => {
    try {
      readCheckpointTestTarget({
        FORCARE_CHECKPOINT_TEST_DATABASE_URL: "postgresql://tester:synthetic-secret-xyz@127.0.0.1:6543/forcare",
      });
      throw new Error("unsafe target was accepted");
    } catch (error) {
      expect(String(error)).toContain("FORCARE_CHECKPOINT_TEST_DATABASE_URL");
      expect(String(error)).not.toContain("synthetic-secret-xyz");
    }
  });
});

describe("synthetic gate decision validation", () => {
  const expected = {
    threadId: "thread-synthetic-1",
    draftId: "draft-synthetic-1",
    draftVersion: 1,
    gateNonce: "nonce-synthetic-1",
    gate: SYNTHETIC_GATE,
  };
  const decision = (patch: Partial<SyntheticDecision> = {}): SyntheticDecision => ({
    gate: SYNTHETIC_GATE,
    threadId: "thread-synthetic-1",
    draftId: "draft-synthetic-1",
    draftVersion: 1,
    gateNonce: "nonce-synthetic-1",
    decisionId: "decision-synthetic-1",
    status: "approved",
    // Synthetic label only. No domain authentication or role verification is implemented.
    authority: "synthetic-test-operator",
    ...patch,
  });

  test("accepts an approved decision bound to the persisted interrupt", () => {
    expect(assertResumableDecision(decision(), expected).decisionId).toBe("decision-synthetic-1");
  });

  test("refuses a decision without an approval, gate binding, nonce or immutable draft binding", () => {
    for (const patch of [
      { status: "rejected" as const },
      { gate: "another-gate" },
      { threadId: "thread-synthetic-2" },
      { draftId: "draft-synthetic-2" },
      { draftVersion: 2 },
      { gateNonce: "stale-nonce" },
      { decisionId: "" },
      { gateNonce: "" },
      { draftId: "" },
    ]) {
      expect(() => assertResumableDecision(decision(patch), expected)).toThrow();
    }
    expect(() => assertResumableDecision(null, expected)).toThrow();
  });
});

integration("PostgreSQL-backed checkpoint spike", () => {
  let target: CheckpointTestTarget;
  let sql: SQL;
  let password: string;

  const newIds = () => ({
    threadId: `synthetic-thread-${randomUUID()}`,
    draftId: `synthetic-draft-${randomUUID()}`,
    draftVersion: 1,
  });

  const decisionFor = (
    ids: { threadId: string; draftId: string; draftVersion: number },
    gateNonce: string,
    patch: Partial<SyntheticDecision> = {},
  ): SyntheticDecision => ({
    gate: SYNTHETIC_GATE,
    threadId: ids.threadId,
    draftId: ids.draftId,
    draftVersion: ids.draftVersion,
    gateNonce,
    decisionId: `synthetic-decision-${randomUUID()}`,
    status: "approved",
    authority: "synthetic-test-operator",
    ...patch,
  });

  async function runWorker(job: WorkerJob): Promise<WorkerResult> {
    const child = Bun.spawn([process.execPath, "run", WORKER, JSON.stringify(job)], {
      cwd: new URL("..", import.meta.url).pathname,
      // Only the dedicated test database URL is inherited; no project credentials.
      env: { FORCARE_CHECKPOINT_TEST_DATABASE_URL: target.url },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    if (timedOut) throw new Error(`checkpoint worker ${job.mode} exceeded ${WORKER_TIMEOUT_MS}ms`);
    const line = stdout.trim().split("\n").filter(Boolean).at(-1);
    let json: Record<string, any> | null = null;
    if (line?.startsWith("{")) {
      try {
        json = JSON.parse(line);
      } catch {
        json = null;
      }
    }
    expect(stderr).not.toContain(password);
    return { pid: child.pid, exitCode, stdout, stderr, json };
  }

  async function rows<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
    return (await sql(query, ...values)) as unknown as T[];
  }

  async function checkpointCount(threadId: string): Promise<number> {
    const found = await rows<{ count: number }>`
      SELECT count(*)::int AS count FROM checkpoints WHERE thread_id = ${threadId}`;
    return Number(found[0]?.count ?? 0);
  }

  async function publicationsForDraft(draftId: string): Promise<PublicationRow[]> {
    return rows<PublicationRow>`
      SELECT id, draft_id, draft_version, thread_id, gate, decision_id, effect, created_at
      FROM synthetic_checkpoint_publications
      WHERE draft_id = ${draftId}
      ORDER BY created_at`;
  }

  async function prepareAttempts(threadId: string): Promise<number> {
    const found = await rows<{ count: number }>`
      SELECT count(*)::int AS count FROM synthetic_checkpoint_prepare_attempts WHERE thread_id = ${threadId}`;
    return Number(found[0]?.count ?? 0);
  }

  async function guardedPrepareRows(draftId: string): Promise<number> {
    const found = await rows<{ count: number }>`
      SELECT count(*)::int AS count FROM synthetic_checkpoint_guarded_prepare WHERE draft_id = ${draftId}`;
    return Number(found[0]?.count ?? 0);
  }

  beforeAll(async () => {
    target = readCheckpointTestTarget(process.env);
    password = decodeURIComponent(new URL(target.url).password);
    sql = new SQL({ url: target.url, max: 2, idleTimeout: 5, connectionTimeout: 5 });
    // Initialization owner is a separate runtime, not this test process and not a worker run.
    const init = await runWorker({ mode: "setup" });
    expect(init.exitCode).toBe(0);
  }, 60_000);

  afterAll(async () => {
    await sql?.close();
  });

  test("setup() repeats safely from a different runtime process", async () => {
    const second = await runWorker({ mode: "setup" });
    expect(second.exitCode).toBe(0);
    const tables = await rows<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('checkpoints', 'checkpoint_writes', 'checkpoint_blobs',
                           'checkpoint_migrations', 'synthetic_checkpoint_publications')`;
    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "checkpoint_blobs",
      "checkpoint_migrations",
      "checkpoint_writes",
      "checkpoints",
      "synthetic_checkpoint_publications",
    ]);
  }, 60_000);

  test("persists an interrupt across process exit and resumes in a new process to one publication", async () => {
    const ids = newIds();
    const started = await runWorker({ mode: "start", ...ids });
    expect(started.exitCode).toBe(0);
    expect(started.json?.phase).toBe("interrupted");
    expect(started.json?.interrupt?.gate).toBe(SYNTHETIC_GATE);
    expect(started.json?.interrupt?.threadId).toBe(ids.threadId);
    expect(started.json?.interrupt?.draftId).toBe(ids.draftId);
    expect(started.json?.interrupt?.draftVersion).toBe(ids.draftVersion);

    // Paused checkpoint persisted by a dead process; no effect yet.
    expect(await checkpointCount(ids.threadId)).toBeGreaterThanOrEqual(1);
    expect(await publicationsForDraft(ids.draftId)).toHaveLength(0);

    const decision = decisionFor(ids, String(started.json!.interrupt.gateNonce));
    const resumed = await runWorker({ mode: "resume", ...ids, decision });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.json?.phase).toBe("completed");
    expect(resumed.pid).not.toBe(started.pid);

    const publications = await publicationsForDraft(ids.draftId);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      draft_id: ids.draftId,
      draft_version: ids.draftVersion,
      thread_id: ids.threadId,
      gate: SYNTHETIC_GATE,
      decision_id: decision.decisionId,
      effect: `synthetic-publication:${ids.draftId}:v${ids.draftVersion}`,
    });
    expect(resumed.json?.publishedEffectId).toBe(publications[0].id);
  }, 90_000);

  test("replays pre-interrupt work after a crash without duplicating the guarded effect", async () => {
    const ids = newIds();
    const crashed = await runWorker({ mode: "start", ...ids, crashAfter: "prepare" });
    expect(crashed.exitCode).toBe(42);
    expect(await prepareAttempts(ids.threadId)).toBe(1);
    expect(await guardedPrepareRows(ids.draftId)).toBe(1);

    const restarted = await runWorker({ mode: "start", ...ids });
    expect(restarted.exitCode).toBe(0);
    expect(restarted.json?.phase).toBe("interrupted");
    // The unguarded audit row shows the work replayed; the guarded effect did not duplicate.
    expect(await prepareAttempts(ids.threadId)).toBe(2);
    expect(await guardedPrepareRows(ids.draftId)).toBe(1);
    expect(await publicationsForDraft(ids.draftId)).toHaveLength(0);
  }, 90_000);

  test("keeps exactly one publication when a worker dies after publishing but before checkpointing", async () => {
    const ids = newIds();
    const started = await runWorker({ mode: "start", ...ids });
    expect(started.json?.phase).toBe("interrupted");
    const checkpointsBefore = await checkpointCount(ids.threadId);
    const decision = decisionFor(ids, String(started.json!.interrupt.gateNonce));

    const crashed = await runWorker({ mode: "resume", ...ids, decision, crashAfter: "publish" });
    expect(crashed.exitCode).toBe(42);
    // The effect committed, the graph checkpoint did not advance.
    const afterCrash = await publicationsForDraft(ids.draftId);
    expect(afterCrash).toHaveLength(1);
    expect(await checkpointCount(ids.threadId)).toBe(checkpointsBefore);

    const replayed = await runWorker({ mode: "resume", ...ids, decision });
    expect(replayed.exitCode).toBe(0);
    expect(replayed.json?.phase).toBe("completed");
    const afterReplay = await publicationsForDraft(ids.draftId);
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0].id).toBe(afterCrash[0].id);
    expect(replayed.json?.publishedEffectId).toBe(afterCrash[0].id);
  }, 120_000);

  const invalidBindings: Array<{ name: string; patch: Partial<SyntheticDecision>; error: string }> = [
    { name: "wrong gate", patch: { gate: "synthetic-other-gate" }, error: "different gate" },
    { name: "stale nonce", patch: { gateNonce: "synthetic-stale-nonce" }, error: "stale or foreign pause" },
    { name: "wrong draft", patch: { draftId: "synthetic-other-draft" }, error: "different draft version" },
    { name: "wrong draft version", patch: { draftVersion: 2 }, error: "different draft version" },
    { name: "wrong thread", patch: { threadId: "synthetic-other-thread" }, error: "different thread" },
  ];

  for (const invalid of invalidBindings) {
    test(`refuses ${invalid.name} against its own fresh persisted interrupt`, async () => {
      const ids = newIds();
      const started = await runWorker({ mode: "start", ...ids });
      expect(started.exitCode).toBe(0);
      expect(started.json?.phase).toBe("interrupted");
      expect(await checkpointCount(ids.threadId)).toBeGreaterThanOrEqual(1);
      const nonce = String(started.json!.interrupt.gateNonce);
      const refused = await runWorker({
        mode: "resume",
        ...ids,
        decision: decisionFor(ids, nonce, invalid.patch),
      });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.json).toBeNull();
      expect(refused.stderr).toContain(invalid.error);
      expect(await publicationsForDraft(ids.draftId)).toHaveLength(0);
    }, 120_000);
  }

  test("characterizes sticky invalid resumes and explicit fresh-nonce re-entry", async () => {
    const ids = newIds();
    const started = await runWorker({ mode: "start", ...ids });
    expect(started.exitCode).toBe(0);
    expect(started.json?.phase).toBe("interrupted");
    const nonce = String(started.json!.interrupt.gateNonce);
    const refused = await runWorker({
      mode: "resume",
      ...ids,
      decision: decisionFor(ids, nonce, { gate: "synthetic-other-gate" }),
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("different gate");

    // LangGraph retains the first resume value on this failed task. A valid
    // second payload does not replace it. This is library characterization,
    // not a production clinical-review recovery policy.
    const retry = await runWorker({
      mode: "resume",
      ...ids,
      decision: decisionFor(ids, nonce),
    });
    expect(retry.exitCode).not.toBe(0);
    expect(retry.stderr).toContain("different gate");
    expect(await publicationsForDraft(ids.draftId)).toHaveLength(0);

    const recovered = await runWorker({ mode: "start", ...ids });
    expect(recovered.exitCode).toBe(0);
    expect(recovered.json?.phase).toBe("interrupted");
    expect(recovered.json?.interrupt?.gateNonce).not.toBe(nonce);
    const valid = await runWorker({
      mode: "resume",
      ...ids,
      decision: decisionFor(ids, String(recovered.json!.interrupt.gateNonce)),
    });
    expect(valid.exitCode).toBe(0);
    expect(await publicationsForDraft(ids.draftId)).toHaveLength(1);
  }, 120_000);

  test("a different thread, draft or decision cannot alter an existing publication", async () => {
    const ids = newIds();
    const started = await runWorker({ mode: "start", ...ids });
    const nonce = String(started.json!.interrupt.gateNonce);
    const firstDecision = decisionFor(ids, nonce);
    const first = await runWorker({ mode: "resume", ...ids, decision: firstDecision });
    expect(first.exitCode).toBe(0);
    const original = (await publicationsForDraft(ids.draftId))[0];

    // Another thread reuses the same draft and an approval; the unique key must refuse it.
    const dupeIds = { ...ids, threadId: `synthetic-thread-${randomUUID()}` };
    const dupeStart = await runWorker({ mode: "start", ...dupeIds });
    const dupe = await runWorker({
      mode: "resume",
      ...dupeIds,
      decision: decisionFor(dupeIds, String(dupeStart.json!.interrupt.gateNonce)),
    });
    expect(dupe.exitCode).not.toBe(0);
    expect(dupe.stderr.toLowerCase()).toContain("conflict");

    const unchanged = (await publicationsForDraft(ids.draftId))[0];
    expect(unchanged).toEqual(original);

    // A genuinely different draft gets its own publication and leaves the original alone.
    const otherIds = newIds();
    const otherStart = await runWorker({ mode: "start", ...otherIds });
    const other = await runWorker({
      mode: "resume",
      ...otherIds,
      decision: decisionFor(otherIds, String(otherStart.json!.interrupt.gateNonce)),
    });
    expect(other.exitCode).toBe(0);
    expect(await publicationsForDraft(ids.draftId)).toHaveLength(1);
    expect(await publicationsForDraft(otherIds.draftId)).toHaveLength(1);
    expect((await publicationsForDraft(ids.draftId))[0]).toEqual(original);
  }, 180_000);
});
