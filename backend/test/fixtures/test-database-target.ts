/**
 * Safe-target validation for opt-in PostgreSQL integration tests.
 *
 * These are test-only guards, not product configuration. They refuse to run
 * against anything but an explicitly named, loopback, dedicated database whose
 * name ends in `_test`, so an ambient DATABASE_URL or the shared development
 * PostgreSQL can never be touched by an integration suite.
 */

export type TestDatabaseTarget = {
  /** Connection URL. Never log or embed this value; it carries credentials. */
  url: string;
  database: string;
  /** host:port without credentials, safe to report. */
  endpoint: string;
};

const REQUIRED_VARIABLE = "FORCARE_TEST_DATABASE_URL";
const DATABASE_SUFFIX = "_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const FORBIDDEN_PORTS = new Set([5432]);
const DATABASE_NAME = /^[a-z0-9_]+$/;

export function readTestDatabaseTarget(
  env: Record<string, string | undefined> = process.env,
): TestDatabaseTarget {
  const raw = env[REQUIRED_VARIABLE]?.trim();
  if (!raw) {
    throw new Error(
      `${REQUIRED_VARIABLE} must be set to a dedicated loopback test database URL whose name ends in "${DATABASE_SUFFIX}"; there is no fallback`,
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
  if (!database.endsWith(DATABASE_SUFFIX) || database.length <= DATABASE_SUFFIX.length) {
    throw new Error(`${REQUIRED_VARIABLE} database name must end with "${DATABASE_SUFFIX}"`);
  }

  return { url: raw, database, endpoint: `${parsed.hostname}:${port}` };
}

/** Builds a URL for a scratch database derived from an already validated target. */
export function deriveTestDatabaseUrl(baseUrl: string, database: string): string {
  if (!DATABASE_NAME.test(database) || !database.endsWith(DATABASE_SUFFIX)) {
    throw new Error(`derived test database name must match ${DATABASE_NAME} and end with "${DATABASE_SUFFIX}"`);
  }
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** True only when a complete opt-in target passes every safety check. */
export function hasTestDatabaseTarget(env: Record<string, string | undefined> = process.env): boolean {
  try {
    readTestDatabaseTarget(env);
    return true;
  } catch {
    return false;
  }
}
