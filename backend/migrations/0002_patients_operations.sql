-- 0002 patients and operations (T06): owned patient profiles, access grants,
-- redacted audit events, actor/session-scoped idempotency receipts, work items
-- and transactional outbox. No clinical tables or clinical defaults belong here.

CREATE TABLE public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  full_name text NOT NULL,
  birth_date date NOT NULL,
  gender text NOT NULL,
  phone text NOT NULL,
  address_line text,
  emergency_contact_name text,
  emergency_contact_phone text,
  insurance_provider text,
  insurance_status text,
  nik_encrypted bytea,
  record_number text,
  primary_nurse_id uuid,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patients_account_id_unique UNIQUE (account_id),
  CONSTRAINT patients_record_number_unique UNIQUE (record_number),
  CONSTRAINT patients_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts (id) ON DELETE RESTRICT,
  CONSTRAINT patients_primary_nurse_id_fkey
    FOREIGN KEY (primary_nurse_id) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT patients_gender_check CHECK (gender IN ('male', 'female', 'other', 'undisclosed')),
  CONSTRAINT patients_full_name_check CHECK (btrim(full_name) <> ''),
  CONSTRAINT patients_phone_check CHECK (btrim(phone) <> ''),
  CONSTRAINT patients_version_check CHECK (version >= 0),
  CONSTRAINT patients_record_number_check CHECK (
    record_number IS NULL OR btrim(record_number) <> ''
  )
);

CREATE INDEX patients_primary_nurse_id_idx ON public.patients (primary_nurse_id);

CREATE TABLE public.patient_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  basis text NOT NULL,
  source_booking_id uuid,
  source_visit_id uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT patient_access_grants_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT patient_access_grants_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT patient_access_grants_basis_check CHECK (basis IN ('primary', 'request_intake', 'visit')),
  CONSTRAINT patient_access_grants_source_check CHECK (
    (basis = 'primary' AND source_booking_id IS NULL AND source_visit_id IS NULL)
    OR (basis = 'request_intake' AND source_booking_id IS NOT NULL AND source_visit_id IS NULL)
    OR (basis = 'visit' AND source_booking_id IS NULL AND source_visit_id IS NOT NULL)
  ),
  CONSTRAINT patient_access_grants_expiry_check CHECK (
    expires_at IS NULL OR expires_at > granted_at
  )
);

CREATE INDEX patient_access_grants_staff_patient_active_idx
  ON public.patient_access_grants (staff_id, patient_id)
  WHERE revoked_at IS NULL;

-- NULLS NOT DISTINCT keeps a single active primary grant per staff/patient even
-- though both polymorphic source columns are null for that basis.
CREATE UNIQUE INDEX patient_access_grants_active_unique_idx
  ON public.patient_access_grants (
    staff_id,
    patient_id,
    basis,
    COALESCE(source_booking_id, source_visit_id)
  ) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_account_id uuid,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  before jsonb,
  after jsonb,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_actor_account_id_fkey
    FOREIGN KEY (actor_account_id) REFERENCES public.accounts (id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_action_check CHECK (btrim(action) <> ''),
  CONSTRAINT audit_events_subject_type_check CHECK (btrim(subject_type) <> '')
);

CREATE INDEX audit_events_subject_idx ON public.audit_events (subject_type, subject_id, created_at DESC);
CREATE INDEX audit_events_actor_idx ON public.audit_events (actor_account_id, created_at DESC);

CREATE FUNCTION public.forcare_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_audit_mutation();

CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_audit_mutation();

CREATE TABLE public.idempotency_keys (
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  method text NOT NULL,
  resource_key text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_pkey
    PRIMARY KEY (account_id, session_id, method, resource_key, key),
  CONSTRAINT idempotency_keys_session_account_fkey
    FOREIGN KEY (session_id, account_id)
    REFERENCES public.sessions (id, account_id) ON DELETE CASCADE,
  CONSTRAINT idempotency_keys_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT idempotency_keys_status_check CHECK (status_code >= 100 AND status_code <= 599),
  CONSTRAINT idempotency_keys_method_check CHECK (btrim(method) <> ''),
  CONSTRAINT idempotency_keys_resource_check CHECK (btrim(resource_key) <> ''),
  CONSTRAINT idempotency_keys_key_check CHECK (btrim(key) <> '')
);

CREATE INDEX idempotency_keys_expires_at_idx ON public.idempotency_keys (expires_at);

CREATE TABLE public.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  patient_id uuid,
  staff_id uuid,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open',
  ref_type text NOT NULL,
  ref_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_items_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients (id) ON DELETE RESTRICT,
  CONSTRAINT work_items_staff_id_fkey
    FOREIGN KEY (staff_id) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT work_items_state_check CHECK (state IN ('open', 'done', 'cancelled')),
  CONSTRAINT work_items_kind_check CHECK (btrim(kind) <> ''),
  CONSTRAINT work_items_ref_check CHECK (btrim(ref_type) <> '')
);

CREATE INDEX work_items_state_due_idx ON public.work_items (state, due_at);

CREATE TABLE public.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0),
  CONSTRAINT outbox_events_aggregate_type_check CHECK (btrim(aggregate_type) <> ''),
  CONSTRAINT outbox_events_event_type_check CHECK (btrim(event_type) <> '')
);

CREATE UNIQUE INDEX outbox_events_version_unique_idx
  ON public.outbox_events (
    aggregate_type,
    aggregate_id,
    event_type,
    (payload ->> 'version')
  );

CREATE INDEX outbox_events_pending_idx
  ON public.outbox_events (processed_at, available_at);
