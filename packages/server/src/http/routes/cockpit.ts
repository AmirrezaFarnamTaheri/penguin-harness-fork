/**
 * Cockpit HTTP routes: telemetry snapshot and autonomous swarm invocation.
 */
import { Hono } from "hono";
import { DEFAULT_PROJECT_ID } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import {
  getOrCreateProjectRuntime,
  buildCockpitSnapshot,
  type CockpitWebSocketDeps,
  type ProjectCockpitRuntime,
} from "../../cockpit/ws.js";

export function cockpitRoutes(deps?: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  function getProjectId(c: { req: { query: (k: string) => string | undefined } }): string {
    const fromQuery = c.req.query("project") || c.req.query("projectId");
    if (fromQuery && typeof fromQuery === "string" && fromQuery.trim()) {
      return fromQuery.trim();
    }
    return DEFAULT_PROJECT_ID;
  }

  function authorizeProject(c: { var?: { user?: { userId: string } } }, projectId: string): void {
    if (deps?.projectService && c.var?.user?.userId) {
      deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    }
  }

  async function getRuntime(
    c: { req: { query: (k: string) => string | undefined }; var?: { user?: { userId: string } } },
    explicitProjectId?: string,
  ): Promise<ProjectCockpitRuntime> {
    const projectId = explicitProjectId ?? getProjectId(c);
    authorizeProject(c, projectId);
    const wsDeps: CockpitWebSocketDeps = deps
      ? {
          authService: deps.authService,
          projectService: deps.projectService,
          projectConfigService: deps.projectConfigService,
          root: deps.config.root,
        }
      : {};
    return getOrCreateProjectRuntime(projectId, wsDeps);
  }

  app.get("/telemetry", async (c) => {
    const runtime = await getRuntime(c);
    const snapshot = buildCockpitSnapshot(
      runtime.coordinator,
      runtime.keyFleet,
      runtime.codeGraphWatcher,
    );
    return c.json(snapshot);
  });

  app.get("/keys", async (c) => {
    const runtime = await getRuntime(c);
    return c.json({
      reports: runtime.keyFleet.getFleetReport(),
      stats: runtime.keyFleet.getFleetStats(),
      snapshot: runtime.keyFleet.getCockpitSnapshot(),
    });
  });

  app.post("/keys/probe", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : getProjectId(c);
    const runtime = await getRuntime(c, projectId);
    const provider = typeof body.provider === "string" ? body.provider : "anthropic";
    const target =
      typeof body.keyId === "string" && body.keyId.trim()
        ? body.keyId.trim()
        : typeof body.maskedKey === "string"
          ? body.maskedKey
          : "";
    const result = await runtime.keyFleet.probeKey(provider, target);
    return c.json({
      success: result.status === "ok",
      result,
    });
  });

  app.post("/keys/action", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : getProjectId(c);
    const runtime = await getRuntime(c, projectId);
    const action = body.action;
    const provider = typeof body.provider === "string" ? body.provider : "";
    const target =
      typeof body.keyId === "string" && body.keyId.trim()
        ? body.keyId.trim()
        : typeof body.maskedKey === "string"
          ? body.maskedKey
          : "";
    const monitor = runtime.keyFleet;

    if (action === "revive") {
      monitor.reviveKey(provider, target);
    } else if (action === "cooldown") {
      monitor.cooldownKey(
        provider,
        target,
        typeof body.cooldownMs === "number" ? body.cooldownMs : 60_000,
      );
    } else if (action === "evict") {
      monitor.evictKey(provider, target);
    } else if (action === "revive_all") {
      monitor.reviveAllCooldowns();
    }

    return c.json({
      success: true,
      stats: monitor.getFleetStats(),
      snapshot: monitor.getCockpitSnapshot(),
      reports: monitor.getFleetReport(),
    });
  });

  app.post("/mailbox/send", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : getProjectId(c);
    const runtime = await getRuntime(c, projectId);
    const from = typeof body.from === "string" ? body.from.slice(0, 64) : "operator";
    const to = typeof body.to === "string" ? body.to.slice(0, 64) : "coder";
    const content = typeof body.content === "string" ? body.content : "";
    const trimmed = content.trim();

    if (!trimmed) {
      return c.json({ success: false, error: "Directive content cannot be empty" }, 400);
    }
    if (trimmed.length > 8192) {
      return c.json(
        { success: false, error: "Directive content exceeds maximum length of 8192 characters" },
        400,
      );
    }

    const coordinator = runtime.coordinator;
    const summaries = coordinator.getMailboxSummaries();
    const targetSummary = summaries[to];
    if (targetSummary && targetSummary.queueDepth >= 100) {
      return c.json(
        { success: false, error: `Mailbox queue for '${to}' exceeds capacity (max 100 pending)` },
        429,
      );
    }

    const directive = coordinator.dispatchDirective(from, to, trimmed);
    return c.json({
      success: true,
      directive,
      mailbox: coordinator.getMailboxSummaries(),
    });
  });

  app.get("/topology", async (c) => {
    const runtime = await getRuntime(c);
    return c.json(runtime.codeGraphWatcher.exportSnapshot());
  });

  app.post("/swarm/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : getProjectId(c);
    const runtime = await getRuntime(c, projectId);
    const goal = typeof body.goal === "string" ? body.goal.slice(0, 4096) : "Autonomous local task";
    const files = Array.isArray(body.files)
      ? (body.files.filter((f: unknown) => typeof f === "string" && f.trim()) as string[])
      : undefined;
    const proposedCommands = Array.isArray(body.proposedCommands)
      ? (body.proposedCommands.filter(
          (p: unknown) => typeof p === "string" && p.trim(),
        ) as string[])
      : undefined;
    const maxRounds =
      typeof body.maxRounds === "number"
        ? Math.min(Math.max(1, Math.floor(body.maxRounds)), 10)
        : 3;
    const simulate = body.simulate === true;

    const coordinator = runtime.coordinator;

    if (body.async === true) {
      const taskId =
        typeof body.id === "string" && body.id.trim()
          ? body.id.trim()
          : `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      void coordinator.runTask({
        id: taskId,
        goal,
        files,
        proposedCommands,
        maxRounds,
        simulate,
      });
      return c.json({ success: true, accepted: true, taskId }, 202);
    }

    const result = await coordinator.runTask({
      id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
      goal,
      files,
      proposedCommands,
      maxRounds,
      simulate,
    });

    return c.json({
      success: true,
      result,
    });
  });

  return app;
}
