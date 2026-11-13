-- 0004 monitoring (T08): patient-reported check-ins, typed observations,
-- medication adherence and append-only primary-nurse confirmations.
--
-- Timestamp precision matches JavaScript serialization so keyset cursors
-- retain exact stored boundaries; UUIDs break ties within a millisecond.

CREATE TABLE public.check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  local_date date NOT NULL,
  time_zone text NOT NULL,
  condition text NOT NULL,
  note text,
  medication_adherence text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  supersedes_check_in_id uuid,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  submitted_at timestamptz(3),
  CONSTRAINT check_ins_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT check_ins_supersedes_fkey
    FOREIGN KEY (supersedes_check_in_id, patient_id)
    REFERENCES public.check_ins (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT check_ins_status_check CHECK (status IN ('draft', 'submitted')),
  CONSTRAINT check_ins_condition_check CHECK (condition IN ('ok', 'complaint')),
  CONSTRAINT check_ins_medication_adherence_check CHECK (
    medication_adherence IN ('regular', 'missed_once', 'none')
  ),
  CONSTRAINT check_ins_version_check CHECK (version >= 0),
  CONSTRAINT check_ins_note_check CHECK (
    note IS NULL OR (btrim(note) <> '' AND length(note) <= 4000)
  ),
  CONSTRAINT check_ins_time_zone_check CHECK (
    btrim(time_zone) <> '' AND length(time_zone) <= 64
  ),
  CONSTRAINT check_ins_submission_check CHECK (
    (status = 'draft' AND submitted_at IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL)
  ),
  CONSTRAINT check_ins_id_patient_unique UNIQUE (id, patient_id)
);

-- One private draft per patient per server-derived local day. Submitted
-- history and corrections are not limited by this index.
CREATE UNIQUE INDEX check_ins_one_draft_per_day_idx
  ON public.check_ins (patient_id, local_date)
  WHERE status = 'draft';

CREATE INDEX check_ins_patient_created_idx
  ON public.check_ins (patient_id, created_at DESC, id DESC);

CREATE INDEX check_ins_patient_submitted_idx
  ON public.check_ins (patient_id, submitted_at DESC NULLS LAST, id DESC);

CREATE TABLE public.check_in_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_in_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  type text NOT NULL,
  value numeric(8, 3) NOT NULL,
  unit text NOT NULL,
  observed_at timestamptz(3) NOT NULL,
  source text NOT NULL DEFAULT 'check_in',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT check_in_observations_check_in_fkey
    FOREIGN KEY (check_in_id, patient_id)
    REFERENCES public.check_ins (id, patient_id) ON DELETE CASCADE,
  CONSTRAINT check_in_observations_type_check CHECK (
    type IN (
      'temperature_c',
      'heart_rate_bpm',
      'bp_systolic_mmhg',
      'bp_diastolic_mmhg',
      'weight_kg',
      'spo2_pct'
    )
  ),
  CONSTRAINT check_in_observations_value_check CHECK (value > 0),
  -- Contract units are exact lowercase tokens; mmHg is never silently
  -- normalised to mmhg or vice versa.
  CONSTRAINT check_in_observations_unit_check CHECK (
    (type = 'temperature_c' AND unit = 'c')
    OR (type = 'heart_rate_bpm' AND unit = 'bpm')
    OR (type = 'bp_systolic_mmhg' AND unit = 'mmhg')
    OR (type = 'bp_diastolic_mmhg' AND unit = 'mmhg')
    OR (type = 'weight_kg' AND unit = 'kg')
    OR (type = 'spo2_pct' AND unit = 'pct')
  ),
  CONSTRAINT check_in_observations_source_check CHECK (
    source IN ('check_in', 'nurse_entry')
  ),
  CONSTRAINT check_in_observations_check_in_type_unique UNIQUE (check_in_id, type),
  CONSTRAINT check_in_observations_id_check_in_unique UNIQUE (id, check_in_id)
);

CREATE INDEX check_in_observations_patient_type_observed_idx
  ON public.check_in_observations (patient_id, type, observed_at DESC, id DESC);

CREATE INDEX check_in_observations_check_in_idx
  ON public.check_in_observations (check_in_id);

