import { describe, expect, test } from "bun:test";
import { readAiConfig } from "../src/ai/config";
import { runAiSmoke } from "../src/ai/smoke";

const enabled = {
  AI_ENABLED: "true",
  AI_API_KEY: "synthetic-test-credential",
  AI_MODEL: "synthetic-test-model",
};

describe("AI configuration", () => {
  test("is disabled by default without a provider credential", () => {
    expect(readAiConfig({})).toEqual({ enabled: false });
    expect(readAiConfig({ AI_ENABLED: "false", AI_MODEL: "" })).toEqual({ enabled: false });
  });

  test("requires an explicit boolean opt-in", () => {
    expect(() => readAiConfig({ AI_ENABLED: "yes" })).toThrow("AI_ENABLED");
  });

  test("requires an explicit model and credential when enabled", () => {
    expect(() => readAiConfig({ AI_ENABLED: "true" })).toThrow("AI_API_KEY");
    expect(() => readAiConfig({ ...enabled, AI_MODEL: " " })).toThrow("AI_MODEL");
  });

  test("validates timeout without echoing secret values", () => {
    try {
      readAiConfig({ ...enabled, AI_TIMEOUT_MS: "not-a-timeout" });
      throw new Error("configuration was accepted");
    } catch (error) {
      expect(String(error)).toContain("AI_TIMEOUT_MS");
      expect(String(error)).not.toContain(enabled.AI_API_KEY);
    }
    for (const timeout of ["0", "-1", "1.5", "120001"]) {
      expect(() => readAiConfig({ ...enabled, AI_TIMEOUT_MS: timeout })).toThrow("AI_TIMEOUT_MS");
    }
  });

  test("accepts HTTPS providers or an explicit loopback test endpoint", () => {
    const config = readAiConfig({ ...enabled, AI_BASE_URL: "https://example.com/v1" });
    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.timeoutMs).toBe(30000);
    expect(readAiConfig({ ...enabled, AI_BASE_URL: "http://127.0.0.1:1234/v1" }).enabled).toBe(true);
    for (const url of ["invalid-url", "file:///etc/passwd", "http://example.com/v1", "https://user:secret@example.com/v1"]) {
      expect(() => readAiConfig({ ...enabled, AI_BASE_URL: url })).toThrow("AI_BASE_URL");
    }
  });
});

describe("LangChain smoke graph against a synthetic local provider", () => {
  test("runs the real graph and chat transport with no clinical input or tools", async () => {
    let received: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
        expect(request.headers.get("authorization")).toBe(`Bearer ${enabled.AI_API_KEY}`);
        received = await request.json() as Record<string, unknown>;
        return Response.json({
          id: "synthetic-completion", object: "chat.completion", created: 0,
          model: enabled.AI_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "FORCARE_LANGCHAIN_OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const config = readAiConfig({ ...enabled, AI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
      if (!config.enabled) throw new Error("expected enabled configuration");
      expect(await runAiSmoke(config)).toBe("FORCARE_LANGCHAIN_OK");
      expect(received?.model).toBe(enabled.AI_MODEL);
      expect(received?.tools ?? []).toEqual([]);
      expect(JSON.stringify(received?.messages)).toContain("FORCARE_LANGCHAIN_OK");
      expect(JSON.stringify(received?.messages)).not.toContain(enabled.AI_API_KEY);
    } finally { await server.stop(true); }
  });

  test("does not treat a provider failure as a successful smoke check or retry", async () => {
    let calls = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls += 1;
      return Response.json({ error: { message: "synthetic provider unavailable", type: "server_error" } }, { status: 503 });
    } });
    try {
      const config = readAiConfig({ ...enabled, AI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
      if (!config.enabled) throw new Error("expected enabled configuration");
      await expect(runAiSmoke(config)).rejects.toThrow();
      expect(calls).toBe(1);
    } finally { await server.stop(true); }
  });

  test("rejects an unexpected model response", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      return Response.json({ id: "synthetic", object: "chat.completion", created: 0, model: enabled.AI_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "not the expected marker" }, finish_reason: "stop" }] });
    } });
    try {
      const config = readAiConfig({ ...enabled, AI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });
      if (!config.enabled) throw new Error("expected enabled configuration");
      await expect(runAiSmoke(config)).rejects.toThrow("Unexpected smoke response");
    } finally { await server.stop(true); }
  });
});
