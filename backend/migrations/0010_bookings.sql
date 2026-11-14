-- 0010 bookings: request state, immutable submitted content, append-only
-- history and the real accepted-visit scheduling identity.

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients (id) ON DELETE RESTRICT,
  nurse_id uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  slot_id uuid,
  availability_version_id uuid,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  reserved_until timestamptz(3) NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  intake jsonb NOT NULL,
  profile_snapshot jsonb,
  version integer NOT NULL DEFAULT 0,
  submitted_at timestamptz(3),
  decided_at timestamptz(3),
  cancelled_at timestamptz(3),
  decision_by uuid REFERENCES public.accounts (id) ON DELETE RESTRICT,
  decision_reason text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT bookings_slot_provenance_fkey
    FOREIGN KEY (slot_id, availability_version_id, nurse_id, starts_at, ends_at)
    REFERENCES public.nurse_availability_slots
      (id, availability_version_id, nurse_id, starts_at, ends_at)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT bookings_availability_version_fkey
    FOREIGN KEY (availability_version_id)
    REFERENCES public.nurse_availability_versions (id) ON DELETE RESTRICT,
  CONSTRAINT bookings_identity_unique UNIQUE (id, patient_id, nurse_id),
  CONSTRAINT bookings_interval_identity_unique
    UNIQUE (id, patient_id, nurse_id, starts_at, ends_at),
  CONSTRAINT bookings_cap_unique UNIQUE (id, patient_id, status),
  CONSTRAINT bookings_patient_unique UNIQUE (id, patient_id),
  CONSTRAINT bookings_version_check CHECK (version >= 0),
  CONSTRAINT bookings_interval_check CHECK (starts_at < ends_at AND reserved_until >= ends_at),
  CONSTRAINT bookings_status_check CHECK (
    status IN ('draft', 'submitted', 'accepted', 'rejected', 'cancelled')
  ),
  CONSTRAINT bookings_slot_version_pair_check CHECK (
    (slot_id IS NULL) = (availability_version_id IS NULL)
  ),
  CONSTRAINT bookings_intake_object_check CHECK (jsonb_typeof(intake) = 'object'),
  CONSTRAINT bookings_profile_snapshot_object_check CHECK (
    profile_snapshot IS NULL OR jsonb_typeof(profile_snapshot) = 'object'
  ),
  CONSTRAINT bookings_decision_reason_check CHECK (
    decision_reason IS NULL OR btrim(decision_reason) <> ''
  ),
  CONSTRAINT bookings_state_fields_check CHECK (
    (status = 'draft' AND submitted_at IS NULL AND decided_at IS NULL
      AND cancelled_at IS NULL AND decision_by IS NULL AND profile_snapshot IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL AND decided_at IS NULL
      AND cancelled_at IS NULL AND decision_by IS NULL AND profile_snapshot IS NOT NULL)
    OR (status = 'accepted' AND submitted_at IS NOT NULL AND decided_at IS NOT NULL
      AND cancelled_at IS NULL AND decision_by IS NOT NULL AND profile_snapshot IS NOT NULL)
    OR (status = 'rejected' AND submitted_at IS NOT NULL AND decided_at IS NOT NULL
      AND cancelled_at IS NULL AND decision_by IS NOT NULL
      AND decision_reason IS NOT NULL AND profile_snapshot IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND decision_reason IS NOT NULL
      AND (decided_at IS NULL OR (submitted_at IS NOT NULL AND decision_by IS NOT NULL))
      AND (submitted_at IS NULL OR profile_snapshot IS NOT NULL))
  ),
  CONSTRAINT bookings_accepted_nurse_buffer
    EXCLUDE USING gist (
      nurse_id WITH =,
      tstzrange(starts_at, reserved_until, '[)') WITH &&
    ) WHERE (status = 'accepted'),
  CONSTRAINT bookings_accepted_patient_raw_interval
    EXCLUDE USING gist (
      patient_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'accepted'),
  CONSTRAINT bookings_accepted_slot_unique
    EXCLUDE USING gist (slot_id WITH =)
    WHERE (status = 'accepted' AND slot_id IS NOT NULL)
);

