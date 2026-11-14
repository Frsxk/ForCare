import { describe, expect, test } from "bun:test";
import {
  createSessionToken,
  csrfHashFromToken,
  csrfMatches,
  deriveCsrfToken,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from "../src/auth/crypto";
import { loginSchema, registrationSchema } from "../src/auth/schemas";
import { scopesForRole } from "../src/auth/policy";
import { readAuthConfig } from "../src/config";
import {
  decodeCursor,
  encodeCursor,
  hashFilter,
} from "../src/http/cursor";
import { AppError } from "../src/http/errors";
import {
  canonicalRequestHash,
} from "../src/http/idempotency";
import { FixedWindowRateLimiter } from "../src/http/rate-limit";
import {
  assertAllowedOrigin,
  MAX_REQUEST_BODY_BYTES,
  parseLimit,
  parseStrict,
  readJsonObject,
  readOptionalJson,
} from "../src/http/request";

function registration(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "Synthetic Patient",
    birthDate: "1990-03-12",
    gender: "female",
    email: "person@example.com",
    phone: "+6281234567890",
    password: "min8chars",
    ...overrides,
  };
}

function appError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected an AppError");
}

async function appErrorAsync(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected an AppError");
}

describe("registration contract", () => {
  test("accepts exactly the approved patient fields", () => {
    expect(parseStrict(registrationSchema, registration()).email).toBe("person@example.com");
  });

  test("accepts only female or male as the registration gender", () => {
    for (const gender of ["female", "male"] as const) {
      expect(parseStrict(registrationSchema, registration({ gender })).gender).toBe(gender);
    }
    for (const gender of ["other", "undisclosed", "", null, 1]) {
      expect(appError(() => parseStrict(registrationSchema, registration({ gender }))).code).toBe(
        "VALIDATION_FAILED",
      );
    }
  });

  test("rejects a role selector as an unknown field", () => {
    expect(appError(() => parseStrict(registrationSchema, registration({ role: "nurse" }))).code).toBe(
      "UNKNOWN_FIELD",
    );
  });

  test("rejects unknown server-owned fields", () => {
    for (const field of ["id", "accountId", "patientId", "status", "version", "createdAt"]) {
      expect(appError(() => parseStrict(registrationSchema, registration({ [field]: "x" }))).code).toBe(
        "UNKNOWN_FIELD",
      );
    }
  });

  test("requires a real, non-future calendar birth date", () => {
    expect(appError(() => parseStrict(registrationSchema, registration({ birthDate: "1990-02-30" }))).code).toBe(
      "VALIDATION_FAILED",
    );
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 10);
    expect(appError(() => parseStrict(registrationSchema, registration({ birthDate: tomorrow }))).code).toBe(
      "VALIDATION_FAILED",
    );
  });

  test("bounds the password and normalizes email case and whitespace", () => {
    expect(appError(() => parseStrict(registrationSchema, registration({ password: "1234567" }))).code).toBe(
      "VALIDATION_FAILED",
    );
    expect(parseStrict(registrationSchema, registration({ password: "a".repeat(128) })).password).toHaveLength(128);
    expect(appError(() => parseStrict(registrationSchema, registration({ password: "a".repeat(129) }))).code).toBe(
      "VALIDATION_FAILED",
    );
    const parsed = parseStrict(registrationSchema, registration({ email: "  Person@Example.COM  " }));
    expect(parsed.email).toBe("person@example.com");
    expect(parseStrict(loginSchema, { email: "A@B.CO", password: "x" }).email).toBe("a@b.co");
  });
});

describe("grant scope reporting", () => {
  test("reports the directory plus exactly the real grant bases without widening", () => {
    expect(scopesForRole("nurse")).toEqual(["nurse:directory"]);
    expect(scopesForRole("nurse", [])).toEqual(["nurse:directory"]);
    expect(scopesForRole("nurse", ["request_intake"])).toEqual([
      "nurse:directory",
      "nurse:request_intake",
    ]);
    expect(scopesForRole("nurse", ["visit"])).toEqual(["nurse:directory", "nurse:visit"]);
    expect(scopesForRole("nurse", ["primary"])).toEqual(["nurse:directory", "nurse:assigned"]);
    expect(scopesForRole("nurse", ["visit", "primary", "request_intake"])).toEqual([
      "nurse:directory",
      "nurse:assigned",
      "nurse:request_intake",
      "nurse:visit",
    ]);
    expect(scopesForRole("nurse", ["unknown"])).toEqual(["nurse:directory"]);
    expect(scopesForRole("patient", ["primary"])).toEqual(["patient:self"]);
  });
});

