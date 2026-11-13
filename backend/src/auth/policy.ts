import type { AuthConfig } from "../config";
import { emailDomain } from "../http/request";

export type Role = "patient" | "nurse";

export type GrantBasis = "primary" | "request_intake" | "visit";

const GRANT_BASIS_SCOPES: ReadonlyArray<readonly [GrantBasis, string]> = [
  ["primary", "nurse:assigned"],
  ["request_intake", "nurse:request_intake"],
  ["visit", "nurse:visit"],
];

export type AuthContext = {
  sessionId: string;
  accountId: string;
  role: Role;
  email: string;
  displayName: string;
  displayTimeZone: string;
  patientId: string | null;
  staffId: string | null;
  staffCode: string | null;
  csrfToken: string;
  csrfHashHex: string;
  expiresAt: string;
};

export type PrincipalRow = {
  account_id: string;
  email_normalized: string;
  status: string;
  display_time_zone: string;
  role: string | null;
  staff_id: string | null;
  staff_code: string | null;
  staff_display_name: string | null;
  staff_active: boolean | null;
  identity_approval_ref: string | null;
  provisioning_email_domain: string | null;
  patient_id: string | null;
  patient_full_name: string | null;
};

export function nurseIdentityValid(row: PrincipalRow, config: AuthConfig): boolean {
  if (row.role !== "nurse" || !row.staff_id) return false;
  if (!config.nurseEmailDomain) return false;
  if (row.staff_active !== true) return false;
  if (!row.identity_approval_ref || row.identity_approval_ref.trim() === "") return false;
  if (row.provisioning_email_domain !== config.nurseEmailDomain) return false;
  return emailDomain(row.email_normalized) === config.nurseEmailDomain;
}

/**
 * Reports the directory plus only the scopes justified by the nurse's actual
 * active grant bases. Unknown or expired/revoked bases must not widen access.
 */
export function scopesForRole(role: Role, grantBases: readonly string[] = []): string[] {
  if (role === "patient") return ["patient:self"];
  const active = new Set(grantBases);
  const scopes = ["nurse:directory"];
  for (const [basis, scope] of GRANT_BASIS_SCOPES) {
    if (active.has(basis)) scopes.push(scope);
  }
  return scopes;
}
