/**
 * Agent State snapshot listing route: GET /api/projects/:p/agents/:a/snapshots
 * (any member) returns the live snapshot versions on disk for that Agent, from
 * SnapshotService's own directory — the versions the export/import flow creates,
 * not a second data source.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import { requireValidId } from "../validate.js";

export function agentSnapshotRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/snapshots", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const agentId = requireValidId(c, "agentId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(await deps.snapshots.listSnapshots(projectId, agentId));
  });

  return app;
}
