import type { SQL } from "bun";
import { createApp } from "../../src/app";
import { createAuthService } from "../../src/auth/service";
import type { AuthConfig } from "../../src/config";
import { createRateLimiters, type RateLimiters } from "../../src/http/rate-limit";
import { createPatientService } from "../../src/patients/service";
import { testAuthConfig } from "./disposable-database";

export const TEST_ORIGIN = "http://127.0.0.1:3000";

export function createTestApp(
  sql: SQL,
  options: { ip?: string; config?: AuthConfig; rateLimiters?: Partial<RateLimiters> } = {},
) {
  const config = options.config ?? testAuthConfig();
  const rateLimiters = createRateLimiters(options.rateLimiters);
  const auth = createAuthService({ sql, config });
  const patients = createPatientService({ sql, config });
  const app = createApp(async () => {}, {
    auth,
    patients,
    config,
    rateLimiters,
    getClientIp: () => options.ip ?? "127.0.0.1",
  });
  return { app, auth, patients, config, rateLimiters };
}

export function jsonRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function request(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: method === "GET" ? headers : { origin: TEST_ORIGIN, ...headers },
  });
}

export function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("response did not set a session cookie");
  return setCookie.split(";")[0];
}
