import type { SQL } from "bun";
import type { AuthConfig } from "../config";
import { nurseIdentityValid } from "../auth/policy";
import { loadPrincipal } from "../auth/repository";
import { AppError } from "../http/errors";
import { parseStrict } from "../http/request";
import { FIXED_CORPUS_NAME } from "./corpus";
import { knowledgeSearchSchema, knowledgeSearchResponseSchema, type KnowledgeSearch, type KnowledgeSearchResponse } from "./schemas";

/** Caller holds a transaction; share locks keep eligibility valid until it ends. */
export async function requireKnowledgeNurse(sql: SQL, staffId: string, config: AuthConfig, accountId?: string) {
  const rows = await sql`
    SELECT a.id AS account_id FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles r ON r.account_id = a.id
    WHERE s.id = ${staffId} AND s.active AND a.status = 'active' AND r.role = 'nurse'
    FOR SHARE OF s, a, r
  `;
  const id = rows[0]?.account_id as string | undefined;
  if (!id || (accountId !== undefined && id !== accountId)) {
    throw new AppError("FORBIDDEN", "An active approved nurse identity is required", 403);
  }
  const principal = await loadPrincipal(sql, id);
  if (!principal || !nurseIdentityValid(principal, config)) {
    throw new AppError("FORBIDDEN", "An active approved nurse identity is required", 403);
  }
  return id;
}

export type KnowledgeRetrieval = KnowledgeSearchResponse & { corpusId: string };

/** Internal graph primitive: pass the caller's transaction SQL. Authorization and
 * patient context belong to that caller. Returns immutable revision IDs, never
 * a raw 'latest' alias. Selection and ranking share one PostgreSQL snapshot.
 * Both locales search bilingual content with the simple lexical dictionary.
 */
export async function retrieveKnowledge(sql: SQL, input: KnowledgeSearch): Promise<KnowledgeRetrieval> {
  const parsed = parseStrict(knowledgeSearchSchema, input);
  const rows = await sql`
    WITH selected AS (
      SELECT id, version FROM public.knowledge_corpora
      WHERE name = ${FIXED_CORPUS_NAME} AND status = 'approved'
      ORDER BY version DESC, id LIMIT 1
    ), search_query AS (SELECT plainto_tsquery('simple', ${parsed.query}) AS q)
    SELECT c.id AS corpus_id, c.version AS corpus_version, hit.*
    FROM selected c
    LEFT JOIN LATERAL (
      SELECT k.id AS chunk_id, d.id AS document_id, d.title, d.version,
             k.ordinal, k.content AS excerpt, ts_rank_cd(k.tsv, q.q)::double precision AS score
      FROM public.knowledge_documents d
      JOIN public.knowledge_chunks k ON k.document_id = d.id
      CROSS JOIN search_query q
      WHERE d.corpus_id = c.id AND d.status = 'approved' AND k.tsv @@ q.q
        AND NOT EXISTS (
          SELECT 1 FROM public.knowledge_documents newer
          WHERE newer.corpus_id = c.id AND newer.title = d.title
            AND newer.status = 'approved' AND newer.version > d.version
        )
      ORDER BY score DESC, d.id, k.ordinal, k.id LIMIT ${parsed.limit}
    ) hit ON true
    ORDER BY hit.score DESC NULLS LAST, hit.document_id, hit.ordinal, hit.chunk_id
  `;
  if (!rows.length) throw new AppError("GATE_UNAVAILABLE", "Approved knowledge corpus is unavailable", 503, { gate: "G05" });
  const corpusId = rows[0]!.corpus_id as string;
  const typedRows = rows as Array<{ corpus_id: string; corpus_version: number; chunk_id: string | null; document_id: string; title: string; version: number; ordinal: number; excerpt: string; score: number }>;
  const response = knowledgeSearchResponseSchema.parse({
    corpusVersion: rows[0]!.corpus_version,
    chunks: typedRows.filter((row) => row.chunk_id !== null).map((row) => ({
      chunkId: row.chunk_id, documentId: row.document_id, corpusId,
      title: row.title, version: row.version, ordinal: row.ordinal, excerpt: row.excerpt, score: row.score,
    })),
  });
  return { corpusId, ...response };
}
