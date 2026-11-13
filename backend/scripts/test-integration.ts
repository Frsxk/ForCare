import { readTestDatabaseTarget, type TestDatabaseTarget } from "../test/fixtures/test-database-target";

/**
 * Runs the Stop 1 integration suites only against an explicit, disposable
 * loopback `_test` database. Without that opt-in this exits nonzero instead of
 * reporting a suite that silently ran no tests.
 */

function requiredTarget(): TestDatabaseTarget {
  try {
    return readTestDatabaseTarget(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const target = requiredTarget();
console.log(`Running Stop 1 integration tests against ${target.endpoint}/${target.database}`);

const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "test/migrations.integration.test.ts",
    "test/auth.integration.test.ts",
    "test/patients.integration.test.ts",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, FORCARE_TEST_DATABASE_URL: target.url },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await child.exited;
