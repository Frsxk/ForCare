import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const schemasUrl = new URL("../src/knowledge/schemas.ts", import.meta.url);

async function schemas() {
  expect(existsSync(schemasUrl), "knowledge DTO schemas must be implemented").toBe(true);
  return import("../src/knowledge/schemas");
}

const request = { query: "cuci tangan", locale: "id" as const, limit: 20 };
const chunk = {
  chunkId: "00000000-0000-4000-8000-000000000001",
  documentId: "00000000-0000-4000-8000-000000000002",
  corpusId: "00000000-0000-4000-8000-000000000003",
  title: "Kebersihan tangan",
  version: 1,
  ordinal: 0,
  excerpt: "Cuci tangan dengan sabun dan air bersih.",
  score: 0.25,
};

describe("knowledge search DTO contract (no database)", () => {
  test("accepts the literal required body and only id/en locale values", async () => {
    const { knowledgeSearchSchema, knowledgeLocaleSchema, knowledgeStatusSchema } = await schemas();
    expect(knowledgeSearchSchema.parse(request)).toEqual(request);
    expect(knowledgeSearchSchema.parse({ ...request, query: " handwashing ", locale: "en", limit: 1 }))
      .toEqual({ query: "handwashing", locale: "en", limit: 1 });
    expect(knowledgeLocaleSchema.options).toEqual(["id", "en"]);
    expect(knowledgeStatusSchema.options).toEqual(["draft", "approved", "retired"]);
    for (const locale of ["ID", "id-ID", "en-US", "fr", "", null]) {
      expect(knowledgeSearchSchema.safeParse({ ...request, locale }).success).toBe(false);
    }
  });

  test("rejects missing keys, coercion, oversized input and arbitrary selectors", async () => {
    const { knowledgeSearchSchema } = await schemas();
    for (const key of Object.keys(request)) {
      const missing: Record<string, unknown> = { ...request };
      delete missing[key];
      expect(knowledgeSearchSchema.safeParse(missing).success).toBe(false);
    }
    for (const query of ["", "  \n ", "x".repeat(1001), 1, null]) {
      expect(knowledgeSearchSchema.safeParse({ ...request, query }).success).toBe(false);
    }
    expect(knowledgeSearchSchema.safeParse({ ...request, query: "x".repeat(1000) }).success).toBe(true);
    for (const limit of [0, -1, 21, 1.5, "20", null, Infinity]) {
      expect(knowledgeSearchSchema.safeParse({ ...request, limit }).success).toBe(false);
    }
    for (const field of ["patientId", "corpusId", "url", "approvedBy", "queryText"]) {
      expect(knowledgeSearchSchema.safeParse({ ...request, [field]: "untrusted" }).success).toBe(false);
    }
  });

  test("preserves every original response field with immutable document version and retrieval rank", async () => {
    const { knowledgeSearchResponseSchema, knowledgeSearchChunkSchema } = await schemas();
    const response = { chunks: [chunk], corpusVersion: 3 };
    expect(knowledgeSearchResponseSchema.parse(response)).toEqual(response);
    expect(Object.keys(knowledgeSearchChunkSchema.shape).sort()).toEqual(Object.keys(chunk).sort());
    for (const key of Object.keys(chunk)) {
      const missing: Record<string, unknown> = { ...chunk };
      delete missing[key];
      expect(knowledgeSearchChunkSchema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { version: 0 }, { version: "1" }, { ordinal: -1 }, { ordinal: 0.5 },
      { score: -1 }, { score: NaN }, { score: Infinity }, { chunkId: "latest" },
      { title: "" }, { excerpt: "" }, { clinicalScore: 0 }, { documentVersion: 1 },
    ]) {
      expect(knowledgeSearchChunkSchema.safeParse({ ...chunk, ...patch }).success).toBe(false);
    }
    expect(knowledgeSearchChunkSchema.safeParse({ ...chunk, score: 0 }).success).toBe(true);
    expect(knowledgeSearchChunkSchema.safeParse({ ...chunk, score: 2 }).success).toBe(true);
    expect(knowledgeSearchResponseSchema.safeParse({ ...response, answer: "generated" }).success).toBe(false);
    expect(knowledgeSearchResponseSchema.safeParse({ chunks: Array(21).fill(chunk), corpusVersion: 3 }).success).toBe(false);
  });

  test("defines corpusVersion as a positive integer for one selected corpus even on zero matches", async () => {
    const { knowledgeSearchResponseSchema, knowledgeCorpusVersionSchema } = await schemas();
    expect(knowledgeCorpusVersionSchema.description).toContain("knowledge_corpora.version");
    expect(knowledgeSearchResponseSchema.parse({ chunks: [], corpusVersion: 3 }))
      .toEqual({ chunks: [], corpusVersion: 3 });
    for (const corpusVersion of [null, 0, -1, 1.5, "3", { corpusId: chunk.corpusId, version: 3 }]) {
      expect(knowledgeSearchResponseSchema.safeParse({ chunks: [], corpusVersion }).success).toBe(false);
    }
    expect(knowledgeSearchResponseSchema.safeParse({ chunks: [] }).success).toBe(false);
    expect(knowledgeSearchResponseSchema.safeParse({
      chunks: [chunk, { ...chunk, corpusId: "00000000-0000-4000-8000-000000000004" }], corpusVersion: 3,
    }).success).toBe(false);
  });
});
