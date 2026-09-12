/**
 * Kanban & Multi-Agent Task Orchestration Routes.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import { KanbanBoard } from "@prismshadow/penguin-core";
import type {
  KanbanTaskPriority,
  KanbanTaskState,
  KanbanTask,
  TriageDraft,
} from "@prismshadow/penguin-core";
import { ProjectJsonStore } from "../../services/project-json-store.js";

const ALLOWED_STATES: readonly KanbanTaskState[] = [
  "backlog",
  "triage",
  "in_progress",
  "review",
  "done",
  "archived",
  "failed",
];
const ALLOWED_PRIORITIES: readonly KanbanTaskPriority[] = ["low", "normal", "high", "urgent"];

type PersistedBoard = { tasks: KanbanTask[]; drafts: TriageDraft[] };

function decodeBoard(raw: string): PersistedBoard {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Kanban persistence file must contain a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.tasks !== undefined && !Array.isArray(record.tasks)) {
    throw new Error("Kanban persistence field 'tasks' must be an array.");
  }
  if (record.drafts !== undefined && !Array.isArray(record.drafts)) {
    throw new Error("Kanban persistence field 'drafts' must be an array.");
  }
  return {
    tasks: (record.tasks as KanbanTask[] | undefined) ?? [],
    drafts: (record.drafts as TriageDraft[] | undefined) ?? [],
  };
}

function hydrateBoard(projectId: string, state: PersistedBoard): KanbanBoard {
  const board = new KanbanBoard({ boardId: projectId });
  board.importState(state);
  return board;
}

function requireGeneration(body: Record<string, unknown>): number {
  if (!Number.isInteger(body.generation) || (body.generation as number) < 0) {
    throw badRequest("generation must be a non-negative integer.");
  }
  return body.generation as number;
}

export function kanbanRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = new ProjectJsonStore<PersistedBoard>(
    deps.config.root,
    ".kanban.json",
    () => ({ tasks: [], drafts: [] }),
    decodeBoard,
  );

  app.get("/tasks", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = hydrateBoard(projectId, await store.read(projectId));

    const rawState = c.req.query("state");
    let state: KanbanTaskState | undefined;
    if (rawState) {
      if (!ALLOWED_STATES.includes(rawState as KanbanTaskState)) {
        throw badRequest(`Invalid state filter '${rawState}'. Allowed: ${ALLOWED_STATES.join(", ")}`);
      }
      state = rawState as KanbanTaskState;
    }

    const rawPriority = c.req.query("priority");
    let priority: KanbanTaskPriority | undefined;
    if (rawPriority) {
      if (!ALLOWED_PRIORITIES.includes(rawPriority as KanbanTaskPriority)) {
        throw badRequest(
          `Invalid priority filter '${rawPriority}'. Allowed: ${ALLOWED_PRIORITIES.join(", ")}`,
        );
      }
      priority = rawPriority as KanbanTaskPriority;
    }

    const assignee = c.req.query("assignee");
    return c.json({
      tasks: board.listTasks({
        state,
        priority,
        assignee: assignee !== undefined ? assignee : undefined,
      }),
    });
  });

  app.post("/tasks", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const description = typeof body.description === "string" ? body.description : undefined;

    let priority: KanbanTaskPriority = "normal";
    if (body.priority !== undefined) {
      const value = requireString(body, "priority", { minLen: 1, maxLen: 30, label: "priority" }) as KanbanTaskPriority;
      if (!ALLOWED_PRIORITIES.includes(value)) {
        throw badRequest(`Invalid priority '${value}'. Allowed: ${ALLOWED_PRIORITIES.join(", ")}`);
      }
      priority = value;
    }

    let state: KanbanTaskState | undefined;
    if (body.state !== undefined) {
      const value = requireString(body, "state", { minLen: 1, maxLen: 30, label: "state" }) as KanbanTaskState;
      if (!ALLOWED_STATES.includes(value)) {
        throw badRequest(`Invalid state '${value}'. Allowed: ${ALLOWED_STATES.join(", ")}`);
      }
      state = value;
    }

    const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId : undefined;
    const dependencies = Array.isArray(body.dependencies) ? body.dependencies.map(String) : undefined;

    try {
      const task = await store.update(projectId, (current) => {
        const board = hydrateBoard(projectId, current);
        const created = board.createTask({ title, description, state, priority, parentTaskId, dependencies });
        return { value: board.exportState(), result: created };
      });
      return c.json({ task }, 201);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  app.patch("/tasks/:taskId/state", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    const nextState = requireString(body, "state", { minLen: 1, maxLen: 30, label: "state" }) as KanbanTaskState;
    if (!ALLOWED_STATES.includes(nextState)) {
      throw badRequest(`Invalid state '${nextState}'. Allowed: ${ALLOWED_STATES.join(", ")}`);
    }

    const force = body.force === true;
    if (force) deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    else deps.projectService.requireProjectAccess(c.var.user.userId, projectId);

    try {
      const task = await store.update(projectId, (current) => {
        const board = hydrateBoard(projectId, current);
        const existing = board.getTask(taskId);
        if (!existing) throw new Error(`Task with id '${taskId}' not found`);

        let workerId: string | undefined;
        let generation: number | undefined;
        if (!force && (existing.assignee || (existing.leaseGeneration ?? 0) > 0)) {
          // Once a task has ever been leased, non-owner state changes remain fenced even after
          // release/reclamation. A replacement worker must claim a fresh generation first; stale
          // workers cannot bypass fencing simply by omitting their old identity after assignee clears.
          workerId = requireString(body, "workerId", { minLen: 1, maxLen: 100, label: "workerId" });
          generation = requireGeneration(body);
        }
        const updated = board.updateTaskState(taskId, nextState, { force, workerId, generation });
        return { value: board.exportState(), result: updated };
      });
      return c.json({ task });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  app.post("/tasks/:taskId/claim", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    const assignee =
      typeof body.workerId === "string" && body.workerId.length > 0
        ? body.workerId
        : requireString(body, "assignee", { minLen: 1, maxLen: 100, label: "assignee" });
    const leaseDurationMs = typeof body.leaseDurationMs === "number" ? body.leaseDurationMs : undefined;
    const workerPid = typeof body.workerPid === "number" ? body.workerPid : undefined;

    try {
      const task = await store.update(projectId, (current) => {
        const board = hydrateBoard(projectId, current);
        const claimed = board.claimTask(taskId, assignee, { leaseDurationMs, workerPid });
        return { value: board.exportState(), result: claimed };
      });
      return c.json({ task });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  app.post("/tasks/:taskId/heartbeat", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    const workerId = requireString(body, "workerId", { minLen: 1, maxLen: 100, label: "workerId" });
    const generation = requireGeneration(body);
    const leaseDurationMs = typeof body.leaseDurationMs === "number" ? body.leaseDurationMs : undefined;

    try {
      const task = await store.update(projectId, (current) => {
        const board = hydrateBoard(projectId, current);
        const updated = board.heartbeat(taskId, { workerId, generation, leaseDurationMs });
        return { value: board.exportState(), result: updated };
      });
      return c.json({ task });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  app.post("/tasks/:taskId/release", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const taskId = requireValidId(c, "taskId");
    const body = await readJson(c);
    const workerId = requireString(body, "workerId", { minLen: 1, maxLen: 100, label: "workerId" });
    const generation = requireGeneration(body);

    try {
      const task = await store.update(projectId, (current) => {
        const board = hydrateBoard(projectId, current);
        const released = board.releaseTask(taskId, { workerId, generation });
        return { value: board.exportState(), result: released };
      });
      return c.json({ task });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
  });

  app.post("/triage/draft", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const draftBody = requireString(body, "body", { minLen: 1, maxLen: 10000, label: "body" });
    const suggestedTasks = Array.isArray(body.suggestedTasks) ? body.suggestedTasks : [];

    const draft = await store.update(projectId, (current) => {
      const board = hydrateBoard(projectId, current);
      const created = board.createTriageDraft({
        title,
        body: draftBody,
        suggestedTasks: suggestedTasks as TriageDraft["suggestedTasks"],
      });
      return { value: board.exportState(), result: created };
    });
    return c.json({ draft }, 201);
  });

  app.post("/triage/drafts/:draftId/launch", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const draftId = requireValidId(c, "draftId");
    try {
      const launched = await store.update(projectId, (current) => {
        const board = hydrateBoard(projectId, current);
        const result = board.launchTriage(draftId);
        return { value: board.exportState(), result };
      });
      return c.json(launched);
    } catch (error) {
      throw notFound((error as Error).message);
    }
  });

  return app;
}
