import { userInfo } from "node:os";
import { createDatabaseFromEnv } from "../src/storage/database";
import { migrate } from "../src/storage/migrate";

function operatingIdentity(): string {
  const configured = process.env.MIGRATION_APPLIED_BY?.trim();
  if (configured) return configured;
  try {
    return userInfo().username || "unspecified";
  } catch {
    return "unspecified";
  }
}

let sql: ReturnType<typeof createDatabaseFromEnv> | undefined;
try {
  sql = createDatabaseFromEnv(process.env, { max: 1 });
  const result = await migrate({ sql, appliedBy: operatingIdentity() });
  if (result.applied.length === 0) {
    console.log("Migrations up to date; nothing to apply.");
  } else {
    const names = result.applied.map((entry) => `${entry.version}_${entry.name}`).join(", ");
    console.log(`Applied ${result.applied.length} migration(s): ${names}`);
  }
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await sql?.close();
}
