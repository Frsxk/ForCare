import { Elysia } from "elysia";
export function createApp(checkDatabase: () => Promise<void>) {
  return new Elysia()
    .get("/", () => "Hello Elysia")
    .get("/health/live", () => ({ status: "ok", service: "forcare-backend" }))
    .get("/health/ready", async ({ status }) => {
      try {
        await checkDatabase();
        return { status: "ready", service: "forcare-backend" };
      } catch {
        return status(503, { status: "unavailable", service: "forcare-backend" });
      }
    });
}
