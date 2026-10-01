import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";

/** Public probes expose only serving state, never configuration or dependency errors. */
export function healthRoutes(deps: Pick<AppDeps, "db" | "readinessChecks">): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", (c) => c.json({ status: "alive" }));
  app.get("/ready", (c) => {
    try {
      deps.db.prepare("SELECT 1").get();
    } catch {
      return c.json({ status: "not_ready", reason: "database_unavailable" }, 503);
    }
    try {
      if (deps.readinessChecks?.some((check) => !check()))
        return c.json({ status: "not_ready", reason: "dependency_degraded" }, 503);
    } catch {
      return c.json({ status: "not_ready", reason: "dependency_degraded" }, 503);
    }
    return c.json({ status: "ready" });
  });
  return app;
}
