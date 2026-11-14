-- 0007 analysis (T11). Immutable snapshots, not placeholder rows for queued work.
-- New writes explicitly require READ COMMITTED. Current-head checks take SHARE
-- table locks against clinical phantoms; this conservative protocol needs no
-- changes to earlier migrations. Never use transaction-level stale snapshots.

CREATE FUNCTION public.forcare_analysis_require_read_committed()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'analysis writes require read committed isolation' USING ERRCODE = '25001';
  END IF;
END;
$$;

CREATE FUNCTION public.forcare_analysis_assert_staff(staff_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  PERFORM 1 FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles r ON r.account_id = a.id
    WHERE s.id = staff_id AND s.active AND a.status = 'active' AND r.role = 'nurse'
    FOR SHARE OF s, a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analysis provenance requires active nurse' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION public.forcare_analysis_assert_context(p_patient uuid, p_check_in uuid, snapshot jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  check_in public.check_ins%ROWTYPE;
  medical public.medical_record_versions%ROWTYPE;
  source public.clinical_source_documents%ROWTYPE;
  care_order public.care_orders%ROWTYPE;
  corpus public.knowledge_corpora%ROWTYPE;
  reference_id uuid;
  sources uuid[];
  orders uuid[];
  observations jsonb;
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
    OR octet_length(snapshot::text) > 262144
    OR NOT snapshot ?& ARRAY['locale','medicalRecordVersionId','medicalRecord','checkIn','sourceIds','orderIds','corpusId','corpusVersion']
    OR snapshot - ARRAY['locale','medicalRecordVersionId','medicalRecord','checkIn','sourceIds','orderIds','corpusId','corpusVersion'] <> '{}'::jsonb
    OR jsonb_typeof(snapshot->'locale') IS DISTINCT FROM 'string'
    OR snapshot->>'locale' NOT IN ('id','en')
    OR jsonb_typeof(snapshot->'medicalRecordVersionId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(snapshot->'corpusId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(snapshot->'corpusVersion') IS DISTINCT FROM 'number'
    OR (snapshot->>'corpusVersion') !~ '^[1-9][0-9]*$'
    OR jsonb_typeof(snapshot->'sourceIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot->'orderIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot->'medicalRecord') IS DISTINCT FROM 'object'
    OR jsonb_typeof(snapshot->'checkIn') IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'invalid strict analysis input snapshot' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(snapshot->'sourceIds') > 50 OR jsonb_array_length(snapshot->'orderIds') > 50
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'sourceIds') x WHERE jsonb_typeof(x) <> 'string')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'orderIds') x WHERE jsonb_typeof(x) <> 'string')
  THEN RAISE EXCEPTION 'invalid bounded source membership' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(array_agg(value::uuid), ARRAY[]::uuid[]) INTO sources FROM jsonb_array_elements_text(snapshot->'sourceIds');
  SELECT coalesce(array_agg(value::uuid), ARRAY[]::uuid[]) INTO orders FROM jsonb_array_elements_text(snapshot->'orderIds');
  IF cardinality(sources) <> (SELECT count(DISTINCT x) FROM unnest(sources) x)
    OR cardinality(orders) <> (SELECT count(DISTINCT x) FROM unnest(orders) x)
  THEN RAISE EXCEPTION 'duplicate snapshot source membership' USING ERRCODE = '23514'; END IF;

  -- These tables do not yet share a per-patient SQL lock protocol. SHARE locks
  -- exclude inserts/approval writes and close current-head phantom races.
  LOCK TABLE public.medical_record_versions, public.clinical_source_documents, public.care_orders IN SHARE MODE;
  SELECT * INTO check_in FROM public.check_ins
    WHERE id = p_check_in AND patient_id = p_patient AND status = 'submitted' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'analysis requires a submitted patient check-in' USING ERRCODE = '23514'; END IF;
  SELECT * INTO medical FROM public.medical_record_versions WHERE patient_id = p_patient
    ORDER BY revision_number DESC LIMIT 1;
  IF NOT FOUND OR medical.id IS DISTINCT FROM (snapshot->>'medicalRecordVersionId')::uuid THEN
    RAISE EXCEPTION 'analysis requires current medical record binding' USING ERRCODE = '23514';
  END IF;
  -- Exact safe projection: internalNote is excluded rather than accepted and
  -- later redacted. Identity/contact fields are not part of this shape.
  IF snapshot->'medicalRecord' IS DISTINCT FROM (medical.payload - 'internalNote')
    OR NOT (snapshot->'medicalRecord') ?& ARRAY['primaryDiagnosis','secondaryDiagnoses','admittedAt','dischargedAt','allergies','procedures','complaints','observations']
    OR (snapshot->'medicalRecord') - ARRAY['primaryDiagnosis','secondaryDiagnoses','admittedAt','dischargedAt','allergies','procedures','complaints','observations'] <> '{}'::jsonb
  THEN RAISE EXCEPTION 'analysis medical input must be exact patient-safe projection' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'observationId', id, 'type', type, 'value', value, 'unit', unit,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY type, id), '[]'::jsonb) INTO observations
    FROM public.check_in_observations WHERE check_in_id = p_check_in;
  IF snapshot->'checkIn' IS DISTINCT FROM jsonb_build_object(
    'condition', check_in.condition, 'note', check_in.note,
    'medicationAdherence', check_in.medication_adherence, 'observations', observations
  ) THEN RAISE EXCEPTION 'analysis check-in facts must match submitted snapshot' USING ERRCODE = '23514'; END IF;

  FOREACH reference_id IN ARRAY sources LOOP
    SELECT * INTO source FROM public.clinical_source_documents WHERE id = reference_id;
    IF NOT FOUND OR source.patient_id <> p_patient OR source.medical_record_version_id <> medical.id
      OR source.status <> 'approved' OR source.approved_by IS NULL OR source.approved_at IS NULL
    THEN RAISE EXCEPTION 'analysis source must be approved and patient/current-medical bound' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM public.clinical_source_documents later
      WHERE later.lineage_id = source.lineage_id AND later.revision_number > source.revision_number
        AND later.status IN ('approved','retired'))
    THEN RAISE EXCEPTION 'analysis source must be current approved head' USING ERRCODE = '23514'; END IF;
  END LOOP;
  FOREACH reference_id IN ARRAY orders LOOP
    SELECT * INTO care_order FROM public.care_orders WHERE id = reference_id;
    IF NOT FOUND OR care_order.patient_id <> p_patient OR care_order.medical_record_version_id <> medical.id
      OR care_order.status <> 'active' OR care_order.published_at IS NULL
      OR care_order.effective_from > statement_timestamp()
      OR (care_order.effective_to IS NOT NULL AND care_order.effective_to <= statement_timestamp())
      OR NOT care_order.source_document_id = ANY(sources)
    THEN RAISE EXCEPTION 'analysis order must be active, effective and bound to approved snapshot source' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM public.care_orders later
      WHERE later.lineage_id = care_order.lineage_id AND later.revision_number > care_order.revision_number
        AND later.status <> 'draft')
    THEN RAISE EXCEPTION 'analysis order must be current published head' USING ERRCODE = '23514'; END IF;
  END LOOP;
  SELECT * INTO corpus FROM public.knowledge_corpora WHERE id = (snapshot->>'corpusId')::uuid FOR SHARE;
  IF NOT FOUND OR corpus.status <> 'approved' OR corpus.version <> (snapshot->>'corpusVersion')::integer
    OR corpus.approved_by IS NULL OR corpus.approved_at IS NULL
  THEN RAISE EXCEPTION 'analysis requires exact approved corpus version' USING ERRCODE = '23514'; END IF;