describe("session cryptography and cookie", () => {
  test("derives a recoverable, domain-separated CSRF token and stores only its double hash", () => {
    const token = createSessionToken();
    expect(token).toHaveLength(43);
    const csrf = deriveCsrfToken(token);
    expect(csrf).not.toBe(token);
    expect(deriveCsrfToken(token)).toBe(csrf);
    expect(deriveCsrfToken(`${token}x`)).not.toBe(csrf);
    const stored = csrfHashFromToken(csrf);
    expect(stored).not.toBe(csrf);
    expect(csrfMatches(stored, csrf)).toBe(true);
    expect(csrfMatches(stored, deriveCsrfToken(`${token}x`))).toBe(false);
    expect(stored).toHaveLength(64);
  });

  test("uses the exact approved host-only secure cookie attributes", () => {
    const header = sessionCookie("token-value");
    expect(header).toStartWith(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });
});

describe("origin guard", () => {
  const allowed = ["https://app.example.test"];

  test("requires an exact allowed Origin on unsafe requests", () => {
    const unsafe = new Request("https://api.example.test/api/v1/auth/login", {
      method: "POST",
      headers: { origin: "https://app.example.test" },
    });
    expect(() => assertAllowedOrigin(unsafe, allowed)).not.toThrow();
    for (const origin of [null, "", "https://app.example.test.evil", "https://APP.example.test", "http://app.example.test"]) {
      const headers: Record<string, string> = origin === null ? {} : { origin };
      const request = new Request("https://api.example.test/api/v1/auth/login", { method: "POST", headers });
      expect(appError(() => assertAllowedOrigin(request, allowed)).code).toBe("ORIGIN_REJECTED");
    }
  });

  test("does not require Origin on reads", () => {
    expect(() =>
      assertAllowedOrigin(new Request("https://api.example.test/api/v1/capabilities"), allowed),
    ).not.toThrow();
  });
});

describe("rate limiter", () => {
  test("enforces a bounded fixed window and reports Retry-After seconds", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 15 * 60_000, now: () => now, maxKeys: 2 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.consume("ip|mail")).toEqual({ allowed: true });
    }
    const blocked = limiter.consume("ip|mail");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    now += 15 * 60_000;
    expect(limiter.consume("ip|mail")).toEqual({ allowed: true });
  });

  test("keeps the table bounded and stops admitting new keys at capacity", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1_000, now: () => now, maxKeys: 2 });
    expect(limiter.consume("a")).toEqual({ allowed: true });
    expect(limiter.consume("b")).toEqual({ allowed: true });
    expect(limiter.consume("c").allowed).toBe(false);
    now += 1_000;
    expect(limiter.consume("c")).toEqual({ allowed: true });
  });

  test("fails closed at capacity without evicting a live bucket", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60_000, now: () => now, maxKeys: 2 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.consume("victim")).toEqual({ allowed: true });
    }
    expect(limiter.consume("filler")).toEqual({ allowed: true });

    const denied = limiter.consume("new-attacker-key");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.consume("victim").allowed).toBe(false);

    now += 60_000;
    expect(limiter.consume("new-attacker-key")).toEqual({ allowed: true });
  });
});

