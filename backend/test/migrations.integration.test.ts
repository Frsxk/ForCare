import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveTestDatabaseUrl,
  readTestDatabaseTarget,
  type TestDatabaseTarget,
} from "./fixtures/test-database-target";

/**
 * T04: transactional, versioned migration foundation and the approved 0001
 * identity schema. These tests use only a disposable loopback database named
 * with a `_test` suffix; there is no fallback to ambient project credentials.
 */

type MigrateModule = typeof import("../src/storage/migrate");
type DatabaseModule = typeof import("../src/storage/database");

type MigrationFile = {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const BACKEND_ROOT = fileURLToPath(new URL("..", import.meta.url));
const IDENTITY_FILE = join(MIGRATIONS_DIR, "0001_identity.sql");
const RUNNER = fileURLToPath(new URL("./fixtures/migrate-runner.ts", import.meta.url));

const APPROVED_MANIFEST = [
  "0001_identity",
  "0002_patients_operations",
  "0003_clinical_sources",
  "0004_monitoring",
  "0005_assessments",
  "0006_knowledge",
  "0007_analysis",
  "0008_reviews",
  "0009_availability",
  "0010_bookings",
  "0011_priority_requests",
  "0012_visits",
  "0013_notifications",
  "0014_push",
];

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;

let migrations!: MigrateModule;
let databases!: DatabaseModule;
let target: TestDatabaseTarget;
let admin: SQL;
const fixtureDirs: string[] = [];

async function loadMigrationsModule(): Promise<MigrateModule> {
  migrations ??= await import("../src/storage/migrate");
  return migrations;
}

function migrationErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_MIGRATION_CODE";
  }
  throw new Error("expected a MigrationError but nothing was thrown");
}

async function expectMigrationError(promise: Promise<unknown>, code: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return error as Error;
  }
  throw new Error(`expected migration error ${code} but the migration resolved`);
}

function fixtureFile(version: string, name: string, sql = "SELECT 1;") {
  const checksum = createHash("sha256").update(sql).digest("hex");
  return { version, name, path: `/fixture/${version}_${name}.sql`, sql, checksum };
}

function appliedRow(version: string, name: string, checksum: string) {
  return { version, name, checksum };
}

async function readIdentitySql(): Promise<string> {
  return readFile(IDENTITY_FILE, "utf8");
}

async function makeMigrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forcare-t04-migrations-"));
  fixtureDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents);
  }
  return dir;
}

/**
 * Isolated copy of the sanctioned 0001 migration. Identity-specific assertions
 * run against this directory so approving a later migration cannot change them.
 */
async function makeIdentityMigrationDir(extra: Record<string, string> = {}): Promise<string> {
  return makeMigrationDir({ "0001_identity.sql": await readIdentitySql(), ...extra });
}

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

type ScratchDatabase = { name: string; url: string; sql: SQL };

async function createScratchDatabase(): Promise<ScratchDatabase> {
  const name = `forcare_stop1_test_t04_${randomUUID().replace(/-/g, "").slice(0, 10)}_test`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = deriveTestDatabaseUrl(target.url, name);
  const sql = databases.createDatabaseFromEnv(envFromUrl(url), {
    max: 2,
    connectionTimeout: 5,
    idleTimeout: 5,
  });
  return { name, url, sql };
}

async function withScratchDatabase(run: (database: ScratchDatabase) => Promise<void>): Promise<void> {
  const database = await createScratchDatabase();
  try {
    await run(database);
  } finally {
    await database.sql.close().catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database.name}" WITH (FORCE)`);
  }
}

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

type ConstraintRow = {
  table_name: string;
  conname: string;
  contype: string;
  confdeltype: string | null;
  definition: string;
};

