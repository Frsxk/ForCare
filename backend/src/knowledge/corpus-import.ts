import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import type { AuthConfig } from "../config";
import { AppError } from "../http/errors";
import { isUuid } from "../http/request";
import { writeAuditEvent } from "../http/audit";
import { FIXED_CORPUS_NAME, FIXED_CORPUS_VERSION, FIXED_CORPUS_OWNER, FIXED_KNOWLEDGE_DOCUMENTS, knowledgeChecksum } from "./corpus";
import { requireKnowledgeNurse } from "./repository";
import type { KnowledgeStatus } from "./schemas";

export type FixedCorpusImportResult = { corpusId: string; corpusVersion: number; status: KnowledgeStatus; documentIds: string[] };
function mismatch(): never {
  throw new AppError("VERSION_CONFLICT", "Stored fixed corpus differs from the shipped immutable manifest; a new reviewed revision is required", 409);
}

/** Fixed content only. Approval is opt-in, never inferred from a repeat import.
 * READ COMMITTED is required and enforced by DB guards, including direct SQL.
 */
export async function importFixedKnowledgeCorpus(options: {
  sql: SQL; config: AuthConfig; approveBy?: string;
}): Promise<FixedCorpusImportResult> {
  if (options.approveBy !== undefined && !isUuid(options.approveBy)) {
    throw new AppError("VALIDATION_FAILED", "--approve-by must be an existing staff UUID", 422);
  }
  return options.sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
    await tx`SELECT pg_advisory_xact_lock(4868321543216)`;
    const actorAccountId = options.approveBy === undefined ? null
      : await requireKnowledgeNurse(tx, options.approveBy, options.config);
    const requestId = randomUUID();
    let [corpus] = await tx`SELECT id, status, owner FROM public.knowledge_corpora WHERE name = ${FIXED_CORPUS_NAME} AND version = ${FIXED_CORPUS_VERSION} FOR UPDATE`;
    if (!corpus) {
      [corpus] = await tx`INSERT INTO public.knowledge_corpora (name, version, owner) VALUES (${FIXED_CORPUS_NAME}, ${FIXED_CORPUS_VERSION}, ${FIXED_CORPUS_OWNER}) RETURNING id, status, owner`;
      for (const document of FIXED_KNOWLEDGE_DOCUMENTS) {
        const [row] = await tx`INSERT INTO public.knowledge_documents (corpus_id, title, version, body, checksum) VALUES (${corpus!.id}, ${document.title}, ${document.version}, ${document.body}, ${document.checksum}) RETURNING id`;
        for (const [ordinal, content] of document.chunks.entries()) {
          await tx`INSERT INTO public.knowledge_chunks (document_id, ordinal, content) VALUES (${row!.id}, ${ordinal}, ${content})`;
        }
      }
      await writeAuditEvent(tx, { actorAccountId: null, action: "knowledge.corpus.imported", subjectType: "knowledge_corpus", subjectId: corpus!.id, requestId, after: { name: FIXED_CORPUS_NAME, version: FIXED_CORPUS_VERSION, status: "draft" } });
    }
    if (corpus!.owner !== FIXED_CORPUS_OWNER || corpus!.status === "retired") mismatch();
    const stored = await tx`SELECT id, title, version, body, checksum, status FROM public.knowledge_documents WHERE corpus_id = ${corpus!.id} ORDER BY title, version`;
    if (stored.length !== FIXED_KNOWLEDGE_DOCUMENTS.length) mismatch();
    const documentIds: string[] = [];
    for (const expected of FIXED_KNOWLEDGE_DOCUMENTS) {
      const document = stored.find((row: { title: string; version: number }) => row.title === expected.title && row.version === expected.version);
      if (!document || document.status === "retired" || document.body !== expected.body
        || document.checksum !== expected.checksum || knowledgeChecksum(document.body) !== document.checksum
        || (corpus!.status === "approved" && document.status !== "approved")) mismatch();
      const chunks = await tx`SELECT ordinal, content FROM public.knowledge_chunks WHERE document_id = ${document.id} ORDER BY ordinal`;
      if (chunks.length !== expected.chunks.length || chunks.some((chunk: { ordinal: number; content: string }, i: number) => chunk.ordinal !== i || chunk.content !== expected.chunks[i])) mismatch();
      documentIds.push(document.id);
    }
    if (options.approveBy !== undefined && corpus!.status === "draft") {
      for (const id of documentIds) {
        await tx`UPDATE public.knowledge_documents SET status = 'approved', approved_by = ${options.approveBy}, approved_at = now() WHERE id = ${id} AND status = 'draft'`;
      }
      await tx`UPDATE public.knowledge_corpora SET status = 'approved', approved_by = ${options.approveBy}, approved_at = now() WHERE id = ${corpus!.id}`;
      await writeAuditEvent(tx, { actorAccountId, action: "knowledge.corpus.approved", subjectType: "knowledge_corpus", subjectId: corpus!.id, requestId, after: { version: FIXED_CORPUS_VERSION, approvedBy: options.approveBy, notice: "Operator attestation only; synthetic fixture approval is not real clinical validation" } });
    }
    // Read back the authoritative target before reporting a successful import.
    const [saved] = await tx`SELECT status FROM public.knowledge_corpora WHERE id = ${corpus!.id}`;
    return { corpusId: corpus!.id, corpusVersion: FIXED_CORPUS_VERSION, status: saved!.status as KnowledgeStatus, documentIds };
  });
}
