import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import type { AuthService } from "../auth/service";
import { assertCsrf, enforceRate } from "../auth/routes";
import { successResponse } from "../http/errors";
import type { RateLimiters } from "../http/rate-limit";
import { assertAllowedOrigin, parseStrict, readJsonObject } from "../http/request";
import { knowledgeSearchSchema } from "./schemas";
import type { KnowledgeService } from "./service";

export function knowledgeRoutes(deps: {
  auth: AuthService; knowledge: KnowledgeService; config: AuthConfig; rateLimiters: RateLimiters;
}) {
  return new Elysia({ prefix: "/api/v1/knowledge" }).post("/search", async ({ request }) => {
    assertAllowedOrigin(request, deps.config.allowedOrigins);
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    assertCsrf(request, auth);
    const input = parseStrict(knowledgeSearchSchema, await readJsonObject(request));
    return successResponse(request, await deps.knowledge.search(auth, input));
  });
}