CREATE INDEX bookings_patient_status_idx
  ON public.bookings (patient_id, status, ends_at DESC);
CREATE INDEX bookings_nurse_status_idx
  ON public.bookings (nurse_id, status, starts_at);
CREATE INDEX bookings_submitted_slot_idx
  ON public.bookings (slot_id) WHERE (status = 'submitted');

CREATE FUNCTION public.forcare_booking_snapshot_fields_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('submitted', 'accepted', 'rejected') THEN
    IF (NEW.intake ->> 'consent')::boolean IS DISTINCT FROM true
      OR jsonb_typeof(NEW.profile_snapshot) <> 'object'
      OR btrim(COALESCE(NEW.profile_snapshot ->> 'fullName', '')) = ''
      OR btrim(COALESCE(NEW.profile_snapshot ->> 'phone', '')) = ''
      OR btrim(COALESCE(NEW.profile_snapshot ->> 'addressLine', '')) = ''
      OR NEW.profile_snapshot ->> 'birthDate' IS NULL
      OR NEW.profile_snapshot ->> 'gender' IS NULL THEN
      RAISE EXCEPTION 'submission requires consent and complete owned contact details' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_snapshot_fields_guard
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_snapshot_fields_guard();

CREATE TABLE public.booking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.bookings (id) ON DELETE RESTRICT,
  actor_account_id uuid REFERENCES public.accounts (id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (btrim(action) <> ''),
  version integer NOT NULL CHECK (version >= 0),
  reason text CHECK (reason IS NULL OR btrim(reason) <> ''),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object' AND (data - ARRAY[
      'slotId', 'availabilityVersionId', 'startsAt', 'endsAt',
      'reservedUntil', 'previousSlotId', 'previousAvailabilityVersionId',
      'previousStartsAt', 'previousEndsAt', 'previousReservedUntil',
      'priorityRequestId', 'version', 'previousVersion', 'patientAgreed'
    ]) = '{}'::jsonb),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT booking_events_booking_version_unique UNIQUE (booking_id, version, action)
);

CREATE INDEX booking_events_booking_created_idx
  ON public.booking_events (booking_id, created_at, id);

CREATE FUNCTION public.forcare_booking_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'booking_events is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER booking_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.booking_events
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_events_reject_mutation();
CREATE TRIGGER booking_events_reject_truncate
  BEFORE TRUNCATE ON public.booking_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_booking_events_reject_mutation();

CREATE TABLE public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES public.bookings (id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES public.patients (id) ON DELETE RESTRICT,
  nurse_id uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT visits_interval_check CHECK (starts_at < ends_at),
  CONSTRAINT visits_status_check CHECK (status IN ('scheduled', 'cancelled')),
  CONSTRAINT visits_version_check CHECK (version >= 0),
  CONSTRAINT visits_existing_grants_unique UNIQUE (id),
  CONSTRAINT visits_booking_grants_unique UNIQUE (id, booking_id),
  CONSTRAINT visits_booking_grants_full_unique
    UNIQUE (id, booking_id, patient_id, nurse_id, starts_at, ends_at, status),
  CONSTRAINT visits_booking_patient_unique UNIQUE (id, patient_id)
);

CREATE INDEX visits_nurse_schedule_idx
  ON public.visits (nurse_id, starts_at, ends_at) WHERE (status = 'scheduled');

CREATE TABLE public.booking_state_transitions (
  booking_id uuid NOT NULL REFERENCES public.bookings (id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 0),
  status text NOT NULL CHECK (status IN ('draft', 'submitted', 'accepted', 'rejected', 'cancelled')),
  actor_account_id uuid REFERENCES public.accounts (id) ON DELETE RESTRICT,
  reason text,
  PRIMARY KEY (booking_id, version)
);
CREATE INDEX booking_state_transitions_booking_idx
  ON public.booking_state_transitions (booking_id, version DESC);

CREATE FUNCTION public.forcare_booking_state_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.booking_state_transitions t
    WHERE t.booking_id = NEW.booking_id AND t.version > NEW.version
  ) THEN
    RAISE EXCEPTION 'booking history is append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_state_transitions_guard
  BEFORE INSERT ON public.booking_state_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_state_transition_guard();

