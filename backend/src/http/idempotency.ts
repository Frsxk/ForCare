import type { SQL } from "bun";
import { createHash } from "node:crypto";

const RECEIPT_TTL_MS = 24 * 60 * 60_000;

export type IdempotencyScope = {
  accountId: string;
  sessionId: string;
  method: string;
  resourceKey: string;
  key: string;
  requestHash: string;
};

export type IdempotencyReceipt = {
  requestHash: string;
  statusCode: number;
  response: unknown;
};

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

export function canonicalRequestHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function receiptResourceKey(method: string, path: string, resourceId?: string): string {
  return `${method.toUpperCase()} ${path}${resourceId ? `/${resourceId}` : ""}`;
}

type ReceiptRow = {
  request_hash: string;
  status_code: number;
  response_json: unknown;
  expires_at: Date | string;
};

export async function findIdempotencyReceipt(
  sql: SQL,
  scope: IdempotencyScope,
): Promise<IdempotencyReceipt | null> {
  const rows = (await sql`
    SELECT request_hash, status_code, response_json, expires_at
    FROM public.idempotency_keys
    WHERE account_id = ${scope.accountId}
      AND session_id = ${scope.sessionId}
      AND method = ${scope.method}
      AND resource_key = ${scope.resourceKey}
      AND key = ${scope.key}
    LIMIT 1
  `) as unknown as ReceiptRow[];
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await sql`
      DELETE FROM public.idempotency_keys
      WHERE account_id = ${scope.accountId}
        AND session_id = ${scope.sessionId}
        AND method = ${scope.method}
        AND resource_key = ${scope.resourceKey}
        AND key = ${scope.key}
    `;
    return null;
  }
  const response =
    typeof row.response_json === "string" ? (JSON.parse(row.response_json) as unknown) : row.response_json;
  return { requestHash: row.request_hash, statusCode: row.status_code, response };
}

export async function storeIdempotencyReceipt(
  sql: SQL,
  scope: IdempotencyScope,
  statusCode: number,
  response: unknown,
): Promise<void> {
  const expiresAt = new Date(Date.now() + RECEIPT_TTL_MS);
  await sql`
    INSERT INTO public.idempotency_keys (
      account_id, session_id, method, resource_key, key,
      request_hash, status_code, response_json, expires_at
    )
    VALUES (
      ${scope.accountId}, ${scope.sessionId}, ${scope.method}, ${scope.resourceKey}, ${scope.key},
      ${scope.requestHash}, ${statusCode}, (${JSON.stringify(response)}::text)::jsonb, ${expiresAt}
    )
    ON CONFLICT (account_id, session_id, method, resource_key, key) DO NOTHING
  `;
}

export async function lockIdempotencyScope(sql: SQL, scope: IdempotencyScope): Promise<void> {
  const lockKey = `${scope.accountId}|${scope.sessionId}|${scope.method}|${scope.resourceKey}|${scope.key}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}
