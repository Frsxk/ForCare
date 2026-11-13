import type { SQL } from "bun";
import type { AuthContext } from "../auth/policy";
import { AppError } from "../http/errors";
import { isUuid } from "../http/request";

export type ScopedPatient = {
  id: string;
  primary_nurse_id: string | null;
};

async function readPrimaryPatient(
  sql: SQL,
  staffId: string,
  patientId: string,
): Promise<ScopedPatient | null> {
  const rows = (await sql`
    SELECT p.id, p.primary_nurse_id
    FROM public.patients p
    JOIN public.patient_access_grants g ON g.patient_id = p.id
    WHERE p.id = ${patientId}
      AND p.primary_nurse_id = ${staffId}
      AND g.staff_id = ${staffId}
      AND g.basis = 'primary'
      AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > now())
    ORDER BY g.granted_at DESC
    LIMIT 1
  `) as unknown as ScopedPatient[];
  return rows[0] ?? null;
}

/**
 * Requires the authenticated actor to be the patient's current primary nurse
 * with an active primary grant. Intake/visit grants never widen this scope.
 * Pass a transaction handle for write paths so the grant is rechecked while
 * the patient row is locked.
 */
export async function requirePrimaryScope(
  sql: SQL,
  auth: AuthContext,
  patientId: string,
): Promise<ScopedPatient> {
  if (auth.role !== "nurse" || !auth.staffId) {
    throw new AppError("FORBIDDEN", "Primary nurse access is required", 403);
  }
  if (!isUuid(patientId)) throw new AppError("NOT_FOUND", "Patient not found", 404);
  const patient = await readPrimaryPatient(sql, auth.staffId, patientId);
  if (!patient) throw new AppError("NOT_FOUND", "Patient not found", 404);
  return patient;
}

/**
 * Enables a patient to read only their own patient-facing projection, or the
 * current primary nurse to read it. Raw clinical sources never use this helper.
 */
export async function requireSelfOrPrimaryScope(
  sql: SQL,
  auth: AuthContext,
  patientId: string,
): Promise<ScopedPatient> {
  if (auth.role === "patient") {
    if (!isUuid(patientId) || auth.patientId !== patientId) {
      throw new AppError("NOT_FOUND", "Patient not found", 404);
    }
    return { id: patientId, primary_nurse_id: null };
  }
  return requirePrimaryScope(sql, auth, patientId);
}
