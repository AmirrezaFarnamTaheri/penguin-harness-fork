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
      runtime.projectId,
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

    if (!["revive", "cooldown", "evict", "revive_all"].includes(action)) {
      return c.json(
        {
          success: false,
          error: `Invalid or unsupported action '${action}'. Must be one of: revive, cooldown, evict, revive_all`,
        },
        400,
      );
    }

    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const target =
      typeof body.keyId === "string" && body.keyId.trim()
        ? body.keyId.trim()
        : typeof body.maskedKey === "string"
          ? body.maskedKey.trim()
          : "";
    const monitor = runtime.keyFleet;

    if (action === "revive_all") {
      monitor.reviveAllCooldowns();
      return c.json({
        success: true,
        changed: true,
        stats: monitor.getFleetStats(),
        snapshot: monitor.getCockpitSnapshot(),
        reports: monitor.getFleetReport(),
      });
    }

    if (!provider) {
      return c.json({ success: false, error: "Provider is required for key action" }, 400);
    }
    if (!target) {
      return c.json(
        { success: false, error: "keyId or maskedKey is required for key action" },
        400,
      );
    }

    if (!monitor.hasKey(provider, target)) {
      return c.json(
        {
          success: false,
          error: `Key '${target}' not found under provider '${provider}'`,
        },
        404,
      );
    }

    let changed = false;
    if (action === "revive") {
      changed = monitor.reviveKey(provider, target);
    } else if (action === "cooldown") {
      const cooldownMs =
        typeof body.cooldownMs === "number" && body.cooldownMs > 0 ? body.cooldownMs : 60_000;
      changed = monitor.cooldownKey(provider, target, cooldownMs);
    } else if (action === "evict") {
      changed = monitor.evictKey(provider, target);
    }

    return c.json({
      success: true,
      changed,
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
    const from =
      (typeof body.from === "string" ? body.from : "operator").trim().slice(0, 64) || "operator";
    const to =
      (typeof body.to === "string" ? body.to : "coder").toLowerCase().trim().slice(0, 64) ||
      "coder";
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
    if (!coordinator.hasAgent(to)) {
      return c.json(
        { success: false, error: `Recipient agent '${to}' is not registered in swarm` },
        400,
      );
    }

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

    if (Array.isArray(body.files) && body.files.length > 50) {
      return c.json({ success: false, error: "Too many files provided (maximum 50)" }, 400);
    }
    if (Array.isArray(body.proposedCommands) && body.proposedCommands.length > 20) {
      return c.json(
        { success: false, error: "Too many proposed commands provided (maximum 20)" },
        400,
      );
    }

    const files = Array.isArray(body.files)
      ? (body.files
          .filter((f: unknown) => typeof f === "string" && f.trim())
          .map((f: string) => f.slice(0, 1024))
          .slice(0, 50) as string[])
      : undefined;
    const proposedCommands = Array.isArray(body.proposedCommands)
      ? (body.proposedCommands
          .filter((p: unknown) => typeof p === "string" && p.trim())
          .map((p: string) => p.slice(0, 4096))
          .slice(0, 20) as string[])
      : undefined;
    const maxRounds =
      typeof body.maxRounds === "number"
        ? Math.min(Math.max(1, Math.floor(body.maxRounds)), 10)
        : 3;
    const simulate = body.simulate === true;

    const coordinator = runtime.coordinator;

    if (coordinator.getPendingTaskCount() >= 10) {
      return c.json(
        {
          success: false,
          error: "Swarm task queue limit reached (10). Project is under backpressure.",
        },
        429,
      );
    }

    if (body.async === true) {
      const taskId =
        typeof body.id === "string" && body.id.trim()
          ? body.id.trim()
          : `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      void coordinator
        .runTask({
          id: taskId,
          goal,
          files,
          proposedCommands,
          maxRounds,
          simulate,
        })
        .catch(() => {});
      return c.json({ success: true, accepted: true, taskId }, 202);
    }

    try {
      const result = await coordinator.runTask({
        id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
        goal,
        files,
        proposedCommands,
        maxRounds,
        simulate,
      });

      if (!simulate && result && (result as { status?: string }).status === "unhandled") {
        return c.json(
          {
            success: false,
            error:
              "Autonomous swarm execution failed: no task handler configured for project and simulation mode was not requested.",
            result,
          },
          400,
        );
      }

      return c.json({
        success: result.status === "settled",
        ...(result.status !== "settled"
          ? { error: `Swarm task ended with status: ${result.status}` }
          : {}),
        result,
      });
    } catch (err: unknown) {
      const isBackpressure =
        (typeof err === "object" &&
          err !== null &&
          "status" in err &&
          (err as { status: number }).status === 429) ||
        (err instanceof Error && err.message.includes("backpressure"));
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        isBackpressure ? 429 : 500,
      );
    }
  });

  return app;
}
