import { createApp } from "./app";
import { readAiConfig } from "./ai/config";
import { createAuthService } from "./auth/service";
import { createAssessmentService } from "./assessments/service";
import { createCheckInService } from "./checkins/service";
import { createClinicalService } from "./clinical/service";
import { readAuthConfig, readServerConfig } from "./config";
import { createRateLimiters } from "./http/rate-limit";
import { MAX_TRANSPORT_BODY_BYTES } from "./http/request";
import { createPatientService } from "./patients/service";
import { createDatabase } from "./storage/database";

try {
  const config = readServerConfig(process.env);
  const authConfig = readAuthConfig(process.env, { hostname: config.hostname });
  readAiConfig(process.env);
  const database = createDatabase(config.database, {
    max: 5,
    connectionTimeout: 3,
    idleTimeout: 20,
  });
  const rateLimiters = createRateLimiters();
  const auth = createAuthService({ sql: database, config: authConfig });
  const patients = createPatientService({ sql: database, config: authConfig });
  const clinical = createClinicalService({ sql: database, config: authConfig });
  const checkins = createCheckInService({ sql: database, config: authConfig });
  const assessments = createAssessmentService({ sql: database, config: authConfig });
  const app = createApp(
    async () => {
      const query = database`SELECT 1`;
      const timer = setTimeout(() => query.cancel(), 2000);
      try {
        await query;
      } finally {
        clearTimeout(timer);
      }
    },
    { auth, patients, clinical, checkins, assessments, config: authConfig, rateLimiters },
  ).listen({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: MAX_TRANSPORT_BODY_BYTES,
  });

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
