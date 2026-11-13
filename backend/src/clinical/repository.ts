import type { SQL } from "bun";

export type MedicalRecordRow = {
  id: string;
  patient_id: string;
  revision_number: number;
  supersedes_id: string | null;
  entered_by: string;
  recorded_at: Date | string;
  source_reference: string;
  payload: unknown;
  version: number;
  created_at: Date | string;
};

export type ClinicalSourceRow = {
  id: string;
  lineage_id: string;
  revision_number: number;
  patient_id: string;
  medical_record_version_id: string;
  kind: string;
  title: string;
  body: string;
  checksum: string;
  status: string;
  created_by: string;
  approved_by: string | null;
  approved_at: Date | string | null;
  supersedes_id: string | null;
  version: number;
  created_at: Date | string;
  chunk_count: number;
};

export type CareOrderRow = {
  id: string;
  lineage_id: string;
  revision_number: number;
  patient_id: string;
  medical_record_version_id: string;
  kind: string;
  source_document_id: string;
  source_version: number;
  payload: unknown;
  effective_from: Date | string;
  effective_to: Date | string | null;
  status: string;
  entered_by: string;
  published_by: string | null;
  published_at: Date | string | null;
  supersedes_id: string | null;
  version: number;
  created_at: Date | string;
};

const MEDICAL_RECORD_COLUMNS = `
  id, patient_id, revision_number, supersedes_id, entered_by, recorded_at,
  source_reference, payload, version, created_at
`;

const SOURCE_COLUMNS = `
  s.id, s.lineage_id, s.revision_number, s.patient_id, s.medical_record_version_id,
  s.kind, s.title, s.body, s.checksum, s.status, s.created_by, s.approved_by,
  s.approved_at, s.supersedes_id, s.version, s.created_at,
  (SELECT count(*)::int FROM public.clinical_source_chunks c WHERE c.document_id = s.id) AS chunk_count
`;

const ORDER_COLUMNS = `
  id, lineage_id, revision_number, patient_id, medical_record_version_id, kind,
  source_document_id, source_version, payload, effective_from, effective_to,
  status, entered_by, published_by, published_at, supersedes_id, version, created_at
`;

export async function lockPatientRow(
  sql: SQL,
  patientId: string,
): Promise<{ id: string; primary_nurse_id: string | null } | null> {
  const rows = (await sql`
    SELECT id, primary_nurse_id FROM public.patients WHERE id = ${patientId} FOR UPDATE
  `) as unknown as Array<{ id: string; primary_nurse_id: string | null }>;
  return rows[0] ?? null;
}

export async function readLatestMedicalRecord(sql: SQL, patientId: string): Promise<MedicalRecordRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(MEDICAL_RECORD_COLUMNS)}
    FROM public.medical_record_versions
    WHERE patient_id = ${patientId}
    ORDER BY revision_number DESC
    LIMIT 1
  `) as unknown as MedicalRecordRow[];
  return rows[0] ?? null;
}

export async function readMedicalRecord(
  sql: SQL,
  patientId: string,
  id: string,
): Promise<MedicalRecordRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(MEDICAL_RECORD_COLUMNS)}
    FROM public.medical_record_versions
    WHERE patient_id = ${patientId} AND id = ${id}
    LIMIT 1
  `) as unknown as MedicalRecordRow[];
  return rows[0] ?? null;
}

export async function listMedicalRecordRows(
  sql: SQL,
  input: {
    patientId: string;
    limit: number;
    afterRevision: number | null;
    afterId: string | null;
  },
): Promise<MedicalRecordRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(MEDICAL_RECORD_COLUMNS)}
    FROM public.medical_record_versions
    WHERE patient_id = ${input.patientId}
      AND (
        ${input.afterRevision}::integer IS NULL
        OR (revision_number, id) < (${input.afterRevision}::integer, ${input.afterId}::uuid)
      )
    ORDER BY revision_number DESC, id DESC
    LIMIT ${input.limit + 1}
  `) as unknown as MedicalRecordRow[];
}

export async function insertMedicalRecord(
  sql: SQL,
  input: {
    patientId: string;
    revisionNumber: number;
    supersedesId: string | null;
    enteredBy: string;
    sourceReference: string;
    payload: unknown;
  },
): Promise<MedicalRecordRow> {
  const rows = (await sql`
    INSERT INTO public.medical_record_versions (
      patient_id, revision_number, supersedes_id, entered_by, source_reference, payload
    ) VALUES (
      ${input.patientId}, ${input.revisionNumber}, ${input.supersedesId}, ${input.enteredBy},
      ${input.sourceReference}, (${JSON.stringify(input.payload)}::text)::jsonb
    )
    RETURNING ${sql.unsafe(MEDICAL_RECORD_COLUMNS)}
  `) as unknown as MedicalRecordRow[];
  return rows[0];
}

export async function readSourceById(sql: SQL, id: string): Promise<ClinicalSourceRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)}
    FROM public.clinical_source_documents s
    WHERE s.id = ${id}
    LIMIT 1
  `) as unknown as ClinicalSourceRow[];
  return rows[0] ?? null;
}

