import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const schema = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: port.default(3001),
  DATABASE_HOST: z.string().trim().min(1).default("db"),
  DATABASE_PORT: port.default(5432),
  POSTGRES_DB: z.string().trim().min(1).default("forcare"),
  POSTGRES_USER: z.string().trim().min(1).default("forcare"),
  POSTGRES_PASSWORD: z.string().min(1),
});

export type ServerConfig = {
  hostname: string;
  port: number;
  database: {
    hostname: string;
    port: number;
    database: string;
    username: string;
    password: string;
  };
};

export function readServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid server configuration: ${fields.join(", ")}`);
  }
  return {
    hostname: result.data.HOST,
    port: result.data.PORT,
    database: {
      hostname: result.data.DATABASE_HOST,
      port: result.data.DATABASE_PORT,
      database: result.data.POSTGRES_DB,
      username: result.data.POSTGRES_USER,
      password: result.data.POSTGRES_PASSWORD,
    },
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const authSchema = z.object({
  AUTH_ALLOWED_ORIGINS: z.string().optional(),
  AUTH_NURSE_EMAIL_DOMAIN: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().toLowerCase().optional(),
  ),
  AUTH_SESSION_SECRET: z.string().min(32).optional(),
  AUTH_LOCAL_HTTP_TEST: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.enum(["true", "false"]).optional(),
  ),
});

export type AuthConfig = {
  allowedOrigins: readonly string[];
  nurseEmailDomain: string | null;
  sessionSecret: string;
  localHttpTest: boolean;
  cookieSecure: true;
};

function invalidAuth(fields: string): Error {
  return new Error(`Invalid auth configuration: ${fields}`);
}

function normalizeOrigin(value: string, localHttpTest: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidAuth("AUTH_ALLOWED_ORIGINS");
  }
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw invalidAuth("AUTH_ALLOWED_ORIGINS");
  }
  if (url.protocol !== "https:" && !(localHttpTest && url.protocol === "http:")) {
    throw invalidAuth("AUTH_ALLOWED_ORIGINS");
  }
  if (localHttpTest && url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw invalidAuth("AUTH_ALLOWED_ORIGINS");
  }
  if (value !== url.origin) throw invalidAuth("AUTH_ALLOWED_ORIGINS");
  return url.origin;
}

export function readAuthConfig(
  env: Record<string, string | undefined>,
  options: { hostname: string },
): AuthConfig {
  const result = authSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw invalidAuth(fields.join(", "));
  }

  const localHttpTest = result.data.AUTH_LOCAL_HTTP_TEST === "true";
  if (localHttpTest && !LOOPBACK_HOSTS.has(options.hostname)) {
    throw invalidAuth("AUTH_LOCAL_HTTP_TEST requires a loopback HOST");
  }

  const rawOrigins = result.data.AUTH_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (rawOrigins.length === 0) throw invalidAuth("AUTH_ALLOWED_ORIGINS");
  const allowedOrigins = rawOrigins.map((value) => normalizeOrigin(value, localHttpTest));
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw invalidAuth("AUTH_ALLOWED_ORIGINS");

  const sessionSecret = result.data.AUTH_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) throw invalidAuth("AUTH_SESSION_SECRET");

  const nurseEmailDomain = result.data.AUTH_NURSE_EMAIL_DOMAIN ?? null;
  if (nurseEmailDomain !== null && !DOMAIN.test(nurseEmailDomain)) {
    throw invalidAuth("AUTH_NURSE_EMAIL_DOMAIN");
  }

  return {
    allowedOrigins,
    nurseEmailDomain,
    sessionSecret,
    localHttpTest,
    cookieSecure: true,
  };
}

export function readNurseEmailDomain(env: Record<string, string | undefined>): string | null {
  const result = authSchema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw invalidAuth(fields.join(", "));
  }
  const domain = result.data.AUTH_NURSE_EMAIL_DOMAIN ?? null;
  if (domain !== null && !DOMAIN.test(domain)) throw invalidAuth("AUTH_NURSE_EMAIL_DOMAIN");
  return domain;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}
