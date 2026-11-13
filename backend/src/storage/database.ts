import { SQL } from "bun";
import { readServerConfig } from "../config";

export type DatabaseConnectionConfig = {
  hostname: string;
  port: number;
  database: string;
  username: string;
  password: string;
};

export type DatabaseOptions = {
  max?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
};

/**
 * Creates one Bun SQL client from the validated server configuration. Callers
 * own the client and must close it. Connection fields stay separate so a
 * password never becomes part of a URL or a log line.
 */
export function createDatabase(
  config: DatabaseConnectionConfig,
  options: DatabaseOptions = {},
): SQL {
  return new SQL({
    hostname: config.hostname,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    max: options.max ?? 5,
    connectionTimeout: options.connectionTimeout ?? 3,
    idleTimeout: options.idleTimeout ?? 20,
  });
}

/** Builds a database client from the same environment contract as the API. */
export function createDatabaseFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: DatabaseOptions = {},
): SQL {
  return createDatabase(readServerConfig(env).database, options);
}
