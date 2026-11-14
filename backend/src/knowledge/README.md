# Fixed knowledge retrieval

Knowledge snapshot mutations (corpus/document/chunk insert, update, deletion,
truncation) support **READ COMMITTED only**. Migration 0006 guards reject other
isolation levels with SQLSTATE `0A000`, including REPEATABLE READ and SERIALIZABLE.
Parent-row locks do not refresh an old transaction snapshot. The operator importer
explicitly starts READ COMMITTED; callers must not remove these DB checks.
Content, membership identifiers and versions are immutable. Only explicit
`draft -> approved -> retired` workflow changes are permitted. No content editing,
user ingestion, file import, URL fetching or automatic approval is implemented.

## Operator command

Run with standard server/database **and auth** environment configuration:

```sh
bun run scripts/knowledge-corpus.ts
bun run scripts/knowledge-corpus.ts --approve-by EXISTING_ACTIVE_NURSE_STAFF_UUID
```

No arguments imports the fixed version as DRAFT. `--approve-by` is the only flag;
it explicitly records the existing active provisioned nurse's staff UUID and time,
with an audit event bound to that nurse's account. This is a trusted operator
command, not an HTTP self-service authority grant or proof of operator identity.
The operator must be authorized to attest for that signer. Synthetic fixture
approval is **not real clinical validation**; the CLI always prints that warning.
A repeated import verifies owner, exact document membership/title/version, body,
SHA-256 and ordered chunk membership/content before considering approval. It
never repairs a mismatch, revives retired content, or silently approves on rerun.
Changing the shipped content requires a separately reviewed new corpus revision.

The two bilingual team-authored educational paraphrases retain publisher, source
title, official URL and parent-verified access date (2026-11-14) in their immutable
bodies. They are general education, not individual orders or clinical scores.

## Integration

- `createKnowledgeService({sql, config: AuthConfig}): KnowledgeService` exposes
  `search(auth: AuthContext, input: KnowledgeSearch): Promise<KnowledgeSearchResponse>`.
  It rechecks live active/provisioned nurse eligibility, not just supplied role.
- `knowledgeRoutes({auth, knowledge, config, rateLimiters})` exposes only
  `POST /api/v1/knowledge/search`; Origin, CSRF, authenticated rate limiting and
  strict required `{query, locale: "id"|"en", limit: 1..20}` are enforced. Parent
  app middleware continues to enforce Origin globally and error envelopes.
- `retrieveKnowledge(transactionSql, input): Promise<KnowledgeRetrieval>` is an
  **internal** repository primitive used by the authorized analysis worker. It
  does not open a transaction, authorize a patient or accept patient selectors.
  It returns `{corpusId, corpusVersion, chunks}` with exact immutable corpus,
  document and chunk revision UUIDs. The HTTP service omits the additive top-level
  `corpusId`, preserving the literal search response.
- `importFixedKnowledgeCorpus({sql, config, approveBy?})` returns
  `{corpusId, corpusVersion, status, documentIds}`. There is no content parameter.

Each retrieval statement selects the highest-version APPROVED corpus named
`forcare-homecare-basics`, then approved latest document versions of each title
inside that corpus, before ranking/limit. Retired/draft content cannot rank. A
retired newest corpus permits the next latest approved revision; none returns
`GATE_UNAVAILABLE` (503/G05). Zero lexical matches returns `chunks: []` with the
selected positive corpusVersion, not model-memory content. Both locales use
PostgreSQL `simple` lexical search over bilingual text (AND terms, no stemming or
semantic fallback). `score` is nonnegative retrieval rank, never a clinical score.