CREATE TABLE public.medication_adherence (
  check_in_id uuid PRIMARY KEY,
  status text NOT NULL,
  note text,
  CONSTRAINT medication_adherence_check_in_id_fkey
    FOREIGN KEY (check_in_id) REFERENCES public.check_ins (id) ON DELETE RESTRICT,
  CONSTRAINT medication_adherence_status_check CHECK (
    status IN ('regular', 'missed_once', 'none')
  ),
  CONSTRAINT medication_adherence_note_check CHECK (
    note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)
  )
);

CREATE TABLE public.observation_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL,
  check_in_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  observation_type text NOT NULL,
  observation_value numeric(8, 3) NOT NULL,
  observation_unit text NOT NULL,
  observation_observed_at timestamptz(3) NOT NULL,
  check_in_version integer NOT NULL,
  note text,
  staff_id uuid NOT NULL,
  confirmed_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT observation_confirmations_observation_fkey
    FOREIGN KEY (observation_id, check_in_id)
    REFERENCES public.check_in_observations (id, check_in_id) ON DELETE RESTRICT,
  CONSTRAINT observation_confirmations_check_in_fkey
    FOREIGN KEY (check_in_id, patient_id)
    REFERENCES public.check_ins (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT observation_confirmations_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT observation_confirmations_version_check CHECK (check_in_version >= 0),
  CONSTRAINT observation_confirmations_note_check CHECK (
    note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)
  ),
  CONSTRAINT observation_confirmations_one_per_observation UNIQUE (observation_id)
);

CREATE FUNCTION public.forcare_check_in_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor public.check_ins%ROWTYPE;
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'check-ins must be created as drafts' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> 0 THEN
    RAISE EXCEPTION 'new check-ins start at workflow version zero' USING ERRCODE = '23514';
  END IF;
  IF NEW.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'draft check-ins cannot carry a submission timestamp'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_check_in_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM public.check_ins WHERE id = NEW.supersedes_check_in_id;
    IF NOT FOUND
      OR predecessor.patient_id <> NEW.patient_id
      OR predecessor.status <> 'submitted'
    THEN
      RAISE EXCEPTION 'a check-in correction must supersede a submitted check-in of the same patient'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_check_in_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'submitted check-ins are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.local_date IS DISTINCT FROM OLD.local_date
    OR NEW.time_zone IS DISTINCT FROM OLD.time_zone
    OR NEW.supersedes_check_in_id IS DISTINCT FROM OLD.supersedes_check_in_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'check-in identity and source fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'check-in workflow version must advance by one'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'draft' THEN
    IF NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'draft check-ins cannot carry a submission timestamp'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'submitted' THEN
    RAISE EXCEPTION 'invalid check-in status' USING ERRCODE = '23514';
  END IF;
  IF NEW.condition IS DISTINCT FROM OLD.condition
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.medication_adherence IS DISTINCT FROM OLD.medication_adherence
  THEN
    RAISE EXCEPTION 'check-in content is frozen at submission' USING ERRCODE = '55000';
  END IF;
  IF NEW.submitted_at IS NULL THEN
    RAISE EXCEPTION 'submitted check-ins require a submission timestamp'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Locks the parent row before reading its status so a child insert/update
-- racing a submit blocks on the same row and re-reads the committed status.
CREATE FUNCTION public.forcare_check_in_child_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'medication_adherence' THEN
    SELECT status INTO parent_status
    FROM public.check_ins
    WHERE id = NEW.check_in_id
    FOR UPDATE;
  ELSE
    SELECT status INTO parent_status
    FROM public.check_ins
    WHERE id = NEW.check_in_id AND patient_id = NEW.patient_id
    FOR UPDATE;
  END IF;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'check-in child rows need a matching parent check-in'
      USING ERRCODE = '23503';
  END IF;
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'check-in child membership is frozen after submission'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_check_in_child_mutation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.check_in_id IS DISTINCT FROM OLD.check_in_id THEN
    RAISE EXCEPTION 'check-in child membership is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT status INTO parent_status
  FROM public.check_ins
  WHERE id = OLD.check_in_id
  FOR UPDATE;
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'check-in child rows are frozen after submission'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Deferred parent/child consistency. Validation runs at COMMIT, so a service
-- may replace the child row and update the parent scalar in either order.
CREATE FUNCTION public.forcare_medication_adherence_consistency_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent public.check_ins%ROWTYPE;
  child_count integer;
  child_status text;
  target_check_in uuid;
