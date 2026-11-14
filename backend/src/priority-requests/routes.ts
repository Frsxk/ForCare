import { Elysia } from "elysia";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import type { AuthConfig } from "../config";
import { requestIdFor, successResponse } from "../http/errors";
import type { RateLimiters } from "../http/rate-limit";
import { parseLimit, parseStrict, readJsonObject, requireIdempotencyKey } from "../http/request";
import { priorityRequestCreateSchema, priorityRequestReviewSchema } from "./schemas";
import type { PriorityRequestService } from "./service";

type PriorityRequestRouteDeps = {
  auth: AuthService;
  priorityRequests: PriorityRequestService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function priorityRequestRoutes(deps: PriorityRequestRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  return new Elysia({ prefix: "/api/v1" })
    .post("/me/priority-requests", async ({ request }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(priorityRequestCreateSchema, await readJsonObject(request));
      const result = await deps.priorityRequests.createPriorityRequest(auth, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/me/priority-requests", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.priorityRequests.listOwnPriorityRequests(auth, {
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    })
    .get("/me/priority-requests/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(
        request,
        await deps.priorityRequests.getOwnPriorityRequest(auth, params.id),
      );
    })
    .get("/priority-requests", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.priorityRequests.listNursePriorityRequests(auth, {
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    })
    .get("/priority-requests/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(
        request,
        await deps.priorityRequests.getNursePriorityRequest(auth, params.id),
      );
    })
    .post("/priority-requests/:id/review", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(priorityRequestReviewSchema, await readJsonObject(request));
      const result = await deps.priorityRequests.reviewPriorityRequest(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    });
}
