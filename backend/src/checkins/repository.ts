import type { SQL } from "bun";

export type CheckInRow = {
  id: string;
  patient_id: string;
  local_date: string;
  time_zone: string;
  condition: string;
  note: string | null;
  medication_adherence: string;
  status: string;
  supersedes_check_in_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  submitted_at: Date | string | null;
};

export type ObservationRow = {
  id: string;
  check_in_id: string;
  patient_id: string;
  type: string;
  value: string | number;
  unit: string;
  observed_at: Date | string;
  source: string;
  created_at: Date | string;
};

export type ObservationWithCheckInRow = ObservationRow & {
  check_in_status: string;
  check_in_version: number;
};

export type ObservationConfirmationRow = {
  id: string;
  observation_id: string;
  check_in_id: string;
  patient_id: string;
  observation_type: string;
  observation_value: string | number;
  observation_unit: string;
  observation_observed_at: Date | string;
  check_in_version: number;
  note: string | null;
  staff_id: string;
  confirmed_at: Date | string;
};

export type LatestSubmittedCheckInRow = {
  id: string;
  condition: string;
  local_date: string;
  submitted_at: Date | string;
};

const CHECK_IN_COLUMNS = `
  id, patient_id, to_char(local_date, 'YYYY-MM-DD') AS local_date, time_zone,
  condition, note, medication_adherence, status, supersedes_check_in_id, version,
  created_at, updated_at, submitted_at
`;

const OBSERVATION_COLUMNS = `
  o.id, o.check_in_id, o.patient_id, o.type, o.value, o.unit, o.observed_at,
  o.source, o.created_at
`;

const CONFIRMATION_COLUMNS = `
  id, observation_id, check_in_id, patient_id, observation_type,
  observation_value, observation_unit, observation_observed_at,
  check_in_version, note, staff_id, confirmed_at
`;

export async function readCheckInById(sql: SQL, id: string): Promise<CheckInRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CHECK_IN_COLUMNS)}
    FROM public.check_ins
    WHERE id = ${id}
    LIMIT 1
  `) as unknown as CheckInRow[];
  return rows[0] ?? null;
}

export async function readCheckInByIdForUpdate(sql: SQL, id: string): Promise<CheckInRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CHECK_IN_COLUMNS)}
    FROM public.check_ins
    WHERE id = ${id}
    FOR UPDATE
  `) as unknown as CheckInRow[];
  return rows[0] ?? null;
}

export async function readDraftForDay(
  sql: SQL,
  patientId: string,
  localDate: string,
): Promise<CheckInRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CHECK_IN_COLUMNS)}
    FROM public.check_ins
    WHERE patient_id = ${patientId}
      AND local_date = ${localDate}::date
      AND status = 'draft'
    LIMIT 1
  `) as unknown as CheckInRow[];
  return rows[0] ?? null;
}

export async function insertCheckIn(
  sql: SQL,
  input: {
    patientId: string;
    localDate: string;
    timeZone: string;
    condition: string;
    note: string | null;
    medicationAdherence: string;
    supersedesCheckInId: string | null;
  },
): Promise<CheckInRow> {
  const rows = (await sql`
    INSERT INTO public.check_ins (
      patient_id, local_date, time_zone, condition, note, medication_adherence,
      status, supersedes_check_in_id
    ) VALUES (
      ${input.patientId}, ${input.localDate}::date, ${input.timeZone},
      ${input.condition}, ${input.note}, ${input.medicationAdherence},
      'draft', ${input.supersedesCheckInId}
    )
    RETURNING ${sql.unsafe(CHECK_IN_COLUMNS)}
  `) as unknown as CheckInRow[];
  return rows[0];
}

export async function updateDraftCheckIn(
  sql: SQL,
  input: {
    id: string;
    expectedVersion: number;
    condition: string;
    note: string | null;
    medicationAdherence: string;
  },
): Promise<CheckInRow | null> {
  const rows = (await sql`
    UPDATE public.check_ins
    SET condition = ${input.condition},
        note = ${input.note},
        medication_adherence = ${input.medicationAdherence},
        version = version + 1,
        updated_at = now()
    WHERE id = ${input.id}
      AND status = 'draft'
      AND version = ${input.expectedVersion}
    RETURNING ${sql.unsafe(CHECK_IN_COLUMNS)}
  `) as unknown as CheckInRow[];
  return rows[0] ?? null;
}

export async function submitCheckInRow(
  sql: SQL,
  input: { id: string; expectedVersion: number },
): Promise<CheckInRow | null> {
  const rows = (await sql`
    UPDATE public.check_ins
    SET status = 'submitted',
        submitted_at = now(),
        version = version + 1,
        updated_at = now()
    WHERE id = ${input.id}
      AND status = 'draft'
      AND version = ${input.expectedVersion}
    RETURNING ${sql.unsafe(CHECK_IN_COLUMNS)}
  `) as unknown as CheckInRow[];
  return rows[0] ?? null;
}

export async function deleteObservationsForCheckIn(sql: SQL, checkInId: string): Promise<void> {
  await sql`DELETE FROM public.check_in_observations WHERE check_in_id = ${checkInId}`;
}

export async function deleteMedicationAdherenceForCheckIn(sql: SQL, checkInId: string): Promise<void> {
  await sql`DELETE FROM public.medication_adherence WHERE check_in_id = ${checkInId}`;
}

export async function insertObservations(
  sql: SQL,
  checkInId: string,
  patientId: string,
  observations: ReadonlyArray<{
    type: string;
    value: number;
    unit: string;
    observedAt: string;
  }>,
): Promise<void> {
  for (const observation of observations) {
    await sql`
      INSERT INTO public.check_in_observations (
        check_in_id, patient_id, type, value, unit, observed_at, source
      ) VALUES (
        ${checkInId}, ${patientId}, ${observation.type}, ${observation.value},
        ${observation.unit}, ${observation.observedAt}::timestamptz, 'check_in'
      )
    `;
  }
}

/** Exactly one adherence child per check-in; its status matches the parent scalar. */
export async function insertMedicationAdherence(
  sql: SQL,
  checkInId: string,
  status: string,
): Promise<void> {
  await sql`
    INSERT INTO public.medication_adherence (check_in_id, status, note)
    VALUES (${checkInId}, ${status}, NULL)
  `;
}

export async function listCheckIns(
  sql: SQL,
  input: {
    patientId: string;
    includeDrafts: boolean;
    status: string | null;
    limit: number;
    afterCreatedAt: string | null;
    afterId: string | null;
  },
): Promise<CheckInRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(CHECK_IN_COLUMNS)}
    FROM public.check_ins
    WHERE patient_id = ${input.patientId}
      AND (${input.includeDrafts}::boolean = true OR status = 'submitted')
      AND (${input.status}::text IS NULL OR status = ${input.status}::text)
      AND (
        ${input.afterCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${input.afterCreatedAt}::timestamptz, ${input.afterId}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${input.limit + 1}
  `) as unknown as CheckInRow[];
}

