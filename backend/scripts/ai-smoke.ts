import { readAiConfig } from "../src/ai/config";
import { runAiSmoke } from "../src/ai/smoke";

try {
  const config = readAiConfig(process.env);
  if (!config.enabled) {
    console.error("AI smoke check disabled. Set AI_ENABLED=true, AI_API_KEY and AI_MODEL in your untracked environment file.");
    process.exitCode = 1;
  } else {
    console.log(await runAiSmoke(config));
  }
} catch {
  console.error("AI smoke check failed. Check the provider configuration, model access and connectivity. No clinical workflow was run.");
  process.exitCode = 1;
}