async function readColumns(sql: SQL): Promise<Map<string, ColumnRow>> {
  const rows = (await sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `) as ColumnRow[];
  return new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
}

async function readConstraints(sql: SQL): Promise<ConstraintRow[]> {
  return (await sql`
    SELECT r.relname AS table_name, c.conname, c.contype, c.confdeltype,
           pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
  `) as ConstraintRow[];
}

async function readIndexes(sql: SQL): Promise<Array<{ indexname: string; indexdef: string }>> {
  return (await sql`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `) as Array<{ indexname: string; indexdef: string }>;
}

function column(columns: Map<string, ColumnRow>, table: string, name: string): ColumnRow {
  const found = columns.get(`${table}.${name}`);
  if (!found) throw new Error(`missing column ${table}.${name}`);
  return found;
}

function hasConstraint(
  constraints: ConstraintRow[],
  table: string,
  type: string,
  definition: RegExp,
  deleteAction?: string,
): boolean {
  return constraints.some(
    (row) =>
      row.table_name === table &&
      row.contype === type &&
      definition.test(row.definition) &&
      (deleteAction === undefined || row.confdeltype === deleteAction),
  );
}

describe("opt-in test database target", () => {
  const safe = "postgresql://tester:***@127.0.0.1:6543/forcare_stop1_test";

  test("accepts only an explicit loopback dedicated test database", () => {
    const parsed = readTestDatabaseTarget({ FORCARE_TEST_DATABASE_URL: safe });
    expect(parsed.database).toBe("forcare_stop1_test");
    expect(parsed.endpoint).toBe("127.0.0.1:6543");
    expect(parsed.url).toBe(safe);

    const localhost = readTestDatabaseTarget({
      FORCARE_TEST_DATABASE_URL: "postgres://tester:***@localhost:6544/forcare_stop1_test_alpha_test",
    });
    expect(localhost.endpoint).toBe("localhost:6544");
    expect(localhost.database).toBe("forcare_stop1_test_alpha_test");

    const ipv6 = readTestDatabaseTarget({
      FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@[::1]:6545/forcare_stop1_test",
    });
    expect(ipv6.database).toBe("forcare_stop1_test");
  });

  test("never falls back to DATABASE_URL or another ambient variable", () => {
    expect(() => readTestDatabaseTarget({ DATABASE_URL: safe })).toThrow("FORCARE_TEST_DATABASE_URL");
    expect(() =>
      readTestDatabaseTarget({ DATABASE_URL: safe, POSTGRES_PASSWORD: "synthetic", POSTGRES_DB: "forcare_stop1_test" }),
    ).toThrow("FORCARE_TEST_DATABASE_URL");
    expect(() => readTestDatabaseTarget({ FORCARE_TEST_DATABASE_URL: "   " })).toThrow("FORCARE_TEST_DATABASE_URL");
  });

  test("rejects shared, remote, malformed and non-dedicated targets before connecting", () => {
    const rejected: Array<Record<string, string | undefined>> = [
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@127.0.0.1:5432/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@localhost:5432/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@db.internal:6543/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@10.0.0.5:6543/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@127.0.0.1/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@127.0.0.1:6543/forcare" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@127.0.0.1:6543/forcare_test2" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@127.0.0.1:6543/_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://127.0.0.1:6543/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester@127.0.0.1:6543/forcare_stop1_test" },
      { FORCARE_TEST_DATABASE_URL: "postgresql://tester:***@127.0.0.1:6543/forcare_stop1_test?host=db" },
      { FORCARE_TEST_DATABASE_URL: "file:///etc/passwd" },
      { FORCARE_TEST_DATABASE_URL: "not-a-url" },
      { FORCARE_TEST_DATABASE_URL: "" },
      {},
    ];
    for (const env of rejected) expect(() => readTestDatabaseTarget(env)).toThrow();
  });

  test("reports rejection without echoing the supplied credential", () => {
    const password = "synthetic-secret-xyz";
    try {
      readTestDatabaseTarget({
        FORCARE_TEST_DATABASE_URL: `postgresql://tester:${password}@127.0.0.1:6543/forcare`,
      });
      throw new Error("unsafe test target was accepted");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("FORCARE_TEST_DATABASE_URL");
      expect(message).not.toContain(password);
      expect(message).not.toContain(`tester:${password}`);
    }
  });

  test("derives only disposable _test database names", () => {
    expect(deriveTestDatabaseUrl(safe, "forcare_stop1_test_extra_test")).toContain(
      "/forcare_stop1_test_extra_test",
    );
    expect(() => deriveTestDatabaseUrl(safe, "forcare")).toThrow("_test");
    expect(() => deriveTestDatabaseUrl(safe, "forcare_stop1_test;drop")).toThrow("_test");
  });

  test("the integration script fails instead of silently running no tests", async () => {
    const child = Bun.spawn([process.execPath, "run", "test:integration"], {
      cwd: BACKEND_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: "postgresql://tester:synthetic@127.0.0.1:5432/forcare",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("FORCARE_TEST_DATABASE_URL");
  }, 30_000);
});

