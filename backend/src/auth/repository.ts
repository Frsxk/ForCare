import type { SQL } from "bun";
import type { PrincipalRow } from "./policy";

export type LoginAccountRow = {
  account_id: string;
  email_normalized: string;
  password_hash: string;
  status: string;
  display_time_zone: string;
  role: string | null;
  staff_id: string | null;
  staff_active: boolean | null;
  identity_approval_ref: string | null;
  provisioning_email_domain: string | null;
};

export type SessionRow = {
  id: string;
  account_id: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  csrf_hash_hex: string;
};

export async function findLoginAccount(sql: SQL, email: string): Promise<LoginAccountRow | null> {
  const rows = (await sql`
    SELECT a.id AS account_id, a.email_normalized, a.password_hash, a.status, a.display_time_zone,
           r.role,
           s.id AS staff_id, s.active AS staff_active,
           s.identity_approval_ref, s.provisioning_email_domain
    FROM public.accounts a
    LEFT JOIN public.account_roles r ON r.account_id = a.id
    LEFT JOIN public.staff s ON s.account_id = a.id
    WHERE a.email_normalized = ${email}
    LIMIT 1
  `) as unknown as LoginAccountRow[];
  return rows[0] ?? null;
}

export async function findSessionByTokenHash(sql: SQL, tokenHashHex: string): Promise<SessionRow | null> {
  const rows = (await sql`
    SELECT id, account_id, expires_at, revoked_at, encode(csrf_hash, 'hex') AS csrf_hash_hex
    FROM public.sessions
    WHERE token_hash = decode(${tokenHashHex}, 'hex')
    LIMIT 1
  `) as unknown as SessionRow[];
  return rows[0] ?? null;
}

export async function loadPrincipal(sql: SQL, accountId: string): Promise<PrincipalRow | null> {
  const rows = (await sql`
    SELECT a.id AS account_id, a.email_normalized, a.status, a.display_time_zone,
           r.role,
           s.id AS staff_id, s.staff_code, s.display_name AS staff_display_name,
           s.active AS staff_active, s.identity_approval_ref, s.provisioning_email_domain,
           p.id AS patient_id, p.full_name AS patient_full_name
    FROM public.accounts a
    LEFT JOIN public.account_roles r ON r.account_id = a.id
    LEFT JOIN public.staff s ON s.account_id = a.id
    LEFT JOIN public.patients p ON p.account_id = a.id
    WHERE a.id = ${accountId}
    LIMIT 1
  `) as unknown as PrincipalRow[];
  return rows[0] ?? null;
}

export async function insertAccount(
  sql: SQL,
  input: { email: string; passwordHash: string },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO public.accounts (email_normalized, password_hash, status)
    VALUES (${input.email}, ${input.passwordHash}, 'active')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

export async function insertAccountRole(sql: SQL, accountId: string, role: "patient" | "nurse"): Promise<void> {
  await sql`
    INSERT INTO public.account_roles (account_id, role, granted_by)
    VALUES (${accountId}, ${role}, 'server')
  `;
}

export async function insertPatientProfile(
  sql: SQL,
  input: {
    accountId: string;
    fullName: string;
    birthDate: string;
    gender: string;
    phone: string;
  },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO public.patients (account_id, full_name, birth_date, gender, phone)
    VALUES (${input.accountId}, ${input.fullName}, ${input.birthDate}::date, ${input.gender}, ${input.phone})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

export async function insertSession(
  sql: SQL,
  input: {
    accountId: string;
    tokenHashHex: string;
    csrfHashHex: string;
    expiresAt: Date;
    ipHash: string | null;
    userAgent: string | null;
  },
): Promise<{ id: string; expiresAt: string }> {
  const rows = (await sql`
    INSERT INTO public.sessions (account_id, token_hash, csrf_hash, expires_at, ip_hash, user_agent)
    VALUES (
      ${input.accountId}, decode(${input.tokenHashHex}, 'hex'), decode(${input.csrfHashHex}, 'hex'),
      ${input.expiresAt}, ${input.ipHash}, ${input.userAgent}
    )
    RETURNING id, expires_at
  `) as unknown as Array<{ id: string; expires_at: Date | string }>;
  return { id: rows[0].id, expiresAt: new Date(rows[0].expires_at).toISOString() };
}

export async function revokeSession(sql: SQL, sessionId: string, accountId: string): Promise<void> {
  await sql`
    UPDATE public.sessions
    SET revoked_at = now()
    WHERE id = ${sessionId} AND account_id = ${accountId} AND revoked_at IS NULL
  `;
}

export async function touchSession(sql: SQL, sessionId: string): Promise<void> {
  await sql`UPDATE public.sessions SET last_seen_at = now() WHERE id = ${sessionId}`;
}

export type AccessGrantRow = {
  patient_id: string;
  basis: string;
  expires_at: Date | string | null;
};

export async function listActiveAccessGrants(sql: SQL, staffId: string): Promise<AccessGrantRow[]> {
  return (await sql`
    SELECT patient_id, basis, expires_at
    FROM public.patient_access_grants
    WHERE staff_id = ${staffId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY granted_at, id
  `) as unknown as AccessGrantRow[];
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: string; errno?: string };
  return record.code === "23505" || record.errno === "23505";
}
