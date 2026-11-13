import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "__Host-forcare_session";
export const SESSION_TTL_MS = 24 * 60 * 60_000;

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sessionTokenHash(token: string): string {
  return sha256Hex(token);
}

// The CSRF value is recoverable on session GET because it is derived from the
// HttpOnly session token with a versioned domain separator. Only a second hash
// is stored, so neither the session token nor the CSRF value is in the database.
export function deriveCsrfToken(sessionToken: string): string {
  return createHash("sha256")
    .update("forcare:csrf:v1\0", "utf8")
    .update(sessionToken, "utf8")
    .digest("base64url");
}

export function csrfHashFromToken(csrfToken: string): string {
  return sha256Hex(`forcare:csrf-store:v1\0${csrfToken}`);
}

export function csrfMatches(storedHashHex: string, suppliedCsrf: string): boolean {
  const expected = Buffer.from(storedHashHex, "hex");
  const actual = Buffer.from(csrfHashFromToken(suppliedCsrf), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashIp(ip: string | null, secret: string): string | null {
  if (!ip) return null;
  return createHmac("sha256", secret).update(`forcare:ip:v1\0${ip}`).digest("hex");
}

export function isSessionToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
