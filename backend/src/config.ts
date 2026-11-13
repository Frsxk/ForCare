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

export function readServerConfig(env: Record<string, string | undefined>) {
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
