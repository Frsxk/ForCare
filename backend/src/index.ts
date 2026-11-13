import { SQL } from "bun";
import { createApp } from "./app";
import { readServerConfig } from "./config";
import { readAiConfig } from "./ai/config";

try {
  const config = readServerConfig(process.env);
  readAiConfig(process.env);
  const database = new SQL({
    ...config.database,
    max: 5,
    connectionTimeout: 3,
    idleTimeout: 20,
  });
  const app = createApp(async () => {
    const query = database`SELECT 1`;
    const timer = setTimeout(() => query.cancel(), 2000);
    try { await query; } finally { clearTimeout(timer); }
  }).listen({ hostname: config.hostname, port: config.port });

  console.log(`ForCare backend listening on ${config.hostname}:${app.server?.port}`);
  const shutdown = async () => {
    await app.stop();
    await database.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch {
  console.error("ForCare backend startup failed. Check server, database and AI environment configuration.");
  process.exitCode = 1;
}
