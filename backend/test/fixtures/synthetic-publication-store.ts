/**
 * Synthetic publication store for the checkpoint spike.
 *
 * Test-only. It exists to prove two things against a real PostgreSQL server:
 * a guarded pre-interrupt effect does not duplicate when the work replays, and
 * a publication effect is inserted at most once per immutable draft binding,
 * even across worker crashes and duplicate resumes.
 *
 * No clinical data, no product tables, no domain authorization.
 */

import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import type { CheckpointTestTarget } from "./checkpoint-test-target";

export const SYNTHETIC_GATE = "synthetic-publication-gate";

export type SyntheticDecision = {
  gate: string;
  threadId: string;
  draftId: string;
  draftVersion: number;
  gateNonce: string;
  decisionId: string;
  status: "approved" | "rejected";
  /** Synthetic label only. This spike implements no authentication or role checks. */
  authority: string;
};

export type PublicationRow = {
  id: string;
  draft_id: string;
  draft_version: number;
  thread_id: string;
  gate: string;
  decision_id: string;
  effect: string;
  created_at: string;
};

export type GateExpectation = {
  threadId: string;
  draftId: string;
  draftVersion: number;
  gateNonce: string;
  gate?: string;
};

export type SyntheticPublicationStore = {
  ensureSchema(): Promise<void>;
  recordPrepareAttempt(input: {
    threadId: string;
    draftId: string;
    draftVersion: number;
    gateNonce: string;
  }): Promise<void>;
  recordGuardedPrepare(input: {
    threadId: string;
    draftId: string;
    draftVersion: number;
  }): Promise<{ created: boolean }>;
  publish(input: {
    threadId: string;
    draftId: string;
    draftVersion: number;
    decision: SyntheticDecision;
  }): Promise<{ effectId: string; created: boolean }>;
  close(): Promise<void>;
};

/**
 * Structural binding check between the persisted interrupt and a resume payload.
 *
 * This is deliberately NOT authorization: any client holding the synthetic
 * nonce can satisfy it. It only proves the decision belongs to this gate, this
 * thread, this immutable draft version and this pause.
 */
export function assertResumableDecision(
  decision: SyntheticDecision | null | undefined,
  expected: GateExpectation,
): SyntheticDecision {
  const gate = expected.gate ?? SYNTHETIC_GATE;
  if (!decision || typeof decision !== "object") {
    throw new Error("checkpoint publish requires a persisted gate decision");
  }
  if (decision.gate !== gate) {
    throw new Error("checkpoint decision refused: decision targets a different gate");
  }
  if (decision.threadId !== expected.threadId) {
    throw new Error("checkpoint decision refused: decision is bound to a different thread");
  }
  if (decision.draftId !== expected.draftId || decision.draftVersion !== expected.draftVersion) {
    throw new Error("checkpoint decision refused: decision is bound to a different draft version");
  }
  if (!decision.gateNonce || decision.gateNonce !== expected.gateNonce) {
    throw new Error("checkpoint decision refused: decision is bound to a stale or foreign pause");
  }
  if (typeof decision.decisionId !== "string" || decision.decisionId.length < 8) {
    throw new Error("checkpoint decision refused: decision id is missing");
  }
  if (decision.status !== "approved") {
    throw new Error("checkpoint decision refused: decision is not an approval");
  }
  return decision;
}

export function syntheticEffect(draftId: string, draftVersion: number): string {
  return `synthetic-publication:${draftId}:v${draftVersion}`;
}

export function createSyntheticPublicationStore(target: CheckpointTestTarget): SyntheticPublicationStore {
  const sql = new SQL({ url: target.url, max: 2, idleTimeout: 5, connectionTimeout: 5 });

  return {
    async ensureSchema() {
      await sql`
        CREATE TABLE IF NOT EXISTS synthetic_checkpoint_prepare_attempts (
          attempt_id uuid PRIMARY KEY,
          thread_id text NOT NULL,
          draft_id text NOT NULL,
          draft_version integer NOT NULL,
          gate_nonce text NOT NULL,
          attempted_at timestamptz NOT NULL DEFAULT now()
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS synthetic_checkpoint_guarded_prepare (
          draft_id text NOT NULL,
          draft_version integer NOT NULL,
          thread_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (draft_id, draft_version)
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS synthetic_checkpoint_publications (
          id uuid PRIMARY KEY,
          draft_id text NOT NULL,
          draft_version integer NOT NULL,
          thread_id text NOT NULL,
          gate text NOT NULL,
          decision_id text NOT NULL,
          effect text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT synthetic_checkpoint_publications_once
            UNIQUE (draft_id, draft_version, gate)
        )`;
    },

    async recordPrepareAttempt({ threadId, draftId, draftVersion, gateNonce }) {
      await sql`
        INSERT INTO synthetic_checkpoint_prepare_attempts
          (attempt_id, thread_id, draft_id, draft_version, gate_nonce)
        VALUES (${randomUUID()}, ${threadId}, ${draftId}, ${draftVersion}, ${gateNonce})`;
    },

    async recordGuardedPrepare({ threadId, draftId, draftVersion }) {
      const inserted = (await sql`
        INSERT INTO synthetic_checkpoint_guarded_prepare (draft_id, draft_version, thread_id)
        VALUES (${draftId}, ${draftVersion}, ${threadId})
        ON CONFLICT (draft_id, draft_version) DO NOTHING
        RETURNING draft_id`) as unknown as unknown[];
      return { created: inserted.length === 1 };
    },

    async publish({ threadId, draftId, draftVersion, decision }) {
      const effect = syntheticEffect(draftId, draftVersion);
      return sql.begin(async (tx) => {
        const inserted = (await tx`
          INSERT INTO synthetic_checkpoint_publications
            (id, draft_id, draft_version, thread_id, gate, decision_id, effect)
          VALUES (${randomUUID()}, ${draftId}, ${draftVersion}, ${threadId}, ${decision.gate},
                  ${decision.decisionId}, ${effect})
          ON CONFLICT (draft_id, draft_version, gate) DO NOTHING
          RETURNING id`) as unknown as Array<{ id: string }>;

        if (inserted.length === 1) {
          return { effectId: inserted[0].id, created: true };
        }

        const existing = (await tx`
          SELECT id, draft_id, draft_version, thread_id, gate, decision_id, effect
          FROM synthetic_checkpoint_publications
          WHERE draft_id = ${draftId} AND draft_version = ${draftVersion} AND gate = ${decision.gate}
          FOR UPDATE`) as unknown as PublicationRow[];

        const row = existing[0];
        if (!row) {
          throw new Error("synthetic publication conflict without an existing effect");
        }
        if (row.decision_id !== decision.decisionId || row.thread_id !== threadId) {
          throw new Error("conflicting decision cannot reuse an existing synthetic publication");
        }
        return { effectId: row.id, created: false };
      });
    },

    async close() {
      await sql.close();
    },
  };
}
