/**
 * GET /api/projects/:projectId/agents/:agentId/schedule-kanban — a read-only projection of
 * the Agents' declarative schedule files (agent_state/schedule/*.toml) as kanban-shaped
 * cards. The file is the intent; this is its projection, not a KanbanTask: there is no
 * claim of runtime eligibility (status/next-fire need state the board does not carry) and
 * no mutation route — writes stay on the schedules API, so a board view can never mutate
 * a schedule file and no card can ever be "moved".
 *
 * Member-gated like every schedules read; registered before /:name in schedules.ts (the
 * static path wins anyway, matching template-placeholder).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import type { ScheduleKanbanResponse } from "../../api/schedule-kanban.js";
import { requireValidId } from "../validate.js";

export function scheduleKanbanRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** Id validation before any access check, matching the repo's route contract. */
  const scope = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    const agentId = requireValidId(c, "agentId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return { projectId, agentId };
  };

  app.get("/", async (c) => {
    const { projectId, agentId } = scope(c);
    await deps.agentConfigService.requireExists(projectId, agentId);
    const { entries, invalid } = await deps.scheduler.listAgent(projectId, agentId);
    const cards: ScheduleKanbanResponse["cards"] = [];
    for (const entry of entries) {
      // Runtime state (state/queued/nextFire) is deliberately not projected: the card is
      // the file's declarative intent, and borrowing listAgent's statusOf output would
      // dress a file read up as a liveness claim.
      const { name, enabled, startAt, period, endAt } = entry.def;
      cards.push({
        id: `${projectId}/${agentId}/${name}`,
        name,
        enabled,
        startAt,
        ...(period !== undefined ? { period } : {}),
        ...(endAt !== undefined ? { endAt } : {}),
      });
    }
    return c.json({ cards, invalidFiles: invalid } satisfies ScheduleKanbanResponse);
  });

  return app;
}