CREATE FUNCTION public.forcare_booking_state_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'booking state history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER booking_state_history_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.booking_state_transitions
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_state_history_reject_mutation();
CREATE TRIGGER booking_state_history_reject_truncate
  BEFORE TRUNCATE ON public.booking_state_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_booking_state_history_reject_mutation();

CREATE FUNCTION public.forcare_bookings_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'bookings cannot be deleted or truncated' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER bookings_reject_delete
  BEFORE DELETE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.forcare_bookings_reject_delete();
CREATE TRIGGER bookings_reject_truncate
  BEFORE TRUNCATE ON public.bookings
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_bookings_reject_delete();

CREATE FUNCTION public.forcare_booking_submission_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    SELECT jsonb_build_object(
      'fullName', p.full_name,
      'birthDate', p.birth_date,
      'gender', p.gender,
      'phone', p.phone,
      'addressLine', p.address_line,
      'recordNumber', p.record_number,
      'emergencyContactName', p.emergency_contact_name,
      'emergencyContactPhone', p.emergency_contact_phone
    ) INTO snapshot
    FROM public.patients p WHERE p.id = NEW.patient_id;
    IF NOT FOUND OR snapshot IS DISTINCT FROM NEW.profile_snapshot THEN
      RAISE EXCEPTION 'booking profile snapshot must be the server-owned patient profile' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_submission_snapshot_guard
  AFTER INSERT OR UPDATE ON public.bookings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_submission_snapshot_guard();

CREATE FUNCTION public.forcare_booking_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  immutable_content jsonb;
  reservation_fields jsonb;
  buffer_interval interval;
  has_history boolean;
BEGIN
  IF NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id
    OR (OLD.status <> 'draft' AND NEW.nurse_id <> OLD.nurse_id)
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking identity and selected nurse are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'booking version must increment by exactly one' USING ERRCODE = '23514';
  END IF;
  immutable_content := to_jsonb(NEW) - ARRAY[
    'status', 'profile_snapshot', 'version', 'submitted_at', 'decided_at',
    'cancelled_at', 'decision_by', 'decision_reason', 'updated_at',
    'starts_at', 'ends_at', 'reserved_until', 'slot_id', 'availability_version_id'
  ];
  IF OLD.status <> 'draft'
    AND immutable_content IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'status', 'profile_snapshot', 'version', 'submitted_at', 'decided_at',
      'cancelled_at', 'decision_by', 'decision_reason', 'updated_at',
      'starts_at', 'ends_at', 'reserved_until', 'slot_id', 'availability_version_id'
    ]) THEN
    RAISE EXCEPTION 'immutable booking content changed' USING ERRCODE = '23514';
  END IF;

  reservation_fields := to_jsonb(NEW) - ARRAY[
    'status', 'profile_snapshot', 'version', 'submitted_at', 'decided_at',
    'cancelled_at', 'decision_by', 'decision_reason', 'updated_at', 'intake'
  ];
  IF OLD.status <> 'draft'
    AND reservation_fields IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'status', 'profile_snapshot', 'version', 'submitted_at', 'decided_at',
      'cancelled_at', 'decision_by', 'decision_reason', 'updated_at', 'intake'
    ])
    AND NOT (OLD.status = 'accepted' AND NEW.status = 'accepted')
  THEN
    RAISE EXCEPTION 'submitted reservation fields are immutable except accepted reschedule' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND NEW.intake IS DISTINCT FROM OLD.intake THEN
    RAISE EXCEPTION 'submitted intake is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND (
    NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.profile_snapshot IS DISTINCT FROM OLD.profile_snapshot
    OR (OLD.status IN ('accepted', 'rejected') AND (
      NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decision_by IS DISTINCT FROM OLD.decision_by
      OR (NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
        AND NOT (OLD.status = 'accepted' AND NEW.status = 'cancelled')))))
  THEN
    RAISE EXCEPTION 'booking submission/decision snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'submitted', 'cancelled'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'accepted', 'rejected', 'cancelled'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('accepted', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'illegal booking state transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = NEW.status AND OLD.status IN ('submitted', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'terminal or submitted booking rows cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'draft'
    AND (NEW.submitted_at IS NOT NULL OR NEW.profile_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'draft edits cannot submit a booking' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'submitted'
    AND (NEW.submitted_at IS NULL
      OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at)) THEN
    RAISE EXCEPTION 'submission requires its immutable submission timestamp' USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'booking updated_at cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NEW.slot_id IS NULL AND NEW.availability_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'null-slot exception reservations cannot reference an availability version' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' THEN
    SELECT v.buffer_minutes * interval '1 minute' INTO buffer_interval
    FROM public.nurse_availability_versions v WHERE v.id = NEW.availability_version_id;
    IF BUFFER_INTERVAL IS NULL AND NEW.slot_id IS NOT NULL THEN
      RAISE EXCEPTION 'accepted slot availability version not found' USING ERRCODE = '23503';
    END IF;
    IF NEW.slot_id IS NOT NULL AND NEW.reserved_until <> NEW.ends_at + buffer_interval THEN
      RAISE EXCEPTION 'reserved_until must include the exact nurse buffer' USING ERRCODE = '23514';
    END IF;
    IF NEW.slot_id IS NULL AND NEW.reserved_until < NEW.ends_at THEN
      RAISE EXCEPTION 'exception reserved_until cannot precede ends_at' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.booking_state_transitions h
    WHERE h.booking_id = NEW.id AND h.version = NEW.version
  ) INTO has_history;
  IF NOT has_history THEN
    INSERT INTO public.booking_state_transitions (booking_id, version, status, reason)
    VALUES (NEW.id, NEW.version, NEW.status, NEW.decision_reason);
  END IF;
  IF OLD.status = 'accepted' AND NEW.status = 'accepted' AND (
    (NEW.starts_at, NEW.ends_at, NEW.reserved_until, NEW.slot_id, NEW.availability_version_id)
      IS DISTINCT FROM
    (OLD.starts_at, OLD.ends_at, OLD.reserved_until, OLD.slot_id, OLD.availability_version_id)
  ) THEN
    INSERT INTO public.booking_state_transitions (booking_id, version, status)
    VALUES (NEW.id, NEW.version, 'accepted')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_transition_guard
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_transition_guard();

