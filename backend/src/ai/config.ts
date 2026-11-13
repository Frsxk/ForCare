import { z } from "zod";

const providerUrl = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopback));
});

const enabledSchema = z.object({
  AI_API_KEY: z.string().trim().min(1),
  AI_MODEL: z.string().trim().min(1),
  AI_BASE_URL: providerUrl.optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(30000),
});

export type EnabledAiConfig = {
  enabled: true;
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
};

export type AiConfig = { enabled: false } | EnabledAiConfig;

export function readAiConfig(env: Record<string, string | undefined>): AiConfig {
  const flag = env.AI_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") throw new Error("Invalid AI_ENABLED: use true or false");
  if (flag === "false") return { enabled: false };

  const result = enabledSchema.safeParse({
    AI_API_KEY: env.AI_API_KEY,
    AI_MODEL: env.AI_MODEL,
    AI_BASE_URL: env.AI_BASE_URL?.trim() || undefined,
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS?.trim() || undefined,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid AI configuration: ${fields.join(", ")}`);
  }
  return {
    enabled: true,
    apiKey: result.data.AI_API_KEY,
    model: result.data.AI_MODEL,
    baseUrl: result.data.AI_BASE_URL,
    timeoutMs: result.data.AI_TIMEOUT_MS,
  };
}
