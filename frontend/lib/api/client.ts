const messages = {
  VALIDATION_FAILED: "Periksa kembali isian Anda.",
  UNKNOWN_FIELD: "Ada isian yang tidak didukung.",
  UNAUTHENTICATED: "Sesi tidak tersedia. Silakan masuk kembali.",
  INVALID_CREDENTIALS: "Email atau kata sandi tidak sesuai.",
  SESSION_EXPIRED: "Sesi telah berakhir. Silakan masuk kembali.",
  CSRF_INVALID: "Sesi perlu diperiksa kembali sebelum melanjutkan.",
  ORIGIN_REJECTED: "Alamat aplikasi belum diizinkan oleh server.",
  FORBIDDEN: "Akun Anda tidak memiliki akses ini.",
  NOT_FOUND: "Data tidak ditemukan atau tidak dapat diakses.",
  VERSION_CONFLICT: "Data telah berubah. Muat ulang sebelum menyimpan.",
  IDEMPOTENCY_CONFLICT: "Permintaan ini berbeda dari pengiriman sebelumnya.",
  IDEMPOTENCY_KEY_REQUIRED: "Identitas permintaan penyimpanan tidak valid.",
  INVALID_TRANSITION: "Tindakan ini tidak tersedia pada status saat ini.",
  RATE_LIMITED: "Terlalu banyak permintaan. Tunggu sebelum mencoba lagi.",
  PAYLOAD_TOO_LARGE: "Data yang dikirim terlalu besar.",
  GATE_UNAVAILABLE: "Fitur ini belum tersedia.",
  REGISTRATION_UNAVAILABLE: "Pendaftaran tidak tersedia.",
  SCOPE_REQUIRED: "Akses untuk data ini belum diberikan.",
  INTERNAL: "Server belum dapat memproses permintaan.",
  HTTP_ERROR: "Permintaan belum dapat diproses.",
  NETWORK_ERROR: "Server tidak dapat dihubungi. Periksa koneksi Anda.",
  REQUEST_ABORTED: "Permintaan dibatalkan; hasil tindakan belum dapat dipastikan.",
  INVALID_RESPONSE: "Respons server tidak sesuai. Muat ulang untuk memeriksa sesi.",
  CLIENT_CONFIG_ERROR: "Konfigurasi permintaan aplikasi tidak valid.",
  CSRF_REQUIRED: "Periksa sesi sebelum mengirim perubahan.",
} as const;
export type ApiErrorCode = keyof typeof messages;
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  constructor(code: ApiErrorCode, status = 0, metadata: { requestId?: string; retryAfterSeconds?: number } = {}) {
    super(messages[code]);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = metadata.requestId;
    this.retryAfterSeconds = metadata.retryAfterSeconds;
  }
}
export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("NETWORK_ERROR");
}
export type ApiPath = `/api/v1/${string}`;
export type Decoder<T> = (value: unknown) => T;
export type Transport = (input: string, init: RequestInit) => Promise<Response>;
type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";
type RequestOptions = {
  signal?: AbortSignal;
  method?: "GET" | WriteMethod;
  json?: unknown;
  authenticated?: boolean;
  empty?: boolean;
};
export type WriteIntent = Readonly<{ path: ApiPath; method: WriteMethod; body: string; idempotencyKey: string }>;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validatePath(path: string): asserts path is ApiPath {
  const pathname = path.split("?")[0];
  if (!/^\/api\/v1\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(pathname) || path.includes("#") || path.includes("\\")) throw new ApiError("CLIENT_CONFIG_ERROR");
}
function validateKey(key: string) {
  if (!(uuidV4.test(key) || /^[A-Za-z0-9_-]{32,128}$/.test(key))) throw new ApiError("CLIENT_CONFIG_ERROR");
}
function serialize(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error();
    return result;
  } catch {
    throw new ApiError("CLIENT_CONFIG_ERROR");
  }
}