CREATE FUNCTION public.forcare_booking_reschedule_event_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'accepted' AND NEW.status = 'accepted'
    AND (NEW.starts_at, NEW.ends_at, NEW.reserved_until, NEW.slot_id, NEW.availability_version_id)
      IS DISTINCT FROM
      (OLD.starts_at, OLD.ends_at, OLD.reserved_until, OLD.slot_id, OLD.availability_version_id)
    AND EXISTS (
      SELECT 1 FROM public.booking_state_transitions h
      WHERE h.booking_id = NEW.id AND h.version = NEW.version AND h.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_events e
          WHERE e.booking_id = NEW.id AND e.version = NEW.version
            AND e.action = 'booking.rescheduled' AND btrim(COALESCE(e.reason, '')) <> ''
            AND e.data @> '{"patientAgreed":true}'::jsonb
        )
    ) THEN
    RAISE EXCEPTION 'reschedule requires a reasoned booking event' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_reschedule_event_guard
  AFTER UPDATE ON public.bookings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_reschedule_event_guard();

CREATE FUNCTION public.forcare_visits_booking_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested public.bookings%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO requested FROM public.bookings WHERE id = NEW.booking_id;
    IF NOT FOUND OR requested.status <> 'accepted'
      OR NEW.status <> 'scheduled' OR NEW.version <> 0
      OR (requested.patient_id, requested.nurse_id, requested.starts_at, requested.ends_at)
        IS DISTINCT FROM (NEW.patient_id, NEW.nurse_id, NEW.starts_at, NEW.ends_at) THEN
      RAISE EXCEPTION 'visit must exactly match its accepted booking' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO requested FROM public.bookings WHERE id = NEW.booking_id;
  IF NEW.booking_id <> OLD.booking_id OR NEW.patient_id <> OLD.patient_id
    OR NEW.nurse_id <> OLD.nurse_id OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1
    OR OLD.status <> 'scheduled'
    OR (NEW.status = 'scheduled' AND requested.status <> 'accepted')
    OR (NEW.status = 'cancelled' AND requested.status <> 'cancelled')
    OR (NEW.starts_at, NEW.ends_at) IS DISTINCT FROM (OLD.starts_at, OLD.ends_at)
      AND NOT (NEW.status = 'scheduled' AND requested.status = 'accepted')
    OR (NEW.status = 'scheduled' AND (requested.starts_at, requested.ends_at)
      IS DISTINCT FROM (NEW.starts_at, NEW.ends_at))
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'illegal visit scheduling transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visits_booking_guard
  BEFORE INSERT OR UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.forcare_visits_booking_guard();

