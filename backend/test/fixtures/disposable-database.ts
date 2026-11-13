import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import type { AuthConfig } from "../../src/config";
import { createDatabaseFromEnv } from "../../src/storage/database";
import { migrate } from "../../src/storage/migrate";
import {
  deriveTestDatabaseUrl,
  readTestDatabaseTarget,
  type TestDatabaseTarget,
} from "./test-database-target";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

export type DisposableDatabase = {
  name: string;
  url: string;
  sql: SQL;
  close(): Promise<void>;
};

function envFromUrl(raw: string): Record<string, string> {
  const url = new URL(raw);
  return {
    DATABASE_HOST: url.hostname,
    DATABASE_PORT: url.port,
    POSTGRES_DB: decodeURIComponent(url.pathname.replace(/^\//, "")),
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
  };
}

export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    allowedOrigins: ["http://127.0.0.1:3000"],
    nurseEmailDomain: "nurse.invalid",
    sessionSecret: "forcare-test-session-secret-32-characters-minimum",
    localHttpTest: true,
    cookieSecure: true,
    ...overrides,
  };
}

export async function createDisposableDatabase(prefix: string): Promise<DisposableDatabase> {
  const target: TestDatabaseTarget = readTestDatabaseTarget(process.env);
  const admin = createDatabaseFromEnv(envFromUrl(target.url), {
    max: 2,
    connectionTimeout: 5,
    idleTimeout: 5,
  });
  const safePrefix = prefix.replace(/[^a-z0-9_]/g, "").slice(0, 20) || "suite";
  const name = `forcare_stop1_test_${safePrefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}_test`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = deriveTestDatabaseUrl(target.url, name);
  const sql = createDatabaseFromEnv(envFromUrl(url), {
    max: 4,
    connectionTimeout: 5,
    idleTimeout: 5,
  });
  try {
    await migrate({ sql, migrationsDir: MIGRATIONS_DIR, appliedBy: "stop1-integration" });
  } catch (error) {
    await sql.close().catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.close().catch(() => {});
    throw error;
  }
  return {
    name,
    url,
    sql,
    async close() {
      await sql.close().catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.close();
    },
  };
}
