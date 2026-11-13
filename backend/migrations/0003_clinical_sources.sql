-- 0003 clinical sources (T07): immutable patient medical snapshots,
-- patient-bound clinical source revisions with deterministic full-text
-- chunks, and immutable manually entered care-order revisions.
-- Global clinical-source approval / RAG corpus authority remains G05-gated.

CREATE TABLE public.medical_record_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  revision_number integer NOT NULL,
  supersedes_id uuid,
  entered_by uuid NOT NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT now(),
  source_reference text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT medical_record_versions_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT medical_record_versions_entered_by_fkey
    FOREIGN KEY (entered_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT medical_record_versions_supersedes_fkey
    FOREIGN KEY (supersedes_id, patient_id)
    REFERENCES public.medical_record_versions (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT medical_record_versions_revision_check CHECK (revision_number >= 1),
  CONSTRAINT medical_record_versions_version_check CHECK (version >= 0),
  CONSTRAINT medical_record_versions_source_reference_check CHECK (
    btrim(source_reference) <> '' AND length(source_reference) <= 300
  ),
  CONSTRAINT medical_record_versions_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT medical_record_versions_patient_revision_unique UNIQUE (patient_id, revision_number),
  CONSTRAINT medical_record_versions_id_patient_unique UNIQUE (id, patient_id)
);

CREATE INDEX medical_record_versions_patient_revision_idx
  ON public.medical_record_versions (patient_id, revision_number DESC);

CREATE FUNCTION public.forcare_reject_immutable_clinical_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.forcare_medical_record_lineage_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor public.medical_record_versions%ROWTYPE;
BEGIN
  IF NEW.revision_number = 1 THEN
    IF NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'first medical record revision cannot supersede a predecessor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.supersedes_id IS NULL THEN
    RAISE EXCEPTION 'medical record revision % requires an exact predecessor', NEW.revision_number
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO predecessor FROM public.medical_record_versions WHERE id = NEW.supersedes_id;
  IF NOT FOUND OR predecessor.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'medical record predecessor must belong to the same patient'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision_number <> predecessor.revision_number + 1 THEN
    RAISE EXCEPTION 'medical record revisions must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER medical_record_versions_lineage_guard
  BEFORE INSERT ON public.medical_record_versions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_medical_record_lineage_guard();

CREATE TRIGGER medical_record_versions_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.medical_record_versions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER medical_record_versions_reject_truncate
  BEFORE TRUNCATE ON public.medical_record_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TABLE public.clinical_source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id uuid NOT NULL,
  revision_number integer NOT NULL,
  patient_id uuid NOT NULL,
  medical_record_version_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  checksum text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz(3),
  supersedes_id uuid,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT clinical_source_documents_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT clinical_source_documents_medical_record_fkey
    FOREIGN KEY (medical_record_version_id, patient_id)
    REFERENCES public.medical_record_versions (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT clinical_source_documents_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT clinical_source_documents_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT clinical_source_documents_supersedes_fkey
    FOREIGN KEY (supersedes_id, patient_id)
    REFERENCES public.clinical_source_documents (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT clinical_source_documents_revision_check CHECK (revision_number >= 1),
  CONSTRAINT clinical_source_documents_version_check CHECK (version >= 0),
  CONSTRAINT clinical_source_documents_kind_check CHECK (
    kind IN ('protocol', 'medication', 'wound_care', 'diet', 'activity', 'danger_sign')
  ),
  CONSTRAINT clinical_source_documents_status_check CHECK (
    status IN ('draft', 'approved', 'retired')
  ),
  CONSTRAINT clinical_source_documents_approval_check CHECK (
    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'retired') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT clinical_source_documents_title_check CHECK (
    btrim(title) <> '' AND length(title) <= 200
  ),
  CONSTRAINT clinical_source_documents_body_check CHECK (
    btrim(body) <> '' AND length(body) <= 20000
  ),
  CONSTRAINT clinical_source_documents_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT clinical_source_documents_lineage_revision_unique UNIQUE (lineage_id, revision_number),
  CONSTRAINT clinical_source_documents_id_patient_unique UNIQUE (id, patient_id),
  CONSTRAINT clinical_source_documents_id_revision_patient_unique UNIQUE (id, revision_number, patient_id)
);

CREATE INDEX clinical_source_documents_patient_status_idx
  ON public.clinical_source_documents (patient_id, status, lineage_id, revision_number DESC);

CREATE FUNCTION public.forcare_clinical_source_lineage_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor public.clinical_source_documents%ROWTYPE;
BEGIN
  IF NEW.revision_number = 1 THEN
    IF NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'first clinical source revision cannot supersede a predecessor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.supersedes_id IS NULL THEN
    RAISE EXCEPTION 'clinical source revision % requires an exact predecessor', NEW.revision_number
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO predecessor FROM public.clinical_source_documents WHERE id = NEW.supersedes_id;
  IF NOT FOUND OR predecessor.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'clinical source predecessor must belong to the same patient'
      USING ERRCODE = '23514';
  END IF;
  IF predecessor.lineage_id <> NEW.lineage_id THEN
    RAISE EXCEPTION 'clinical source predecessor must share the lineage'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision_number <> predecessor.revision_number + 1 THEN
    RAISE EXCEPTION 'clinical source revisions must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;
  IF predecessor.status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'clinical source corrections may only supersede a draft or approved revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_clinical_source_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.lineage_id IS DISTINCT FROM OLD.lineage_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.medical_record_version_id IS DISTINCT FROM OLD.medical_record_version_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.checksum IS DISTINCT FROM OLD.checksum
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
  THEN
    RAISE EXCEPTION 'clinical source snapshot content is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'draft' AND NEW.status IN ('approved', 'retired')) THEN
      RAISE EXCEPTION 'invalid clinical source status transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'clinical source workflow version must advance by one'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'clinical source workflow version changed without a transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
  THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'clinical source approval provenance is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_source_documents_lineage_guard
  BEFORE INSERT ON public.clinical_source_documents
  FOR EACH ROW EXECUTE FUNCTION public.forcare_clinical_source_lineage_guard();

CREATE TRIGGER clinical_source_documents_update_guard
  BEFORE UPDATE ON public.clinical_source_documents
  FOR EACH ROW EXECUTE FUNCTION public.forcare_clinical_source_update_guard();

CREATE TRIGGER clinical_source_documents_reject_delete
  BEFORE DELETE ON public.clinical_source_documents
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER clinical_source_documents_reject_truncate
  BEFORE TRUNCATE ON public.clinical_source_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TABLE public.clinical_source_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  ordinal integer NOT NULL,
  content text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  CONSTRAINT clinical_source_chunks_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES public.clinical_source_documents (id) ON DELETE RESTRICT,
  CONSTRAINT clinical_source_chunks_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT clinical_source_chunks_content_check CHECK (btrim(content) <> ''),
  CONSTRAINT clinical_source_chunks_document_ordinal_unique UNIQUE (document_id, ordinal),
  CONSTRAINT clinical_source_chunks_id_document_unique UNIQUE (id, document_id)
);

CREATE INDEX clinical_source_chunks_tsv_idx ON public.clinical_source_chunks USING gin (tsv);

CREATE FUNCTION public.forcare_clinical_chunk_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM public.clinical_source_documents
  WHERE id = NEW.document_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'clinical source chunk has no parent source' USING ERRCODE = '23503';
  END IF;
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'clinical source chunk membership is fixed at approval'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_source_chunks_insert_guard
  BEFORE INSERT ON public.clinical_source_chunks
  FOR EACH ROW EXECUTE FUNCTION public.forcare_clinical_chunk_insert_guard();

CREATE TRIGGER clinical_source_chunks_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.clinical_source_chunks
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER clinical_source_chunks_reject_truncate
  BEFORE TRUNCATE ON public.clinical_source_chunks
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TABLE public.care_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id uuid NOT NULL,
  revision_number integer NOT NULL,
  patient_id uuid NOT NULL,
  medical_record_version_id uuid NOT NULL,
  kind text NOT NULL,
  source_document_id uuid NOT NULL,
  source_version integer NOT NULL,
  payload jsonb NOT NULL,
  effective_from timestamptz(3) NOT NULL,
  effective_to timestamptz(3),
  status text NOT NULL DEFAULT 'draft',
  entered_by uuid NOT NULL,
  published_by uuid,
  published_at timestamptz(3),
  supersedes_id uuid,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT care_orders_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT care_orders_medical_record_fkey
    FOREIGN KEY (medical_record_version_id, patient_id)
    REFERENCES public.medical_record_versions (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT care_orders_source_fkey
    FOREIGN KEY (source_document_id, source_version, patient_id)
    REFERENCES public.clinical_source_documents (id, revision_number, patient_id) ON DELETE RESTRICT,
  CONSTRAINT care_orders_entered_by_fkey
    FOREIGN KEY (entered_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT care_orders_published_by_fkey
    FOREIGN KEY (published_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT care_orders_supersedes_fkey
    FOREIGN KEY (supersedes_id, patient_id)
    REFERENCES public.care_orders (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT care_orders_revision_check CHECK (revision_number >= 1),
  CONSTRAINT care_orders_source_version_check CHECK (source_version >= 1),
  CONSTRAINT care_orders_version_check CHECK (version >= 0),
  CONSTRAINT care_orders_kind_check CHECK (kind IN ('medication', 'followup', 'care')),
  CONSTRAINT care_orders_status_check CHECK (
    status IN ('draft', 'active', 'completed', 'cancelled')
  ),
  CONSTRAINT care_orders_publication_check CHECK (
    (status = 'draft' AND published_by IS NULL AND published_at IS NULL)
    OR (status IN ('active', 'completed', 'cancelled')
        AND published_by IS NOT NULL AND published_at IS NOT NULL)
  ),
  CONSTRAINT care_orders_effective_check CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT care_orders_payload_check CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload ? 'instructions'
    AND jsonb_typeof(payload -> 'instructions') = 'string'
    AND btrim(payload ->> 'instructions') <> ''
  ),
  CONSTRAINT care_orders_lineage_revision_unique UNIQUE (lineage_id, revision_number),
  CONSTRAINT care_orders_id_patient_unique UNIQUE (id, patient_id)
);

CREATE INDEX care_orders_patient_status_idx
  ON public.care_orders (patient_id, status, lineage_id, revision_number DESC);

CREATE FUNCTION public.forcare_care_order_lineage_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor public.care_orders%ROWTYPE;
BEGIN
  IF NEW.revision_number = 1 THEN
    IF NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'first care order revision cannot supersede a predecessor'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.supersedes_id IS NULL THEN
    RAISE EXCEPTION 'care order revision % requires an exact predecessor', NEW.revision_number
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO predecessor FROM public.care_orders WHERE id = NEW.supersedes_id;
  IF NOT FOUND OR predecessor.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'care order predecessor must belong to the same patient'
      USING ERRCODE = '23514';
  END IF;
  IF predecessor.lineage_id <> NEW.lineage_id THEN
    RAISE EXCEPTION 'care order predecessor must share the lineage'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision_number <> predecessor.revision_number + 1 THEN
    RAISE EXCEPTION 'care order revisions must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_care_order_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source public.clinical_source_documents%ROWTYPE;
  latest_medical_record uuid;
BEGIN
  SELECT * INTO source
  FROM public.clinical_source_documents
  WHERE id = NEW.source_document_id
    AND revision_number = NEW.source_version
    AND patient_id = NEW.patient_id;

  IF NOT FOUND OR source.status <> 'approved' THEN
    RAISE EXCEPTION 'care order must bind one exact approved patient source'
      USING ERRCODE = '23514';
  END IF;
  IF source.medical_record_version_id IS DISTINCT FROM NEW.medical_record_version_id THEN
    RAISE EXCEPTION 'care order source and medical record binding must agree'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.clinical_source_documents later
    WHERE later.lineage_id = source.lineage_id
      AND later.status = 'approved'
      AND later.revision_number > source.revision_number
  ) THEN
    RAISE EXCEPTION 'care order must bind the current approved source head'
      USING ERRCODE = '23514';
  END IF;

  SELECT id INTO latest_medical_record
  FROM public.medical_record_versions
  WHERE patient_id = NEW.patient_id
  ORDER BY revision_number DESC
  LIMIT 1;
  IF latest_medical_record IS DISTINCT FROM NEW.medical_record_version_id THEN
    RAISE EXCEPTION 'care order must bind the current medical record revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_care_order_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.lineage_id IS DISTINCT FROM OLD.lineage_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.medical_record_version_id IS DISTINCT FROM OLD.medical_record_version_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
    OR NEW.source_version IS DISTINCT FROM OLD.source_version
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
    OR NEW.entered_by IS DISTINCT FROM OLD.entered_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
  THEN
    RAISE EXCEPTION 'care order content is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'draft' OR NEW.status NOT IN ('active', 'completed', 'cancelled') THEN
      RAISE EXCEPTION 'invalid care order status transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'care order workflow version must advance by one'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'care order workflow version changed without a transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.published_by IS DISTINCT FROM OLD.published_by
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
  THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'care order publication provenance is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER care_orders_lineage_guard
  BEFORE INSERT ON public.care_orders
  FOR EACH ROW EXECUTE FUNCTION public.forcare_care_order_lineage_guard();

CREATE TRIGGER care_orders_insert_guard
  BEFORE INSERT ON public.care_orders
  FOR EACH ROW EXECUTE FUNCTION public.forcare_care_order_insert_guard();

CREATE TRIGGER care_orders_update_guard
  BEFORE UPDATE ON public.care_orders
  FOR EACH ROW EXECUTE FUNCTION public.forcare_care_order_update_guard();

CREATE TRIGGER care_orders_reject_delete
  BEFORE DELETE ON public.care_orders
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER care_orders_reject_truncate
  BEFORE TRUNCATE ON public.care_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
