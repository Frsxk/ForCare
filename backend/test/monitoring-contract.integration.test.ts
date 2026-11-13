import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as checkInSchemas from "../src/checkins/schemas";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;

const VALID_OBSERVATION = {
  type: "bp_systolic_mmhg",
  value: 120.123,
  unit: "mmhg",
  observedAt: "2026-11-13T08:00:00Z",
};

const VALID_BODY = {
  condition: "ok",
  note: null,
  medicationAdherence: "regular",
  observations: [VALID_OBSERVATION],
};

function parseCreate(body: unknown) {
  return checkInSchemas.checkInCreateSchema.safeParse(body);
}

describe("check-in API contract shape", () => {
  test("accepts the approved create body with lowercase units", () => {
    expect(parseCreate(VALID_BODY).success).toBe(true);
  });

  test("requires condition as ok|complaint", () => {
    expect(parseCreate({ ...VALID_BODY, condition: "complaint" }).success).toBe(true);
    expect(parseCreate({ ...VALID_BODY, condition: "fever" }).success).toBe(false);
  });

  test("requires scalar medication adherence regular|missed_once|none", () => {
    for (const status of ["regular", "missed_once", "none"]) {
      expect(parseCreate({ ...VALID_BODY, medicationAdherence: status }).success).toBe(true);
    }
    expect(parseCreate({ ...VALID_BODY, medicationAdherence: "sometimes" }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, medicationAdherence: { taken: true } }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, medicationAdherence: [{ name: "x", taken: true }] }).success).toBe(false);
    const { medicationAdherence: _missing, ...withoutAdherence } = VALID_BODY;
    expect(parseCreate(withoutAdherence).success).toBe(false);
  });

  test("requires note, nullable but never blank", () => {
    expect(parseCreate({ ...VALID_BODY, note: "felt fine" }).success).toBe(true);
    expect(parseCreate({ ...VALID_BODY, note: "  " }).success).toBe(false);
    const { note: _missing, ...withoutNote } = VALID_BODY;
    expect(parseCreate(withoutNote).success).toBe(false);
  });

  test("keeps units exactly lowercase and rejects case-normalisation", () => {
    expect(parseCreate({ ...VALID_BODY, observations: [{ ...VALID_OBSERVATION, unit: "mmHg" }] }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, observations: [{ ...VALID_OBSERVATION, type: "temperature_c", unit: "c" }] }).success).toBe(true);
    expect(parseCreate({ ...VALID_BODY, observations: [{ ...VALID_OBSERVATION, type: "temperature_c", unit: "C" }] }).success).toBe(false);
  });

  test("enforces finite positive numeric(8,3) with at most three fraction digits", () => {
    const observation = (value: number) => ({ ...VALID_OBSERVATION, value });
    expect(parseCreate({ ...VALID_BODY, observations: [observation(0)] }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, observations: [observation(-1.5)] }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, observations: [observation(99999.999)] }).success).toBe(true);
    expect(parseCreate({ ...VALID_BODY, observations: [observation(100000)] }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, observations: [observation(38.123)] }).success).toBe(true);
    expect(parseCreate({ ...VALID_BODY, observations: [observation(38.1234)] }).success).toBe(false);
    expect(parseCreate({ ...VALID_BODY, observations: [observation(Number.NaN)] }).success).toBe(false);
  });

  test("rejects duplicate observation types in one snapshot", () => {
    const duplicate = [
      { ...VALID_OBSERVATION, type: "heart_rate_bpm", value: 80, unit: "bpm" },
      { ...VALID_OBSERVATION, type: "heart_rate_bpm", value: 81, unit: "bpm" },
    ];
    expect(parseCreate({ ...VALID_BODY, observations: duplicate }).success).toBe(false);
  });

  test("rejects unknown body fields and client-owned identity", () => {
    for (const extra of [{ patientId: randomUUID() }, { status: "draft" }, { localDate: "2026-11-13" }, { timeZone: "Asia/Jakarta" }, { actor: "x" }]) {
      expect(parseCreate({ ...VALID_BODY, ...extra }).success).toBe(false);
    }
  });

  test("PUT requires expectedVersion plus every editable field", () => {
    expect(checkInSchemas.checkInUpdateSchema.safeParse({ expectedVersion: 0, ...VALID_BODY }).success).toBe(true);
    const { observations: _omitted, ...withoutObservations } = VALID_BODY;
    expect(checkInSchemas.checkInUpdateSchema.safeParse({ expectedVersion: 0, ...withoutObservations }).success).toBe(false);
  });

  test("PATCH requires expectedVersion plus at least one editable field", () => {
    const patchSchema = (checkInSchemas as any).checkInPatchSchema;
    expect(patchSchema).toBeDefined();
    expect(patchSchema.safeParse({ expectedVersion: 2, medicationAdherence: "missed_once" }).success).toBe(true);
    expect(patchSchema.safeParse({ expectedVersion: 2, note: null }).success).toBe(true);
    expect(patchSchema.safeParse({ expectedVersion: 2 }).success).toBe(false);
    expect(patchSchema.safeParse({ medicationAdherence: "none" }).success).toBe(false);
    expect(patchSchema.safeParse({ expectedVersion: 2, condition: "fever" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Database constraints: raw SQL, one disposable migrated database.    */
/* ------------------------------------------------------------------ */

let db: DisposableDatabase;
let patientId: string;
let staffId: string;

type Sql = DisposableDatabase["sql"];

async function seedAccount(tag: string): Promise<string> {
  const id = randomUUID();
  await db.sql`INSERT INTO public.accounts (id, email_normalized, password_hash)
    VALUES (${id}, ${`${tag}-${id}@example.test`}, 'synthetic-not-a-login')`;
  return id;
}

async function seedPatient(): Promise<string> {
  const id = randomUUID();
  const accountId = await seedAccount("patient");
  await db.sql`INSERT INTO public.patients (id, account_id, full_name, birth_date, gender, phone)
    VALUES (${id}, ${accountId}, 'Synthetic Contract Patient', '1990-01-01', 'female', '+62')`;
  return id;
}

async function seedStaff(): Promise<string> {
  const id = randomUUID();
  const accountId = await seedAccount("nurse");
  await db.sql`INSERT INTO public.staff
      (id, account_id, staff_code, discipline, display_name, identity_approval_ref,
       identity_approved_by, identity_approved_at, provisioning_email_domain,
       domain_checked_at, provisioned_by)
    VALUES (${id}, ${accountId}, ${`SYN-${id.slice(0, 8)}`}, 'nurse', 'Synthetic Nurse',
       'approval-synthetic', 'synthetic-operator', now(), 'nurse.invalid', now(), 'synthetic-operator')`;
  return id;
}

let draftDay = 0;

async function insertCheckIn(
  sql: Sql,
  options: { condition?: string; medicationAdherence?: string; note?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  draftDay += 1;
  const localDate = `2026-12-${String(draftDay % 28 + 1).padStart(2, "0")}`;
  await sql`INSERT INTO public.check_ins
      (id, patient_id, local_date, time_zone, condition, note, medication_adherence, status, version)
    VALUES (${id}, ${patientId}, ${localDate}, 'Asia/Jakarta',
      ${options.condition ?? "ok"}, ${options.note ?? null},
      ${options.medicationAdherence ?? "regular"}, 'draft', 0)`;
  return id;
}

async function insertAdherence(sql: Sql, checkInId: string, status: string): Promise<void> {
  await sql`INSERT INTO public.medication_adherence (check_in_id, status)
    VALUES (${checkInId}, ${status})`;
}

async function createDraft(
  options: { condition?: string; medicationAdherence?: string; note?: string | null } = {},
): Promise<string> {
  return db.sql.begin(async (tx: Sql) => {
    const id = await insertCheckIn(tx, options);
    await insertAdherence(tx, id, options.medicationAdherence ?? "regular");
    return id;
  });
}

async function insertObservation(
  sql: Sql,
  checkInId: string,
  options: Partial<{ type: string; value: number; unit: string; source: string; observedAt: string }> = {},
): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO public.check_in_observations
      (id, check_in_id, patient_id, type, value, unit, observed_at, source)
    VALUES (${id}, ${checkInId}, ${patientId}, ${options.type ?? "temperature_c"},
      ${options.value ?? 37.5}, ${options.unit ?? "c"},
      ${options.observedAt ?? "2026-12-01T08:00:00.123Z"}, ${options.source ?? "check_in"})`;
  return id;
}

async function submitCheckIn(sql: Sql, checkInId: string, version = 1): Promise<void> {
  await sql`UPDATE public.check_ins
    SET status = 'submitted', submitted_at = now(), version = ${version}
    WHERE id = ${checkInId}`;
}

async function expectCommitError(
  run: (tx: any) => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  const client = new SQL(db.url, { max: 1 });
  try {
    await client.unsafe("BEGIN");
    try {
      await run(client);
      // The constraint is INITIALLY DEFERRED, so the transaction may hold a
      // transient mismatch; forcing the deferred check must reject it.
      await client.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      await client.unsafe("COMMIT");
    } catch (error) {
      await client.unsafe("ROLLBACK").catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (!pattern.test(message)) {
        throw new Error(`expected deferred constraint error ${pattern}, received: ${message}`);
      }
      return;
    }
  } finally {
    await client.close();
  }
  throw new Error(`expected deferred constraint error ${pattern}, but the check passed`);
}

async function expectSqlError(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`expected SQL error ${pattern}, received: ${message}`);
    }
    return;
  }
  throw new Error(`expected SQL error ${pattern}, but the statement succeeded`);
}

integration("T08 monitoring schema contract", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("t08contract");
    patientId = await seedPatient();
    staffId = await seedStaff();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  test("check_ins has the approved columns and no legacy condition freedom", async () => {
    const columns = await db.sql`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_ins'`;
    expect(columns.map((row: any) => row.column_name).sort()).toEqual([
      "condition", "created_at", "id", "local_date", "medication_adherence", "note",
      "patient_id", "status", "submitted_at", "supersedes_check_in_id", "time_zone",
      "updated_at", "version",
    ]);

    const id = await createDraft({ condition: "complaint", medicationAdherence: "missed_once" });

    await expectSqlError(
      () => insertCheckIn(db.sql, { condition: "fever" }),
      /check_ins_condition_check/,
    );
    await expectSqlError(
      () => insertCheckIn(db.sql, { medicationAdherence: "sometimes" }),
      /check_ins_medication_adherence_check/,
    );
  });

  test("check_in_observations replaces observations with exact enum, unit, positive, source and uniqueness", async () => {
    expect((await db.sql`SELECT to_regclass('public.observations') AS relation`)[0].relation).toBeNull();

    const columns = await db.sql`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_in_observations'`;
    expect(columns.map((row: any) => row.column_name).sort()).toEqual([
      "check_in_id", "created_at", "id", "observed_at", "patient_id", "source",
      "type", "unit", "value",
    ]);

    const deleteRule = await db.sql`SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc
        ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = 'check_in_observations'
        AND tc.constraint_type = 'FOREIGN KEY'`;
    expect(deleteRule.map((row: any) => row.delete_rule)).toContain("CASCADE");

    const checkInId = await createDraft();
    await insertObservation(db.sql, checkInId, { source: "nurse_entry" });

    await expectSqlError(
      () => insertObservation(db.sql, checkInId, { type: "temperature_c" }),
      /check_in_observations_check_in_type_unique|duplicate key/,
    );
    await expectSqlError(
      () => insertObservation(db.sql, checkInId, { type: "spo2_pct", value: 98, unit: "pct", source: "device" }),
      /check_in_observations_source_check/,
    );
    await expectSqlError(
      () => insertObservation(db.sql, checkInId, { type: "bp_systolic_mmhg", value: 120, unit: "mmHg" }),
      /check_in_observations_unit_check/,
    );
    await expectSqlError(
      () => insertObservation(db.sql, checkInId, { type: "bp_diastolic_mmhg", value: 0, unit: "mmhg" }),
      /check_in_observations_value_check/,
    );
  });

  test("medication_adherence is exactly one row per check-in keyed by check_in_id", async () => {
    const columns = await db.sql`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'medication_adherence'`;
    expect(columns.map((row: any) => row.column_name).sort()).toEqual([
      "check_in_id", "note", "status",
    ]);

    const primaryKey = await db.sql`SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = 'medication_adherence'
        AND tc.constraint_type = 'PRIMARY KEY'`;
    expect(primaryKey.map((row: any) => row.column_name)).toEqual(["check_in_id"]);

    const checkInId = await createDraft();
    await expectSqlError(
      () => insertAdherence(db.sql, checkInId, "missed_once"),
      /duplicate key/,
    );
    await expectSqlError(
      () => insertAdherence(db.sql, randomUUID(), "regular"),
      /medication_adherence_check_in_id_fkey|foreign key|matching parent check-in/,
    );
  });

  test("deferred consistency rejects a missing or mismatched medication child only at commit", async () => {
    await expectCommitError(
      (tx) => insertCheckIn(tx),
      /requires exactly one medication adherence row|medication adherence/,
    );

    // Both consistency triggers are DEFERRABLE INITIALLY DEFERRED, which is
    // what allows a service to replace the child and update the parent scalar
    // in either order inside one transaction.
    const triggers = await db.sql`SELECT tgname, tgdeferrable, tginitdeferred
      FROM pg_trigger
      WHERE tgname IN ('check_ins_medication_adherence_consistency', 'medication_adherence_consistency')
      ORDER BY tgname`;
    expect(triggers).toEqual([
      { tgname: "check_ins_medication_adherence_consistency", tgdeferrable: true, tginitdeferred: true },
      { tgname: "medication_adherence_consistency", tgdeferrable: true, tginitdeferred: true },
    ]);

    const committed = await db.sql.begin(async (tx: Sql) => {
      const id = await insertCheckIn(tx, { medicationAdherence: "none" });
      await insertAdherence(tx, id, "none");
      return id;
    });
    const status = await db.sql`SELECT status FROM public.medication_adherence WHERE check_in_id = ${committed}`;
    expect(status[0].status).toBe("none");

    const replaced = await db.sql.begin(async (tx: Sql) => {
      const id = await insertCheckIn(tx);
      await insertAdherence(tx, id, "regular");
      await tx`DELETE FROM public.medication_adherence WHERE check_in_id = ${id}`;
      await insertAdherence(tx, id, "missed_once");
      await tx`UPDATE public.check_ins
        SET medication_adherence = 'missed_once', version = 1
        WHERE id = ${id}`;
      return id;
    });
    const replacedStatus = await db.sql`SELECT status FROM public.medication_adherence WHERE check_in_id = ${replaced}`;
    expect(replacedStatus[0].status).toBe("missed_once");
  });

  test("parent and child content freeze after submission", async () => {
    const checkInId = await db.sql.begin(async (tx: Sql) => {
      const id = await insertCheckIn(tx);
      await insertAdherence(tx, id, "regular");
      await insertObservation(tx, id);
      await submitCheckIn(tx, id);
      return id;
    });

    await expectSqlError(
      () => db.sql`UPDATE public.check_ins SET note = 'late edit', version = 2 WHERE id = ${checkInId}`,
      /immutable|frozen/,
    );
    const observationId = (await db.sql`SELECT id FROM public.check_in_observations WHERE check_in_id = ${checkInId}`)[0].id;
    await expectSqlError(
      () => db.sql`UPDATE public.check_in_observations SET value = 38 WHERE id = ${observationId}`,
      /frozen/,
    );
    await expectSqlError(
      () => db.sql`DELETE FROM public.check_in_observations WHERE id = ${observationId}`,
      /frozen/,
    );
    await expectSqlError(
      () => insertObservation(db.sql, checkInId, { type: "heart_rate_bpm", value: 80, unit: "bpm" }),
      /frozen/,
    );
    await expectSqlError(
      () => db.sql`UPDATE public.medication_adherence SET status = 'none' WHERE check_in_id = ${checkInId}`,
      /frozen/,
    );
    await expectSqlError(
      () => db.sql`DELETE FROM public.medication_adherence WHERE check_in_id = ${checkInId}`,
      /frozen/,
    );
  });

  test("observation_confirmations uses staff_id and keeps snapshot provenance append-only", async () => {
    const columns = await db.sql`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'observation_confirmations'`;
    const names = columns.map((row: any) => row.column_name);
    expect(names).toContain("staff_id");
    expect(names).not.toContain("confirmed_by");
    expect(names).toEqual(expect.arrayContaining([
      "observation_id", "check_in_id", "patient_id", "observation_type",
      "observation_value", "observation_unit", "observation_observed_at",
      "check_in_version", "note", "confirmed_at",
    ]));

    const { checkInId, observationId } = await db.sql.begin(async (tx: Sql) => {
      const id = await insertCheckIn(tx);
      await insertAdherence(tx, id, "regular");
      const observation = await insertObservation(tx, id, { type: "heart_rate_bpm", value: 80, unit: "bpm" });
      await submitCheckIn(tx, id);
      return { checkInId: id, observationId: observation };
    });

    const snapshot = (await db.sql`SELECT * FROM public.check_in_observations WHERE id = ${observationId}`)[0];
    await db.sql`INSERT INTO public.observation_confirmations
        (observation_id, check_in_id, patient_id, observation_type, observation_value,
         observation_unit, observation_observed_at, check_in_version, note, staff_id)
      VALUES (${observationId}, ${checkInId}, ${patientId}, ${snapshot.type}, ${snapshot.value},
        ${snapshot.unit}, ${snapshot.observed_at}, 1, 'synthetic', ${staffId})`;

    await expectSqlError(
      () => db.sql`INSERT INTO public.observation_confirmations
          (observation_id, check_in_id, patient_id, observation_type, observation_value,
           observation_unit, observation_observed_at, check_in_version, staff_id)
        VALUES (${observationId}, ${checkInId}, ${patientId}, ${snapshot.type}, ${snapshot.value},
          ${snapshot.unit}, ${snapshot.observed_at}, 1, ${staffId})`,
      /observation_confirmations_one_per_observation|duplicate key/,
    );

    const confirmationId = (await db.sql`SELECT id FROM public.observation_confirmations WHERE observation_id = ${observationId}`)[0].id;
    await expectSqlError(
      () => db.sql`UPDATE public.observation_confirmations SET note = 'changed' WHERE id = ${confirmationId}`,
      /immutable|append-only/,
    );
    await expectSqlError(
      () => db.sql`DELETE FROM public.observation_confirmations WHERE id = ${confirmationId}`,
      /immutable|append-only/,
    );
  });

  test("child insert waits on a concurrent submit and then rejects", async () => {
    const checkInId = await db.sql.begin(async (tx: Sql) => {
      const id = await insertCheckIn(tx);
      await insertAdherence(tx, id, "regular");
      return id;
    });

    const writer = new SQL(db.url, { max: 1 });
    const submitter = new SQL(db.url, { max: 1 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const submit = submitter.begin(async (tx: any) => {
        await tx`UPDATE public.check_ins
          SET status = 'submitted', submitted_at = now(), version = 1
          WHERE id = ${checkInId}`;
        await gate;
      });
      await Bun.sleep(200);
      const lateChild = writer.begin(async (tx: any) => {
        await tx.unsafe("SET LOCAL lock_timeout = '5000ms'");
        await tx`INSERT INTO public.check_in_observations
            (check_in_id, patient_id, type, value, unit, observed_at, source)
          VALUES (${checkInId}, ${patientId}, 'heart_rate_bpm', 80, 'bpm', now(), 'check_in')`;
      });
      await Bun.sleep(300);
      release();
      await submit;
      await expectSqlError(() => lateChild, /frozen|submitted|lock timeout/);
    } finally {
      release();
      await writer.close();
      await submitter.close();
    }
  });
});
