import { describe, expect, test } from "bun:test";
import type { BaseMessageLike } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  createGeminiDraftModel,
  GEMINI_FALLBACK_MODEL_ID,
  GEMINI_PRIMARY_MODEL_ID,
  GeminiDraftModelError,
  type GeminiInvokeFactory,
} from "../src/ai/gemini-model";

const secret = "synthetic-key-never-disclose";
const messages: BaseMessageLike[] = [["human", "synthetic-private-patient-facts"]];
const config = { apiKey: secret, timeoutMs: 200, maxOutputTokens: 512 };
const httpError = (status: number) => Object.assign(new Error(`${secret}: provider body ${messages[0]}`), { status });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

for (const [primaryStatus, fallbackStatus, expectedCode] of [[429, 200, null], [429, 429, "rate_limited"], [401, 200, "authentication"]] as const) {
  test(`installed LangChain SDK preserves HTTP ${primaryStatus} status and makes only bounded transport attempts (${fallbackStatus})`, async () => {
    const requests: string[] = [];
    const factory: GeminiInvokeFactory = (fields) => new ChatOpenAI({
      ...fields,
      configuration: {
        ...fields.configuration,
        // Synthetic in-process transport: no socket, real key or provider call.
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.reasoning_effort).toBe("low");
          expect(body.max_tokens).toBe(512);
          requests.push(String(body.model));
          const status = body.model === GEMINI_PRIMARY_MODEL_ID ? primaryStatus : fallbackStatus;
          return new Response(JSON.stringify(status === 200 ? {
            id: "synthetic-completion", object: "chat.completion", created: 1, model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "SDK draft" }, finish_reason: "stop" }],
          } : { error: { message: `${secret} provider body`, type: "synthetic", code: null } }), {
            status, headers: { "content-type": "application/json" },
          });
        },
      },
    });
    const result = createGeminiDraftModel({ ...config, timeoutMs: 1000 }, factory).invoke(messages);
    if (expectedCode) await failure(result, expectedCode);
    else expect(await result).toEqual({ content: "SDK draft", modelId: GEMINI_FALLBACK_MODEL_ID, provider: "google-ai-studio", usedFallback: true });
    expect(requests).toEqual(primaryStatus === 429 ? [GEMINI_PRIMARY_MODEL_ID, GEMINI_FALLBACK_MODEL_ID] : [GEMINI_PRIMARY_MODEL_ID]);
  });
}

async function failure(promise: Promise<unknown>, code: ConstructorParameters<typeof GeminiDraftModelError>[0]) {
  const error = await promise.then(() => { throw new Error("expected failure"); }, (error: unknown) => error);
  expect(error).toBeInstanceOf(GeminiDraftModelError);
  expect((error as GeminiDraftModelError).code).toBe(code);
  const exposed = `${String(error)} ${(error as Error).stack} ${JSON.stringify(error)}`;
  expect(exposed).not.toContain(secret);
  expect(exposed).not.toContain("synthetic-private-patient-facts");
  expect(exposed).not.toContain("provider body");
  expect(error).not.toHaveProperty("cause");
  return error as GeminiDraftModelError;
}

function scripted(steps: Array<unknown | Error>) {
  const calls: string[] = [];
  const factory: GeminiInvokeFactory = (fields) => ({
    async invoke(input, options) {
      expect(input).toBe(messages);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      calls.push(fields.model!);
      const result = steps.shift();
      if (result instanceof Error) throw result;
      return result as { content: unknown };
    },
  });
  return { factory, calls };
}