CREATE FUNCTION public.forcare_visits_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'visits cannot be deleted or truncated' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER visits_reject_delete
  BEFORE DELETE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.forcare_visits_reject_delete();
CREATE TRIGGER visits_reject_truncate
  BEFORE TRUNCATE ON public.visits
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_visits_reject_delete();

CREATE FUNCTION public.forcare_booking_acceptance_requires_visit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.booking_id = NEW.id AND v.patient_id = NEW.patient_id
      AND v.nurse_id = NEW.nurse_id AND v.starts_at = NEW.starts_at
      AND v.ends_at = NEW.ends_at AND v.status = 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM public.visits newer WHERE newer.booking_id = NEW.id AND newer.version > v.version
      )
  ) THEN
    RAISE EXCEPTION 'accepted booking requires an actual scheduled visit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_acceptance_requires_visit
  AFTER INSERT OR UPDATE ON public.bookings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.forcare_booking_acceptance_requires_visit();

ALTER TABLE public.patient_access_grants
  ADD CONSTRAINT patient_access_grants_source_booking_fkey
    FOREIGN KEY (source_booking_id, patient_id)
    REFERENCES public.bookings (id, patient_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT patient_access_grants_source_visit_fkey
    FOREIGN KEY (source_visit_id, patient_id)
    REFERENCES public.visits (id, patient_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.forcare_patient_access_grant_source_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_nurse uuid;
BEGIN
  IF NEW.source_booking_id IS NOT NULL THEN
    SELECT nurse_id INTO selected_nurse FROM public.bookings WHERE id = NEW.source_booking_id;
  ELSE
    SELECT nurse_id INTO selected_nurse FROM public.visits WHERE id = NEW.source_visit_id;
  END IF;
  IF (NEW.source_booking_id IS NOT NULL OR NEW.source_visit_id IS NOT NULL)
     AND NEW.staff_id IS DISTINCT FROM selected_nurse THEN
    RAISE EXCEPTION 'access grant must belong to the source nurse' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_access_grants_source_guard
  BEFORE INSERT OR UPDATE ON public.patient_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.forcare_patient_access_grant_source_guard();
ALTER TABLE public.visits
  ADD CONSTRAINT visits_booking_identity_fkey
    FOREIGN KEY (booking_id, patient_id, nurse_id)
    REFERENCES public.bookings (id, patient_id, nurse_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.forcare_bookings_active_cap_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
BEGIN
  IF NEW.status NOT IN ('submitted', 'accepted') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('submitted', 'accepted')
    AND OLD.starts_at = NEW.starts_at AND OLD.ends_at = NEW.ends_at THEN
    RETURN NEW;
  END IF;
  IF NEW.starts_at <= now() OR NEW.ends_at <= now() THEN
    RAISE EXCEPTION 'active bookings require a future interval' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.patients WHERE id = NEW.patient_id FOR UPDATE;
  SELECT count(*) INTO active_count
  FROM public.bookings b
  WHERE b.patient_id = NEW.patient_id AND b.id <> NEW.id
    AND b.status IN ('submitted', 'accepted') AND b.ends_at > now();
  IF active_count >= 3 THEN
    RAISE EXCEPTION 'a patient may have at most three active booking requests' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_active_cap_guard
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.forcare_bookings_active_cap_guard();
