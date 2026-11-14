import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { validateGeneratedClaims } from "../src/analysis/worker";
import { analysisInputSnapshotSchema } from "../src/analysis/schemas";

const checkInId = randomUUID();
const observationId = randomUUID();
const knowledgeChunkId = randomUUID();
const snapshot = analysisInputSnapshotSchema.parse({
  locale: "id", medicalRecordVersionId: randomUUID(),
  medicalRecord: { primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null,
    allergies: [], procedures: [], complaints: null, observations: [] },
  checkIn: { condition: "complaint", note: "Synthetic", medicationAdherence: "regular", observations: [{
    observationId, type: "temperature_c", value: 36.8, unit: "c", observedAt: "2026-11-14T00:00:00.000Z",
  }] },
  sourceIds: [], orderIds: [], corpusId: randomUUID(), corpusVersion: 1,
});
const retrieved = [{ chunkId: knowledgeChunkId, documentId: randomUUID(), corpusId: snapshot.corpusId,
  title: "Synthetic", version: 1, ordinal: 0, excerpt: "Synthetic", content: "Synthetic", score: 1 }];

describe("analysis model evidence validation", () => {
  test("accepts only evidence in the exact bound input", () => {
    const claims = validateGeneratedClaims({ claims: [{ text: "Synthetic observation", claimType: "observation_summary",
      evidence: [{ checkInId, observationId, knowledgeChunkId }] }] }, snapshot, checkInId, retrieved);
    expect(claims).toHaveLength(1);
    for (const patch of [{ checkInId: randomUUID() }, { observationId: randomUUID() }, { knowledgeChunkId: randomUUID() }]) {
      expect(() => validateGeneratedClaims({ claims: [{ text: "Synthetic", claimType: "concern", evidence: [{ ...patch }] }] }, snapshot, checkInId, retrieved)).toThrow();
    }
  });

  test("rejects empty, excess, malformed and foreign output fields", () => {
    for (const output of [{ claims: [] }, { claims: [{ text: "Synthetic", claimType: "concern", evidence: [] }] },
      { claims: [{ text: "Synthetic", claimType: "concern", evidence: [{ checkInId }], patientFacing: false }] },
      { claims: [{ text: "Synthetic", claimType: "diagnosis", evidence: [{ checkInId }] }] },
      { claims: Array.from({ length: 51 }, () => ({ text: "Synthetic", claimType: "concern", evidence: [{ checkInId }] })) }]) {
      expect(() => validateGeneratedClaims(output, snapshot, checkInId, retrieved)).toThrow();
    }
  });
});
