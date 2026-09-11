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
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import { KanbanBoard } from "@prismshadow/penguin-core";
import type { KanbanTaskPriority, KanbanTaskState } from "@prismshadow/penguin-core";

const projectBoards = new Map<string, KanbanBoard>();

function getOrCreateBoard(projectId: string): KanbanBoard {
  let board = projectBoards.get(projectId);
  if (!board) {
    board = new KanbanBoard({ boardId: projectId });
    projectBoards.set(projectId, board);
  }
  return board;
}

export function kanbanRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /tasks
  app.get("/tasks", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);

    const state = c.req.query("state") as KanbanTaskState | undefined;
    const priority = c.req.query("priority") as KanbanTaskPriority | undefined;
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
    const board = getOrCreateBoard(projectId);
    const body = await readJson(c);

    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const description = typeof body.description === "string" ? body.description : undefined;
    const priority = typeof body.priority === "string" ? (body.priority as KanbanTaskPriority) : "normal";
    const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId : undefined;
    const dependencies = Array.isArray(body.dependencies) ? body.dependencies.map(String) : undefined;

    const task = board.createTask({
      title,
      description,
      priority,
      parentTaskId,
      dependencies,
    });

    return c.json({ task }, 201);
  });

  // PATCH /tasks/:taskId/state
  app.patch("/tasks/:taskId/state", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);
    const taskId = c.req.param("taskId");
    const body = await readJson(c);

    const nextState = requireString(body, "state", { minLen: 1, maxLen: 30, label: "state" }) as KanbanTaskState;
    const force = body.force === true;

    try {
      const task = board.updateTaskState(taskId, nextState, { force });
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /tasks/:taskId/claim
  app.post("/tasks/:taskId/claim", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);
    const taskId = c.req.param("taskId");
    const body = await readJson(c);

    const assignee = requireString(body, "assignee", { minLen: 1, maxLen: 100, label: "assignee" });
    const leaseDurationMs = typeof body.leaseDurationMs === "number" ? body.leaseDurationMs : undefined;
    const workerPid = typeof body.workerPid === "number" ? body.workerPid : undefined;

    try {
      const task = board.claimTask(taskId, assignee, { leaseDurationMs, workerPid });
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /tasks/:taskId/heartbeat
  app.post("/tasks/:taskId/heartbeat", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);
    const taskId = c.req.param("taskId");

    try {
      const task = board.heartbeat(taskId);
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /tasks/:taskId/release
  app.post("/tasks/:taskId/release", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);
    const taskId = c.req.param("taskId");

    try {
      const task = board.releaseTask(taskId);
      return c.json({ task });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // POST /triage/draft
  app.post("/triage/draft", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);
    const body = await readJson(c);

    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const draftBody = requireString(body, "body", { minLen: 1, maxLen: 10000, label: "body" });
    const suggestedTasks = Array.isArray(body.suggestedTasks) ? (body.suggestedTasks as any[]) : [];

    const draft = board.createTriageDraft({
      title,
      body: draftBody,
      suggestedTasks,
    });

    return c.json({ draft }, 201);
  });

  // POST /triage/drafts/:draftId/launch
  app.post("/triage/drafts/:draftId/launch", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const board = getOrCreateBoard(projectId);
    const draftId = c.req.param("draftId");

    try {
      const launched = board.launchTriage(draftId);
      return c.json(launched);
    } catch (err) {
      throw notFound((err as Error).message);
    }
  });

  return app;
}
