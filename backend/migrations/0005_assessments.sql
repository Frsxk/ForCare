-- 0005 assessments (T09): versioned instrument definitions and immutable run
-- provenance only. G02 scoring remains unapproved: there are no instrument
-- seeds, formulas, thresholds, mapping tables, score routes or fake clinical
-- recording endpoints. Available runs are a future operator/DBA-only shape and
-- never enable the numeric read API on their own.

CREATE TABLE public.assessment_instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  definition jsonb NOT NULL,
  approved_by uuid,
  approved_at timestamptz(3),
  g02_evidence_ref text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT assessment_instruments_code_check CHECK (code ~ '^[a-z0-9_]{2,64}$'),
  CONSTRAINT assessment_instruments_version_check CHECK (version >= 1),
  CONSTRAINT assessment_instruments_name_check CHECK (
    btrim(name) <> '' AND length(name) <= 200
  ),
  CONSTRAINT assessment_instruments_definition_check CHECK (
    jsonb_typeof(definition) = 'object'
  ),
  CONSTRAINT assessment_instruments_status_check CHECK (
    status IN ('proposed', 'approved', 'retired')
  ),
  CONSTRAINT assessment_instruments_approval_check CHECK (
    (status = 'proposed' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'retired')
      AND approved_by IS NOT NULL AND approved_at IS NOT NULL
      AND g02_evidence_ref IS NOT NULL AND btrim(g02_evidence_ref) <> '')
  ),
  CONSTRAINT assessment_instruments_g02_evidence_check CHECK (
    g02_evidence_ref IS NULL OR btrim(g02_evidence_ref) <> ''
  ),
  CONSTRAINT assessment_instruments_code_version_unique UNIQUE (code, version),
  CONSTRAINT assessment_instruments_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES public.staff (id) ON DELETE RESTRICT
);

CREATE TABLE public.assessment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  instrument_id uuid,
  source_check_in_id uuid,
  status text NOT NULL,
  unavailable_reason text,
  score numeric(8, 3),
  inputs jsonb NOT NULL,
  computed_at timestamptz(3),
  reviewed_by uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT assessment_runs_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT assessment_runs_instrument_id_fkey
    FOREIGN KEY (instrument_id) REFERENCES public.assessment_instruments (id) ON DELETE RESTRICT,
  -- Composite binding keeps a source check-in attached to the same patient.
  CONSTRAINT assessment_runs_source_check_in_fkey
    FOREIGN KEY (source_check_in_id, patient_id)
    REFERENCES public.check_ins (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT assessment_runs_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT assessment_runs_status_check CHECK (
    status IN ('available', 'unavailable')
  ),
  CONSTRAINT assessment_runs_unavailable_reason_check CHECK (
    unavailable_reason IS NULL OR btrim(unavailable_reason) <> ''
  ),
  CONSTRAINT assessment_runs_inputs_check CHECK (
    jsonb_typeof(inputs) = 'object'
  ),
  -- available iff score and instrument are present; unavailable iff the score
  -- is absent and a non-empty reason is recorded.
  CONSTRAINT assessment_runs_score_integrity_check CHECK (
    (status = 'available' AND score IS NOT NULL AND instrument_id IS NOT NULL)
    OR (status = 'unavailable'
      AND score IS NULL AND unavailable_reason IS NOT NULL
      AND btrim(unavailable_reason) <> '')
  )
);

CREATE INDEX assessment_runs_patient_created_idx
  ON public.assessment_runs (patient_id, created_at DESC, id DESC);

CREATE FUNCTION public.forcare_assessment_instrument_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.definition IS DISTINCT FROM OLD.definition
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'assessment instrument definition and version are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'proposed' AND NEW.status = 'approved')
      OR (OLD.status = 'approved' AND NEW.status = 'retired')
    ) THEN
      RAISE EXCEPTION 'invalid assessment instrument status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Approval provenance may be recorded once, when the instrument is approved,
  -- but retiring must not erase it and recorded provenance is immutable.
  IF OLD.approved_by IS NOT NULL
    AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)
  THEN
    RAISE EXCEPTION 'assessment instrument approval provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.g02_evidence_ref IS NOT NULL
    AND NEW.g02_evidence_ref IS DISTINCT FROM OLD.g02_evidence_ref
  THEN
    RAISE EXCEPTION 'assessment instrument G02 evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_assessment_run_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  instrument public.assessment_instruments%ROWTYPE;
BEGIN
  IF NEW.instrument_id IS NOT NULL THEN
    SELECT * INTO instrument FROM public.assessment_instruments WHERE id = NEW.instrument_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assessment run requires an existing instrument'
        USING ERRCODE = '23503';
    END IF;
    IF NEW.status = 'available'
      AND (instrument.status <> 'approved'
        OR instrument.approved_by IS NULL
        OR instrument.approved_at IS NULL)
    THEN
      RAISE EXCEPTION 'available assessment runs require an approved instrument'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assessment_instruments_update_guard
  BEFORE UPDATE ON public.assessment_instruments
  FOR EACH ROW EXECUTE FUNCTION public.forcare_assessment_instrument_update_guard();

CREATE TRIGGER assessment_instruments_reject_delete
  BEFORE DELETE ON public.assessment_instruments
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER assessment_instruments_reject_truncate
  BEFORE TRUNCATE ON public.assessment_instruments
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER assessment_runs_insert_guard
  BEFORE INSERT ON public.assessment_runs
  FOR EACH ROW EXECUTE FUNCTION public.forcare_assessment_run_insert_guard();

-- Assessment rows are immutable history. reviewed_by is reserved future review
-- metadata; no review or recording route exists in this slice.
CREATE TRIGGER assessment_runs_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.assessment_runs
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER assessment_runs_reject_truncate
  BEFORE TRUNCATE ON public.assessment_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
