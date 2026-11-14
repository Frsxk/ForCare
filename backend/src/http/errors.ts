import { randomUUID } from "node:crypto";

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNKNOWN_FIELD"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "SESSION_EXPIRED"
  | "CSRF_INVALID"
  | "ORIGIN_REJECTED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "SCHEDULE_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "INVALID_TRANSITION"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "GATE_UNAVAILABLE"
  | "REGISTRATION_UNAVAILABLE"
  | "SCOPE_REQUIRED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requestIds = new WeakMap<Request, string>();

export function isApiPath(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/v1");
}

export function requestIdFor(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && REQUEST_ID.test(supplied)) return supplied.toLowerCase();
  const existing = requestIds.get(request);
  if (existing) return existing;
  const generated = randomUUID();
  requestIds.set(request, generated);
  return generated;
}

function baseHeaders(request: Request): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestIdFor(request),
  });
}

export function successResponse(request: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, requestId: requestIdFor(request) }), {
    status,
    headers: baseHeaders(request),
  });
}

export function errorResponse(request: Request, error: AppError): Response {
  const headers = baseHeaders(request);
  if (error.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(error.retryAfterSeconds));
  }
  return new Response(
    JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        requestId: requestIdFor(request),
        ...(error.details ? { details: error.details } : {}),
      },
    }),
    { status: error.status, headers },
  );
}

export function noContentResponse(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestIdFor(request),
    },
  });
}

export function toErrorResponse(request: Request, error: unknown): Response | undefined {
  if (!isApiPath(request)) return undefined;
  if (error instanceof AppError) return errorResponse(request, error);
  if (typeof error === "object" && error !== null && (error as { code?: string }).code === "NOT_FOUND") {
    return errorResponse(request, new AppError("NOT_FOUND", "Resource not found", 404));
  }
  console.error("Unhandled API error", error instanceof Error ? error.name : "unknown");
  return errorResponse(request, new AppError("INTERNAL", "An internal error occurred", 500));
}
