import { readAuthConfig, readServerConfig } from "../src/config";
import { AppError } from "../src/http/errors";
import { createDatabase } from "../src/storage/database";
import { importFixedKnowledgeCorpus } from "../src/knowledge/corpus-import";

export function parseKnowledgeCorpusArgs(args: string[]): { approveBy?: string } {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--approve-by" && args[1] && !args[1].startsWith("--")) return { approveBy: args[1] };
  throw new AppError("VALIDATION_FAILED", "Usage: bun run scripts/knowledge-corpus.ts [--approve-by STAFF_UUID]. Only the fixed bundled corpus is accepted.", 422);
}

async function main() {
  const args = parseKnowledgeCorpusArgs(Bun.argv.slice(2));
  console.warn("WARNING: This imports general education, not individual care orders. Synthetic fixture approval is NOT real clinical validation. Default import is DRAFT; --approve-by records an explicit existing active nurse's operator attestation.");
  const config = readServerConfig(process.env);
  const sql = createDatabase(config.database, { max: 1, connectionTimeout: 5, idleTimeout: 5 });
  try {
    const result = await importFixedKnowledgeCorpus({ sql, config: readAuthConfig(process.env, { hostname: config.hostname }), ...args });
    console.log(JSON.stringify(result));
  } finally { await sql.close(); }
}

if (import.meta.main) {
  try { await main(); } catch (error) {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : "Knowledge corpus import failed");
    process.exitCode = 1;
  }
}
