import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import type { EnabledAiConfig } from "./config";

export async function runAiSmoke(config: EnabledAiConfig): Promise<string> {
  const model = new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    timeout: config.timeoutMs,
    maxRetries: 0,
    useResponsesApi: false,
    streamUsage: false,
    configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
  });
  const agent = createAgent({
    model,
    tools: [],
    systemPrompt: "This is a non-medical software connectivity check. Reply with exactly FORCARE_LANGCHAIN_OK and nothing else.",
  });
  const result = await agent.invoke(
    { messages: [{ role: "user", content: "Run the connectivity check." }] },
    { recursionLimit: 3, signal: AbortSignal.timeout(config.timeoutMs) },
  );
  const content = result.messages.at(-1)?.content;
  if (typeof content !== "string" || content.trim() !== "FORCARE_LANGCHAIN_OK") {
    throw new Error("Unexpected smoke response");
  }
  return content.trim();
}
