import { Elysia } from "elysia";
import type { AuthConfig } from "./config";
import { authRoutes, type ClientIpResolver } from "./auth/routes";
import type { AuthService } from "./auth/service";
import { AppError, isApiPath, toErrorResponse } from "./http/errors";
import { createRateLimiters, type RateLimiters } from "./http/rate-limit";
import { assertAllowedOrigin } from "./http/request";
import { patientRoutes } from "./patients/routes";
import type { PatientService } from "./patients/service";

export type AppServices = {
  auth?: AuthService;
  patients?: PatientService;
  config?: AuthConfig;
  rateLimiters?: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function createApp(checkDatabase: () => Promise<void>, services: AppServices = {}) {
  const app = new Elysia()
    .onRequest(({ request }) => {
      if (!services.config || !isApiPath(request)) return;
      try {
        assertAllowedOrigin(request, services.config.allowedOrigins);
      } catch (error) {
        return toErrorResponse(request, error);
      }
    })
    .onError(({ error, request }) => toErrorResponse(request, error))
    .get("/", () => "Hello Elysia")
    .get("/health/live", () => ({ status: "ok", service: "forcare-backend" }))
    .get("/health/ready", async ({ status }) => {
      try {
        await checkDatabase();
        return { status: "ready", service: "forcare-backend" };
      } catch {
        return status(503, { status: "unavailable", service: "forcare-backend" });
      }
    });

  if (services.auth && services.patients && services.config) {
    const rateLimiters = services.rateLimiters ?? createRateLimiters();
    app.use(
      authRoutes({
        auth: services.auth,
        config: services.config,
        rateLimiters,
        getClientIp: services.getClientIp,
      }),
    );
    app.use(
      patientRoutes({
        auth: services.auth,
        patients: services.patients,
        config: services.config,
        rateLimiters,
        getClientIp: services.getClientIp,
      }),
    );
  }

  return app;
}
