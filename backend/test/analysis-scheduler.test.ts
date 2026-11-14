import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createAnalysisScheduler } from "../src/analysis/scheduler";

function fixture(count = 2) {
  const gates = Array.from({ length: count }, (_, index) => ({
    id: String(index + 1).padStart(4, "0"), analysis_id: `patient-${index + 1}-analysis`,
    created_at: "2026-01-01T00:00:00.000Z", state: "decided", review_id: `review-${index + 1}`,
  }));
  const queries: unknown[][] = [];
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(values);
    // The production query uses a nullable (created_at, id) keyset and a bound limit.
    const [createdAt, , id, limit] = values as [string | null, string | null, string | null, number];
    return gates.filter((gate) => gate.state === "decided" && (createdAt === null
      || gate.created_at > createdAt || (gate.created_at === createdAt && gate.id > id!))).slice(0, limit);
  }) as unknown as SQL;
  const attempts: string[] = [];
  const errors: string[] = [];
  const generated: string[] = [];
  const queued = ["other-patient-job"];
  let generationSlots = 0;
  let now = 0;
  const worker = {
    async reconcileAnalysis(id: string) {
      attempts.push(id);
      if (id === gates[0]!.analysis_id) {
        const error = new Error("sensitive patient details and database connection");
        error.name = "sensitive error name";
        throw error;
      }
      gates.find((gate) => gate.analysis_id === id)!.state = "reconciled";
      return true;
    },
    async runNext() {
      generationSlots++;
      const job = queued.shift();
      if (!job) return "idle" as const;
      generated.push(job);
      return "interrupted" as const;
    },
  };
  const scheduler = createAnalysisScheduler({ sql, worker, now: () => now,
    onError: (stage) => { errors.push(stage); } });
  return { scheduler, worker, gates, attempts, errors, generated, queries,
    generationSlots: () => generationSlots, advance: (ms: number) => { now += ms; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("production analysis scheduler", () => {
  test("a stale earliest gate cannot starve a later decision or another patient's queued generation", async () => {
    const f = fixture();
    await f.scheduler.tick();
    expect(f.attempts).toEqual(f.gates.map((gate) => gate.analysis_id));
    expect(f.gates[0]).toMatchObject({ state: "decided", review_id: "review-1" });
    expect(f.gates[1]).toMatchObject({ state: "reconciled", review_id: "review-2" });
    expect(f.generated).toEqual(["other-patient-job"]);
    expect(f.errors).toEqual(["review_reconciliation"]);
    expect(JSON.stringify(f.errors)).not.toContain("sensitive");
  });

  test("bounded keyset batches advance past failures and retry only after the sweep cooldown", async () => {
    const f = fixture(23);
    await f.scheduler.tick();
    expect(f.attempts).toHaveLength(10);
    await f.scheduler.tick();
    expect(f.attempts).toHaveLength(20);
    await f.scheduler.tick();
    expect(f.attempts).toHaveLength(23);
    for (let i = 0; i < 20; i++) { f.advance(1000); await f.scheduler.tick(); }
    expect(f.attempts).toHaveLength(23);
    expect(f.generationSlots()).toBe(23);
    f.advance(10000);
    await f.scheduler.tick();
    expect(f.attempts).toHaveLength(24);
    expect(f.attempts[23]).toBe(f.gates[0]!.analysis_id);
  });

  test("new tail gates progress while an older stale gate is cooling down", async () => {
    const f = fixture(1);
    await f.scheduler.tick();
    f.gates.push({ id: "0002", analysis_id: "later-patient-analysis", created_at: "2026-01-02T00:00:00.000Z",
      state: "decided", review_id: "review-2" });
    await f.scheduler.tick();
    expect(f.attempts).toEqual([f.gates[0]!.analysis_id, "later-patient-analysis"]);
    expect(f.gates[1]!.state).toBe("reconciled");
  });

  test("scan and generation failures expose only fixed stages and do not poison the next tick", async () => {
    const f = fixture(0);
    let scans = 0;
    const scheduler = createAnalysisScheduler({
      sql: (async () => { if (scans++ === 0) throw new Error("private SQL"); return []; }) as unknown as SQL,
      worker: { ...f.worker, runNext: async () => { throw new Error("private provider error"); } },
      onError: (stage) => { f.errors.push(stage); },
    });
    await scheduler.tick();
    await scheduler.tick();
    expect(f.errors).toEqual(["review_scan", "generation", "generation"]);
  });

  test("a decision made behind the cursor is discovered on the next sweep", async () => {
    const f = fixture(3);
    f.gates[1]!.state = "waiting";
    await f.scheduler.tick();
    expect(f.attempts).toEqual([f.gates[0]!.analysis_id, f.gates[2]!.analysis_id]);
    f.gates[1]!.state = "decided";
    f.advance(30000);
    await f.scheduler.tick();
    expect(f.gates[1]!.state).toBe("reconciled");
    expect(f.attempts).toHaveLength(4);
  });

  test("transient failures can recover without resetting or replacing their stored decisions", async () => {
    const f = fixture(1);
    await f.scheduler.tick();
    f.worker.reconcileAnalysis = async (id) => {
      f.attempts.push(id);
      f.gates[0]!.state = "reconciled";
      return true;
    };
    f.advance(30000);
    await f.scheduler.tick();
    expect(f.gates[0]).toMatchObject({ state: "reconciled", review_id: "review-1" });
    expect(f.attempts).toHaveLength(2);
  });

  test("shutdown waits for in-flight reconciliation, suppresses overlap and starts no more work", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.worker.reconcileAnalysis = async (id) => { f.attempts.push(id); entered.resolve(); await release.promise; return true; };
    const tick = f.scheduler.tick();
    await entered.promise;
    await f.scheduler.tick();
    let stopped = false;
    const stop = f.scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
    expect(f.attempts).toHaveLength(1);
    expect(f.generated).toHaveLength(0);
    await f.scheduler.tick();
    expect(f.attempts).toHaveLength(1);
  });

  test("shutdown also waits for in-flight generation before resources can close", async () => {
    const f = fixture(0);
    const entered = deferred();
    const release = deferred();
    f.worker.runNext = async () => { entered.resolve(); await release.promise; return "interrupted" as const; };
    const tick = f.scheduler.tick();
    await entered.promise;
    let stopped = false;
    const stop = f.scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
  });
});