export async function readSourceByIdForUpdate(sql: SQL, id: string): Promise<ClinicalSourceRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)}
    FROM public.clinical_source_documents s
    WHERE s.id = ${id}
    FOR UPDATE OF s
  `) as unknown as ClinicalSourceRow[];
  return rows[0] ?? null;
}

export async function readSourceExactRevision(
  sql: SQL,
  input: { patientId: string; id: string; revisionNumber: number },
): Promise<ClinicalSourceRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)}
    FROM public.clinical_source_documents s
    WHERE s.patient_id = ${input.patientId}
      AND s.id = ${input.id}
      AND s.revision_number = ${input.revisionNumber}
    LIMIT 1
  `) as unknown as ClinicalSourceRow[];
  return rows[0] ?? null;
}

export async function readLatestSourceRevision(
  sql: SQL,
  lineageId: string,
): Promise<ClinicalSourceRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)}
    FROM public.clinical_source_documents s
    WHERE s.lineage_id = ${lineageId}
    ORDER BY s.revision_number DESC
    LIMIT 1
  `) as unknown as ClinicalSourceRow[];
  return rows[0] ?? null;
}

export async function readLatestApprovedSourceHead(
  sql: SQL,
  lineageId: string,
): Promise<ClinicalSourceRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)}
    FROM public.clinical_source_documents s
    WHERE s.lineage_id = ${lineageId} AND s.status = 'approved'
    ORDER BY s.revision_number DESC
    LIMIT 1
  `) as unknown as ClinicalSourceRow[];
  return rows[0] ?? null;
}

export async function insertSource(
  sql: SQL,
  input: {
    lineageId: string;
    revisionNumber: number;
    patientId: string;
    medicalRecordVersionId: string;
    kind: string;
    title: string;
    body: string;
    checksum: string;
    createdBy: string;
    supersedesId: string | null;
  },
): Promise<ClinicalSourceRow> {
  const rows = (await sql`
    INSERT INTO public.clinical_source_documents (
      lineage_id, revision_number, patient_id, medical_record_version_id,
      kind, title, body, checksum, status, created_by, supersedes_id
    ) VALUES (
      ${input.lineageId}, ${input.revisionNumber}, ${input.patientId},
      ${input.medicalRecordVersionId}, ${input.kind}, ${input.title}, ${input.body},
      ${input.checksum}, 'draft', ${input.createdBy}, ${input.supersedesId}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const created = await readSourceById(sql, rows[0].id);
  if (!created) throw new Error("inserted clinical source could not be read back");
  return created;
}

export async function insertSourceChunks(sql: SQL, documentId: string, chunks: readonly string[]): Promise<void> {
  for (const [ordinal, content] of chunks.entries()) {
    await sql`
      INSERT INTO public.clinical_source_chunks (document_id, ordinal, content)
      VALUES (${documentId}, ${ordinal}, ${content})
    `;
  }
}

export async function readOrderById(sql: SQL, id: string): Promise<CareOrderRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(ORDER_COLUMNS)} FROM public.care_orders WHERE id = ${id} LIMIT 1
  `) as unknown as CareOrderRow[];
  return rows[0] ?? null;
}

/**
 * Patient-facing order detail may only expose the current published head of a
 * lineage while it is active and effective now. Draft successors do not hide an
 * active head, but any published successor (including a cancelled one) does.
 */