BEGIN
  -- Deferred events carry the row image from statement time; both rows may
  -- have been replaced later in the transaction. Always validate the final
  -- state of the pair at check time.
  IF TG_TABLE_NAME = 'check_ins' THEN
    target_check_in := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_check_in := OLD.check_in_id;
  ELSE
    target_check_in := NEW.check_in_id;
  END IF;

  SELECT * INTO parent FROM public.check_ins WHERE id = target_check_in;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO child_count
  FROM public.medication_adherence
  WHERE check_in_id = target_check_in;
  IF child_count <> 1 THEN
    RAISE EXCEPTION 'check-in % requires exactly one medication adherence row', target_check_in
      USING ERRCODE = '23514';
  END IF;

  SELECT status INTO child_status
  FROM public.medication_adherence
  WHERE check_in_id = target_check_in;
  IF child_status <> parent.medication_adherence THEN
    RAISE EXCEPTION 'check-in medication adherence (%) must match the medication adherence row (%)',
      parent.medication_adherence, child_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.forcare_observation_confirmation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  observation public.check_in_observations%ROWTYPE;
  parent_status text;
  parent_version integer;
BEGIN
  SELECT * INTO observation FROM public.check_in_observations WHERE id = NEW.observation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation requires an existing observation'
      USING ERRCODE = '23503';
  END IF;
  SELECT status, version INTO parent_status, parent_version
  FROM public.check_ins
  WHERE id = observation.check_in_id;
  IF parent_status IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'only submitted check-in observations can be confirmed'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.check_in_id <> observation.check_in_id
    OR NEW.patient_id <> observation.patient_id
  THEN
    RAISE EXCEPTION 'confirmation must bind the observation provenance'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.check_in_version <> parent_version THEN
    RAISE EXCEPTION 'confirmation must bind the current submitted check-in version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.observation_type <> observation.type
    OR NEW.observation_value <> observation.value
    OR NEW.observation_unit <> observation.unit
    OR NEW.observation_observed_at <> observation.observed_at
  THEN
    RAISE EXCEPTION 'confirmation snapshot must match the stored observation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_ins_insert_guard
  BEFORE INSERT ON public.check_ins
  FOR EACH ROW EXECUTE FUNCTION public.forcare_check_in_insert_guard();

CREATE TRIGGER check_ins_update_guard
  BEFORE UPDATE ON public.check_ins
  FOR EACH ROW EXECUTE FUNCTION public.forcare_check_in_update_guard();

CREATE TRIGGER check_ins_reject_delete
  BEFORE DELETE ON public.check_ins
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER check_ins_reject_truncate
  BEFORE TRUNCATE ON public.check_ins
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE CONSTRAINT TRIGGER check_ins_medication_adherence_consistency
  AFTER INSERT OR UPDATE OF medication_adherence ON public.check_ins
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.forcare_medication_adherence_consistency_guard();

CREATE CONSTRAINT TRIGGER medication_adherence_consistency
  AFTER INSERT OR UPDATE OR DELETE ON public.medication_adherence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.forcare_medication_adherence_consistency_guard();

CREATE TRIGGER check_in_observations_insert_guard
  BEFORE INSERT ON public.check_in_observations
  FOR EACH ROW EXECUTE FUNCTION public.forcare_check_in_child_insert_guard();

CREATE TRIGGER check_in_observations_mutation_guard
  BEFORE UPDATE OR DELETE ON public.check_in_observations
  FOR EACH ROW EXECUTE FUNCTION public.forcare_check_in_child_mutation_guard();

CREATE TRIGGER check_in_observations_reject_truncate
  BEFORE TRUNCATE ON public.check_in_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER medication_adherence_insert_guard
  BEFORE INSERT ON public.medication_adherence
  FOR EACH ROW EXECUTE FUNCTION public.forcare_check_in_child_insert_guard();

CREATE TRIGGER medication_adherence_mutation_guard
  BEFORE UPDATE OR DELETE ON public.medication_adherence
  FOR EACH ROW EXECUTE FUNCTION public.forcare_check_in_child_mutation_guard();

CREATE TRIGGER medication_adherence_reject_truncate
  BEFORE TRUNCATE ON public.medication_adherence
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER observation_confirmations_insert_guard
  BEFORE INSERT ON public.observation_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.forcare_observation_confirmation_guard();

CREATE TRIGGER observation_confirmations_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.observation_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();

CREATE TRIGGER observation_confirmations_reject_truncate
  BEFORE TRUNCATE ON public.observation_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
