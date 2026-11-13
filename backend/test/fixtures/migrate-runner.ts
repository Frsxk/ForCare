/**
 * Child-process entry point for the concurrent migration test.
 *
 * The database URL arrives only through the subprocess environment and is
 * never printed. The last stdout line is a JSON summary for the parent test.
 */
import { SQL } from "bun";
import { migrate } from "../../src/storage/migrate";

const migrationsDir = process.argv[2];
const url = process.env.FORCARE_TEST_DATABASE_URL;
if (!migrationsDir) throw new Error("migrations directory argument is required");
if (!url) throw new Error("FORCARE_TEST_DATABASE_URL is required");

const sql = new SQL({ url, max: 1, connectionTimeout: 5, idleTimeout: 5 });
try {
  const result = await migrate({ sql, migrationsDir, appliedBy: "t04-concurrent-runner" });
  console.log(
    JSON.stringify({
      applied: result.applied.map((entry) => entry.version),
      skipped: result.skipped,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await sql.close();
}
