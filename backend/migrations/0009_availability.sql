-- 0009 availability: immutable, explicitly timestamped nurse availability.
-- Service code publishes a new version under a staff-row lock; historical
-- versions and slots are never rewritten.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.nurse_availability_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nurse_id uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  version integer NOT NULL,
  time_zone text NOT NULL,
  slot_minutes integer NOT NULL,
  buffer_minutes integer NOT NULL,
  effective_from timestamptz(3) NOT NULL,
  effective_to timestamptz(3) NOT NULL,
  windows jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES public.accounts (id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT nurse_availability_versions_nurse_version_unique UNIQUE (nurse_id, version),
  CONSTRAINT nurse_availability_versions_id_nurse_unique UNIQUE (id, nurse_id),
  CONSTRAINT nurse_availability_versions_version_check CHECK (version >= 1),
  CONSTRAINT nurse_availability_versions_slot_minutes_check CHECK (slot_minutes BETWEEN 1 AND 480),
  CONSTRAINT nurse_availability_versions_buffer_minutes_check CHECK (buffer_minutes BETWEEN 0 AND 120),
  CONSTRAINT nurse_availability_versions_effective_check CHECK (
    effective_from < effective_to
    AND effective_to <= effective_from + interval '90 days'
  ),
  CONSTRAINT nurse_availability_versions_windows_array_check CHECK (jsonb_typeof(windows) = 'array')
);

CREATE TABLE public.nurse_availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  availability_version_id uuid NOT NULL,
  nurse_id uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  CONSTRAINT nurse_availability_slots_version_nurse_fkey
    FOREIGN KEY (availability_version_id, nurse_id)
    REFERENCES public.nurse_availability_versions (id, nurse_id) ON DELETE RESTRICT,
  CONSTRAINT nurse_availability_slots_version_interval_unique
    UNIQUE (availability_version_id, starts_at, ends_at),
  CONSTRAINT nurse_availability_slots_booking_provenance_unique
    UNIQUE (id, availability_version_id, nurse_id, starts_at, ends_at),
  CONSTRAINT nurse_availability_slots_interval_check CHECK (starts_at < ends_at),
  CONSTRAINT nurse_availability_slots_no_overlap
    EXCLUDE USING gist (
      availability_version_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    )
);

CREATE INDEX nurse_availability_slots_current_idx
  ON public.nurse_availability_slots (nurse_id, starts_at, ends_at)
  INCLUDE (id, availability_version_id);

CREATE FUNCTION public.forcare_availability_version_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
BEGIN
  IF NEW.effective_from < statement_timestamp() THEN
    RAISE EXCEPTION 'availability effective_from cannot be in the past' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'availability time_zone must be a valid IANA time zone' USING ERRCODE = '22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(NEW.windows)
  LOOP
    IF jsonb_typeof(item) <> 'object'
      OR NOT (item ?& ARRAY['weekday', 'startMinute', 'endMinute'])
      OR item - ARRAY['weekday', 'startMinute', 'endMinute'] <> '{}'::jsonb
      OR jsonb_typeof(item -> 'weekday') <> 'number'
      OR jsonb_typeof(item -> 'startMinute') <> 'number'
      OR jsonb_typeof(item -> 'endMinute') <> 'number'
      OR (item ->> 'weekday')::numeric % 1 <> 0
      OR (item ->> 'startMinute')::numeric % 1 <> 0
      OR (item ->> 'endMinute')::numeric % 1 <> 0
      OR (item ->> 'weekday')::integer NOT BETWEEN 1 AND 7
      OR (item ->> 'startMinute')::integer NOT BETWEEN 0 AND 1439
      OR (item ->> 'endMinute')::integer NOT BETWEEN 1 AND 1440
      OR (item ->> 'startMinute')::integer >= (item ->> 'endMinute')::integer
    THEN
      RAISE EXCEPTION 'invalid availability working window' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.windows) WITH ORDINALITY AS a(value, ordinal)
    JOIN jsonb_array_elements(NEW.windows) WITH ORDINALITY AS b(value, ordinal)
      ON b.ordinal > a.ordinal
      AND (a.value ->> 'weekday')::integer = (b.value ->> 'weekday')::integer
      AND (a.value ->> 'startMinute')::integer < (b.value ->> 'endMinute')::integer
      AND (b.value ->> 'startMinute')::integer < (a.value ->> 'endMinute')::integer
  ) THEN
    RAISE EXCEPTION 'availability working windows cannot overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nurse_availability_versions_insert_guard
  BEFORE INSERT ON public.nurse_availability_versions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_availability_version_insert_guard();

CREATE FUNCTION public.forcare_availability_slot_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  availability public.nurse_availability_versions%ROWTYPE;
  local_start timestamp;
  local_end timestamp;
  start_seconds numeric;
BEGIN
  SELECT * INTO availability
  FROM public.nurse_availability_versions
  WHERE id = NEW.availability_version_id AND nurse_id = NEW.nurse_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slot version and nurse must match' USING ERRCODE = '23503';
  END IF;
  IF (SELECT count(*) FROM public.nurse_availability_slots
      WHERE availability_version_id = NEW.availability_version_id) >= 200 THEN
    RAISE EXCEPTION 'availability version cannot contain more than 200 slots' USING ERRCODE = '23514';
  END IF;
  IF NEW.starts_at < availability.effective_from OR NEW.ends_at > availability.effective_to THEN
    RAISE EXCEPTION 'slot must be inside its availability effective horizon' USING ERRCODE = '23514';
  END IF;
  IF extract(epoch FROM NEW.ends_at - NEW.starts_at) <> availability.slot_minutes * 60 THEN
    RAISE EXCEPTION 'slot duration must exactly match its availability version' USING ERRCODE = '23514';
  END IF;

  local_start := NEW.starts_at AT TIME ZONE availability.time_zone;
  local_end := NEW.ends_at AT TIME ZONE availability.time_zone;
  start_seconds := extract(epoch FROM local_start - local_start::date);
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(availability.windows)
      AS w(weekday integer, "startMinute" integer, "endMinute" integer)
    WHERE w.weekday = extract(isodow FROM local_start)
      AND start_seconds >= w."startMinute" * 60
      AND (start_seconds - w."startMinute" * 60) % (availability.slot_minutes * 60) = 0
      AND local_start + (NEW.ends_at - NEW.starts_at)
        <= local_start::date + make_interval(mins => w."endMinute")
      AND local_start + (NEW.ends_at - NEW.starts_at) = local_end
  ) THEN
    RAISE EXCEPTION 'slot must align to and fit within one working window' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nurse_availability_slots_insert_guard
  BEFORE INSERT ON public.nurse_availability_slots
  FOR EACH ROW EXECUTE FUNCTION public.forcare_availability_slot_insert_guard();

CREATE FUNCTION public.forcare_availability_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER nurse_availability_versions_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.nurse_availability_versions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_availability_reject_mutation();
CREATE TRIGGER nurse_availability_versions_reject_truncate
  BEFORE TRUNCATE ON public.nurse_availability_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_availability_reject_mutation();
CREATE TRIGGER nurse_availability_slots_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.nurse_availability_slots
  FOR EACH ROW EXECUTE FUNCTION public.forcare_availability_reject_mutation();
CREATE TRIGGER nurse_availability_slots_reject_truncate
  BEFORE TRUNCATE ON public.nurse_availability_slots
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_availability_reject_mutation();
