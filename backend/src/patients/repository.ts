import type { SQL } from "bun";

export type OwnPatientRow = {
  id: string;
  account_id: string;
  full_name: string;
  birth_date: string;
  gender: string;
  phone: string;
  address_line: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  record_number: string | null;
  version: number;
  primary_nurse_id: string | null;
  primary_nurse_display_name: string | null;
};

export type OwnStaffRow = {
  id: string;
  account_id: string;
  staff_code: string;
  display_name: string;
  discipline: string;
  phone: string | null;
  version: number;
  email_normalized: string;
  display_time_zone: string;
};

export type NurseDirectoryRow = {
  id: string;
  display_name: string;
  staff_code: string;
  active: boolean;
};

export type AssignedPatientRow = {
  id: string;
  full_name: string;
  record_number: string | null;
  version: number;
  birth_date: string;
  gender: string;
  primary_nurse_id: string | null;
  primary_nurse_display_name: string | null;
  expires_at: Date | string | null;
};

export async function readOwnPatient(sql: SQL, accountId: string): Promise<OwnPatientRow | null> {
  const rows = (await sql`
    SELECT p.id, p.account_id, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
           p.gender, p.phone, p.address_line, p.emergency_contact_name, p.emergency_contact_phone,
           p.record_number, p.version, p.primary_nurse_id,
           n.display_name AS primary_nurse_display_name
    FROM public.patients p
    LEFT JOIN public.staff n ON n.id = p.primary_nurse_id
    WHERE p.account_id = ${accountId}
    LIMIT 1
  `) as unknown as OwnPatientRow[];
  return rows[0] ?? null;
}

export async function readOwnPatientForUpdate(sql: SQL, accountId: string): Promise<OwnPatientRow | null> {
  const rows = (await sql`
    SELECT p.id, p.account_id, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
           p.gender, p.phone, p.address_line, p.emergency_contact_name, p.emergency_contact_phone,
           p.record_number, p.version, p.primary_nurse_id,
           n.display_name AS primary_nurse_display_name
    FROM public.patients p
    LEFT JOIN public.staff n ON n.id = p.primary_nurse_id
    WHERE p.account_id = ${accountId}
    FOR UPDATE OF p
  `) as unknown as OwnPatientRow[];
  return rows[0] ?? null;
}

export async function readOwnStaff(sql: SQL, accountId: string): Promise<OwnStaffRow | null> {
  const rows = (await sql`
    SELECT s.id, s.account_id, s.staff_code, s.display_name, s.discipline, s.phone, s.version,
           a.email_normalized, a.display_time_zone
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    WHERE s.account_id = ${accountId}
    LIMIT 1
  `) as unknown as OwnStaffRow[];
  return rows[0] ?? null;
}

export async function readOwnStaffForUpdate(sql: SQL, accountId: string): Promise<OwnStaffRow | null> {
  const rows = (await sql`
    SELECT s.id, s.account_id, s.staff_code, s.display_name, s.discipline, s.phone, s.version,
           a.email_normalized, a.display_time_zone
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    WHERE s.account_id = ${accountId}
    FOR UPDATE OF s
  `) as unknown as OwnStaffRow[];
  return rows[0] ?? null;
}

export async function updatePatientContact(
  sql: SQL,
  input: {
    patientId: string;
    phone: string;
    addressLine: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE public.patients
    SET phone = ${input.phone},
        address_line = ${input.addressLine},
        emergency_contact_name = ${input.emergencyContactName},
        emergency_contact_phone = ${input.emergencyContactPhone},
        version = version + 1,
        updated_at = now()
    WHERE id = ${input.patientId}
  `;
}

export async function updateStaffPhone(sql: SQL, staffId: string, phone: string | null): Promise<void> {
  await sql`
    UPDATE public.staff
    SET phone = ${phone}, version = version + 1
    WHERE id = ${staffId}
  `;
}

export async function listNurses(
  sql: SQL,
  input: {
    limit: number;
    afterName: string | null;
    afterId: string | null;
    nurseEmailDomain: string | null;
  },
): Promise<NurseDirectoryRow[]> {
  return (await sql`
    SELECT s.id, s.display_name, s.staff_code, s.active
    FROM public.staff s
    JOIN public.accounts a ON a.id = s.account_id
    JOIN public.account_roles r ON r.account_id = s.account_id AND r.role = 'nurse'
    WHERE s.active = true AND a.status = 'active'
      AND ${input.nurseEmailDomain}::text IS NOT NULL
      AND s.identity_approval_ref IS NOT NULL
      AND btrim(s.identity_approval_ref) <> ''
      AND s.provisioning_email_domain = ${input.nurseEmailDomain}::text
      AND split_part(a.email_normalized, '@', 2) = ${input.nurseEmailDomain}::text
      AND (
        ${input.afterName}::text IS NULL
        OR (lower(s.display_name), s.id) > (${input.afterName}, ${input.afterId}::uuid)
      )
    ORDER BY lower(s.display_name), s.id
    LIMIT ${input.limit + 1}
  `) as unknown as NurseDirectoryRow[];
}

export async function listAssignedPatients(
  sql: SQL,
  input: {
    staffId: string;
    search: string;
    limit: number;
    afterName: string | null;
    afterId: string | null;
  },
): Promise<Array<{ id: string; full_name: string; record_number: string | null }>> {
  return (await sql`
    SELECT p.id, p.full_name, p.record_number
    FROM public.patients p
    JOIN public.patient_access_grants g ON g.patient_id = p.id
    WHERE g.staff_id = ${input.staffId}
      AND g.basis = 'primary'
      AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > now())
      AND (
        ${input.search} = ''
        OR strpos(lower(p.full_name), ${input.search}) > 0
        OR strpos(lower(coalesce(p.record_number, '')), ${input.search}) > 0
      )
      AND (
        ${input.afterName}::text IS NULL
        OR (lower(p.full_name), p.id) > (${input.afterName}, ${input.afterId}::uuid)
      )
    ORDER BY lower(p.full_name), p.id
    LIMIT ${input.limit + 1}
  `) as unknown as Array<{ id: string; full_name: string; record_number: string | null }>;
}

export async function readAssignedPatient(
  sql: SQL,
  staffId: string,
  patientId: string,
): Promise<AssignedPatientRow | null> {
  const rows = (await sql`
    SELECT p.id, p.full_name, p.record_number, p.version,
           to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, p.gender,
           p.primary_nurse_id, n.display_name AS primary_nurse_display_name,
           g.expires_at
    FROM public.patients p
    JOIN public.patient_access_grants g ON g.patient_id = p.id
    LEFT JOIN public.staff n ON n.id = p.primary_nurse_id
    WHERE p.id = ${patientId}
      AND g.staff_id = ${staffId}
      AND g.basis = 'primary'
      AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > now())
    ORDER BY g.granted_at
    LIMIT 1
  `) as unknown as AssignedPatientRow[];
  return rows[0] ?? null;
}