export async function listObservationsForCheckIn(
  sql: SQL,
  checkInId: string,
): Promise<ObservationRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(OBSERVATION_COLUMNS)}
    FROM public.check_in_observations o
    WHERE o.check_in_id = ${checkInId}
    ORDER BY o.type, o.id
  `) as unknown as ObservationRow[];
}

export async function listSubmittedObservations(
  sql: SQL,
  input: {
    patientId: string;
    type: string | null;
    limit: number;
    afterObservedAt: string | null;
    afterId: string | null;
  },
): Promise<ObservationRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(OBSERVATION_COLUMNS)}
    FROM public.check_in_observations o
    JOIN public.check_ins ci ON ci.id = o.check_in_id
    WHERE o.patient_id = ${input.patientId}
      AND ci.status = 'submitted'
      AND (${input.type}::text IS NULL OR o.type = ${input.type}::text)
      AND (
        ${input.afterObservedAt}::timestamptz IS NULL
        OR (o.observed_at, o.id) < (${input.afterObservedAt}::timestamptz, ${input.afterId}::uuid)
      )
    ORDER BY o.observed_at DESC, o.id DESC
    LIMIT ${input.limit + 1}
  `) as unknown as ObservationRow[];
}

export async function readObservationWithCheckIn(
  sql: SQL,
  id: string,
): Promise<ObservationWithCheckInRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(OBSERVATION_COLUMNS)},
           ci.status AS check_in_status, ci.version AS check_in_version
    FROM public.check_in_observations o
    JOIN public.check_ins ci ON ci.id = o.check_in_id
    WHERE o.id = ${id}
    LIMIT 1
  `) as unknown as ObservationWithCheckInRow[];
  return rows[0] ?? null;
}

export async function readObservationConfirmation(
  sql: SQL,
  observationId: string,
): Promise<ObservationConfirmationRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CONFIRMATION_COLUMNS)}
    FROM public.observation_confirmations
    WHERE observation_id = ${observationId}
    LIMIT 1
  `) as unknown as ObservationConfirmationRow[];
  return rows[0] ?? null;
}

export async function insertObservationConfirmation(
  sql: SQL,
  input: {
    observationId: string;
    checkInId: string;
    patientId: string;
    observationType: string;
    observationValue: number;
    observationUnit: string;
    observationObservedAt: string;
    checkInVersion: number;
    note: string | null;
    staffId: string;
  },
): Promise<ObservationConfirmationRow> {
  const rows = (await sql`
    INSERT INTO public.observation_confirmations (
      observation_id, check_in_id, patient_id, observation_type,
      observation_value, observation_unit, observation_observed_at,
      check_in_version, note, staff_id
    ) VALUES (
      ${input.observationId}, ${input.checkInId}, ${input.patientId},
      ${input.observationType}, ${input.observationValue}, ${input.observationUnit},
      ${input.observationObservedAt}::timestamptz, ${input.checkInVersion},
      ${input.note}, ${input.staffId}
    )
    RETURNING ${sql.unsafe(CONFIRMATION_COLUMNS)}
  `) as unknown as ObservationConfirmationRow[];
  return rows[0];
}

/** Newest confirmation event, not the newest measurement timestamp. */
export async function readLatestObservationConfirmation(
  sql: SQL,
  patientId: string,
  type: string | null,
): Promise<ObservationConfirmationRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(CONFIRMATION_COLUMNS)}
    FROM public.observation_confirmations
    WHERE patient_id = ${patientId}
      AND (${type}::text IS NULL OR observation_type = ${type}::text)
    ORDER BY confirmed_at DESC, id DESC
    LIMIT 1
  `) as unknown as ObservationConfirmationRow[];
  return rows[0] ?? null;
}

/** Only submitted rows feed the patient summary; drafts never leak there. */
export async function readLatestSubmittedCheckIn(
  sql: SQL,
  patientId: string,
): Promise<LatestSubmittedCheckInRow | null> {
  const rows = (await sql`
    SELECT id, condition, to_char(local_date, 'YYYY-MM-DD') AS local_date, submitted_at
    FROM public.check_ins
    WHERE patient_id = ${patientId} AND status = 'submitted'
    ORDER BY submitted_at DESC, id DESC
    LIMIT 1
  `) as unknown as LatestSubmittedCheckInRow[];
  return rows[0] ?? null;
}
