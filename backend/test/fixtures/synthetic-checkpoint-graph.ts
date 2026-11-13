/**
 * Synthetic LangGraph checkpoint graph for the T03 spike.
 *
 * Shape: prepare -> await_approval (interrupt) -> publish.
 * All content is synthetic; no model, provider or clinical data is involved.
 */

import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { randomUUID } from "node:crypto";
import {
  SYNTHETIC_GATE,
  assertResumableDecision,
  type SyntheticDecision,
  type SyntheticPublicationStore,
} from "./synthetic-publication-store";

export type SyntheticCheckpointOptions = {
  crashAfterPrepare?: boolean;
  crashAfterPublish?: boolean;
};

export const SYNTHETIC_CRASH_EXIT_CODE = 42;

const SyntheticState = Annotation.Root({
  threadId: Annotation<string>(),
  draftId: Annotation<string>(),
  draftVersion: Annotation<number>(),
  gateNonce: Annotation<string>(),
  decision: Annotation<SyntheticDecision | null>(),
  publishedEffectId: Annotation<string | null>(),
});

export type SyntheticStateValues = typeof SyntheticState.State;

export function createSyntheticCheckpointGraph(
  checkpointer: BaseCheckpointSaver,
  store: SyntheticPublicationStore,
  options: SyntheticCheckpointOptions = {},
) {
  async function prepare(state: SyntheticStateValues) {
    const gateNonce = state.gateNonce || randomUUID();

    // Unguarded, append-only audit: a crash before checkpointing makes this replay visibly.
    await store.recordPrepareAttempt({
      threadId: state.threadId,
      draftId: state.draftId,
      draftVersion: state.draftVersion,
      gateNonce,
    });
    // Guarded durable pre-interrupt effect: replay must not duplicate it.
    await store.recordGuardedPrepare({
      threadId: state.threadId,
      draftId: state.draftId,
      draftVersion: state.draftVersion,
    });

    if (options.crashAfterPrepare) process.exit(SYNTHETIC_CRASH_EXIT_CODE);
    return { gateNonce };
  }

  function awaitApproval(state: SyntheticStateValues) {
    const decision = interrupt<Record<string, unknown>, SyntheticDecision>({
      gate: SYNTHETIC_GATE,
      threadId: state.threadId,
      draftId: state.draftId,
      draftVersion: state.draftVersion,
      gateNonce: state.gateNonce,
    });

    // Validate before publishing. LangGraph retains an invalid resume value on
    // the failed task; a new payload does not replace it. Tests characterize
    // explicit fresh-nonce re-entry without prescribing production recovery.
    const validated = assertResumableDecision(decision, {
      threadId: state.threadId,
      draftId: state.draftId,
      draftVersion: state.draftVersion,
      gateNonce: state.gateNonce,
    });
    return { decision: validated };
  }

  async function publish(state: SyntheticStateValues) {
    const decision = assertResumableDecision(state.decision, {
      threadId: state.threadId,
      draftId: state.draftId,
      draftVersion: state.draftVersion,
      gateNonce: state.gateNonce,
    });

    const { effectId } = await store.publish({
      threadId: state.threadId,
      draftId: state.draftId,
      draftVersion: state.draftVersion,
      decision,
    });

    // Simulate death after the publication commits but before the graph checkpoints.
    if (options.crashAfterPublish) process.exit(SYNTHETIC_CRASH_EXIT_CODE);
    return { publishedEffectId: effectId };
  }

  return new StateGraph(SyntheticState)
    .addNode("prepare", prepare)
    .addNode("await_approval", awaitApproval)
    .addNode("publish", publish)
    .addEdge(START, "prepare")
    .addEdge("prepare", "await_approval")
    .addEdge("await_approval", "publish")
    .addEdge("publish", END)
    .compile({ checkpointer });
}
