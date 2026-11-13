import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Versioned PostgreSQL migrations for the ForCare domain schema.
 *
 * Each migration file is applied inside its own transaction and recorded in
 * public.schema_migrations with a SHA-256 checksum. A session advisory lock
 * serializes runners. The approved manifest sequence is fixed: migration
 * numbers and names may not be renumbered or renamed, and a later migration
 * only adds objects it owns.
 */

export type MigrationManifestEntry = {
  readonly version: string;
  readonly name: string;
};

/** Exact approved sequence from schema-contract-v0.1 section 2. */
export const MIGRATION_MANIFEST: readonly MigrationManifestEntry[] = [
  { version: "0001", name: "identity" },
  { version: "0002", name: "patients_operations" },
  { version: "0003", name: "clinical_sources" },
  { version: "0004", name: "monitoring" },
  { version: "0005", name: "assessments" },
  { version: "0006", name: "knowledge" },
  { version: "0007", name: "analysis" },
  { version: "0008", name: "reviews" },
  { version: "0009", name: "availability" },
  { version: "0010", name: "bookings" },
  { version: "0011", name: "priority_requests" },
  { version: "0012", name: "visits" },
  { version: "0013", name: "notifications" },
  { version: "0014", name: "push" },
];

export type MigrationErrorCode =
  | "MIGRATION_INVALID_FILENAME"
  | "MIGRATION_UNKNOWN_VERSION"
  | "MIGRATION_NAME_MISMATCH"
  | "MIGRATION_DUPLICATE_VERSION"
  | "MIGRATION_FILE_MISSING"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_OUT_OF_ORDER"
  | "MIGRATION_FAILED"
  | "MIGRATION_LOCK_TIMEOUT";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}