export async function isCurrentActiveOrderHead(sql: SQL, id: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS visible
    FROM public.care_orders o
    WHERE o.id = ${id}
      AND o.status = 'active'
      AND o.effective_from <= now()
      AND (o.effective_to IS NULL OR o.effective_to > now())
      AND NOT EXISTS (
        SELECT 1
        FROM public.care_orders successor
        WHERE successor.lineage_id = o.lineage_id
          AND successor.revision_number > o.revision_number
          AND successor.status <> 'draft'
      )
    LIMIT 1
  `) as unknown as Array<{ visible: number }>;
  return rows.length > 0;
}

export async function readOrderByIdForUpdate(sql: SQL, id: string): Promise<CareOrderRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(ORDER_COLUMNS)} FROM public.care_orders WHERE id = ${id} FOR UPDATE
  `) as unknown as CareOrderRow[];
  return rows[0] ?? null;
}

export async function readLatestOrderRevision(
  sql: SQL,
  lineageId: string,
): Promise<CareOrderRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(ORDER_COLUMNS)}
    FROM public.care_orders
    WHERE lineage_id = ${lineageId}
    ORDER BY revision_number DESC
    LIMIT 1
  `) as unknown as CareOrderRow[];
  return rows[0] ?? null;
}

export async function insertOrder(
  sql: SQL,
  input: {
    lineageId: string;
    revisionNumber: number;
    patientId: string;
    medicalRecordVersionId: string;
    kind: string;
    sourceDocumentId: string;
    sourceVersion: number;
    payload: unknown;
    effectiveFrom: string;
    effectiveTo: string | null;
    enteredBy: string;
    supersedesId: string | null;
  },
): Promise<CareOrderRow> {
  const rows = (await sql`
    INSERT INTO public.care_orders (
      lineage_id, revision_number, patient_id, medical_record_version_id, kind,
      source_document_id, source_version, payload, effective_from, effective_to,
      status, entered_by, supersedes_id
    ) VALUES (
      ${input.lineageId}, ${input.revisionNumber}, ${input.patientId},
      ${input.medicalRecordVersionId}, ${input.kind}, ${input.sourceDocumentId},
      ${input.sourceVersion}, (${JSON.stringify(input.payload)}::text)::jsonb,
      ${input.effectiveFrom}::timestamptz, ${input.effectiveTo}::timestamptz,
      'draft', ${input.enteredBy}, ${input.supersedesId}
    )
    RETURNING ${sql.unsafe(ORDER_COLUMNS)}
  `) as unknown as CareOrderRow[];
  return rows[0];
}

export async function listOrderHeads(
  sql: SQL,
  input: {
    patientId: string;
    patientView: boolean;
    limit: number;
    afterEffectiveFrom: string | null;
    afterId: string | null;
  },
): Promise<CareOrderRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(ORDER_COLUMNS)}
    FROM (
      SELECT DISTINCT ON (lineage_id) ${sql.unsafe(ORDER_COLUMNS)}
      FROM public.care_orders
      WHERE patient_id = ${input.patientId} AND status <> 'draft'
      ORDER BY lineage_id, revision_number DESC
    ) heads
    WHERE (
      ${input.patientView}::boolean = false
      OR (
        status = 'active'
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      )
    )
      AND (
        ${input.afterEffectiveFrom}::timestamptz IS NULL
        OR (effective_from, id) < (${input.afterEffectiveFrom}::timestamptz, ${input.afterId}::uuid)
      )
    ORDER BY effective_from DESC, id DESC
    LIMIT ${input.limit + 1}
  `) as unknown as CareOrderRow[];
}

export async function listCareGuideSources(sql: SQL, patientId: string): Promise<ClinicalSourceRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(SOURCE_COLUMNS)}
    FROM public.clinical_source_documents s
    WHERE s.id IN (
      SELECT DISTINCT ON (lineage_id) id
      FROM public.clinical_source_documents
      WHERE patient_id = ${patientId} AND status = 'approved' AND kind <> 'protocol'
      ORDER BY lineage_id, revision_number DESC
    )
    ORDER BY s.kind, s.revision_number, s.id
  `) as unknown as ClinicalSourceRow[];
}

export async function countActiveOrderHeads(sql: SQL, patientId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM (
      SELECT DISTINCT ON (lineage_id) status
      FROM public.care_orders
      WHERE patient_id = ${patientId} AND status <> 'draft'
      ORDER BY lineage_id, revision_number DESC
    ) heads
    WHERE status = 'active'
  `) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}
