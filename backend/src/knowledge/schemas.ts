import { z } from "zod";

export const knowledgeLocaleSchema = z.enum(["id", "en"]);
export const knowledgeStatusSchema = z.enum(["draft", "approved", "retired"]);

export const knowledgeSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(1000),
    locale: knowledgeLocaleSchema,
    limit: z.number().int().min(1).max(20),
  })
  .strict();

// One search selects one approved shipped corpus revision. This is its immutable
// integer version, including when there are no matches; it is not a workflow
// counter or a document version. No approved corpus means an unavailable error,
// not a successful response with a fabricated zero/null version.
export const knowledgeCorpusVersionSchema = z.number().int().min(1).describe(
  "Immutable knowledge_corpora.version of the single selected approved corpus, including zero matches",
);

export const knowledgeSearchChunkSchema = z
  .object({
    chunkId: z.string().uuid(),
    documentId: z.string().uuid(),
    corpusId: z.string().uuid(),
    title: z.string().min(1).max(200),
    version: z.number().int().min(1).describe("Immutable knowledge_documents.version"),
    ordinal: z.number().int().min(0),
    excerpt: z.string().min(1).max(20000),
    score: z.number().finite().min(0).describe("Lexical retrieval rank, never a clinical score"),
  })
  .strict();

export const knowledgeSearchResponseSchema = z
  .object({
    chunks: z.array(knowledgeSearchChunkSchema).max(20),
    corpusVersion: knowledgeCorpusVersionSchema,
  })
  .strict()
  .refine(
    ({ chunks }) => chunks.every((chunk) => chunk.corpusId === chunks[0]?.corpusId),
    "All chunks must belong to the single selected corpus revision",
  );

export type KnowledgeLocale = z.infer<typeof knowledgeLocaleSchema>;
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
export type KnowledgeSearch = z.infer<typeof knowledgeSearchSchema>;
export type KnowledgeSearchChunk = z.infer<typeof knowledgeSearchChunkSchema>;
export type KnowledgeSearchResponse = z.infer<typeof knowledgeSearchResponseSchema>;
