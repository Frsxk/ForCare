import type { SQL } from "bun";

export type AuditInput = {
  actorAccountId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  requestId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export async function writeAuditEvent(sql: SQL, input: AuditInput): Promise<void> {
  await sql`
    INSERT INTO public.audit_events (
      actor_account_id, action, subject_type, subject_id, before, after, request_id
    )
    VALUES (
      ${input.actorAccountId}, ${input.action}, ${input.subjectType}, ${input.subjectId},
      (${input.before === undefined || input.before === null ? null : JSON.stringify(input.before)}::text)::jsonb,
      (${input.after === undefined || input.after === null ? null : JSON.stringify(input.after)}::text)::jsonb,
      ${input.requestId}
    )
  `;
}

export type OutboxInput = {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export async function writeOutboxEvent(sql: SQL, input: OutboxInput): Promise<void> {
  await sql`
    INSERT INTO public.outbox_events (
      aggregate_type, aggregate_id, event_type, payload
    )
    VALUES (
      ${input.aggregateType}, ${input.aggregateId}, ${input.eventType},
      (${JSON.stringify(input.payload)}::text)::jsonb
    )
  `;
}
