import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "../http/audit";
import { AppError } from "../http/errors";
import { emailDomain } from "../http/request";
import { insertAccount, insertAccountRole } from "../auth/repository";

export type ProvisionNurseInput = {
  email: string;
  passwordHash: string;
  staffCode: string;
  displayName: string;
  approvalReference: string;
  operator: string;
  nurseDomain: string;
  requestId?: string;
};

/**
 * Provisions a nurse using the caller's transaction. This function does not
 * open its own transaction, so callers must pass a transaction-scoped handle.
 */
export async function provisionNurseInTransaction(
  sql: SQL,
  input: ProvisionNurseInput,
): Promise<{ accountId: string; staffId: string }> {
  if (!input.nurseDomain || emailDomain(input.email) !== input.nurseDomain) {
    throw new AppError("GATE_UNAVAILABLE", "Nurse email domain does not match the configured domain", 503, {
      gate: "G01",
    });
  }
  if (!input.approvalReference.trim() || !input.operator.trim()) {
    throw new AppError("GATE_UNAVAILABLE", "Approved staff identity evidence is required", 503, {
      gate: "G01",
    });
  }
  if (!input.staffCode.trim() || !input.displayName.trim()) {
    throw new AppError("VALIDATION_FAILED", "Invalid staff identity", 422);
  }

  const accountId = await insertAccount(sql, {
    email: input.email,
    passwordHash: input.passwordHash,
  });
  await insertAccountRole(sql, accountId, "nurse");
  const staffRows = (await sql`
    INSERT INTO public.staff (
      account_id, staff_code, discipline, display_name, active,
      identity_approval_ref, identity_approved_by, identity_approved_at,
      provisioning_email_domain, domain_checked_at, provisioned_by, provisioned_at
    )
    VALUES (
      ${accountId}, ${input.staffCode}, 'nurse', ${input.displayName}, true,
      ${input.approvalReference}, ${input.operator}, now(),
      ${input.nurseDomain}, now(), ${input.operator}, now()
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const staffId = staffRows[0].id;
  await writeAuditEvent(sql, {
    actorAccountId: null,
    action: "staff.provisioned",
    subjectType: "staff",
    subjectId: staffId,
    requestId: input.requestId ?? randomUUID(),
    after: {
      operator: input.operator,
      approvalReference: input.approvalReference,
      staffCode: input.staffCode,
    },
  });
  return { accountId, staffId };
}
