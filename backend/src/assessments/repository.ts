import type { SQL } from "bun";

/**
 * Metadata-only projection of assessment runs. The numeric score column is
 * deliberately never selected: while G02 is unapproved, stored numeric rows
 * must not leak through the read boundary. The instrument join is optional
 * because unavailable runs may honestly have no instrument.
 */
export type AssessmentRunMetadataRow = {
  id: string;
  patient_id: string;
  instrument_id: string | null;
  instrument_code: string | null;
  instrument_name: string | null;
  source_check_in_id: string | null;
  status: string;
  unavailable_reason: string | null;
  computed_at: Date | string | null;
  reviewed_by: string | null;
  created_at: Date | string;
};

export async function listAssessmentRunMetadata(
  sql: SQL,
  input: {
    patientId: string;
    limit: number;
    afterCreatedAt: string | null;
    afterId: string | null;
  },
): Promise<AssessmentRunMetadataRow[]> {
  return (await sql`
    SELECT r.id, r.patient_id, r.instrument_id, i.code AS instrument_code,
           i.name AS instrument_name, r.source_check_in_id, r.status,
           r.unavailable_reason, r.computed_at, r.reviewed_by, r.created_at
    FROM public.assessment_runs r
    LEFT JOIN public.assessment_instruments i ON i.id = r.instrument_id
    WHERE r.patient_id = ${input.patientId}
      AND (
        ${input.afterCreatedAt}::timestamptz IS NULL
        OR (r.created_at, r.id) < (${input.afterCreatedAt}::timestamptz, ${input.afterId}::uuid)
      )
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${input.limit + 1}
  `) as unknown as AssessmentRunMetadataRow[];
}