END;
$$;

CREATE TABLE public.analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients (id) ON DELETE RESTRICT,
  check_in_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  prompt_version text NOT NULL CHECK (prompt_version = 'forcare-condition-v1'),
  locale text NOT NULL CHECK (locale IN ('id','en')),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'awaiting_review', 'failed', 'completed')),
  analysis_id uuid UNIQUE,
  error_code text CHECK (error_code IN ('INSUFFICIENT_EVIDENCE','INVALID_MODEL_OUTPUT','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_AUTH_FAILED','PROVIDER_SAFETY_BLOCKED','PROVIDER_UNAVAILABLE','STALE_CONTEXT','SCOPE_REVOKED','ATTEMPTS_EXHAUSTED','INTERNAL_ERROR')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  lease_owner text CHECK (lease_owner IS NULL OR (btrim(lease_owner) <> '' AND length(lease_owner) <= 200)),
  lease_token uuid,
  lease_expires_at timestamptz(3),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY (check_in_id, patient_id) REFERENCES public.check_ins (id, patient_id) ON DELETE RESTRICT,
  UNIQUE (id, check_in_id, patient_id),
  CHECK (attempt_count <= max_attempts),
  CHECK ((status IN ('awaiting_review','completed')) = (analysis_id IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CHECK ((status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX analysis_jobs_queue_idx ON public.analysis_jobs (status, lease_expires_at, created_at, id);
CREATE INDEX analysis_jobs_patient_idx ON public.analysis_jobs (patient_id, created_at DESC, id DESC);

CREATE TABLE public.analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  supersedes_id uuid REFERENCES public.analyses (id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients (id) ON DELETE RESTRICT,
  check_in_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'published')),
  model_provider text NOT NULL CHECK (btrim(model_provider) <> '' AND length(model_provider) <= 100),
  model_id text NOT NULL CHECK (btrim(model_id) <> '' AND length(model_id) <= 200),
  prompt_version text NOT NULL CHECK (prompt_version = 'forcare-condition-v1'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL,
  retrieved_chunk_ids uuid[] NOT NULL CHECK (
    cardinality(retrieved_chunk_ids) <= 20
    AND (array_ndims(retrieved_chunk_ids) IS NULL OR array_ndims(retrieved_chunk_ids) = 1)
    AND (array_lower(retrieved_chunk_ids, 1) IS NULL OR array_lower(retrieved_chunk_ids, 1) = 1)
    AND array_position(retrieved_chunk_ids, NULL) IS NULL
  ),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  job_id uuid UNIQUE,
  construction_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  finalized_at timestamptz(3),
  FOREIGN KEY (check_in_id, patient_id) REFERENCES public.check_ins (id, patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, check_in_id, patient_id) REFERENCES public.analysis_jobs (id, check_in_id, patient_id) ON DELETE RESTRICT,
  UNIQUE (lineage_id, revision_number),
  UNIQUE (supersedes_id),
  UNIQUE (id, revision_number),
  UNIQUE (id, check_in_id, patient_id)
);
ALTER TABLE public.analysis_jobs ADD CONSTRAINT analysis_jobs_result_fkey
  FOREIGN KEY (analysis_id, check_in_id, patient_id) REFERENCES public.analyses (id, check_in_id, patient_id) ON DELETE RESTRICT;
CREATE INDEX analyses_patient_created_idx ON public.analyses (patient_id, created_at DESC, id DESC);
CREATE INDEX analyses_patient_status_idx ON public.analyses (patient_id, status, created_at DESC, id DESC);

CREATE TABLE public.analysis_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES public.analyses (id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
  claim_type text NOT NULL CHECK (claim_type IN ('observation_summary', 'concern', 'suggestion', 'care_note')),
  text text NOT NULL CHECK (btrim(text) <> '' AND length(text) <= 4000),
  patient_facing boolean NOT NULL DEFAULT false,
  UNIQUE (analysis_id, ordinal),
  UNIQUE (id, analysis_id)
);

CREATE TABLE public.analysis_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  check_in_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  observation_id uuid,
  order_id uuid,
  source_document_id uuid,
  source_version integer CHECK (source_version >= 1),
  clinical_chunk_id uuid,
  knowledge_chunk_id uuid REFERENCES public.knowledge_chunks (id) ON DELETE RESTRICT,
  FOREIGN KEY (claim_id, analysis_id) REFERENCES public.analysis_claims (id, analysis_id) ON DELETE RESTRICT,
  FOREIGN KEY (analysis_id, check_in_id, patient_id) REFERENCES public.analyses (id, check_in_id, patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (check_in_id, patient_id) REFERENCES public.check_ins (id, patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id, check_in_id) REFERENCES public.check_in_observations (id, check_in_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id, patient_id) REFERENCES public.care_orders (id, patient_id) ON DELETE RESTRICT,
  -- Actual 0003 exposes the stronger patient-bound composite unique target.
  FOREIGN KEY (source_document_id, source_version, patient_id) REFERENCES public.clinical_source_documents (id, revision_number, patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (clinical_chunk_id, source_document_id) REFERENCES public.clinical_source_chunks (id, document_id) ON DELETE RESTRICT,
  CHECK ((source_document_id IS NULL) = (source_version IS NULL)),
  CHECK (clinical_chunk_id IS NULL OR source_document_id IS NOT NULL)
);
CREATE INDEX analysis_evidence_claim_idx ON public.analysis_evidence (claim_id, analysis_id);
CREATE INDEX analysis_evidence_analysis_idx ON public.analysis_evidence (analysis_id);

CREATE TABLE public.analysis_job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.analysis_jobs (id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  lease_token uuid NOT NULL,
  model_provider text NOT NULL CHECK (btrim(model_provider) <> '' AND length(model_provider) <= 100),
  model_id text NOT NULL CHECK (btrim(model_id) <> '' AND length(model_id) <= 200),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','failed','lease_expired')),
  error_code text,
  started_at timestamptz(3) NOT NULL,
  finished_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (job_id, attempt_number),
  CHECK (finished_at >= started_at AND finished_at - started_at <= interval '15 minutes'),
  CHECK ((outcome = 'succeeded' AND error_code IS NULL)
    OR (outcome <> 'succeeded' AND error_code IS NOT NULL AND error_code IN ('INSUFFICIENT_EVIDENCE','INVALID_MODEL_OUTPUT','PROVIDER_TIMEOUT','PROVIDER_RATE_LIMITED','PROVIDER_AUTH_FAILED','PROVIDER_SAFETY_BLOCKED','PROVIDER_UNAVAILABLE','STALE_CONTEXT','SCOPE_REVOKED','ATTEMPTS_EXHAUSTED','INTERNAL_ERROR')))
);

CREATE FUNCTION public.forcare_analysis_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor public.analyses%ROWTYPE;
  job public.analysis_jobs%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_assert_staff(NEW.created_by);
  PERFORM public.forcare_analysis_assert_context(NEW.patient_id, NEW.check_in_id, NEW.input_snapshot);
  IF NEW.status <> 'draft' OR NEW.version <> 0 OR NEW.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'analysis snapshots must start as unsealed drafts at version zero' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('analysis-lineage:' || NEW.lineage_id::text, 0));
  IF NEW.revision_number = 1 THEN
    IF NEW.supersedes_id IS NOT NULL THEN RAISE EXCEPTION 'first analysis revision has no predecessor' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT * INTO predecessor FROM public.analyses WHERE lineage_id = NEW.lineage_id ORDER BY revision_number DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR predecessor.id IS DISTINCT FROM NEW.supersedes_id
      OR predecessor.patient_id <> NEW.patient_id OR predecessor.check_in_id <> NEW.check_in_id
      OR predecessor.input_hash <> NEW.input_hash OR predecessor.input_snapshot IS DISTINCT FROM NEW.input_snapshot
      OR predecessor.retrieved_chunk_ids IS DISTINCT FROM NEW.retrieved_chunk_ids
      OR NEW.revision_number <> predecessor.revision_number + 1 OR predecessor.finalized_at IS NULL
      OR NEW.job_id IS NOT NULL
    THEN RAISE EXCEPTION 'analysis revision must supersede the latest same-bound head' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.job_id IS NOT NULL THEN
    SELECT * INTO job FROM public.analysis_jobs WHERE id = NEW.job_id FOR UPDATE;
    IF NOT FOUND OR job.status <> 'running' OR job.lease_expires_at <= statement_timestamp()
      OR job.requested_by <> NEW.created_by OR job.prompt_version <> NEW.prompt_version
      OR job.input_hash <> NEW.input_hash OR job.input_snapshot IS DISTINCT FROM NEW.input_snapshot
      OR job.check_in_id <> NEW.check_in_id OR job.patient_id <> NEW.patient_id
    THEN RAISE EXCEPTION 'analysis must bind exact running job input' USING ERRCODE = '23514'; END IF;
  END IF;
  NEW.construction_xid := pg_current_xact_id();
  NEW.created_at := statement_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  IF (to_jsonb(NEW) - ARRAY['status','version','updated_at','finalized_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','version','updated_at','finalized_at'])
  THEN RAISE EXCEPTION 'analysis content snapshot is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    IF OLD.finalized_at IS NOT NULL OR OLD.construction_xid <> pg_current_xact_id() OR NEW.finalized_at IS NULL
      OR NEW.status <> OLD.status OR NEW.version <> OLD.version
    THEN RAISE EXCEPTION 'analysis construction seal is immutable' USING ERRCODE = '55000'; END IF;
    NEW.finalized_at := statement_timestamp();
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.finalized_at IS NULL OR NEW.version <> OLD.version + 1 OR NOT (
      (OLD.status = 'draft' AND NEW.status = 'in_review')
      OR (OLD.status = 'in_review' AND NEW.status IN ('draft','approved','rejected'))
      OR (OLD.status = 'approved' AND NEW.status = 'published')
    ) THEN RAISE EXCEPTION 'invalid analysis workflow transition' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'analysis version advances only on workflow transitions' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_member_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent public.analyses%ROWTYPE;
  source public.clinical_source_documents%ROWTYPE;
  care_order public.care_orders%ROWTYPE;
  document public.knowledge_documents%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  SELECT * INTO parent FROM public.analyses WHERE id = NEW.analysis_id FOR UPDATE;
  IF NOT FOUND OR parent.finalized_at IS NOT NULL OR parent.construction_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'analysis membership is fixed in construction transaction' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'analysis_evidence' THEN
    IF NEW.check_in_id <> parent.check_in_id OR NEW.patient_id <> parent.patient_id THEN
      RAISE EXCEPTION 'evidence must bind exact analysis patient and check-in' USING ERRCODE = '23514';
    END IF;
    IF NEW.source_document_id IS NOT NULL THEN
      IF NOT (parent.input_snapshot->'sourceIds') @> jsonb_build_array(NEW.source_document_id::text) THEN
        RAISE EXCEPTION 'evidence source is outside bound input' USING ERRCODE = '23514'; END IF;
      SELECT * INTO source FROM public.clinical_source_documents WHERE id = NEW.source_document_id;
      IF NOT FOUND OR source.revision_number <> NEW.source_version THEN RAISE EXCEPTION 'evidence source version mismatch' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW.order_id IS NOT NULL THEN
      IF NOT (parent.input_snapshot->'orderIds') @> jsonb_build_array(NEW.order_id::text) THEN
        RAISE EXCEPTION 'evidence order is outside bound input' USING ERRCODE = '23514'; END IF;
      SELECT * INTO care_order FROM public.care_orders WHERE id = NEW.order_id;
      IF NEW.source_document_id IS NOT NULL AND (care_order.source_document_id <> NEW.source_document_id OR care_order.source_version <> NEW.source_version) THEN
        RAISE EXCEPTION 'evidence order/source exact binding mismatch' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW.knowledge_chunk_id IS NOT NULL THEN
      SELECT d.* INTO document FROM public.knowledge_chunks c JOIN public.knowledge_documents d ON d.id = c.document_id
        WHERE c.id = NEW.knowledge_chunk_id FOR SHARE OF d;
      IF NOT FOUND OR document.status <> 'approved' OR document.corpus_id <> (parent.input_snapshot->>'corpusId')::uuid
        OR document.approved_at IS NULL OR document.approved_by IS NULL
      THEN RAISE EXCEPTION 'knowledge evidence must bind approved document in exact corpus' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_finalize_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent public.analyses%ROWTYPE;
  target uuid;
  actual uuid[];
  declared uuid[];
BEGIN
  IF TG_TABLE_NAME = 'analyses' THEN target := NEW.id; ELSE target := NEW.analysis_id; END IF;
  SELECT * INTO parent FROM public.analyses WHERE id = target FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.analysis_claims WHERE analysis_id = target)
    OR EXISTS (SELECT 1 FROM public.analysis_claims c WHERE c.analysis_id = target
      AND NOT EXISTS (SELECT 1 FROM public.analysis_evidence e WHERE e.claim_id = c.id AND e.analysis_id = target))
  THEN RAISE EXCEPTION 'every analysis claim requires evidence' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.analysis_evidence WHERE analysis_id = target GROUP BY claim_id HAVING count(*) > 20) THEN
    RAISE EXCEPTION 'analysis evidence exceeds per-claim bound' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(array_agg(DISTINCT knowledge_chunk_id ORDER BY knowledge_chunk_id), ARRAY[]::uuid[]) INTO actual
    FROM public.analysis_evidence WHERE analysis_id = target AND knowledge_chunk_id IS NOT NULL;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO declared FROM unnest(parent.retrieved_chunk_ids) x;
  IF actual IS DISTINCT FROM declared OR cardinality(declared) <> cardinality(parent.retrieved_chunk_ids) THEN
    RAISE EXCEPTION 'retrieved chunks must exactly equal knowledge evidence' USING ERRCODE = '23514'; END IF;
  IF parent.finalized_at IS NULL THEN
    UPDATE public.analyses SET finalized_at = statement_timestamp() WHERE id = target;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.forcare_analysis_job_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  result public.analyses%ROWTYPE;
  receipt public.analysis_job_attempts%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  IF TG_OP = 'INSERT' THEN
    PERFORM public.forcare_analysis_assert_staff(NEW.requested_by);
    PERFORM public.forcare_analysis_assert_context(NEW.patient_id, NEW.check_in_id, NEW.input_snapshot);
    IF NEW.status <> 'queued' OR NEW.version <> 0 OR NEW.attempt_count <> 0 OR NEW.locale <> NEW.input_snapshot->>'locale' THEN
      RAISE EXCEPTION 'analysis jobs must start queued with exact input locale' USING ERRCODE = '23514'; END IF;
    NEW.created_at := statement_timestamp();
  ELSE
    IF (to_jsonb(NEW) - ARRAY['status','analysis_id','error_code','attempt_count','lease_owner','lease_token','lease_expires_at','version','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','analysis_id','error_code','attempt_count','lease_owner','lease_token','lease_expires_at','version','updated_at'])
      OR NEW.version <> OLD.version + 1 OR OLD.status IN ('failed','completed')
    THEN RAISE EXCEPTION 'invalid job mutation or workflow version' USING ERRCODE = '23514'; END IF;
    IF NOT (
      (OLD.status = 'queued' AND NEW.status IN ('running','failed'))
      OR (OLD.status = 'running' AND NEW.status IN ('running','queued','awaiting_review','failed'))
      OR (OLD.status = 'awaiting_review' AND NEW.status = 'completed')
    ) THEN RAISE EXCEPTION 'invalid job transition' USING ERRCODE = '23514'; END IF;
    IF OLD.status = 'running' AND (NEW.status <> 'running' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
      SELECT * INTO receipt FROM public.analysis_job_attempts
        WHERE job_id = OLD.id AND attempt_number = OLD.attempt_count AND lease_token = OLD.lease_token;
      IF NOT FOUND OR (NEW.status = 'awaiting_review' AND receipt.outcome <> 'succeeded')
        OR (NEW.status <> 'awaiting_review' AND receipt.outcome = 'succeeded') THEN
        RAISE EXCEPTION 'job transition requires exact attempt outcome receipt' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW.status = 'running' THEN
      IF OLD.status <> 'running' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
        IF NEW.attempt_count <> OLD.attempt_count + 1 OR (OLD.status = 'running' AND OLD.lease_expires_at > statement_timestamp()) THEN
          RAISE EXCEPTION 'new attempt requires queued or expired lease and next attempt number' USING ERRCODE = '23514'; END IF;
      ELSIF NEW.attempt_count <> OLD.attempt_count OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR OLD.lease_expires_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'heartbeat requires same active lease' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'attempt counter advances only on lease acquisition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'running' AND (NEW.lease_expires_at <= statement_timestamp() OR NEW.lease_expires_at > statement_timestamp() + interval '15 minutes') THEN
    RAISE EXCEPTION 'job lease must be bounded and unexpired' USING ERRCODE = '23514'; END IF;
  IF NEW.analysis_id IS NOT NULL THEN
    SELECT * INTO result FROM public.analyses WHERE id = NEW.analysis_id;
    IF NOT FOUND OR result.job_id IS DISTINCT FROM NEW.id OR result.input_hash <> NEW.input_hash
      OR result.input_snapshot IS DISTINCT FROM NEW.input_snapshot OR result.finalized_at IS NULL
    THEN RAISE EXCEPTION 'job result must be its exact finalized snapshot' USING ERRCODE = '23514'; END IF;
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_attempt_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job public.analysis_jobs%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  SELECT * INTO job FROM public.analysis_jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND OR job.status <> 'running' OR NEW.attempt_number <> job.attempt_count
    OR NEW.lease_token <> job.lease_token OR NEW.finished_at > statement_timestamp()
    OR (NEW.outcome = 'lease_expired' AND job.lease_expires_at > statement_timestamp())
    OR (NEW.outcome <> 'lease_expired' AND job.lease_expires_at <= statement_timestamp())
  THEN RAISE EXCEPTION 'attempt receipt must bind exact current lease' USING ERRCODE = '23514'; END IF;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_result_consistency_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job public.analysis_jobs%ROWTYPE;
  result public.analyses%ROWTYPE;
  target uuid;
BEGIN
  IF TG_TABLE_NAME = 'analyses' THEN target := NEW.job_id; ELSE target := NEW.id; END IF;
  IF target IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.analysis_jobs WHERE id = target FOR UPDATE;
  SELECT * INTO result FROM public.analyses WHERE job_id = target;
  IF FOUND THEN
    IF job.analysis_id IS DISTINCT FROM result.id OR job.status NOT IN ('awaiting_review','completed') THEN
      RAISE EXCEPTION 'saved snapshot and job result must commit atomically' USING ERRCODE = '23514'; END IF;
  ELSIF job.analysis_id IS NOT NULL THEN
    RAISE EXCEPTION 'job result requires exact generated snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER analyses_insert_guard BEFORE INSERT ON public.analyses
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_insert_guard();
CREATE TRIGGER analyses_update_guard BEFORE UPDATE ON public.analyses
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_update_guard();
CREATE TRIGGER analyses_reject_delete BEFORE DELETE ON public.analyses
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analyses_reject_truncate BEFORE TRUNCATE ON public.analyses
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_claims_insert_guard BEFORE INSERT ON public.analysis_claims
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_member_insert_guard();
CREATE TRIGGER analysis_evidence_insert_guard BEFORE INSERT ON public.analysis_evidence
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_member_insert_guard();
CREATE TRIGGER analysis_claims_immutable BEFORE UPDATE OR DELETE ON public.analysis_claims
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_evidence_immutable BEFORE UPDATE OR DELETE ON public.analysis_evidence
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_claims_reject_truncate BEFORE TRUNCATE ON public.analysis_claims
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_evidence_reject_truncate BEFORE TRUNCATE ON public.analysis_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE CONSTRAINT TRIGGER analyses_finalize AFTER INSERT ON public.analyses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_finalize_guard();
CREATE CONSTRAINT TRIGGER analysis_claims_finalize AFTER INSERT ON public.analysis_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_finalize_guard();
CREATE CONSTRAINT TRIGGER analysis_evidence_finalize AFTER INSERT ON public.analysis_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_finalize_guard();
CREATE CONSTRAINT TRIGGER analyses_job_result_consistency AFTER INSERT ON public.analyses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_result_consistency_guard();
CREATE CONSTRAINT TRIGGER analysis_jobs_result_consistency AFTER INSERT OR UPDATE ON public.analysis_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_result_consistency_guard();
CREATE TRIGGER analysis_jobs_insert_update BEFORE INSERT OR UPDATE ON public.analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_job_guard();
CREATE TRIGGER analysis_jobs_reject_delete BEFORE DELETE ON public.analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_jobs_reject_truncate BEFORE TRUNCATE ON public.analysis_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_job_attempts_insert BEFORE INSERT ON public.analysis_job_attempts
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_attempt_guard();
CREATE TRIGGER analysis_job_attempts_immutable BEFORE UPDATE OR DELETE ON public.analysis_job_attempts
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_job_attempts_reject_truncate BEFORE TRUNCATE ON public.analysis_job_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

REVOKE ALL ON TABLE public.analyses, public.analysis_claims, public.analysis_evidence,
  public.analysis_jobs, public.analysis_job_attempts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forcare_analysis_require_read_committed(), public.forcare_analysis_assert_staff(uuid),
  public.forcare_analysis_assert_context(uuid, uuid, jsonb) FROM PUBLIC;
