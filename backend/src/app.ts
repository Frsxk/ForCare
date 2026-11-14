import { Elysia } from "elysia";
import type { AuthConfig } from "./config";
import { authRoutes, type ClientIpResolver } from "./auth/routes";
import type { AuthService } from "./auth/service";
import { assessmentRoutes } from "./assessments/routes";
import type { AssessmentService } from "./assessments/service";
import { checkInRoutes } from "./checkins/routes";
import type { CheckInService } from "./checkins/service";
import { clinicalRoutes } from "./clinical/routes";
import type { ClinicalService } from "./clinical/service";
import { AppError, isApiPath, toErrorResponse } from "./http/errors";
import { createRateLimiters, type RateLimiters } from "./http/rate-limit";
import { assertAllowedOrigin } from "./http/request";
import { patientRoutes } from "./patients/routes";
import type { PatientService } from "./patients/service";
import { analysisRoutes } from "./analysis/routes";
import type { AnalysisService } from "./analysis/service";
import { knowledgeRoutes } from "./knowledge/routes";
import type { KnowledgeService } from "./knowledge/service";

export type AppServices = {
  auth?: AuthService;
  patients?: PatientService;
  clinical?: ClinicalService;
  checkins?: CheckInService;
  assessments?: AssessmentService;
  analysis?: AnalysisService;
  knowledge?: KnowledgeService;
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

  const rateLimiters = services.rateLimiters ?? createRateLimiters();
  if (services.auth && services.patients && services.config) {
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
  if (services.auth && services.clinical && services.config) {
    app.use(
      clinicalRoutes({
        auth: services.auth,
        clinical: services.clinical,
        config: services.config,
        rateLimiters,
        getClientIp: services.getClientIp,
      }),
    );
  }
  if (services.auth && services.checkins && services.config) {
    app.use(
      checkInRoutes({
        auth: services.auth,
        checkins: services.checkins,
        config: services.config,
        rateLimiters,
        getClientIp: services.getClientIp,
      }),
    );
  }
  if (services.auth && services.assessments && services.config) {
    app.use(
      assessmentRoutes({
        auth: services.auth,
        assessments: services.assessments,
        config: services.config,
        rateLimiters,
        getClientIp: services.getClientIp,
      }),
    );
  }
  if (services.auth && services.knowledge && services.config) {
    app.use(knowledgeRoutes({
      auth: services.auth, knowledge: services.knowledge, config: services.config, rateLimiters,
    }));
  }
  if (services.auth && services.analysis && services.config) {
    app.use(analysisRoutes({
      auth: services.auth, analysis: services.analysis, config: services.config,
      rateLimiters, getClientIp: services.getClientIp,
    }));
  }

  return app;
}
