import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import { successResponse } from "../http/errors";
import { parseLimit } from "../http/request";
import type { RateLimiters } from "../http/rate-limit";
import { enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import type { AssessmentService } from "./service";

type AssessmentRouteDeps = {
  auth: AuthService;
  assessments: AssessmentService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function assessmentRoutes(deps: AssessmentRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  return new Elysia({ prefix: "/api/v1" }).get(
    "/patients/:id/assessments",
    async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(
        request,
        await deps.assessments.getPatientAssessments(auth, params.id, {
          cursor: url.searchParams.get("cursor"),
          limit: parseLimit(url.searchParams.get("limit")),
        }),
      );
    },
  );
}
