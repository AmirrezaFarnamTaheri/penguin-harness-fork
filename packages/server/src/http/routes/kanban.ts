/**
 * Kanban & Multi-Agent Task Orchestration Routes:
 * GET    /api/projects/:projectId/kanban/tasks - list tasks
 * POST   /api/projects/:projectId/kanban/tasks - create task
 * PATCH  /api/projects/:projectId/kanban/tasks/:taskId/state - update state
 * POST   /api/projects/:projectId/kanban/tasks/:taskId/claim - claim task
 * POST   /api/projects/:projectId/kanban/tasks/:taskId/heartbeat - heartbeat
 * POST   /api/projects/:projectId/kanban/tasks/:taskId/release - release task
 * POST   /api/projects/:projectId/kanban/triage/draft - create triage draft
 * POST   /api/projects/:projectId/kanban/triage/drafts/:draftId/launch - launch draft
 */
import path from "node:path";
import fs from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import { KanbanBoard, projectDir, atomicWriteFile } from "@prismshadow/penguin-core";
import type { KanbanTaskPriority, KanbanTaskState } from "@prismshadow/penguin-core";

const ALLOWED_STATES: readonly KanbanTaskState[] = [
  "backlog",
  "triage",
  "in_progress",
  "review",
  "done",
  "archived",
  "failed",
];

const ALLOWED_PRIORITIES: readonly KanbanTaskPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

const projectBoards = new Map<string, KanbanBoard>();

async function getOrCreateBoard(root: string, projectId: string): Promise<KanbanBoard> {
  let board = projectBoards.get(projectId);
  if (!board) {
    board = new KanbanBoard({ boardId: projectId });
    projectBoards.set(projectId, board);
    try {
      const pDir = projectDir(root, projectId);
      const filePath = path.join(pDir, ".kanban.json");
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") {
        board.importState(parsed);
      }
    } catch {
      // Start empty if not yet saved
    }
  }
  return board;
}

async function saveBoard(root: string, projectId: string): Promise<void> {
  const board = projectBoards.get(projectId);
  if (!board) return;
  try {
    const pDir = projectDir(root, projectId);
    await fs.mkdir(pDir, { recursive: true });
    const filePath = path.join(pDir, ".kanban.json");
    await atomicWriteFile(filePath, JSON.stringify(board.exportState(), null, 2));
  } catch {
    // Disk write error recovery
  }
}

export function kanbanRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /tasks
  app.get("/tasks", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);

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
        throw badRequest(`Invalid priority filter '${rawPriority}'. Allowed: ${ALLOWED_PRIORITIES.join(", ")}`);
      }
      priority = rawPriority as KanbanTaskPriority;
    }

    const assignee = c.req.query("assignee");

    const tasks = board.listTasks({
      state,
      priority,
      assignee: assignee !== undefined ? assignee : undefined,
    });

    return c.json({ tasks });
  });

  // POST /tasks
  app.post("/tasks", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const body = await readJson(c);

    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const description = typeof body.description === "string" ? body.description : undefined;

    let priority: KanbanTaskPriority = "normal";
    if (body.priority !== undefined) {
      const p = requireString(body, "priority", { minLen: 1, maxLen: 30, label: "priority" }) as KanbanTaskPriority;
      if (!ALLOWED_PRIORITIES.includes(p)) {
        throw badRequest(`Invalid priority '${p}'. Allowed: ${ALLOWED_PRIORITIES.join(", ")}`);
      }
      priority = p;
    }

    let state: KanbanTaskState | undefined;
    if (body.state !== undefined) {
      const s = requireString(body, "state", { minLen: 1, maxLen: 30, label: "state" }) as KanbanTaskState;
      if (!ALLOWED_STATES.includes(s)) {
        throw badRequest(`Invalid state '${s}'. Allowed: ${ALLOWED_STATES.join(", ")}`);
      }
      state = s;
    }

    const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId : undefined;
    const dependencies = Array.isArray(body.dependencies) ? body.dependencies.map(String) : undefined;

    const task = board.createTask({
      title,
      description,
      state,
      priority,
      parentTaskId,
      dependencies,
    });

    await saveBoard(deps.config.root, projectId);
    return c.json({ task }, 201);
  });

  // PATCH /tasks/:taskId/state
  app.patch("/tasks/:taskId/state", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const taskId = c.req.param("taskId");
    const body = await readJson(c);

    const nextStateRaw = requireString(body, "state", { minLen: 1, maxLen: 30, label: "state" }) as KanbanTaskState;
    if (!ALLOWED_STATES.includes(nextStateRaw)) {
      throw badRequest(`Invalid state '${nextStateRaw}'. Allowed: ${ALLOWED_STATES.join(", ")}`);
    }
    const force = body.force === true;
    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const generation = typeof body.generation === "number" ? body.generation : undefined;

    try {
      const task = board.updateTaskState(taskId, nextStateRaw, { force, workerId, generation });
      await saveBoard(deps.config.root, projectId);
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /tasks/:taskId/claim
  app.post("/tasks/:taskId/claim", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const taskId = c.req.param("taskId");
    const body = await readJson(c);

    const assignee = typeof body.workerId === "string" && body.workerId.length > 0
      ? body.workerId
      : requireString(body, "assignee", { minLen: 1, maxLen: 100, label: "assignee" });
    const leaseDurationMs = typeof body.leaseDurationMs === "number" ? body.leaseDurationMs : undefined;
    const workerPid = typeof body.workerPid === "number" ? body.workerPid : undefined;

    try {
      const task = board.claimTask(taskId, assignee, { leaseDurationMs, workerPid });
      await saveBoard(deps.config.root, projectId);
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /tasks/:taskId/heartbeat
  app.post("/tasks/:taskId/heartbeat", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const taskId = c.req.param("taskId");
    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;

    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const generation = typeof body.generation === "number" ? body.generation : undefined;
    const leaseDurationMs = typeof body.leaseDurationMs === "number" ? body.leaseDurationMs : undefined;

    try {
      const task = board.heartbeat(taskId, { workerId, generation, leaseDurationMs });
      await saveBoard(deps.config.root, projectId);
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /tasks/:taskId/release
  app.post("/tasks/:taskId/release", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const taskId = c.req.param("taskId");
    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;

    const workerId = typeof body.workerId === "string" ? body.workerId : undefined;
    const generation = typeof body.generation === "number" ? body.generation : undefined;

    try {
      const task = board.releaseTask(taskId, { workerId, generation });
      await saveBoard(deps.config.root, projectId);
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /triage/draft
  app.post("/triage/draft", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const body = await readJson(c);

    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const draftBody = requireString(body, "body", { minLen: 1, maxLen: 10000, label: "body" });
    const suggestedTasks = Array.isArray(body.suggestedTasks) ? (body.suggestedTasks as any[]) : [];

    const draft = board.createTriageDraft({
      title,
      body: draftBody,
      suggestedTasks,
    });

    await saveBoard(deps.config.root, projectId);
    return c.json({ draft }, 201);
  });

  // POST /triage/drafts/:draftId/launch
  app.post("/triage/drafts/:draftId/launch", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = await getOrCreateBoard(deps.config.root, projectId);
    const draftId = c.req.param("draftId");

    try {
      const launched = board.launchTriage(draftId);
      await saveBoard(deps.config.root, projectId);
      return c.json(launched);
    } catch (err) {
      throw notFound((err as Error).message);
    }
  });

  return app;
}
