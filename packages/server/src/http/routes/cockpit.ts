/**
 * Cockpit HTTP routes: telemetry snapshot and autonomous swarm invocation.
 */
import { Hono } from "hono";
import { DEFAULT_PROJECT_ID, isValidId } from "@prismshadow/penguin-core";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import type { ErrorBody } from "../../api/types.js";
import { errorBody, handleError, HttpError } from "../errors.js";
import { readJson } from "../validate.js";
import {
  getOrCreateProjectRuntime,
  buildCockpitSnapshot,
  type CockpitWebSocketDeps,
  type ProjectCockpitRuntime,
} from "../../cockpit/ws.js";

export function cockpitRoutes(
  deps?: AppDeps,
  standaloneRuntime?: Pick<CockpitWebSocketDeps, "workspaceRoot" | "swarmHandlers">,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(async (error, c) => {
    deps?.errors.record({ source: "http", err: error });
    const response = handleError(error, c);
    const body = (await response.json()) as ErrorBody;
    return c.json({ success: false, ...body }, response.status as 400);
  });

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
    if (projectId.length > 128 || !isValidId(projectId))
      throw new HttpError(
        400,
        "invalid_project_id",
        "Project id must be a valid identifier of at most 128 characters.",
      );
    authorizeProject(c, projectId);
    const wsDeps: CockpitWebSocketDeps = deps
      ? {
          authService: deps.authService,
          projectService: deps.projectService,
          projectConfigService: deps.projectConfigService,
          root: deps.config.root,
          swarmHandlers: deps.cockpitSwarmHandlers,
        }
      : (standaloneRuntime ?? {});
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
    const body = await readJson(c);
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
      ...(result.status !== "ok"
        ? errorBody("key_probe_failed", "Provider key probe did not succeed.")
        : {}),
      result,
    });
  });

  app.post("/keys/action", async (c) => {
    const body = await readJson(c);
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : getProjectId(c);
    const runtime = await getRuntime(c, projectId);
    const action = body.action;

    if (
      typeof action !== "string" ||
      !["revive", "cooldown", "evict", "revive_all"].includes(action)
    ) {
      return c.json(
        {
          success: false,
          ...errorBody(
            "invalid_key_action",
            "Action must be one of: revive, cooldown, evict, revive_all.",
          ),
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
      return c.json(
        {
          success: false,
          ...errorBody("provider_required", "Provider is required for key action"),
        },
        400,
      );
    }
    if (!target) {
      return c.json(
        {
          success: false,
          ...errorBody("key_required", "keyId or maskedKey is required for key action"),
        },
        400,
      );
    }

    if (!monitor.hasKey(provider, target)) {
      return c.json(
        {
          success: false,
          ...errorBody("key_not_found", "Key not found under the requested provider."),
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
    const body = await readJson(c);
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
      return c.json(
        { success: false, ...errorBody("directive_empty", "Directive content cannot be empty") },
        400,
      );
    }
    if (trimmed.length > 8192) {
      return c.json(
        {
          success: false,
          ...errorBody(
            "directive_too_long",
            "Directive content exceeds maximum length of 8192 characters",
          ),
        },
        400,
      );
    }

    const coordinator = runtime.coordinator;
    if (!coordinator.hasAgent(to)) {
      return c.json(
        {
          success: false,
          ...errorBody("recipient_not_found", "Recipient agent is not registered in swarm"),
        },
        400,
      );
    }

    const summaries = coordinator.getMailboxSummaries();
    const targetSummary = summaries[to];
    if (targetSummary && targetSummary.queueDepth >= 100) {
      return c.json(
        {
          success: false,
          ...errorBody("mailbox_capacity", "Mailbox queue exceeds capacity (max 100 pending)"),
        },
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
    const body = await readJson(c);
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : getProjectId(c);
    const runtime = await getRuntime(c, projectId);
    const goal = typeof body.goal === "string" ? body.goal.slice(0, 4096) : "Autonomous local task";

    if (Array.isArray(body.files) && body.files.length > 50) {
      return c.json(
        { success: false, ...errorBody("too_many_files", "Too many files provided (maximum 50)") },
        400,
      );
    }
    if (Array.isArray(body.proposedCommands) && body.proposedCommands.length > 20) {
      return c.json(
        {
          success: false,
          ...errorBody("too_many_commands", "Too many proposed commands provided (maximum 20)"),
        },
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

    if (!simulate && !runtime.swarmHandlers?.onExecute) {
      throw new HttpError(
        400,
        "swarm_handler_missing",
        "No task handler configured for this project; request simulation explicitly.",
      );
    }

    if (coordinator.getPendingTaskCount() >= 10) {
      return c.json(
        {
          success: false,
          ...errorBody(
            "swarm_capacity",
            "Swarm task queue limit reached (10). Project is under backpressure.",
          ),
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
        .runTask(
          {
            id: taskId,
            goal,
            files,
            proposedCommands,
            maxRounds,
            simulate,
          },
          runtime.swarmHandlers,
        )
        .catch(() => {});
      return c.json({ success: true, accepted: true, taskId }, 202);
    }

    try {
      const result = await coordinator.runTask(
        {
          id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
          goal,
          files,
          proposedCommands,
          maxRounds,
          simulate,
        },
        runtime.swarmHandlers,
      );

      if (!simulate && result && (result as { status?: string }).status === "unhandled") {
        return c.json(
          {
            success: false,
            ...errorBody(
              "swarm_handler_missing",
              "Autonomous swarm execution failed: no task handler configured for project and simulation mode was not requested.",
            ),
            result,
          },
          400,
        );
      }

      return c.json({
        success: result.status === "settled",
        ...(result.status !== "settled"
          ? errorBody("swarm_task_failed", `Swarm task ended with status: ${result.status}`)
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
      if (isBackpressure)
        throw new HttpError(429, "swarm_capacity", "Swarm task queue is at capacity.");
      throw err;
    }
  });

  return app;
}
