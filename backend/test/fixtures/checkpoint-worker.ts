/**
 * Child-process entry point for the checkpoint spike.
 *
 * Each invocation is a real, short-lived Bun process: it builds a fresh
 * PostgresSaver on the dedicated test database, runs one graph phase, closes
 * the pool, and exits. Crash modes exit hard from inside a node so the graph
 * never gets to persist the node's checkpoint.
 *
 * Usage: bun run checkpoint-worker.ts '<json job>'
 * Only FORCARE_CHECKPOINT_TEST_DATABASE_URL is read from the environment.
 */

import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { readCheckpointTestTarget } from "./checkpoint-test-target";
import { createSyntheticCheckpointGraph } from "./synthetic-checkpoint-graph";
import { createSyntheticPublicationStore, type SyntheticDecision } from "./synthetic-publication-store";

type WorkerJob = {
  mode: "setup" | "start" | "resume";
  threadId?: string;
  draftId?: string;
  draftVersion?: number;
  decision?: SyntheticDecision;
  crashAfter?: "prepare" | "publish";
};

const rawJob = process.argv[2];
if (!rawJob) {
  console.error("checkpoint-worker-error: missing job payload");
  process.exit(1);
}

const job = JSON.parse(rawJob) as WorkerJob;
const target = readCheckpointTestTarget(process.env);
const password = decodeURIComponent(new URL(target.url).password);

function sanitize(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replaceAll(target.url, "[redacted-database-url]").replaceAll(password, "[redacted]").slice(0, 500);
}

function fail(error: unknown): never {
  console.error(`checkpoint-worker-error: ${sanitize(error)}`);
  process.exit(1);
}

if (job.mode !== "setup" && (!job.threadId || !job.draftId || !job.draftVersion)) {
  fail(new Error("start and resume jobs require threadId, draftId and draftVersion"));
}

const saver = PostgresSaver.fromConnString(target.url);
const store = createSyntheticPublicationStore(target);
// Workers never initialize the schema; setup() is owned by one separate runtime.
const graph = createSyntheticCheckpointGraph(saver, store, {
  crashAfterPrepare: job.crashAfter === "prepare",
  crashAfterPublish: job.crashAfter === "publish",
});

try {
  if (job.mode === "setup") {
    await saver.setup();
    await store.ensureSchema();
    console.log(JSON.stringify({ ok: true, pid: process.pid }));
  } else {
    const config = { configurable: { thread_id: job.threadId! } };
    const result = (await graph.invoke(
      job.mode === "start"
        ? {
            threadId: job.threadId,
            draftId: job.draftId,
            draftVersion: job.draftVersion,
            gateNonce: "",
            decision: null,
            publishedEffectId: null,
          }
        : new Command({ resume: job.decision }),
      config,
    )) as Record<string, unknown>;

    const interrupts = result.__interrupt__ as Array<{ value?: Record<string, unknown> }> | undefined;
    console.log(
      JSON.stringify({
        phase: interrupts?.length ? "interrupted" : "completed",
        pid: process.pid,
        interrupt: interrupts?.[0]?.value ?? null,
        publishedEffectId: result.publishedEffectId ?? null,
      }),
    );
  }
} catch (error) {
  console.error(`checkpoint-worker-error: ${sanitize(error)}`);
  process.exitCode = 1;
} finally {
  await store.close();
  await saver.end();
}
