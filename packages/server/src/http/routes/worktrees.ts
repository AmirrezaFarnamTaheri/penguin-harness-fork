import { Hono } from "hono";
import { WorktreeManager } from "@prismshadow/penguin-core";
import type { AppDeps } from "../../app.js";
import type { AppEnv } from "../../auth/middleware.js";
import type { WorktreesResponse } from "../../api/types.js";
import { HttpError } from "../errors.js";
import { requireProjectDir, requireValidId } from "../validate.js";

/** Read-only: the project authorizes access; the operator explicitly selects the repository. */
export function worktreesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const workspace = await requireProjectDir(c.req.query("workspace"));
    const worktrees = await new WorktreeManager(workspace).listWorktrees();
    // Core's legacy API returns [] on Git failure. A real repository always includes its
    // primary worktree (or bare entry); never present that failure as an empty success.
    if (worktrees.length === 0) {
      throw new HttpError(
        400,
        "worktree_list_failed",
        "Cannot list worktrees. Choose a Git repository and check that Git is available on the server.",
      );
    }
    return c.json({ workspace, worktrees } satisfies WorktreesResponse);
  });
  return app;
}
