import type { SQL } from "bun";
import { createApp } from "../../src/app";
import { createAssessmentService } from "../../src/assessments/service";
import { createAuthService } from "../../src/auth/service";
import { createAvailabilityService } from "../../src/availability/service";
import { createBookingService } from "../../src/bookings/service";
import { createCheckInService } from "../../src/checkins/service";
import type { AuthConfig } from "../../src/config";
import { createRateLimiters, type RateLimiters } from "../../src/http/rate-limit";
import { createClinicalService } from "../../src/clinical/service";
import { createPatientService } from "../../src/patients/service";
import { createPriorityRequestService } from "../../src/priority-requests/service";
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
  const clinical = createClinicalService({ sql, config });
  const checkins = createCheckInService({ sql, config });
  const assessments = createAssessmentService({ sql, config });
  const availability = createAvailabilityService({ sql, config });
  const bookings = createBookingService({ sql, config });
  const priorityRequests = createPriorityRequestService({ sql, config });
  const app = createApp(async () => {}, {
    auth,
    patients,
    clinical,
    checkins,
    assessments,
    availability,
    bookings,
    priorityRequests,
    config,
    rateLimiters,
    getClientIp: () => options.ip ?? "127.0.0.1",
  });
  return {
    app, auth, patients, clinical, checkins, assessments,
    availability, bookings, priorityRequests, config, rateLimiters,
  };
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
