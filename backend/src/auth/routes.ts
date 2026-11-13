import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import { AppError, noContentResponse, successResponse } from "../http/errors";
import { loginRateKey, type RateLimiters } from "../http/rate-limit";
import {
  normalizeEmail,
  parseStrict,
  readJsonObject,
  readOptionalJson,
} from "../http/request";
import { requestIdFor } from "../http/errors";
import { clearSessionCookie, csrfMatches, sessionCookie } from "./crypto";
import { loginSchema, logoutSchema, registrationSchema } from "./schemas";
import type { AuthContext } from "./policy";
import type { AuthService } from "./service";

type BunServerLike = {
  requestIP?: (request: Request) => { address: string } | null;
} | null;

export type ClientIpResolver = (request: Request, server: BunServerLike) => string | null;

type AuthRouteDeps = {
  auth: AuthService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

function resolveIp(
  request: Request,
  server: BunServerLike,
  resolver: ClientIpResolver | undefined,
): string | null {
  if (resolver) return resolver(request, server);
  return server?.requestIP?.(request)?.address ?? null;
}

export function enforceRate(limiter: RateLimiters["login"], key: string): void {
  const result = limiter.consume(key);
  if (!result.allowed) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many requests",
      429,
      undefined,
      result.retryAfterSeconds,
    );
  }
}

export function assertCsrf(request: Request, auth: AuthContext): void {
  const supplied = request.headers.get("x-csrf-token");
  if (!supplied || !csrfMatches(auth.csrfHashHex, supplied)) {
    throw new AppError("CSRF_INVALID", "CSRF token is invalid", 403);
  }
}

export function authRoutes(deps: AuthRouteDeps) {
  return new Elysia({ prefix: "/api/v1/auth" })
    .post("/register", async ({ request, server }) => {
      const input = parseStrict(registrationSchema, await readJsonObject(request));
      const ip = resolveIp(request, server as BunServerLike, deps.getClientIp);
      enforceRate(deps.rateLimiters.registration, ip ?? "unknown");
      const result = await deps.auth.register(input, {
        ip,
        userAgent: request.headers.get("user-agent"),
        requestId: requestIdFor(request),
      });
      const response = successResponse(request, result.data, 201);
      response.headers.append("set-cookie", sessionCookie(result.token));
      return response;
    })
    .post("/login", async ({ request, server }) => {
      const ip = resolveIp(request, server as BunServerLike, deps.getClientIp);
      enforceRate(deps.rateLimiters.loginIp, ip ?? "unknown");
      const input = parseStrict(loginSchema, await readJsonObject(request));
      enforceRate(deps.rateLimiters.login, loginRateKey(ip, normalizeEmail(input.email)));
      const result = await deps.auth.login(input, {
        ip,
        userAgent: request.headers.get("user-agent"),
        requestId: requestIdFor(request),
      });
      const response = successResponse(request, result.data);
      response.headers.append("set-cookie", sessionCookie(result.token));
      return response;
    })
    .get("/session", async ({ request }) => {
      const auth = await deps.auth.authenticate(request);
      enforceRate(deps.rateLimiters.authenticated, auth.accountId);
      return successResponse(request, await deps.auth.session(auth));
    })
    .post("/logout", async ({ request }) => {
      const auth = await deps.auth.authenticate(request);
      enforceRate(deps.rateLimiters.authenticated, auth.accountId);
      assertCsrf(request, auth);
      const body = parseStrict(logoutSchema, await readOptionalJson(request));
      await deps.auth.logout(auth, body, requestIdFor(request));
      const response = noContentResponse(request);
      response.headers.append("set-cookie", clearSessionCookie());
      return response;
    });
}