describe("migration manifest and planning", () => {
  test("declares the approved exact manifest sequence", async () => {
    const module = await loadMigrationsModule();
    expect(module.MIGRATION_MANIFEST.map((entry) => `${entry.version}_${entry.name}`)).toEqual(
      APPROVED_MANIFEST,
    );
  });

  test("checksums migration content with SHA-256", async () => {
    const module = await loadMigrationsModule();
    expect(module.computeChecksum("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(module.computeChecksum("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("loads exactly the manifest migration files present on disk", async () => {
    const module = await loadMigrationsModule();
    const files = await module.loadMigrations(MIGRATIONS_DIR);
    const present = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.map((file) => `${file.version}_${file.name}.sql`)).toEqual(present);
    for (const file of files) {
      expect(file.checksum).toBe(module.computeChecksum(await readFile(file.path, "utf8")));
    }
  });

  test("rejects an unknown applied version", async () => {
    const module = await loadMigrationsModule();
    expect(
      migrationErrorCode(() =>
        module.planMigrations(
          [fixtureFile("0001", "identity")],
          [appliedRow("0099", "mystery", "irrelevant")],
        ),
      ),
    ).toBe("MIGRATION_UNKNOWN_VERSION");
  });

  test("rejects history whose migration file is missing", async () => {
    const module = await loadMigrationsModule();
    expect(
      migrationErrorCode(() =>
        module.planMigrations(
          [fixtureFile("0001", "identity")],
          [appliedRow("0002", "patients_operations", "irrelevant")],
        ),
      ),
    ).toBe("MIGRATION_FILE_MISSING");
  });

  test("rejects a checksum mismatch", async () => {
    const module = await loadMigrationsModule();
    expect(
      migrationErrorCode(() =>
        module.planMigrations(
          [fixtureFile("0001", "identity")],
          [appliedRow("0001", "identity", "0".repeat(64))],
        ),
      ),
    ).toBe("MIGRATION_CHECKSUM_MISMATCH");
  });

  test("rejects a migration that is pending before an already applied version", async () => {
    const module = await loadMigrationsModule();
    const files = [fixtureFile("0001", "identity"), fixtureFile("0002", "patients_operations")];
    expect(
      migrationErrorCode(() => module.planMigrations(files, [appliedRow("0002", "patients_operations", files[1].checksum)])),
    ).toBe("MIGRATION_OUT_OF_ORDER");
  });
});

integration("PostgreSQL migration foundation", () => {
  beforeAll(async () => {
    migrations = await loadMigrationsModule();
    databases = await import("../src/storage/database");
    target = readTestDatabaseTarget(process.env);
    admin = databases.createDatabaseFromEnv(envFromUrl(target.url), { max: 3, connectionTimeout: 5 });
  }, 30_000);

  afterAll(async () => {
    await admin?.close();
    await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("applies 0001 exactly once, then is a no-op", async () => {
    const identityDir = await makeIdentityMigrationDir();
    await withScratchDatabase(async (database) => {
      const first = await migrations.migrate({
        sql: database.sql,
        migrationsDir: identityDir,
        appliedBy: "t04-integration",
      });
      expect(first.applied.map((entry) => `${entry.version}_${entry.name}`)).toEqual(["0001_identity"]);
      expect(first.applied[0].checksum).toBe(migrations.computeChecksum(await readIdentitySql()));
      expect(first.applied[0].appliedBy).toBe("t04-integration");
      expect(Number.isNaN(Date.parse(first.applied[0].appliedAt))).toBe(false);
      expect(first.skipped).toEqual([]);

      const history = (await database.sql`
        SELECT version, name, checksum, applied_by FROM public.schema_migrations ORDER BY version
      `) as Array<{ version: string; name: string; checksum: string; applied_by: string }>;
      expect(history.map((row) => `${row.version}_${row.name}`)).toEqual(["0001_identity"]);
      expect(history[0].applied_by).toBe("t04-integration");

      const second = await migrations.migrate({
        sql: database.sql,
        migrationsDir: identityDir,
        appliedBy: "t04-integration",
      });
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(["0001"]);

      const after = (await database.sql`
        SELECT version, checksum FROM public.schema_migrations ORDER BY version
      `) as Array<{ version: string; checksum: string }>;
      expect(after).toHaveLength(1);
      expect(after[0].checksum).toBe(history[0].checksum);

      const vendor = (await database.sql`SELECT to_regclass('checkpoints.checkpoints') AS present`) as Array<{
        present: string | null;
      }>;
      expect(vendor[0].present).toBeNull();
    });
  }, 60_000);

  test("creates the approved identity tables, columns and constraints", async () => {
    const identityDir = await makeIdentityMigrationDir();
    await withScratchDatabase(async (database) => {
      await migrations.migrate({
        sql: database.sql,
        migrationsDir: identityDir,
        appliedBy: "t04-integration",
      });

      const tables = (
        (await database.sql`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `) as Array<{ table_name: string }>
      ).map((row) => row.table_name);
      expect(tables).toEqual(
        expect.arrayContaining(["accounts", "account_roles", "staff", "sessions", "schema_migrations"]),
      );
      expect(tables).not.toContain("patients");

      const columns = await readColumns(database.sql);
      const constraints = await readConstraints(database.sql);
      const indexes = await readIndexes(database.sql);

      expect(column(columns, "schema_migrations", "version").data_type).toBe("text");
      expect(
        [...columns.values()]
          .filter((row) => row.table_name === "schema_migrations")
          .map((row) => row.column_name)
          .sort(),
      ).toEqual(["applied_at", "applied_by", "checksum", "name", "version"]);

      expect(column(columns, "accounts", "id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
      expect(column(columns, "accounts", "email_normalized")).toMatchObject({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(column(columns, "accounts", "password_hash")).toMatchObject({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(column(columns, "accounts", "status").is_nullable).toBe("NO");
      expect(column(columns, "accounts", "status").column_default).toContain("active");
      expect(column(columns, "accounts", "display_time_zone").is_nullable).toBe("NO");
      expect(column(columns, "accounts", "display_time_zone").column_default).toContain("Asia/Jakarta");
      expect(column(columns, "accounts", "version")).toMatchObject({
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      });
      expect(column(columns, "accounts", "created_at").data_type).toBe("timestamp with time zone");
      expect(column(columns, "accounts", "updated_at").data_type).toBe("timestamp with time zone");

      expect(column(columns, "account_roles", "account_id").is_nullable).toBe("NO");
      expect(column(columns, "account_roles", "role").is_nullable).toBe("NO");
      expect(column(columns, "account_roles", "granted_at").data_type).toBe("timestamp with time zone");

      expect(column(columns, "staff", "account_id").is_nullable).toBe("NO");
      expect(column(columns, "staff", "staff_code").is_nullable).toBe("NO");
      expect(column(columns, "staff", "discipline").is_nullable).toBe("NO");
      expect(column(columns, "staff", "display_name").is_nullable).toBe("NO");
      for (const field of [
        "identity_approval_ref",
        "identity_approved_by",
        "identity_approved_at",
        "provisioning_email_domain",
        "domain_checked_at",
        "provisioned_by",
        "provisioned_at",
      ]) {
        expect(column(columns, "staff", field).is_nullable).toBe("NO");
      }
      expect(column(columns, "staff", "active").is_nullable).toBe("NO");
      expect(column(columns, "staff", "version")).toMatchObject({
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      });

      expect(column(columns, "sessions", "token_hash")).toMatchObject({
        data_type: "bytea",
        is_nullable: "NO",
      });
      expect(column(columns, "sessions", "csrf_hash")).toMatchObject({
        data_type: "bytea",
        is_nullable: "NO",
      });
      expect(column(columns, "sessions", "account_id").is_nullable).toBe("NO");
      expect(column(columns, "sessions", "expires_at").is_nullable).toBe("NO");
      expect(column(columns, "sessions", "revoked_at").is_nullable).toBe("YES");
      expect(column(columns, "sessions", "ip_hash").data_type).toBe("text");
      expect(column(columns, "sessions", "user_agent").data_type).toBe("text");

      expect(hasConstraint(constraints, "accounts", "u", /\(email_normalized\)/i)).toBe(true);
      expect(hasConstraint(constraints, "accounts", "c", /active/i) && hasConstraint(constraints, "accounts", "c", /disabled/i)).toBe(true);
      expect(hasConstraint(constraints, "accounts", "c", /lower\(btrim\(email_normalized\)\)/i)).toBe(true);

      expect(hasConstraint(constraints, "account_roles", "p", /\(account_id, role\)/i)).toBe(true);
      expect(hasConstraint(constraints, "account_roles", "u", /\(account_id\)/i)).toBe(true);
      expect(hasConstraint(constraints, "account_roles", "f", /FOREIGN KEY \(account_id\)/i, "r")).toBe(true);
      expect(hasConstraint(constraints, "account_roles", "c", /patient/i) && hasConstraint(constraints, "account_roles", "c", /nurse/i)).toBe(true);

      expect(hasConstraint(constraints, "staff", "u", /\(account_id\)/i)).toBe(true);
      expect(hasConstraint(constraints, "staff", "u", /\(staff_code\)/i)).toBe(true);
      expect(hasConstraint(constraints, "staff", "f", /FOREIGN KEY \(account_id\)/i, "r")).toBe(true);
      expect(hasConstraint(constraints, "staff", "c", /nurse/i)).toBe(true);

      expect(hasConstraint(constraints, "sessions", "u", /\(token_hash\)/i)).toBe(true);
      expect(hasConstraint(constraints, "sessions", "u", /\(id, account_id\)/i)).toBe(true);
      expect(hasConstraint(constraints, "sessions", "f", /FOREIGN KEY \(account_id\)/i, "c")).toBe(true);
      expect(hasConstraint(constraints, "sessions", "c", /expires_at > created_at/i)).toBe(true);

      const partialIndex = indexes.find((row) => row.indexname === "sessions_account_id_active_idx");
      expect(partialIndex).toBeDefined();
      expect(partialIndex!.indexdef.toLowerCase()).toContain("where (revoked_at is null)");
      expect(partialIndex!.indexdef).toContain("(account_id)");
    });
  }, 60_000);

  test("rejects a modified applied migration and preserves the existing schema", async () => {
    const identityDir = await makeIdentityMigrationDir();
    await withScratchDatabase(async (database) => {
      await migrations.migrate({
        sql: database.sql,
        migrationsDir: identityDir,
        appliedBy: "t04-integration",
      });
      await database.sql`
        UPDATE public.schema_migrations SET checksum = 'tampered-checksum' WHERE version = '0001'
      `;

      const error = await expectMigrationError(
        migrations.migrate({ sql: database.sql, appliedBy: "t04-integration" }),
        "MIGRATION_CHECKSUM_MISMATCH",
      );
      expect(error.message).toContain("0001");
      expect(error.message.toLowerCase()).toContain("checksum");

      const history = (await database.sql`
        SELECT version, checksum FROM public.schema_migrations
      `) as Array<{ version: string; checksum: string }>;
      expect(history).toEqual([{ version: "0001", checksum: "tampered-checksum" }]);

      const accounts = (await database.sql`SELECT to_regclass('public.accounts') AS present`) as Array<{
        present: string | null;
      }>;
      expect(accounts[0].present).not.toBeNull();
    });
  }, 60_000);

  test("rejects history for an applied migration whose file is absent", async () => {
    const identityDir = await makeIdentityMigrationDir();
    await withScratchDatabase(async (database) => {
      await migrations.migrate({
        sql: database.sql,
        migrationsDir: identityDir,
        appliedBy: "t04-integration",
      });
      await database.sql`
        INSERT INTO public.schema_migrations (version, name, checksum, applied_at, applied_by)
        VALUES ('0002', 'patients_operations', 'missing-file-checksum', now(), 't04-integration')
      `;

      const error = await expectMigrationError(
        migrations.migrate({ sql: database.sql, migrationsDir: identityDir, appliedBy: "t04-integration" }),
        "MIGRATION_FILE_MISSING",
      );
      expect(error.message).toContain("0002");
      expect(error.message.toLowerCase()).toContain("file");
    });
  }, 60_000);

  test("rejects an unknown applied version in history", async () => {
    await withScratchDatabase(async (database) => {
      await migrations.migrate({ sql: database.sql, appliedBy: "t04-integration" });
      await database.sql`
        INSERT INTO public.schema_migrations (version, name, checksum, applied_at, applied_by)
        VALUES ('0099', 'mystery', 'unknown', now(), 't04-integration')
      `;

      const error = await expectMigrationError(
        migrations.migrate({ sql: database.sql, appliedBy: "t04-integration" }),
        "MIGRATION_UNKNOWN_VERSION",
      );
      expect(error.message).toContain("0099");
    });
  }, 60_000);

  test("rejects unknown migration files and manifest name mismatches", async () => {
    const identity = await readIdentitySql();
    const unknownDir = await makeMigrationDir({
      "0001_identity.sql": identity,
      "0099_mystery.sql": "SELECT 1;",
    });
    const renamedDir = await makeMigrationDir({
      "0001_identity.sql": identity,
      "0002_typo_name.sql": "SELECT 1;",
    });

    await withScratchDatabase(async (database) => {
      const unknown = await expectMigrationError(
        migrations.migrate({ sql: database.sql, migrationsDir: unknownDir, appliedBy: "t04-integration" }),
        "MIGRATION_UNKNOWN_VERSION",
      );
      expect(unknown.message).toContain("0099");

      const renamed = await expectMigrationError(
        migrations.migrate({ sql: database.sql, migrationsDir: renamedDir, appliedBy: "t04-integration" }),
        "MIGRATION_NAME_MISMATCH",
      );
      expect(renamed.message).toContain("0002");

      const history = (await database.sql`
        SELECT count(*)::int AS count FROM public.schema_migrations
      `) as Array<{ count: number }>;
      expect(history[0].count).toBe(0);
    });
  }, 60_000);

  test("refuses to apply an earlier migration after a later one is recorded", async () => {
    const identity = await readIdentitySql();
    const laterSql = "SELECT 1;";
    const onlyFirst = await makeMigrationDir({ "0001_identity.sql": identity });
    const complete = await makeMigrationDir({
      "0001_identity.sql": identity,
      "0002_patients_operations.sql": laterSql,
      "0003_clinical_sources.sql": laterSql,
    });

    await withScratchDatabase(async (database) => {
      await migrations.migrate({ sql: database.sql, migrationsDir: onlyFirst, appliedBy: "t04-integration" });
      await database.sql`
        INSERT INTO public.schema_migrations (version, name, checksum, applied_at, applied_by)
        VALUES ('0003', 'clinical_sources', ${migrations.computeChecksum(laterSql)}, now(), 't04-integration')
      `;

      const error = await expectMigrationError(
        migrations.migrate({ sql: database.sql, migrationsDir: complete, appliedBy: "t04-integration" }),
        "MIGRATION_OUT_OF_ORDER",
      );
      expect(error.message).toContain("0002");

      const history = (await database.sql`
        SELECT version FROM public.schema_migrations ORDER BY version
      `) as Array<{ version: string }>;
      expect(history.map((row) => row.version)).toEqual(["0001", "0003"]);
    });
  }, 60_000);

  test("rolls back a failed migration and preserves pre-existing fixture data", async () => {
    const identity = await readIdentitySql();
    const brokenDir = await makeMigrationDir({
      "0001_identity.sql": identity,
      "0002_patients_operations.sql": [
        "CREATE TABLE public.t04_rollback_probe (id integer PRIMARY KEY);",
        "INSERT INTO public.t04_rollback_probe VALUES (1);",
        "CREATE TABLE public.t04_rollback_probe (id integer PRIMARY KEY);",
      ].join("\n"),
    });

    await withScratchDatabase(async (database) => {
      await database.sql.unsafe(`
        CREATE TABLE public.t04_preserved_fixture (id integer PRIMARY KEY, note text NOT NULL);
        INSERT INTO public.t04_preserved_fixture VALUES (1, 'kept');
      `);

      const error = await expectMigrationError(
        migrations.migrate({ sql: database.sql, migrationsDir: brokenDir, appliedBy: "t04-integration" }),
        "MIGRATION_FAILED",
      );
      expect(error.message).toContain("0002");

      const probe = (await database.sql`SELECT to_regclass('public.t04_rollback_probe') AS present`) as Array<{
        present: string | null;
      }>;
      expect(probe[0].present).toBeNull();

      const history = (await database.sql`
        SELECT version FROM public.schema_migrations ORDER BY version
      `) as Array<{ version: string }>;
      expect(history.map((row) => row.version)).toEqual(["0001"]);

      const preserved = (await database.sql`
        SELECT id, note FROM public.t04_preserved_fixture
      `) as Array<{ id: number; note: string }>;
      expect(preserved).toEqual([{ id: 1, note: "kept" }]);
    });
  }, 60_000);

  test("leaves vendor checkpoint tables untouched", async () => {
    await withScratchDatabase(async (database) => {
      await database.sql.unsafe(`
        CREATE SCHEMA checkpoints;
        CREATE TABLE checkpoints.checkpoints (thread_id text PRIMARY KEY, payload text NOT NULL);
        INSERT INTO checkpoints.checkpoints VALUES ('synthetic-thread', 'synthetic-payload');
      `);

      await migrations.migrate({ sql: database.sql, appliedBy: "t04-integration" });

      const rows = (await database.sql`
        SELECT thread_id, payload FROM checkpoints.checkpoints
      `) as Array<{ thread_id: string; payload: string }>;
      expect(rows).toEqual([{ thread_id: "synthetic-thread", payload: "synthetic-payload" }]);
    });
  }, 60_000);

  test("serializes concurrent runners with an advisory lock", async () => {
    const identity = await readIdentitySql();
    const concurrentDir = await makeMigrationDir({
      "0001_identity.sql": `${identity}\nSELECT pg_sleep(0.25);\n`,
      "0002_patients_operations.sql":
        "CREATE TABLE public.t04_concurrent_probe (id integer PRIMARY KEY);\nSELECT pg_sleep(0.25);",
    });

    await withScratchDatabase(async (database) => {
      const spawn = () =>
        Bun.spawn([process.execPath, "run", RUNNER, concurrentDir], {
          cwd: BACKEND_ROOT,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            FORCARE_TEST_DATABASE_URL: database.url,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      const children = [spawn(), spawn()];
      const results = await Promise.all(
        children.map(async (child) => {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const line = stdout.trim().split("\n").filter(Boolean).at(-1);
          return { exitCode, stderr, result: line ? JSON.parse(line) : null };
        }),
      );

      for (const result of results) {
        expect(result.stderr).not.toContain(database.url);
        expect(result.exitCode).toBe(0);
      }
      const appliedVersions = results.flatMap((result) => result.result?.applied ?? []);
      expect(appliedVersions.sort()).toEqual(["0001", "0002"]);

      const history = (await database.sql`
        SELECT version FROM public.schema_migrations ORDER BY version
      `) as Array<{ version: string }>;
      expect(history.map((row) => row.version)).toEqual(["0001", "0002"]);

      const probe = (await database.sql`SELECT to_regclass('public.t04_concurrent_probe') AS present`) as Array<{
        present: string | null;
      }>;
      expect(probe[0].present).not.toBeNull();
    });
  }, 90_000);
});
