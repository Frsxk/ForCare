import type { z } from "zod";
import { AppError } from "./errors";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_REQUEST_BODY_BYTES = 32 * 1024;
// The transport backstop may return a bare 413; ordinary oversized API bodies
// reach the smaller streaming limit and receive the JSON error envelope.
export const MAX_TRANSPORT_BODY_BYTES = 2 * MAX_REQUEST_BODY_BYTES;

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

export function isUuid(value: string): boolean {
  return UUID_V4.test(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

function bodyTooLarge(): AppError {
  return new AppError(
    "PAYLOAD_TOO_LARGE",
    `Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`,
    413,
  );
}

async function readLimitedText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    throw bodyTooLarge();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw bodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled or errored.
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await readLimitedText(request);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Request body must be valid JSON", 422);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_FAILED", "Request body must be a JSON object", 422);
  }
  return value as Record<string, unknown>;
}

export async function readOptionalJson(request: Request): Promise<unknown> {
  const raw = await readLimitedText(request);
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Request body must be valid JSON", 422);
  }
}

export function parseStrict<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const unknownKeys = result.error.issues
    .filter((issue) => issue.code === "unrecognized_keys")
    .flatMap((issue) => (issue as z.core.$ZodIssueUnrecognizedKeys).keys ?? [])
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 10);
  if (unknownKeys.length > 0) {
    throw new AppError(
      "UNKNOWN_FIELD",
      `Unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
      422,
    );
  }

  const paths = [...new Set(result.error.issues.map((issue) => issue.path.join(".")).filter(Boolean))]
    .slice(0, 10);
  throw new AppError(
    "VALIDATION_FAILED",
    paths.length > 0 ? `Invalid request: ${paths.join(", ")}` : "Invalid request",
    422,
  );
}

export function assertAllowedOrigin(request: Request, allowedOrigins: readonly string[]): void {
  if (!isUnsafeMethod(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new AppError("ORIGIN_REJECTED", "Request origin is not allowed", 403);
  }
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required", 400);
  }
  if (!(UUID_V4.test(key) || /^[A-Za-z0-9_-]{32,128}$/.test(key))) {
    throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is invalid", 400);
  }
  return key;
}

export function parseLimit(raw: string | null, fallback = 20, maximum = 100): number {
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new AppError("VALIDATION_FAILED", "Invalid request: limit", 422);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AppError("VALIDATION_FAILED", "Invalid request: limit", 422);
  }
  return value;
}
