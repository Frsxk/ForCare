import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { readServerConfig } from "../src/config";

describe("server configuration", () => {
  test("defaults to loopback and requires a database credential", () => {
    expect(() => readServerConfig({})).toThrow("POSTGRES_PASSWORD");
    const config = readServerConfig({ POSTGRES_PASSWORD: "synthetic-db-credential" });
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
    expect(config.database.hostname).toBe("db");
    expect(config.database.port).toBe(5432);
  });
  test("accepts explicit container binding and validates numeric ports", () => {
    expect(readServerConfig({ POSTGRES_PASSWORD: "synthetic", HOST: "0.0.0.0", PORT: "3000" }).port).toBe(3000);
    for (const port of ["0", "-1", "65536", "1.5", "not-a-port"]) {
      expect(() => readServerConfig({ POSTGRES_PASSWORD: "synthetic", PORT: port })).toThrow("PORT");
    }
  });
  test("never includes supplied credentials in configuration errors", () => {
    expect(() => readServerConfig({ POSTGRES_PASSWORD: "", DATABASE_PORT: "bad" })).toThrow("POSTGRES_PASSWORD");
    try {
      readServerConfig({ POSTGRES_PASSWORD: "synthetic-do-not-log", DATABASE_PORT: "bad" });
      throw new Error("invalid configuration accepted");
    } catch (error) {
      expect(String(error)).toContain("DATABASE_PORT");
      expect(String(error)).not.toContain("synthetic-do-not-log");
    }
  });
});

describe("health routes", () => {
  test("preserves the teammate's greeting", async () => {
    const app = createApp(async () => {});
    const response = await app.handle(new Request("http://localhost/"));
    expect(await response.text()).toBe("Hello Elysia");
  });
  test("liveness never contacts PostgreSQL or AI", async () => {
    let calls = 0;
    const app = createApp(async () => { calls++; throw new Error("unavailable"); });
    const response = await app.handle(new Request("http://localhost/health/live"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "forcare-backend" });
    expect(calls).toBe(0);
  });
  test("readiness probes the database", async () => {
    let calls = 0;
    const app = createApp(async () => { calls++; });
    const response = await app.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", service: "forcare-backend" });
    expect(calls).toBe(1);
  });
  test("database failure is unavailable, with no raw diagnostics", async () => {
    const app = createApp(async () => { throw new Error("postgres://user:synthetic-password@private-host/db"); });
    const response = await app.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable", service: "forcare-backend" });
    expect(body).not.toContain("synthetic-password");
    expect(body).not.toContain("private-host");
  });
  test("does not expose AI smoke execution over HTTP", async () => {
    const app = createApp(async () => {});
    const response = await app.handle(new Request("http://localhost/api/ai/smoke", { method: "POST" }));
    expect(response.status).toBe(404);
  });
});
