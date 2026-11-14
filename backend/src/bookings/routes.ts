import { Elysia } from "elysia";
import { z } from "zod";
import type { AuthConfig } from "../config";
import { assertCsrf, enforceRate, type ClientIpResolver } from "../auth/routes";
import type { AuthService } from "../auth/service";
import { AppError, requestIdFor, successResponse } from "../http/errors";
import { isoUtcSchema } from "../checkins/schemas";
import type { RateLimiters } from "../http/rate-limit";
import { parseLimit, parseStrict, readJsonObject, requireIdempotencyKey } from "../http/request";
import { bookingCancelSchema, bookingCreateSchema, bookingDecisionSchema, bookingPatchSchema, bookingRescheduleSchema, bookingVersionSchema } from "./schemas";
import type { BookingService } from "./service";

export type BookingRouteDeps = {
  auth: AuthService;
  bookings: BookingService;
  config: AuthConfig;
  rateLimiters: RateLimiters;
  getClientIp?: ClientIpResolver;
};

const scheduleRangeSchema = z.object({ from: isoUtcSchema, to: isoUtcSchema }).strict();

function scheduleRange(from: string | null, to: string | null): { from: string; to: string } {
  if (!from || !to) throw new AppError("VALIDATION_FAILED", "from and to are required", 422);
  const range = parseStrict(scheduleRangeSchema, { from, to });
  const start = new Date(range.from).getTime();
  const end = new Date(range.to).getTime();
  if (!(end > start) || end - start > 31 * 24 * 60 * 60_000) {
    throw new AppError("VALIDATION_FAILED", "Schedule range must be positive and at most 31 days", 422);
  }
  return range;
}

export function bookingRoutes(deps: BookingRouteDeps) {
  async function requireAuth(request: Request) {
    const auth = await deps.auth.authenticate(request);
    enforceRate(deps.rateLimiters.authenticated, auth.accountId);
    return auth;
  }

  async function mutation(request: Request) {
    const auth = await requireAuth(request);
    assertCsrf(request, auth);
    return { auth, key: requireIdempotencyKey(request), requestId: requestIdFor(request) };
  }

  return new Elysia({ prefix: "/api/v1" })
    .post("/me/bookings", async ({ request }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingCreateSchema, await readJsonObject(request));
      const result = await deps.bookings.createBooking(meta.auth, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .patch("/me/bookings/:id", async ({ request, params }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingPatchSchema, await readJsonObject(request));
      const result = await deps.bookings.patchBooking(meta.auth, params.id, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/me/bookings", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(request, await deps.bookings.listOwnBookings(auth, {
        status: url.searchParams.get("status"),
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      }));
    })
    .get("/me/bookings/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.bookings.getOwnBooking(auth, params.id));
    })
    .post("/me/bookings/:id/submit", async ({ request, params }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingVersionSchema, await readJsonObject(request));
      const result = await deps.bookings.submitBooking(meta.auth, params.id, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/me/bookings/:id/cancel", async ({ request, params }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingCancelSchema, await readJsonObject(request));
      const result = await deps.bookings.cancelOwnBooking(meta.auth, params.id, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/bookings", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(request, await deps.bookings.listNurseBookings(auth, {
        status: url.searchParams.get("status"),
        search: url.searchParams.get("search") ?? "",
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      }));
    })
    .get("/bookings/:id", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.bookings.getNurseBooking(auth, params.id));
    })
    .post("/bookings/:id/decisions", async ({ request, params }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingDecisionSchema, await readJsonObject(request));
      const result = await deps.bookings.decideBooking(meta.auth, params.id, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/bookings/:id/cancel", async ({ request, params }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingCancelSchema, await readJsonObject(request));
      const result = await deps.bookings.cancelNurseBooking(meta.auth, params.id, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .post("/bookings/:id/reschedule", async ({ request, params }) => {
      const meta = await mutation(request);
      const input = parseStrict(bookingRescheduleSchema, await readJsonObject(request));
      const result = await deps.bookings.rescheduleBooking(meta.auth, params.id, input, meta);
      return successResponse(request, result.data, result.statusCode);
    })
    .get("/schedule", async ({ request }) => {
      const auth = await requireAuth(request);
      const url = new URL(request.url);
      return successResponse(request, await deps.bookings.listSchedule(auth, {
        ...scheduleRange(url.searchParams.get("from"), url.searchParams.get("to")),
        cursor: url.searchParams.get("cursor"),
        limit: parseLimit(url.searchParams.get("limit")),
      }));
    })
    .get("/bookings/:id/care-guide", async ({ request, params }) => {
      const auth = await requireAuth(request);
      return successResponse(request, await deps.bookings.getCareGuide(auth, params.id));
    });
}