// Retain this intent for an explicit user retry. New content requires a new intent/key.
export function prepareWrite(path: ApiPath, method: WriteMethod, json: unknown, idempotencyKey: string = globalThis.crypto.randomUUID()): WriteIntent {
  validatePath(path);
  validateKey(idempotencyKey);
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new ApiError("CLIENT_CONFIG_ERROR");
  return Object.freeze({ path, method, body: serialize(json), idempotencyKey });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function statusCode(status: number): ApiErrorCode {
  return ({ 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 413: "PAYLOAD_TOO_LARGE", 429: "RATE_LIMITED" } as Record<number, ApiErrorCode>)[status] ?? (status >= 500 ? "INTERNAL" : "HTTP_ERROR");
}
function wasAborted(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

export function createApiClient(options: { fetch?: Transport; onUnauthorized?: () => void } = {}) {
  const transport: Transport = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let csrfToken: string | null = null;
  let authVersion = 0;
  function setCsrfToken(token: string | null) {
    csrfToken = token;
    authVersion++;
  }
  async function perform<T>(path: ApiPath, decode: Decoder<T>, opts: RequestOptions, prepared?: WriteIntent): Promise<T> {
    validatePath(path);
    if (opts.signal?.aborted) throw new ApiError("REQUEST_ABORTED");
    const method = opts.method ?? "GET";
    const authenticated = opts.authenticated !== false;
    const headers = new Headers({ accept: "application/json" });
    const body = prepared?.body ?? (opts.json === undefined ? undefined : serialize(opts.json));
    if (body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET" && authenticated) {
      if (!csrfToken) throw new ApiError("CSRF_REQUIRED");
      headers.set("x-csrf-token", csrfToken);
    }
    if (prepared) {
      validateKey(prepared.idempotencyKey);
      headers.set("idempotency-key", prepared.idempotencyKey);
    }
    const version = authVersion;
    let response: Response;
    try {
      response = await transport(path, { method, headers, body, signal: opts.signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
    } catch (error) {
      throw new ApiError(wasAborted(error, opts.signal) ? "REQUEST_ABORTED" : "NETWORK_ERROR");
    }
    if (opts.signal?.aborted) throw new ApiError("REQUEST_ABORTED");
    if (response.status === 401 && authenticated && version === authVersion) {
      setCsrfToken(null);
      options.onUnauthorized?.();
    }
    let payload: unknown;
    // Bun may reject oversized bodies before routing, with a non-JSON 413.
    if (response.status !== 204 && response.status !== 413) {
      try { payload = await response.json(); }
      catch (error) {
        if (wasAborted(error, opts.signal)) throw new ApiError("REQUEST_ABORTED");
        if (response.ok) throw new ApiError("INVALID_RESPONSE", response.status);
      }
    }
    if (opts.signal?.aborted) throw new ApiError("REQUEST_ABORTED");
    if (!response.ok) {
      const error = record(record(payload)?.error);
      const rawCode = error?.code;
      const code = response.status === 413 ? "PAYLOAD_TOO_LARGE" : typeof rawCode === "string" && Object.hasOwn(messages, rawCode) ? rawCode as ApiErrorCode : statusCode(response.status);
      const rawId = error?.requestId ?? response.headers.get("x-request-id");
      const rawRetry = response.headers.get("retry-after");
      const retryAfterSeconds = rawRetry && /^\d{1,8}$/.test(rawRetry) ? Number(rawRetry) : undefined;
      throw new ApiError(code, response.status, {
        ...(typeof rawId === "string" && uuidV4.test(rawId) ? { requestId: rawId } : {}),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    }
    try {
      if (opts.empty) {
        if (response.status !== 204) throw new Error();
        return decode(undefined);
      }
      const envelope = record(payload);
      if (!envelope || !Object.hasOwn(envelope, "data") || typeof envelope.requestId !== "string" || !uuidV4.test(envelope.requestId)) throw new Error();
      return decode(envelope.data);
    } catch {
      throw new ApiError("INVALID_RESPONSE", response.status);
    }
  }
  return {
    setCsrfToken,
    request<T>(path: ApiPath, decode: Decoder<T>, opts: RequestOptions = {}) { return perform(path, decode, opts); },
    write<T>(intent: WriteIntent, decode: Decoder<T>, signal?: AbortSignal) {
      return perform(intent.path, decode, { method: intent.method, signal }, intent);
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
