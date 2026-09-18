/**
 * Audit receipt route: GET /api/projects/:p/audit/receipts — the verified, Project-scoped
 * projection of the append-only audit log the recorder writes (sandbox/audit.ts). Any
 * member can read it: the receipts name tool calls the whole Project is accountable for,
 * and the view is allowlisted (no raw arguments, no origin chain, no signing material).
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import { readAuditReceipts } from "../../sandbox/read-audit.js";
import { requireValidId } from "../validate.js";
import { HttpError } from "../errors.js";

export function auditRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/receipts", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readAuditReceipts(deps.config.root, { projectId, limit: 50 }));
    } catch {
      throw new HttpError(
        503,
        "audit_unavailable",
        "Audit receipts could not be read or verified.",
      );
    }
  });
  return app;
}
