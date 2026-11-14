import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import type { AuthService } from "../auth/service";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { RateLimiters } from "../http/rate-limit";
import { requestIdFor, successResponse } from "../http/errors";
import { parseStrict, readJsonObject, requireIdempotencyKey } from "../http/request";
import { analysisGenerateSchema, analysisListQuerySchema, analysisPublishSchema, analysisReviewSchema, analysisRevisionSchema } from "./schemas";
import type { AnalysisService } from "./service";

export function analysisRoutes(deps: {
  auth: AuthService; analysis: AnalysisService; config: AuthConfig;
  rateLimiters: RateLimiters; getClientIp?: ClientIpResolver;
}) {
  async function authenticate(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }
  const meta = (request: Request) => ({ requestId: requestIdFor(request), key: requireIdempotencyKey(request) });
  return new Elysia({ prefix: "/api/v1" })
    .post("/check-ins/:id/analyses", async ({ request, params }) => {
      const auth = await authenticate(request); assertCsrf(request, auth);
      const result = await deps.analysis.generate(auth, params.id, parseStrict(analysisGenerateSchema, await readJsonObject(request)), meta(request));
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/analysis-jobs/:id", async ({ request, params }) => {
      const auth = await authenticate(request);
      return successResponse(request, await deps.analysis.getJob(auth, params.id));
    })
    .get("/analyses", async ({ request }) => {
      const auth = await authenticate(request);
      const query = Object.fromEntries(new URL(request.url).searchParams);
      return successResponse(request, await deps.analysis.list(auth, parseStrict(analysisListQuerySchema, query)));
    })
    .get("/analyses/:id", async ({ request, params }) => {
      const auth = await authenticate(request);
      return successResponse(request, await deps.analysis.get(auth, params.id));
    })
    .post("/analyses/:id/revisions", async ({ request, params }) => {
      const auth = await authenticate(request); assertCsrf(request, auth);
      const result = await deps.analysis.revise(auth, params.id, parseStrict(analysisRevisionSchema, await readJsonObject(request)), meta(request));
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/analyses/:id/reviews", async ({ request, params }) => {
      const auth = await authenticate(request); assertCsrf(request, auth);
      const result = await deps.analysis.review(auth, params.id, parseStrict(analysisReviewSchema, await readJsonObject(request)), meta(request));
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/analyses/:id/publish", async ({ request, params }) => {
      const auth = await authenticate(request); assertCsrf(request, auth);
      const result = await deps.analysis.publish(auth, params.id, parseStrict(analysisPublishSchema, await readJsonObject(request)), meta(request));
      return successResponse(request, result.data, result.statusCode);
    });
}
