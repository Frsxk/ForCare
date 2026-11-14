import type { SQL } from "bun";
import type { AnalysisWorker } from "./worker";

type FailureStage = "review_scan" | "review_reconciliation" | "generation";

export function createAnalysisScheduler(options: {
  sql: SQL;
  worker: Pick<AnalysisWorker, "reconcileAnalysis" | "runNext">;
  now?: () => number;
  onError: (stage: FailureStage) => void;
}) {
  const batchSize = 10;
  const retryDelayMs = 30_000;
  const now = options.now ?? Date.now;
  let stopping = false;
  let activeTick: Promise<void> | null = null;
  let cursor: { created_at: Date | string; id: string } | null = null;
  let retryAt: number | null = null;

  async function iterate() {
    if (retryAt !== null && now() >= retryAt) {
      cursor = null;
      retryAt = null;
    }
    try {
      const rows = await options.sql`SELECT id, analysis_id, created_at FROM public.analysis_review_gates
        WHERE state = 'decided'
          AND (${cursor?.created_at ?? null}::timestamptz IS NULL
            OR (created_at, id) > (${cursor?.created_at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY created_at, id LIMIT ${batchSize}`;
      for (const row of rows) {
        if (stopping) return;
        // Advance even on failure. Do not alter a stale gate or its durable decision.
        cursor = { created_at: row.created_at as Date | string, id: row.id as string };
        try { await options.worker.reconcileAnalysis(row.analysis_id as string); }
        catch { options.onError("review_reconciliation"); }
      }
      // Keep looking beyond the cursor for new gates, but pause before wrapping
      // to old failures. Only bounded in-memory scheduling state is retained.
      if (cursor && rows.length < batchSize && retryAt === null) retryAt = now() + retryDelayMs;
    } catch { options.onError("review_scan"); }

    // Generation has its own slot on every tick, even if scanning/resume fails.
    if (!stopping) {
      try { await options.worker.runNext(); }
      catch { options.onError("generation"); }
    }
  }
  return {
    tick(): Promise<void> {
      if (stopping || activeTick) return Promise.resolve();
      activeTick = iterate().finally(() => { activeTick = null; });
      return activeTick;
    },
    async stop() { stopping = true; await activeTick; },
  };
}
