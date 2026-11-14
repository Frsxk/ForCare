-- 0011 priority requests: human availability approval only. An approved
-- exception is separate from submission, reservation and booking acceptance.

CREATE TABLE public.priority_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  nurse_id uuid NOT NULL,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  statement text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  reviewed_by uuid REFERENCES public.accounts (id) ON DELETE RESTRICT,
  reviewed_at timestamptz(3),
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT priority_requests_booking_exact_fkey
    FOREIGN KEY (booking_id, patient_id, nurse_id)
    REFERENCES public.bookings (id, patient_id, nurse_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT priority_requests_patient_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT priority_requests_nurse_fkey
    FOREIGN KEY (nurse_id) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT priority_requests_identity_unique UNIQUE (id, booking_id, patient_id, nurse_id),
  CONSTRAINT priority_requests_exception_identity_unique
    UNIQUE (id, booking_id, nurse_id, starts_at, ends_at),
  CONSTRAINT priority_requests_interval_check CHECK (starts_at < ends_at),
  CONSTRAINT priority_requests_statement_check CHECK (
    btrim(statement) <> '' AND btrim(statement) = statement AND length(statement) <= 4000
  ),
  CONSTRAINT priority_requests_status_check CHECK (
    status IN ('pending', 'availability_accepted', 'declined')
  ),
  CONSTRAINT priority_requests_version_check CHECK (version >= 0),
  CONSTRAINT priority_requests_reason_check CHECK (reason IS NULL OR btrim(reason) <> ''),
  CONSTRAINT priority_requests_decision_check CHECK (
    (status = 'pending' AND reason IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status <> 'pending' AND reason IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX priority_requests_booking_idx
  ON public.priority_requests (booking_id, created_at DESC);
CREATE INDEX priority_requests_nurse_pending_idx
  ON public.priority_requests (nurse_id, created_at DESC) WHERE (status = 'pending');

CREATE FUNCTION public.forcare_priority_request_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO requested FROM public.bookings WHERE id = NEW.booking_id;
  IF NOT FOUND OR requested.patient_id <> NEW.patient_id
    OR requested.nurse_id <> NEW.nurse_id
    OR requested.status NOT IN ('draft', 'accepted') THEN
    RAISE EXCEPTION 'priority request must bind an owned draft or accepted booking' USING ERRCODE = '23514';
  END IF;
  IF requested.status = 'draft'
    AND (NEW.starts_at, NEW.ends_at) IS DISTINCT FROM (requested.starts_at, requested.ends_at) THEN
    RAISE EXCEPTION 'draft priority interval must match its binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER priority_requests_insert_guard
  BEFORE INSERT ON public.priority_requests
  FOR EACH ROW EXECUTE FUNCTION public.forcare_priority_request_insert_guard();

CREATE FUNCTION public.forcare_priority_request_review_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reviewer uuid;
  target_reserved_until timestamptz(3);
BEGIN
  PERFORM 1 FROM public.staff WHERE id = NEW.nurse_id FOR KEY SHARE;
  IF NEW.booking_id <> OLD.booking_id OR NEW.patient_id <> OLD.patient_id
    OR NEW.nurse_id <> OLD.nurse_id OR NEW.starts_at <> OLD.starts_at
    OR NEW.ends_at <> OLD.ends_at OR NEW.statement IS DISTINCT FROM OLD.statement
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'priority request statement and binding are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('availability_accepted', 'declined')
    OR NEW.version <> OLD.version + 1 OR NEW.reason IS NULL
    OR btrim(NEW.reason) = '' OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'priority request permits exactly one reasoned decision' USING ERRCODE = '23514';
  END IF;
  SELECT account_id INTO reviewer FROM public.staff
  WHERE id = NEW.nurse_id AND active = true AND btrim(identity_approval_ref) <> '';
  IF NEW.reviewed_by IS NULL OR NEW.reviewed_by IS DISTINCT FROM reviewer THEN
    RAISE EXCEPTION 'priority request must be reviewed by its selected nurse' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'availability_accepted' THEN
    SELECT NEW.ends_at + av.buffer_minutes * interval '1 minute'
    INTO target_reserved_until
    FROM public.nurse_availability_versions av
    WHERE av.nurse_id = NEW.nurse_id
      AND av.effective_from <= NEW.starts_at AND av.effective_to >= NEW.ends_at
      AND NOT EXISTS (
        SELECT 1 FROM public.nurse_availability_versions newer
        WHERE newer.nurse_id = av.nurse_id AND newer.version > av.version
          AND newer.effective_from <= NEW.starts_at
      );
    IF EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.status = 'accepted' AND b.id <> NEW.booking_id
        AND (
          (b.nurse_id = NEW.nurse_id
            AND tstzrange(NEW.starts_at, COALESCE(target_reserved_until, NEW.ends_at), '[)')
              && tstzrange(b.starts_at, b.reserved_until, '[)'))
          OR (b.patient_id = NEW.patient_id
            AND tstzrange(NEW.starts_at, NEW.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)'))
        )
    ) THEN
      RAISE EXCEPTION 'priority interval conflicts with an accepted booking' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER priority_requests_review_guard
  BEFORE UPDATE ON public.priority_requests
  FOR EACH ROW EXECUTE FUNCTION public.forcare_priority_request_review_guard();

CREATE FUNCTION public.forcare_priority_requests_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'priority request history cannot be deleted or truncated' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER priority_requests_reject_delete
  BEFORE DELETE ON public.priority_requests
  FOR EACH ROW EXECUTE FUNCTION public.forcare_priority_requests_reject_delete();
CREATE TRIGGER priority_requests_reject_truncate
  BEFORE TRUNCATE ON public.priority_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_priority_requests_reject_delete();

CREATE TABLE public.schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  priority_request_id uuid NOT NULL UNIQUE,
  booking_id uuid NOT NULL,
  nurse_id uuid NOT NULL,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  approved_by uuid NOT NULL REFERENCES public.accounts (id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT schedule_exceptions_request_fkey
    FOREIGN KEY (priority_request_id, booking_id, nurse_id, starts_at, ends_at)
    REFERENCES public.priority_requests (id, booking_id, nurse_id, starts_at, ends_at)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT schedule_exceptions_interval_check CHECK (starts_at < ends_at)
);

CREATE FUNCTION public.forcare_schedule_exception_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested public.priority_requests%ROWTYPE;
  booking_row public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO requested FROM public.priority_requests WHERE id = NEW.priority_request_id;
  IF NOT FOUND OR requested.status <> 'availability_accepted'
    OR requested.reviewed_by IS DISTINCT FROM NEW.approved_by
    OR requested.reason IS DISTINCT FROM NEW.reason
    OR (requested.booking_id, requested.nurse_id, requested.starts_at, requested.ends_at)
      IS DISTINCT FROM (NEW.booking_id, NEW.nurse_id, NEW.starts_at, NEW.ends_at)
    OR NEW.created_at < requested.reviewed_at THEN
    RAISE EXCEPTION 'exception must exactly match its approved priority request' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO booking_row FROM public.bookings WHERE id = NEW.booking_id;
  IF NOT FOUND OR booking_row.status NOT IN ('draft', 'accepted')
    OR booking_row.nurse_id IS DISTINCT FROM NEW.nurse_id
    OR (booking_row.status = 'draft'
      AND (booking_row.starts_at, booking_row.ends_at) IS DISTINCT FROM (NEW.starts_at, NEW.ends_at)) THEN
    RAISE EXCEPTION 'exception must match its draft interval or accepted proposed target' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff s
    WHERE s.id = NEW.nurse_id AND s.account_id = NEW.approved_by AND s.active) THEN
    RAISE EXCEPTION 'exception approval requires the active selected nurse' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_exceptions_insert_guard
  BEFORE INSERT ON public.schedule_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_schedule_exception_insert_guard();

CREATE FUNCTION public.forcare_schedule_exceptions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'schedule exceptions are immutable and append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER schedule_exceptions_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.schedule_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_schedule_exceptions_reject_mutation();
CREATE TRIGGER schedule_exceptions_reject_truncate
  BEFORE TRUNCATE ON public.schedule_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_schedule_exceptions_reject_mutation();

CREATE FUNCTION public.forcare_booking_exception_usage_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('submitted', 'accepted') AND NEW.slot_id IS NULL
    AND (OLD.status IS DISTINCT FROM 'submitted' OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at)
    AND NOT EXISTS (
      SELECT 1 FROM public.schedule_exceptions e
      JOIN public.priority_requests p ON p.id = e.priority_request_id
      WHERE p.status = 'availability_accepted'
        AND e.booking_id = NEW.id AND e.nurse_id = NEW.nurse_id
        AND e.starts_at = NEW.starts_at AND e.ends_at = NEW.ends_at
    ) THEN
    RAISE EXCEPTION 'null-slot submission/reschedule requires an exact approved exception' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_exception_usage_guard
  AFTER UPDATE ON public.bookings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_exception_usage_guard();
