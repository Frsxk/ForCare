-- 0001 identity (T04): accounts, account_roles, staff, sessions.
-- Auth behavior is T05. Patient records and operations are 0002 (T06).
-- Domain objects live in the public schema; vendor checkpoint schemas are not touched.

CREATE TABLE public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  display_time_zone text NOT NULL DEFAULT 'Asia/Jakarta',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_email_normalized_unique UNIQUE (email_normalized),
  CONSTRAINT accounts_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT accounts_email_normalized_check CHECK (
    email_normalized = lower(btrim(email_normalized))
    AND email_normalized <> ''
  )
);

CREATE TABLE public.account_roles (
  account_id uuid NOT NULL,
  role text NOT NULL,
  granted_by text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_roles_pkey PRIMARY KEY (account_id, role),
  CONSTRAINT account_roles_account_id_unique UNIQUE (account_id),
  CONSTRAINT account_roles_role_check CHECK (role IN ('patient', 'nurse')),
  CONSTRAINT account_roles_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts (id) ON DELETE RESTRICT
);

CREATE TABLE public.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  staff_code text NOT NULL,
  discipline text NOT NULL,
  display_name text NOT NULL,
  phone text,
  active boolean NOT NULL DEFAULT true,
  identity_approval_ref text NOT NULL,
  identity_approved_by text NOT NULL,
  identity_approved_at timestamptz NOT NULL,
  provisioning_email_domain text NOT NULL,
  domain_checked_at timestamptz NOT NULL,
  provisioned_by text NOT NULL,
  provisioned_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0,
  CONSTRAINT staff_account_id_unique UNIQUE (account_id),
  CONSTRAINT staff_staff_code_unique UNIQUE (staff_code),
  CONSTRAINT staff_discipline_check CHECK (discipline IN ('nurse')),
  CONSTRAINT staff_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts (id) ON DELETE RESTRICT
);

CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  csrf_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_id_account_id_unique UNIQUE (id, account_id),
  CONSTRAINT sessions_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts (id) ON DELETE CASCADE,
  CONSTRAINT sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX sessions_account_id_active_idx
  ON public.sessions (account_id)
  WHERE revoked_at IS NULL;
