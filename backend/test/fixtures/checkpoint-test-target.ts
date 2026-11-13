/**
 * Safe-target validation for the disposable checkpoint integration database.
 *
 * This is a test-only guard, not product configuration. It refuses to run
 * against anything but an explicitly named, loopback, dedicated test database
 * so a stray DATABASE_URL or the shared development PostgreSQL can never be
 * touched by this spike.
 */

export type CheckpointTestTarget = {
  /** Connection URL. Never log or embed this value; it carries credentials. */
  url: string;
  database: string;
  /** host:port without credentials, safe to report. */
  endpoint: string;
};

const REQUIRED_VARIABLE = "FORCARE_CHECKPOINT_TEST_DATABASE_URL";
const DATABASE_PREFIX = "forcare_checkpoint_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const FORBIDDEN_PORTS = new Set([5432]);

export function readCheckpointTestTarget(
  env: Record<string, string | undefined> = process.env,
): CheckpointTestTarget {
  const raw = env[REQUIRED_VARIABLE]?.trim();
  if (!raw) {
    throw new Error(
      `${REQUIRED_VARIABLE} must be set to a dedicated loopback test database URL; there is no fallback`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${REQUIRED_VARIABLE} is not a valid URL`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${REQUIRED_VARIABLE} must use the postgres or postgresql protocol`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${REQUIRED_VARIABLE} must not carry query parameters or fragments`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${REQUIRED_VARIABLE} must target a loopback host (127.0.0.1, localhost or ::1)`);
  }

  const port = Number(parsed.port);
  if (!parsed.port || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${REQUIRED_VARIABLE} must include an explicit non-default port`);
  }
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(`${REQUIRED_VARIABLE} must not use port 5432, which is reserved for the shared database`);
  }

  if (!parsed.username || !parsed.password) {
    throw new Error(`${REQUIRED_VARIABLE} must include a dedicated user and password`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    throw new Error(`${REQUIRED_VARIABLE} must name exactly one database`);
  }
  if (!database.startsWith(DATABASE_PREFIX)) {
    throw new Error(`${REQUIRED_VARIABLE} database name must start with "${DATABASE_PREFIX}"`);
  }

  return { url: raw, database, endpoint: `${parsed.hostname}:${port}` };
}
