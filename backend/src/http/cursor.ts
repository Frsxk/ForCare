import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";
import { isUuid } from "./request";

const CURSOR_TTL_MS = 15 * 60_000;
const MAX_CURSOR_LENGTH = 2048;

export type CursorBinding = {
  accountId: string;
  sessionId: string;
  scope: string;
  filterHash: string;
};

export type CursorAfter = { name: string; id: string };

type CursorPayload = {
  v: 1;
  a: string;
  s: string;
  sc: string;
  f: string;
  after: CursorAfter;
  exp: number;
};

export function hashFilter(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function encodeCursor(
  binding: CursorBinding,
  after: CursorAfter,
  secret: string,
  now = Date.now(),
): string {
  const payload: CursorPayload = {
    v: 1,
    a: binding.accountId,
    s: binding.sessionId,
    sc: binding.scope,
    f: binding.filterHash,
    after,
    exp: now + CURSOR_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signature(body, secret)}`;
}

export function decodeCursor(
  cursor: string,
  binding: CursorBinding,
  secret: string,
  now = Date.now(),
): CursorAfter {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }
  const [body, suppliedSignature, ...rest] = cursor.split(".");
  if (!body || !suppliedSignature || rest.length > 0) {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }

  const expected = Buffer.from(signature(body, secret), "utf8");
  const supplied = Buffer.from(suppliedSignature, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }

  if (
    payload.v !== 1 ||
    payload.a !== binding.accountId ||
    payload.s !== binding.sessionId ||
    payload.sc !== binding.scope ||
    payload.f !== binding.filterHash ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now ||
    typeof payload.after?.name !== "string" ||
    typeof payload.after?.id !== "string" ||
    !isUuid(payload.after.id)
  ) {
    throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
  }

  return { name: payload.after.name, id: payload.after.id };
}