describe("Gemini draft model", () => {
  test("uses the exact primary model and returns string-only provenance", async () => {
    expect(GEMINI_PRIMARY_MODEL_ID).toBe("gemini-3.5-flash");
    expect(GEMINI_FALLBACK_MODEL_ID).toBe("gemini-3.5-flash-lite");
    const fake = scripted([{ content: "draft", additional_kwargs: { private: secret } }]);
    expect(await createGeminiDraftModel(config, fake.factory).invoke(messages)).toEqual({
      content: "draft", modelId: "gemini-3.5-flash", provider: "google-ai-studio", usedFallback: false,
    });
    expect(fake.calls).toEqual(["gemini-3.5-flash"]);
  });

  test("pins Google chat-completions transport, low effort and bounded SDK settings", async () => {
    const factory: GeminiInvokeFactory = (fields) => {
      expect(fields.apiKey).toBe(secret);
      expect(fields.configuration?.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
      expect(fields.configuration?.maxRetries).toBe(0);
      expect(fields.useResponsesApi).toBe(false);
      expect(fields.streaming).toBe(false);
      expect(fields.streamUsage).toBe(false);
      expect(fields.maxRetries).toBe(0);
      expect(fields.maxTokens).toBe(512);
      expect(fields.timeout).toBeGreaterThan(0);
      expect(fields.timeout).toBeLessThanOrEqual(config.timeoutMs);
      // Check the installed LangChain serializer, not just our fake's input.
      const params = new ChatOpenAI(fields).invocationParams({});
      expect(params).toHaveProperty("reasoning_effort", "low");
      expect(params).toHaveProperty("max_tokens", 512);
      expect(params.stream).toBe(false);
      expect(params).not.toHaveProperty("stream_options");
      expect(params.tools).toBeUndefined();
      return { async invoke() { return { content: "draft" }; } };
    };
    await createGeminiDraftModel(config, factory).invoke(messages);
  });

  test("only an HTTP 429 invokes the fallback, once, with the same messages", async () => {
    const fake = scripted([httpError(429), { content: "fallback draft" }]);
    expect(await createGeminiDraftModel(config, fake.factory).invoke(messages)).toEqual({
      content: "fallback draft", modelId: "gemini-3.5-flash-lite", provider: "google-ai-studio", usedFallback: true,
    });
    expect(fake.calls).toEqual(["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  });

  test("fallback failure is sanitized and never makes a third attempt", async () => {
    const fake = scripted([httpError(429), httpError(429), { content: "must not run" }]);
    await failure(createGeminiDraftModel(config, fake.factory).invoke(messages), "rate_limited");
    expect(fake.calls).toEqual(["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  });

  for (const [status, code] of [[401, "authentication"], [403, "authentication"], [400, "invalid_request"], [500, "provider_error"]] as const) {
    test(`HTTP ${status} fails without retry or fallback`, async () => {
      const fake = scripted([httpError(status)]);
      await failure(createGeminiDraftModel(config, fake.factory).invoke(messages), code);
      expect(fake.calls).toEqual(["gemini-3.5-flash"]);
    });
  }

  for (const error of [new Error(`HTTP 429 quota ${secret}`), Object.assign(new Error(secret), { status: "429" }), Object.assign(new Error(secret), { cause: httpError(429) }), Object.assign(new Error(secret), { response: { status: 429 } }), new TypeError(`network failure ${secret}`)]) {
    test(`does not infer HTTP 429 from messages or unsupported nested shapes (${Object.keys(error).join(",") || error.name})`, async () => {
      const fake = scripted([error]);
      await failure(createGeminiDraftModel(config, fake.factory).invoke(messages), "provider_error");
      expect(fake.calls).toHaveLength(1);
    });
  }

  for (const response of [undefined, { content: "" }, { content: " \n " }, { content: 12 }, { content: [{ type: "text", text: "not a string" }] }, { content: "x".repeat(65_537) }, { content: "draft", tool_calls: [{ name: "never_execute" }] }]) {
    test("rejects empty, malformed, oversized or tool-call output without fallback", async () => {
      const fake = scripted([response]);
      await failure(createGeminiDraftModel(config, fake.factory).invoke(messages), "invalid_response");
      expect(fake.calls).toHaveLength(1);
    });
  }

  for (const response of [{ content: "", additional_kwargs: { refusal: secret } }, { content: "draft", response_metadata: { finish_reason: "content_filter" } }]) {
    test("safety refusal is terminal even if it contains text", async () => {
      const fake = scripted([response]);
      await failure(createGeminiDraftModel(config, fake.factory).invoke(messages), "safety_refusal");
      expect(fake.calls).toHaveLength(1);
    });
  }

  test("uses one shared deadline and abort signal for primary plus fallback", async () => {
    const signals: AbortSignal[] = [];
    const budgets: number[] = [];
    const factory: GeminiInvokeFactory = (fields) => {
      budgets.push(fields.timeout!);
      return { async invoke(_messages, { signal }) {
        signals.push(signal);
        if (fields.model === GEMINI_PRIMARY_MODEL_ID) {
          await sleep(35);
          throw httpError(429);
        }
        return new Promise(() => {}); // Ignore cancellation to prove the adapter enforces its own deadline.
      } };
    };
    await failure(createGeminiDraftModel({ ...config, timeoutMs: 80 }, factory).invoke(messages), "timeout");
    expect(budgets).toHaveLength(2);
    expect(budgets[1]!).toBeLessThan(budgets[0]! - 20);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]!.aborted).toBe(true);
  });

  test("a primary timeout cannot start a fallback", async () => {
    const calls: string[] = [];
    const factory: GeminiInvokeFactory = (fields) => ({ async invoke() {
      calls.push(fields.model!);
      return new Promise(() => {});
    } });
    await failure(createGeminiDraftModel({ ...config, timeoutMs: 10 }, factory).invoke(messages), "timeout");
    expect(calls).toEqual([GEMINI_PRIMARY_MODEL_ID]);
  });

  test("pre-aborted callers do not construct or invoke a provider", async () => {
    const controller = new AbortController();
    controller.abort(new Error(secret));
    let factories = 0;
    const factory: GeminiInvokeFactory = () => { factories++; throw new Error(secret); };
    const error = await failure(createGeminiDraftModel(config, factory).invoke(messages, { signal: controller.signal }), "aborted");
    expect(error.name).toBe("AbortError");
    expect(factories).toBe(0);
  });

  test("caller cancellation rejects promptly without fallback or leaking abort reason", async () => {
    const controller = new AbortController();
    let calls = 0;
    let providerSignal: AbortSignal | undefined;
    const factory: GeminiInvokeFactory = () => ({ async invoke(_messages, { signal }) {
      calls++;
      providerSignal = signal;
      controller.abort(new Error(secret));
      throw httpError(429);
    } });
    await failure(createGeminiDraftModel(config, factory).invoke(messages, { signal: controller.signal }), "aborted");
    expect(calls).toBe(1);
    expect(providerSignal!.aborted).toBe(true);
  });

  test("caller cancellation during fallback aborts the same shared signal", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const factory: GeminiInvokeFactory = (fields) => ({ async invoke(_messages, { signal }) {
      signals.push(signal);
      if (fields.model === GEMINI_PRIMARY_MODEL_ID) throw httpError(429);
      controller.abort(secret);
      return new Promise(() => {});
    } });
    await failure(createGeminiDraftModel(config, factory).invoke(messages, { signal: controller.signal }), "aborted");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]!.aborted).toBe(true);
  });

  test("synchronous factory errors are sanitized", async () => {
    await failure(createGeminiDraftModel(config, () => { throw new Error(secret); }).invoke(messages), "provider_error");
  });

  test("validates positive finite bounded settings before constructing a provider", () => {
    let calls = 0;
    const factory: GeminiInvokeFactory = () => { calls++; throw new Error(secret); };
    for (const settings of [
      { ...config, apiKey: "" }, { ...config, apiKey: " " },
      ...[0, -1, NaN, Infinity, 1.5, 120_001].map((timeoutMs) => ({ ...config, timeoutMs })),
      ...[0, -1, NaN, Infinity, 1.5, 4097].map((maxOutputTokens) => ({ ...config, maxOutputTokens })),
    ]) {
      expect(() => createGeminiDraftModel(settings, factory)).toThrow(GeminiDraftModelError);
      try { createGeminiDraftModel(settings, factory); } catch (error) {
        expect((error as GeminiDraftModelError).code).toBe("invalid_configuration");
        expect(String(error)).not.toContain(secret);
      }
    }
    expect(calls).toBe(0);
  });

  test("omitted token budget has a finite bounded default", async () => {
    const factory: GeminiInvokeFactory = (fields) => {
      expect(fields.maxTokens).toBe(2048);
      return { async invoke() { return { content: "draft" }; } };
    };
    await createGeminiDraftModel({ apiKey: secret, timeoutMs: 200 }, factory).invoke(messages);
  });
});
