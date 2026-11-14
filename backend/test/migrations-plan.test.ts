import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations, migrate, planMigrations, type MigrationFile } from "../src/storage/migrate";

/**
 * Pure regression tests for migration planning and session cleanup. They never
 * connect to PostgreSQL, so they run without FORCARE_TEST_DATABASE_URL.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function fixtureFile(version: string, name: string): MigrationFile {
  const sql = `SELECT 1; -- ${version}_${name}`;
  return {
    version,
    name,
    path: `/fixture/${version}_${name}.sql`,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
}

function record(file: MigrationFile) {
  return { version: file.version, name: file.name, checksum: file.checksum };
}

function errorFrom(run: () => unknown): { code?: string; message: string } {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected a MigrationError but nothing was thrown");
}

const IDENTITY = fixtureFile("0001", "identity");
const PATIENTS = fixtureFile("0002", "patients_operations");
const CLINICAL = fixtureFile("0003", "clinical_sources");

describe("loadMigrations default directory", () => {
  test("loads shipped migration SQL without an explicit directory", async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThan(0);
    const identity = files.find((file) => file.version === "0001" && file.name === "identity");
    expect(identity?.sql).toBe(await readFile(join(MIGRATIONS_DIR, "0001_identity.sql"), "utf8"));
  });
});

describe("planMigrations contiguous manifest prefix", () => {
  test("rejects files that skip an intermediate manifest version", () => {
    const error = errorFrom(() => planMigrations([IDENTITY, CLINICAL], [record(IDENTITY)]));
    expect(error.code).toBe("MIGRATION_FILE_MISSING");
    expect(error.message).toContain("0002_patients_operations");
  });

  test("rejects applied history that skips an intermediate manifest version", () => {
    const error = errorFrom(() =>
      planMigrations([IDENTITY, CLINICAL], [record(IDENTITY), record(CLINICAL)]),
    );
    expect(error.code).toBe("MIGRATION_OUT_OF_ORDER");
    expect(error.message).toContain("0002_patients_operations");
  });

  test("allows later approved files to be absent", () => {
    const fresh = planMigrations([IDENTITY], []);
    expect(fresh.pending.map((file) => file.version)).toEqual(["0001"]);

    const caughtUp = planMigrations([IDENTITY, PATIENTS], [record(IDENTITY), record(PATIENTS)]);
    expect(caughtUp.pending).toEqual([]);
    expect(caughtUp.skipped).toEqual(["0001", "0002"]);
  });
});

describe("migrate advisory-lock cleanup", () => {
  test("clears the session timeout and attempts unlock even when acquisition fails", async () => {
    const events: string[] = [];
    const connection = {
      async unsafe(query: string): Promise<unknown[]> {
        events.push(query);
        if (query.includes("pg_advisory_lock")) {
          throw Object.assign(new Error("lock timeout"), { errno: "55P03" });
        }
        return [];
      },
      async release(): Promise<void> {
        events.push("release");
      },
    };
    const sql = { reserve: async () => connection } as unknown as SQL;

    let caught: { code?: string } | undefined;
    try {
      await migrate({ sql, migrationsDir: MIGRATIONS_DIR, lockTimeoutMs: 25 });
    } catch (error) {
      caught = error as { code?: string };
    }

    expect(caught?.code).toBe("MIGRATION_LOCK_TIMEOUT");
    expect(events).toEqual([
      "SET lock_timeout = '25ms'",
      expect.stringContaining("pg_advisory_lock"),
      expect.stringContaining("pg_advisory_unlock"),
      "SET lock_timeout = DEFAULT",
      "release",
    ]);
  });
});
