import { randomUUID } from "node:crypto";
import { createAnalysisScheduler } from "./analysis/scheduler";
import { createGeminiDraftModel } from "./ai/gemini-model";
import { readAuthConfig, readServerConfig } from "./config";
import { createAnalysisWorker } from "./analysis/worker";
import { createDatabase } from "./storage/database";

const config = readServerConfig(process.env);
const authConfig = readAuthConfig(process.env, { hostname: config.hostname });
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey?.trim()) throw new Error("GOOGLE_API_KEY is required for the analysis worker");
const rawTimeout = Number(process.env.AI_TIMEOUT_MS ?? 30000);
if (!Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 120000) throw new Error("Invalid AI_TIMEOUT_MS");
const database = createDatabase(config.database, { max: 4, connectionTimeout: 3, idleTimeout: 20 });
const model = createGeminiDraftModel({ apiKey, timeoutMs: rawTimeout });

// PostgresSaver accepts a pg Pool. Keep its connection fields separate from URLs/logs.
const { Pool } = await import("pg");
const pool = new Pool({
  host: config.database.hostname, port: config.database.port, database: config.database.database,
  user: config.database.username, password: config.database.password, max: 2,
});
const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
const saver = new PostgresSaver(pool);
await saver.setup();
const worker = createAnalysisWorker({
  sql: database, checkpointer: saver, setupCheckpointer: async () => { await saver.setup(); },
  model, config: authConfig,
  owner: `analysis-${process.pid}-${randomUUID()}`,
  leaseMs: Math.min(rawTimeout + 15000, 900000),
});

const scheduler = createAnalysisScheduler({
  sql: database,
  worker,
  onError: (stage) => { console.error("Analysis worker iteration failed", stage); },
});
const interval = setInterval(() => { void scheduler.tick(); }, 1000);
await scheduler.tick();
const shutdown = async () => {
  clearInterval(interval);
  await scheduler.stop();
  await pool.end();
  await database.close();
};
await new Promise<void>((resolve) => {
  const stop = () => { void shutdown().finally(resolve); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});
