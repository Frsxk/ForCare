import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import { requestIdFor, successResponse } from "../http/errors";
import { parseLimit, parseStrict, readJsonObject, requireIdempotencyKey } from "../http/request";
import type { RateLimiters } from "../http/rate-limit";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import { availabilityPublishSchema } from "./schemas";
import type { AvailabilityService } from "./service";

type AvailabilityRouteDeps = {
  auth: AuthService;
  availability: AvailabilityService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function availabilityRoutes(deps: AvailabilityRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  return new Elysia({ prefix: "/api/v1" })
    .get("/nurses/me/availability", async ({ request }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.availability.getOwnAvailability(auth));
    })
    .put("/nurses/me/availability", async ({ request }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(availabilityPublishSchema, await readJsonObject(request));
      const result = await deps.availability.publishOwnAvailability(auth, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/nurses/:nurseId/slots", async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.availability.listNurseSlots(auth, params.nurseId, {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    });
}