export type MigrationFile = {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

export type AppliedMigrationRecord = {
  version: string;
  name: string;
  checksum: string;
};

export type AppliedMigration = AppliedMigrationRecord & {
  appliedAt: string;
  appliedBy: string;
};

export type MigrateResult = {
  applied: AppliedMigration[];
  skipped: string[];
};

export type MigrateOptions = {
  sql: SQL;
  migrationsDir?: string;
  appliedBy?: string;
  lockTimeoutMs?: number;
};

const DEFAULT_MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;
const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const HISTORY_TABLE = "public.schema_migrations";
const MIGRATION_LOCK_KEY = 4868321543210;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

const manifestOrder = new Map(
  MIGRATION_MANIFEST.map((entry, index) => [entry.version, { entry, order: index + 1 }]),
);

/**
 * Enforces that versions form a contiguous prefix of the approved manifest:
 * later entries may be absent, but an intermediate version may never be
 * skipped. `onGap` lets each caller choose its error code and wording.
 */
function assertContiguousManifestPrefix(
  versions: readonly string[],
  onGap: (missing: MigrationManifestEntry, presentThrough: MigrationManifestEntry) => MigrationError,
): void {
  const present = new Set(versions);
  let highestOrder = 0;
  for (const version of present) {
    const order = manifestOrder.get(version)?.order;
    if (order !== undefined && order > highestOrder) highestOrder = order;
  }

  for (let index = 0; index < highestOrder; index += 1) {
    const entry = MIGRATION_MANIFEST[index];
    if (!present.has(entry.version)) {
      throw onGap(entry, MIGRATION_MANIFEST[highestOrder - 1]);
    }
  }
}

const BOOTSTRAP_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
  version text PRIMARY KEY,
  name text,
  checksum text,
  applied_at timestamptz,
  applied_by text
)`;

export function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function describe(version: string, name: string): string {
  return `${version}_${name}`;
}

/**
 * Reads the migration directory and validates every `.sql` file against the
 * approved manifest. Missing later files are allowed; unknown files, renamed
 * files and missing 0001 are not.
 */
export async function loadMigrations(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;

    const match = MIGRATION_FILENAME.exec(entry.name);
    if (!match) {
      throw new MigrationError(
        "MIGRATION_INVALID_FILENAME",
        `Migration file "${entry.name}" must be named NNNN_name.sql`,
      );
    }

    const [, version, name] = match;
    const manifest = manifestOrder.get(version);
    if (!manifest) {
      throw new MigrationError(
        "MIGRATION_UNKNOWN_VERSION",
        `Migration file "${entry.name}" uses version ${version}, which is not in the approved manifest`,
      );
    }
    if (manifest.entry.name !== name) {
      throw new MigrationError(
        "MIGRATION_NAME_MISMATCH",
        `Migration file "${entry.name}" does not match manifest entry ${describe(version, manifest.entry.name)}`,
      );
    }
    if (seen.has(version)) {
      throw new MigrationError(
        "MIGRATION_DUPLICATE_VERSION",
        `More than one migration file claims version ${version}`,
      );
    }

    const path = join(migrationsDir, entry.name);
    const sql = await readFile(path, "utf8");
    seen.add(version);
    files.push({ version, name, path, sql, checksum: computeChecksum(sql) });
  }

  if (!seen.has("0001")) {
    throw new MigrationError(
      "MIGRATION_FILE_MISSING",
      "Approved migration 0001_identity is missing from the migration directory",
    );
  }

  return files.sort((left, right) => left.version.localeCompare(right.version));
}

/**
 * Validates recorded history against the files and returns the pending
 * migrations in manifest order. Pure function: it never touches a database.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigrationRecord[],
): { pending: MigrationFile[]; skipped: string[] } {
  const filesByVersion = new Map(files.map((file) => [file.version, file]));
  const appliedByVersion = new Map(applied.map((record) => [record.version, record]));
  const appliedSorted = [...applied].sort((left, right) => left.version.localeCompare(right.version));
  let highestAppliedOrder = 0;
  let highestApplied: AppliedMigrationRecord | null = null;

  for (const record of appliedSorted) {
    const manifest = manifestOrder.get(record.version);
    if (!manifest) {
      throw new MigrationError(
        "MIGRATION_UNKNOWN_VERSION",
        `Recorded migration ${record.version} is not in the approved manifest`,
      );
    }
    if (manifest.entry.name !== record.name) {
      throw new MigrationError(
        "MIGRATION_NAME_MISMATCH",
        `Recorded migration ${record.version} is named "${record.name}" but the manifest requires "${manifest.entry.name}"`,
      );
    }

    const file = filesByVersion.get(record.version);
    if (!file) {
      throw new MigrationError(
        "MIGRATION_FILE_MISSING",
        `Recorded migration ${describe(record.version, record.name)} has no migration file`,
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationError(
        "MIGRATION_CHECKSUM_MISMATCH",
        `Recorded migration ${describe(record.version, record.name)} checksum does not match the migration file`,
      );
    }

    if (manifest.order > highestAppliedOrder) {
      highestAppliedOrder = manifest.order;
      highestApplied = record;
    }
  }

  assertContiguousManifestPrefix(
    appliedSorted.map((record) => record.version),
    (missing, presentThrough) =>
      new MigrationError(
        "MIGRATION_OUT_OF_ORDER",
        `Recorded migration ${describe(presentThrough.version, presentThrough.name)} is applied while earlier approved migration ${describe(missing.version, missing.name)} is missing from history; applied history must be a contiguous manifest prefix`,
      ),
  );

  assertContiguousManifestPrefix(
    files.map((file) => file.version),
    (missing, presentThrough) =>
      new MigrationError(
        "MIGRATION_FILE_MISSING",
        `Migration ${describe(presentThrough.version, presentThrough.name)} is present but earlier approved migration ${describe(missing.version, missing.name)} has no file; only later approved files may be absent`,
      ),
  );

  const pending = files.filter((file) => !appliedByVersion.has(file.version));
  for (const file of pending) {
    const order = manifestOrder.get(file.version)!.order;
    if (order < highestAppliedOrder) {
      throw new MigrationError(
        "MIGRATION_OUT_OF_ORDER",
        `Migration ${describe(file.version, file.name)} is pending before already applied version ${
          highestApplied?.version ?? "unknown"
        }; migrations must apply in manifest order`,
      );
    }
  }

  pending.sort(
    (left, right) => manifestOrder.get(left.version)!.order - manifestOrder.get(right.version)!.order,
  );

  return {
    pending,
    skipped: appliedSorted.map((record) => record.version),
  };
}

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { errno?: string }).errno === "55P03"
  );
}

async function acquireLock(connection: SQL, lockTimeoutMs: number): Promise<void> {
  await connection.unsafe(`SET lock_timeout = '${lockTimeoutMs}ms'`);
  try {
    await connection.unsafe(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new MigrationError(
        "MIGRATION_LOCK_TIMEOUT",
        `Another migration runner held the schema lock for more than ${lockTimeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function releaseLock(connection: SQL): Promise<void> {
  // Unlock first: resetting lock_timeout first could leave the unlock waiting
  // behind another session. Each step runs independently because lock_timeout
  // is set before acquisition can fail, so cleanup must run even when this
  // runner never held the lock.
  try {
    await connection.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  } catch {
    // Best effort: a session that cannot unlock drops its lock on disconnect.
  }
  try {
    await connection.unsafe("SET lock_timeout = DEFAULT");
  } catch {
    // Best effort: the connection is returned to the pool below.
  }
}

/**
 * Applies every pending migration in manifest order and records its checksum.
 * Each migration runs in its own transaction: a failure rolls back that file
 * fully and leaves earlier applied migrations untouched.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const { sql } = options;
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const appliedBy = options.appliedBy?.trim() || "unspecified";
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new Error("lockTimeoutMs must be a non-negative integer");
  }

  const connection = await sql.reserve();
  try {
    await acquireLock(connection, lockTimeoutMs);

    await connection.unsafe(BOOTSTRAP_HISTORY_SQL);

    const files = await loadMigrations(migrationsDir);
    const applied = (await connection`
      SELECT version, name, checksum FROM public.schema_migrations ORDER BY version
    `) as unknown as AppliedMigrationRecord[];

    const plan = planMigrations(files, applied);
    const result: MigrateResult = { applied: [], skipped: plan.skipped };

    for (const migration of plan.pending) {
      const appliedAt = new Date().toISOString();
      try {
        await connection.begin(async (transaction) => {
          await transaction.unsafe(migration.sql);
          await transaction`
            INSERT INTO public.schema_migrations (version, name, checksum, applied_at, applied_by)
            VALUES (
              ${migration.version},
              ${migration.name},
              ${migration.checksum},
              ${appliedAt}::timestamptz,
              ${appliedBy}
            )
          `;
        });
      } catch (error) {
        throw new MigrationError(
          "MIGRATION_FAILED",
          `Migration ${describe(migration.version, migration.name)} failed and was rolled back`,
          { cause: error },
        );
      }

      result.applied.push({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt,
        appliedBy,
      });
    }

    return result;
  } finally {
    // Always clear session state: lock_timeout is set before acquisition can
    // fail, and returning the connection to the pool does not end its session.
    await releaseLock(connection);
    await connection.release();
  }
}
