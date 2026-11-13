import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import { capabilitySnapshot } from "../capabilities";
import { requestIdFor, successResponse } from "../http/errors";
import type { RateLimiters } from "../http/rate-limit";
import {
  parseLimit,
  parseStrict,
  readJsonObject,
  requireIdempotencyKey,
} from "../http/request";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import type { PatientService } from "./service";
import { nurseProfilePatchSchema, patientProfilePatchSchema } from "./schemas";

type PatientRouteDeps = {
  auth: AuthService;
  patients: PatientService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function patientRoutes(deps: PatientRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  return new Elysia({ prefix: "/api/v1" })
    .get("/me/profile", async ({ request }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.patients.getOwnProfile(auth));
    })
    .patch("/me/profile", async ({ request }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const key = requireIdempotencyKey(request);
      const body = await readJsonObject(request);
      const input =
        auth.role === "patient"
          ? parseStrict(patientProfilePatchSchema, body)
          : parseStrict(nurseProfilePatchSchema, body);
      const result = await deps.patients.patchOwnProfile(auth, input, {
        requestId: requestIdFor(request),
        key,
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/me/access", async ({ request }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.patients.getAccess(auth));
    })
    .get("/capabilities", async ({ request }) => {
      await requireAuth(request);
      return successResponse(request, capabilitySnapshot());
    })
    .get("/nurses", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      const result = await deps.patients.listNurses(auth, {
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      });
      return successResponse(request, result);
    })
    .get("/patients", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      const result = await deps.patients.listPatients(auth, {
        scope: url.searchParams.get("scope"),
        search: url.searchParams.get("search") ?? "",
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      });
      return successResponse(request, result);
    })
    .get("/patients/:id/summary", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.patients.getSummary(auth, params.id));
    })
    .get("/patients/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.patients.getDetail(auth, params.id, url.searchParams.get("scope")),
      );
    });
}
