import type { BaseMessageLike } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

export const GEMINI_PRIMARY_MODEL_ID = "gemini-3.5-flash";
export const GEMINI_FALLBACK_MODEL_ID = "gemini-3.5-flash-lite";
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_OUTPUT_TOKENS = 2048;
const MAX_CONTENT_CHARACTERS = 65_536;

export type GeminiDraftModelErrorCode =
  | "invalid_configuration"
  | "authentication"
  | "invalid_request"
  | "rate_limited"
  | "safety_refusal"
  | "invalid_response"
  | "timeout"
  | "aborted"
  | "provider_error";

const ERROR_MESSAGES: Record<GeminiDraftModelErrorCode, string> = {
  invalid_configuration: "Invalid Gemini draft model configuration.",
  authentication: "Gemini draft authentication failed.",
  invalid_request: "Gemini draft request was rejected.",
  rate_limited: "Gemini draft capacity is unavailable.",
  safety_refusal: "Gemini draft was declined by the provider safety policy.",
  invalid_response: "Gemini draft response was not valid text.",
  timeout: "Gemini draft deadline exceeded.",
  aborted: "Gemini draft was cancelled.",
  provider_error: "Gemini draft provider is unavailable.",
};

export class GeminiDraftModelError extends Error {
  constructor(readonly code: GeminiDraftModelErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = code === "aborted" ? "AbortError" : "GeminiDraftModelError";
  }
}

export interface GeminiDraftModelConfig {
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens?: number;
}

export interface GeminiDraftResult {
  content: string;
  modelId: string;
  provider: "google-ai-studio";
  usedFallback: boolean;
}

export interface GeminiDraftModel {
  invoke(messages: BaseMessageLike[], options?: { signal?: AbortSignal }): Promise<GeminiDraftResult>;
}

export type GeminiInvokeFactory = (
  fields: Exclude<ConstructorParameters<typeof ChatOpenAI>[0], string | undefined>,
) => {
  invoke(messages: BaseMessageLike[], options: { signal: AbortSignal }): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function httpStatus(error: unknown): number | undefined {
  // The installed OpenAI SDK exposes numeric status directly; LangChain preserves it.
  // Do not infer status from text, JSON bodies, or unsupported wrapper shapes.
  return isRecord(error) && typeof error.status === "number" ? error.status : undefined;
}

function sanitizedError(error: unknown): GeminiDraftModelError {
  const status = httpStatus(error);
  if (status === 401 || status === 403) return new GeminiDraftModelError("authentication");
  if (status === 400) return new GeminiDraftModelError("invalid_request");
  if (status === 429) return new GeminiDraftModelError("rate_limited");
  if (isRecord(error)) {
    if (error.name === "TimeoutError" || error.name === "APIConnectionTimeoutError") {
      return new GeminiDraftModelError("timeout");
    }
    if (error.name === "AbortError" || error.name === "APIUserAbortError") {
      return new GeminiDraftModelError("aborted");
    }
  }
  return new GeminiDraftModelError("provider_error");
}

function textContent(response: unknown): string {
  if (!isRecord(response)) throw new GeminiDraftModelError("invalid_response");
  const extra = isRecord(response.additional_kwargs) ? response.additional_kwargs : {};
  const metadata = isRecord(response.response_metadata) ? response.response_metadata : {};
  if (extra.refusal || metadata.finish_reason === "content_filter" || metadata.finish_reason === "SAFETY") {
    throw new GeminiDraftModelError("safety_refusal");
  }
  if (
    typeof response.content !== "string" || !response.content.trim() ||
    response.content.length > MAX_CONTENT_CHARACTERS ||
    (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) ||
    (Array.isArray(response.invalid_tool_calls) && response.invalid_tool_calls.length > 0) ||
    (Array.isArray(extra.tool_calls) && extra.tool_calls.length > 0) || extra.function_call
  ) {
    throw new GeminiDraftModelError("invalid_response");
  }
  return response.content;
}

export function createGeminiDraftModel(
  config: GeminiDraftModelConfig,
  invokeFactory: GeminiInvokeFactory = (fields) => new ChatOpenAI(fields),
): GeminiDraftModel {
  const maxOutputTokens = config?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  if (
    !config || typeof config.apiKey !== "string" || !config.apiKey.trim() ||
    !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw new GeminiDraftModelError("invalid_configuration");
  }
  const { apiKey, timeoutMs } = config;

  return {
    async invoke(messages, options = {}) {
      const callerSignal = options.signal;
      if (callerSignal?.aborted) throw new GeminiDraftModelError("aborted");
      const controller = new AbortController();
      const deadline = performance.now() + timeoutMs;
      const stopError = () => new GeminiDraftModelError(callerSignal?.aborted ? "aborted" : "timeout");
      const assertActive = () => {
        if (controller.signal.aborted || performance.now() >= deadline) {
          controller.abort();
          throw stopError();
        }
      };
      let rejectInterrupted!: (reason: GeminiDraftModelError) => void;
      const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
      const onStopped = () => { rejectInterrupted(stopError()); };
      const onCallerAbort = () => { controller.abort(); };
      controller.signal.addEventListener("abort", onStopped, { once: true });
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      // Also close the registration race without copying the caller's potentially sensitive reason.
      if (callerSignal?.aborted) onCallerAbort();

      try {
        for (const [attempt, modelId] of [GEMINI_PRIMARY_MODEL_ID, GEMINI_FALLBACK_MODEL_ID].entries()) {
          let response: unknown;
          try {
            response = await Promise.race([
              Promise.resolve().then(() => {
                assertActive();
                const model = invokeFactory({
                  apiKey,
                  model: modelId,
                  configuration: { baseURL: GOOGLE_BASE_URL, maxRetries: 0 },
                  useResponsesApi: false,
                  streaming: false,
                  streamUsage: false,
                  maxRetries: 0,
                  timeout: Math.max(1, Math.ceil(deadline - performance.now())),
                  maxTokens: maxOutputTokens,
                  // reasoning.effort is ignored for non-OpenAI model IDs in this SDK.
                  // modelKwargs is its documented escape hatch for valid completion parameters.
                  modelKwargs: { reasoning_effort: "low" },
                });
                assertActive();
                return model.invoke(messages, { signal: controller.signal });
              }),
              interrupted,
            ]);
          } catch (error) {
            assertActive();
            if (attempt === 0 && httpStatus(error) === 429) continue;
            throw sanitizedError(error);
          }
          assertActive();
          return {
            content: textContent(response),
            modelId,
            provider: "google-ai-studio",
            usedFallback: attempt === 1,
          };
        }
        throw new GeminiDraftModelError("provider_error");
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        controller.signal.removeEventListener("abort", onStopped);
      }
    },
  };
}
