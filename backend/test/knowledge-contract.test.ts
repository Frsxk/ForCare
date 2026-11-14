import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadMigrations, MIGRATION_MANIFEST } from "../src/storage/migrate";

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

function table(sql: string, name: string): string {
  const definition = new RegExp(`CREATE TABLE public\\.${name} \\(\\n([\\s\\S]*?)\\n\\);`).exec(sql)?.[1];
  expect(definition, `${name} must retain its literal contract`).toBeDefined();
  return definition!;
}

async function migrationSql(): Promise<string> {
  const migration = (await loadMigrations()).find((file) => file.version === "0006");
  expect(migration, "0006_knowledge.sql must be present in the approved manifest").toBeDefined();
  expect(migration!.name).toBe("knowledge");
  return migration!.sql;
}

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

describe("0006 knowledge migration declarations (not executed DB invariants)", () => {
  test("uses the exact manifest entry, tables and literal fields plus additive timestamps", async () => {
    expect(MIGRATION_MANIFEST.find((entry) => entry.version === "0006"))
      .toEqual({ version: "0006", name: "knowledge" });
    const sql = await migrationSql();
    expect([...sql.matchAll(/CREATE TABLE public\.(\w+)/g)].map((match) => match[1]))
      .toEqual(["knowledge_corpora", "knowledge_documents", "knowledge_chunks"]);
    const fields: Record<string, string[]> = {
      knowledge_corpora: ["id", "name", "version", "status", "owner", "approved_by", "approved_at", "created_at", "updated_at"],
      knowledge_documents: ["id", "corpus_id", "title", "version", "status", "body", "checksum", "approved_by", "approved_at", "created_at", "updated_at"],
      knowledge_chunks: ["id", "document_id", "ordinal", "content", "tsv", "created_at"],
    };
    for (const [name, expected] of Object.entries(fields)) {
      const columns = [...table(sql, name).matchAll(/^  (\w+) (?:uuid|text|integer|timestamptz|tsvector)\b/gm)]
        .map((match) => match[1]);
      expect(columns).toEqual(expected);
    }
    expect(sql).not.toMatch(/\btimestamptz(?!\(3\))/);
    expect(sql).not.toMatch(/(?:INSERT INTO|ALTER TABLE|DROP TABLE|CREATE EXTENSION)/i);
  });

  test("declares literal uniqueness, restrict FKs, simple lexical index and exact chunk binding target", async () => {
    const sql = await migrationSql();
    expect(table(sql, "knowledge_corpora")).toContain("UNIQUE (name, version)");
    expect(table(sql, "knowledge_documents")).toContain("UNIQUE (corpus_id, title, version)");
    expect(table(sql, "knowledge_documents")).toMatch(/REFERENCES public\.knowledge_corpora \(id\) ON DELETE RESTRICT/);
    expect(table(sql, "knowledge_chunks")).toMatch(/REFERENCES public\.knowledge_documents \(id\) ON DELETE RESTRICT/);
    expect(table(sql, "knowledge_chunks")).toContain("UNIQUE (document_id, ordinal)");
    expect(table(sql, "knowledge_chunks")).toContain("UNIQUE (id, document_id)");
    expect(table(sql, "knowledge_chunks")).toContain("GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED");
    expect(sql).toMatch(/ON public\.knowledge_chunks USING gin \(tsv\)/);
  });

  test("declares approval consistency and guards for immutable content, frozen membership and irreversible retirement", async () => {
    const sql = await migrationSql();
    for (const name of ["knowledge_corpora", "knowledge_documents"]) {
      const definition = table(sql, name);
      expect(definition).toContain("status IN ('draft', 'approved', 'retired')");
      expect(definition).toContain("status = 'draft' AND approved_by IS NULL AND approved_at IS NULL");
      expect(definition).toContain("status IN ('approved', 'retired') AND approved_by IS NOT NULL AND approved_at IS NOT NULL");
      expect(definition).toMatch(/REFERENCES public\.staff \(id\) ON DELETE RESTRICT/);
      expect(sql).toContain(`BEFORE INSERT ON public.${name}`);
      expect(sql).toContain(`BEFORE UPDATE ON public.${name}`);
      expect(sql).toContain(`BEFORE DELETE ON public.${name}`);
    }
    for (const name of ["knowledge_corpora", "knowledge_documents", "knowledge_chunks"]) {
      expect(sql).toContain(`BEFORE TRUNCATE ON public.${name}`);
    }
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON public.knowledge_chunks");
    expect(sql).toContain("BEFORE INSERT ON public.knowledge_chunks");
    expect(sql).toContain("OLD.status = 'draft' AND NEW.status = 'approved'");
    expect(sql).toContain("OLD.status = 'approved' AND NEW.status = 'retired'");
    expect(sql).toContain("knowledge approval provenance is immutable");
    expect(sql).toContain("all corpus documents must be approved before corpus approval");
    expect(sql).toContain("knowledge chunk membership is fixed at document approval");
    expect(sql).toContain("knowledge document membership is fixed at corpus approval");
    expect(sql).toContain("knowledge snapshot content is immutable");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("REVOKE ALL ON TABLE");
  });
});
