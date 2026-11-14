/**
 * Fail-closed entry point for the checkpoint integration tests.
 *
 * Without FORCARE_CHECKPOINT_TEST_DATABASE_URL this exits nonzero instead of
 * silently skipping. A dedicated loopback test database is required; there is
 * no DATABASE_URL or .env fallback.
 */

import { fileURLToPath } from "node:url";
import { readCheckpointTestTarget } from "../test/fixtures/checkpoint-test-target";

try {
  const target = readCheckpointTestTarget(process.env);
  console.log(`checkpoint integration target: ${target.endpoint}/${target.database}`);
} catch (error) {
  console.error(`checkpoint integration tests not run: ${(error as Error).message}`);
  process.exit(1);
}

const child = Bun.spawn([process.execPath, "test", "test/ai-checkpoint.integration.test.ts", "--timeout", "120000"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdout: "inherit",
  stderr: "inherit",
  env: {
    FORCARE_CHECKPOINT_TEST_DATABASE_URL: process.env.FORCARE_CHECKPOINT_TEST_DATABASE_URL!,
  },
});

process.exit(await child.exited);
