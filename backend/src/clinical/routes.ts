import { Elysia } from "elysia";
import type { AuthConfig } from "../config";
import { requestIdFor, successResponse } from "../http/errors";
import { parseLimit, parseStrict, readJsonObject, requireIdempotencyKey } from "../http/request";
import type { RateLimiters } from "../http/rate-limit";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import {
  careOrderCreateSchema,
  careOrderPatchSchema,
  careOrderPublishSchema,
  clinicalSourceCreateSchema,
  clinicalSourcePatchSchema,
  medicalRecordCreateSchema,
  publishExpectedVersionSchema,
} from "./schemas";
import type { ClinicalService } from "./service";

type ClinicalRouteDeps = {
  auth: AuthService;
  clinical: ClinicalService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

export function clinicalRoutes(deps: ClinicalRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  return new Elysia({ prefix: "/api/v1" })
    .post("/patients/:id/medical-record-versions", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(medicalRecordCreateSchema, await readJsonObject(request));
      const result = await deps.clinical.createMedicalRecord(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/patients/:id/medical-record-versions", async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      const result = await deps.clinical.listMedicalRecords(auth, params.id, {
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      });
      return successResponse(request, result);
    })
    .get("/patients/:id/medical-record-versions/:versionId", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(
        request,
        await deps.clinical.getMedicalRecord(auth, params.id, params.versionId),
      );
    })
    .post("/clinical-sources", async ({ request }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(clinicalSourceCreateSchema, await readJsonObject(request));
      const result = await deps.clinical.createSource(auth, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/clinical-sources/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.clinical.getSource(auth, params.id));
    })
    .patch("/clinical-sources/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(clinicalSourcePatchSchema, await readJsonObject(request));
      const result = await deps.clinical.patchSource(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/clinical-sources/:id/publish", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(publishExpectedVersionSchema, await readJsonObject(request));
      const result = await deps.clinical.publishSource(auth, params.id, input.expectedVersion, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/orders", async ({ request }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(careOrderCreateSchema, await readJsonObject(request));
      const result = await deps.clinical.createOrder(auth, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .patch("/orders/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(careOrderPatchSchema, await readJsonObject(request));
      const result = await deps.clinical.patchOrder(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/orders/:id/publish", async ({ request, params }) => {
      const auth = await requireAuth(request);
      assertCsrf(request, auth);
      const input = parseStrict(careOrderPublishSchema, await readJsonObject(request));
      const result = await deps.clinical.publishOrder(auth, params.id, input, {
        requestId: requestIdFor(request),
        key: requireIdempotencyKey(request),
      });
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/orders/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.clinical.getOrder(auth, params.id));
    })
    .get("/patients/:id/orders", async ({ request, params }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      const result = await deps.clinical.listOrders(auth, params.id, {
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      });
      return successResponse(request, result);
    })
    .get("/patients/:id/care-guide", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.clinical.careGuide(auth, params.id));
    });
}