describe("request body cap", () => {
  const loginBody = '{"email":"person@example.com","password":"min8chars"}';

  test("rejects a declared oversized body before parsing it", async () => {
    const request = new Request("https://api.example.test/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: loginBody,
    });
    const error = await appErrorAsync(() => readJsonObject(request));
    expect(error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });

  test("counts streamed chunks even when Content-Length is absent", async () => {
    const chunk = new Uint8Array(8 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("https://api.example.test/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
    });
    const error = await appErrorAsync(() => readJsonObject(request));
    expect(error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });

  test("accepts exactly the cap and applies it to optional logout JSON", async () => {
    const prefix = '{"pad":"';
    const suffix = '"}';
    const body = `${prefix}${"a".repeat(MAX_REQUEST_BODY_BYTES - prefix.length - suffix.length)}${suffix}`;
    expect(body.length).toBe(MAX_REQUEST_BODY_BYTES);
    const parsed = await readJsonObject(
      new Request("https://api.example.test/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(parsed.pad).toBe("a".repeat(MAX_REQUEST_BODY_BYTES - prefix.length - suffix.length));

    expect(await readOptionalJson(new Request("https://api.example.test/api/v1/auth/logout", { method: "POST" }))).toEqual({});
    const oversized = new Request("https://api.example.test/api/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
      body: "{}",
    });
    expect((await appErrorAsync(() => readOptionalJson(oversized))).code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("cursor and idempotency primitives", () => {
  const secret = "cursor-secret-at-least-32-characters-long";
  const binding = {
    accountId: "3f1c2a9e-7b1d-4c2e-9a3f-5d6e7f8091a2",
    sessionId: "8b22d7c1-2e3f-4a5b-8c6d-7e8f90123456",
    scope: "patients:assigned",
    filterHash: hashFilter("alice"),
  };

  test("binds opaque cursors to actor, session, scope and filter", () => {
    const after = { name: "Alice", id: "0c1d2e3f-4a5b-4c6d-8e7f-901234567890" };
    const cursor = encodeCursor(binding, after, secret);
    expect(cursor).not.toContain("Alice");
    expect(decodeCursor(cursor, binding, secret)).toEqual(after);
    for (const changed of [
      { ...binding, accountId: "11111111-1111-4111-8111-111111111111" },
      { ...binding, sessionId: "22222222-2222-4222-8222-222222222222" },
      { ...binding, scope: "nurses" },
      { ...binding, filterHash: hashFilter("bob") },
    ]) {
      expect(appError(() => decodeCursor(cursor, changed, secret)).code).toBe("VALIDATION_FAILED");
    }
    expect(appError(() => decodeCursor(`${cursor}x`, binding, secret)).code).toBe("VALIDATION_FAILED");
    expect(appError(() => decodeCursor(cursor, binding, secret, Date.now() + 16 * 60_000)).code).toBe(
      "VALIDATION_FAILED",
    );
  });

  test("hashes canonical request bodies independent of object key order", () => {
    expect(canonicalRequestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalRequestHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(canonicalRequestHash({ a: 1 })).not.toBe(canonicalRequestHash({ a: 2 }));
  });

  test("validates list limits", () => {
    expect(parseLimit(null)).toBe(20);
    expect(parseLimit("100")).toBe(100);
    for (const raw of ["0", "101", "-1", "1.5", "abc"]) {
      expect(appError(() => parseLimit(raw)).code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("auth configuration", () => {
  const base = {
    AUTH_ALLOWED_ORIGINS: "https://app.example.test",
    AUTH_NURSE_EMAIL_DOMAIN: "nurse.invalid",
    AUTH_SESSION_SECRET: "a".repeat(32),
  };

  test("accepts exact HTTPS origins in production", () => {
    const config = readAuthConfig(base, { hostname: "0.0.0.0" });
    expect(config.allowedOrigins).toEqual(["https://app.example.test"]);
    expect(config.cookieSecure).toBe(true);
    expect(config.localHttpTest).toBe(false);
    expect(readAuthConfig({ ...base, AUTH_NURSE_EMAIL_DOMAIN: "" }, { hostname: "0.0.0.0" }).nurseEmailDomain).toBeNull();
  });

  test("rejects HTTP production origins and guessed paths", () => {
    for (const origin of ["http://app.example.test", "https://app.example.test/login", "https://app.example.test/"]) {
      expect(() => readAuthConfig({ ...base, AUTH_ALLOWED_ORIGINS: origin }, { hostname: "0.0.0.0" })).toThrow(
        "AUTH_ALLOWED_ORIGINS",
      );
    }
  });

  test("permits loopback HTTP only through the explicit local test opt-in", () => {
    const local = readAuthConfig(
      {
        ...base,
        AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
        AUTH_LOCAL_HTTP_TEST: "true",
      },
      { hostname: "127.0.0.1" },
    );
    expect(local.localHttpTest).toBe(true);
    expect(() =>
      readAuthConfig(
        { ...base, AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:3000", AUTH_LOCAL_HTTP_TEST: "true" },
        { hostname: "0.0.0.0" },
      ),
    ).toThrow("loopback");
  });

  test("requires an exact configured session secret and domain", () => {
    expect(() => readAuthConfig({ ...base, AUTH_SESSION_SECRET: "short" }, { hostname: "0.0.0.0" })).toThrow(
      "AUTH_SESSION_SECRET",
    );
    expect(() => readAuthConfig({ ...base, AUTH_NURSE_EMAIL_DOMAIN: "not a domain" }, { hostname: "0.0.0.0" })).toThrow(
      "AUTH_NURSE_EMAIL_DOMAIN",
    );
  });
});
