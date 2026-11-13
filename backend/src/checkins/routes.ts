import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import { requestIdFor, successResponse } from "../http/errors";
import { parseLimit, parseStrict, readJsonObject, requireIdempotencyKey } from "../http/request";
import type { RateLimiters } from "../http/rate-limit";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import {
  checkInCreateSchema,
  checkInPatchSchema,
  checkInSubmitSchema,
  checkInUpdateSchema,
  observationConfirmSchema,
} from "./schemas";
import type { CheckInService } from "./service";

type CheckInRouteDeps = {
  auth: AuthService;
  checkins: CheckInService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function checkInRoutes(deps: CheckInRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  return new Elysia({ prefix: "/api/v1" })
    .post("/check-ins", async ({ request }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(checkInCreateSchema, await readJsonObject(request));
      const result = await deps.checkins.createCheckIn(auth, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/check-ins", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.checkins.listOwnCheckIns(auth, {
          status: url.searchParams.get("status"),
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    })
    .get("/check-ins/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.checkins.getCheckIn(auth, params.id));
    })
    .put("/check-ins/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(checkInUpdateSchema, await readJsonObject(request));
      const result = await deps.checkins.updateCheckIn(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
        method: "PUT",
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .patch("/check-ins/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(checkInPatchSchema, await readJsonObject(request));
      const result = await deps.checkins.updateCheckIn(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
        method: "PATCH",
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/check-ins/:id/submit", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(checkInSubmitSchema, await readJsonObject(request));
      const result = await deps.checkins.submitCheckIn(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/patients/:id/check-ins", async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.checkins.listPatientCheckIns(auth, params.id, {
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    })
    .get("/patients/:id/observations", async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.checkins.listObservations(auth, params.id, {
          type: url.searchParams.get("type"),
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    })
    .post("/observations/:id/confirm", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(observationConfirmSchema, await readJsonObject(request));
      const result = await deps.checkins.confirmObservation(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    });
}
