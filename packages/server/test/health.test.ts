import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { openDatabase } from "../src/db/database.js";
import { healthRoutes } from "../src/http/routes/health.js";
import { createTestApp } from "./helpers.js";

describe("health and readiness", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close();
  });

  it("serves public probes through the application without cookie authentication", async () => {
    const app = await createTestApp();
    cleanup.push(() => app.cleanup());
    expect((await app.app.request("/api/health")).status).toBe(200);
    expect((await app.app.request("/health")).status).toBe(200);
    expect((await app.app.request("/health/ready")).status).toBe(200);
    const ready = await app.app.request("/api/health/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  it("keeps liveness responding when the DB is closed", async () => {
    const db = openDatabase(":memory:");
    const app = new Hono().route("/api/health", healthRoutes({ db }));
    db.close();
    expect((await app.request("/api/health")).status).toBe(200);
    const ready = await app.request("/api/health/ready");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready", reason: "database_unavailable" });
  });

  it("reports degraded dependencies without leaking errors and recovers", async () => {
    const db = openDatabase(":memory:");
    cleanup.push(() => db.close());
    let healthy = false;
    const app = new Hono().route(
      "/api/health",
      healthRoutes({
        db,
        readinessChecks: [
          () => {
            if (!healthy) throw new Error("secret connection string");
            return true;
          },
        ],
      }),
    );
    const degraded = await app.request("/api/health/ready");
    expect(degraded.status).toBe(503);
    expect(await degraded.text()).not.toContain("secret");
    healthy = true;
    expect((await app.request("/api/health/ready")).status).toBe(200);
  });
});
