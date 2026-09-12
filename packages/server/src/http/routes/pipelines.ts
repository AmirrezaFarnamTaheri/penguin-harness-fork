/**
 * Autonomous Workflow Pipelines & Persona Presets Routes:
 * Mounted at /api/projects/:projectId/pipelines
 * GET    / - list pipeline definitions
 * POST   / - create pipeline
 * POST   /:pipelineId/runs - create run
 * GET    /:pipelineId/runs/:runId - get run
 * POST   /:pipelineId/runs/:runId/nodes/:nodeId/complete - step run
 * Persona Presets:
 * GET    /api/personas - list personas
 * GET    /api/personas/:personaId - get persona
 */
import { Hono } from "hono";
import path from "node:path";
import fs from "node:fs/promises";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  WorkflowPipeline,
  PersonaRegistry,
  BUILTIN_PERSONA_MASKS,
  projectDir,
  atomicWriteFile,
} from "@prismshadow/penguin-core";
import type { WorkflowNode, WorkflowEdge, WorkflowRunState, WorkflowNodeKind } from "@prismshadow/penguin-core";

export interface ScopedRunRecord {
  projectId: string;
  pipelineId: string;
  run: WorkflowRunState;
}

const projectPipelines = new Map<string, Map<string, WorkflowPipeline>>();
const activeRuns = new Map<string, ScopedRunRecord>();
const personaRegistry = new PersonaRegistry(BUILTIN_PERSONA_MASKS);

const ALLOWED_NODE_KINDS: readonly WorkflowNodeKind[] = ["trigger", "agent", "condition", "gate", "output"];

async function getProjectPipelineMap(root: string, projectId: string): Promise<Map<string, WorkflowPipeline>> {
  let map = projectPipelines.get(projectId);
  if (!map) {
    map = new Map<string, WorkflowPipeline>();
    projectPipelines.set(projectId, map);
    try {
      const pDir = projectDir(root, projectId);
      const filePath = path.join(pDir, ".pipelines.json");
      const content = await fs.readFile(filePath, "utf-8");
      const list = JSON.parse(content);
      if (Array.isArray(list)) {
        for (const item of list) {
          map.set(item.id, new WorkflowPipeline(item));
        }
      }
    } catch {
      // File doesn't exist yet or unparseable, start empty
    }
  }
  return map;
}

async function saveProjectPipelines(root: string, projectId: string): Promise<void> {
  const map = projectPipelines.get(projectId);
  if (!map) return;
  try {
    const pDir = projectDir(root, projectId);
    await fs.mkdir(pDir, { recursive: true });
    const filePath = path.join(pDir, ".pipelines.json");
    const list = Array.from(map.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      nodes: p.listNodes(),
      edges: p.listEdges(),
    }));
    await atomicWriteFile(filePath, JSON.stringify(list, null, 2));
  } catch {
    // Disk write error recovery
  }
}

async function loadProjectRuns(root: string, projectId: string): Promise<void> {
  try {
    const pDir = projectDir(root, projectId);
    const filePath = path.join(pDir, ".pipeline_runs.json");
    const content = await fs.readFile(filePath, "utf-8");
    const list = JSON.parse(content);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.run && item.projectId === projectId) {
          activeRuns.set(item.run.runId, item);
        }
      }
    }
  } catch {
    // Start empty if file does not exist
  }
}

async function saveProjectRuns(root: string, projectId: string): Promise<void> {
  try {
    const pDir = projectDir(root, projectId);
    await fs.mkdir(pDir, { recursive: true });
    const filePath = path.join(pDir, ".pipeline_runs.json");
    const list = Array.from(activeRuns.values()).filter((r) => r.projectId === projectId);
    await atomicWriteFile(filePath, JSON.stringify(list, null, 2));
  } catch {
    // Disk write error recovery
  }
}

export function pipelineRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET / (list pipelines)
  app.get("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = await getProjectPipelineMap(deps.config.root, projectId);

    const pipelines = Array.from(map.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      nodeCount: p.listNodes().length,
      edgeCount: p.listEdges().length,
    }));

    return c.json({ pipelines });
  });

  // POST / (create pipeline)
  app.post("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = await getProjectPipelineMap(deps.config.root, projectId);
    const body = await readJson(c);

    const id = requireString(body, "id", { minLen: 1, maxLen: 64, label: "id" });
    const name = requireString(body, "name", { minLen: 1, maxLen: 200, label: "name" });
    const description = typeof body.description === "string" ? body.description : undefined;

    if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
      throw badRequest("nodes must be a non-empty array of workflow node objects");
    }

    const seenIds = new Set<string>();
    const nodes: WorkflowNode[] = [];
    for (let i = 0; i < body.nodes.length; i++) {
      const item = body.nodes[i];
      if (typeof item !== "object" || item === null) {
        throw badRequest(`nodes[${i}] must be an object`);
      }
      const raw = item as Record<string, unknown>;
      const nodeId = requireString(raw, "id", { minLen: 1, maxLen: 64, label: `nodes[${i}].id` });
      if (seenIds.has(nodeId)) {
        throw badRequest(`Duplicate node ID '${nodeId}' at nodes[${i}]`);
      }
      seenIds.add(nodeId);

      const nodeName = requireString(raw, "name", { minLen: 1, maxLen: 200, label: `nodes[${i}].name` });
      const kindStr = requireString(raw, "kind", { minLen: 1, maxLen: 32, label: `nodes[${i}].kind` }) as WorkflowNodeKind;
      if (!ALLOWED_NODE_KINDS.includes(kindStr)) {
        throw badRequest(`Invalid kind '${kindStr}' for node '${nodeId}'. Must be one of: ${ALLOWED_NODE_KINDS.join(", ")}`);
      }

      nodes.push({
        id: nodeId,
        name: nodeName,
        kind: kindStr,
        summary: typeof raw.summary === "string" ? raw.summary : undefined,
        agentRole: typeof raw.agentRole === "string" ? raw.agentRole : undefined,
        conditionField: typeof raw.conditionField === "string" ? raw.conditionField : undefined,
        conditionExpected: (typeof raw.conditionExpected === "string" || typeof raw.conditionExpected === "boolean" || typeof raw.conditionExpected === "number")
          ? raw.conditionExpected
          : undefined,
        config: typeof raw.config === "object" && raw.config !== null ? (raw.config as Record<string, unknown>) : undefined,
      });
    }

    const edges: WorkflowEdge[] = [];
    if (Array.isArray(body.edges)) {
      for (let i = 0; i < body.edges.length; i++) {
        const item = body.edges[i];
        if (typeof item !== "object" || item === null) {
          throw badRequest(`edges[${i}] must be an object`);
        }
        const raw = item as Record<string, unknown>;
        const from = requireString(raw, "from", { minLen: 1, maxLen: 64, label: `edges[${i}].from` });
        const to = requireString(raw, "to", { minLen: 1, maxLen: 64, label: `edges[${i}].to` });
        const conditionValue = (typeof raw.conditionValue === "string" || typeof raw.conditionValue === "boolean" || typeof raw.conditionValue === "number")
          ? raw.conditionValue
          : undefined;
        edges.push({ from, to, conditionValue });
      }
    }

    const pipeline = new WorkflowPipeline({ id, name, description, nodes, edges });
    const check = pipeline.validateDAG();
    if (!check.isValid) {
      throw badRequest(`Invalid DAG: ${check.errors.join("; ")}`);
    }

    map.set(id, pipeline);
    await saveProjectPipelines(deps.config.root, projectId);

    return c.json({
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      nodes: pipeline.listNodes(),
      edges: pipeline.listEdges(),
    }, 201);
  });

  // POST /:pipelineId/runs
  app.post("/:pipelineId/runs", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = await getProjectPipelineMap(deps.config.root, projectId);
    const pipelineId = c.req.param("pipelineId");

    const pipeline = map.get(pipelineId);
    if (!pipeline) {
      throw notFound(`Pipeline '${pipelineId}' not found in project`);
    }

    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;
    const initialContext = (typeof body.context === "object" && body.context !== null)
      ? (body.context as Record<string, unknown>)
      : {};

    const run = pipeline.createRun(initialContext);
    activeRuns.set(run.runId, { projectId, pipelineId, run });
    await saveProjectRuns(deps.config.root, projectId);

    return c.json({ run }, 201);
  });

  // GET /:pipelineId/runs/:runId
  app.get("/:pipelineId/runs/:runId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = c.req.param("pipelineId");
    const runId = c.req.param("runId");

    await loadProjectRuns(deps.config.root, projectId);
    const record = activeRuns.get(runId);
    if (!record || record.projectId !== projectId || record.pipelineId !== pipelineId) {
      throw notFound(`Pipeline run '${runId}' not found`);
    }

    return c.json({ run: record.run });
  });

  // POST /:pipelineId/runs/:runId/nodes/:nodeId/complete
  app.post("/:pipelineId/runs/:runId/nodes/:nodeId/complete", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = await getProjectPipelineMap(deps.config.root, projectId);
    const pipelineId = c.req.param("pipelineId");
    const runId = c.req.param("runId");
    const nodeId = c.req.param("nodeId");

    const pipeline = map.get(pipelineId);
    if (!pipeline) {
      throw notFound(`Pipeline '${pipelineId}' not found`);
    }

    await loadProjectRuns(deps.config.root, projectId);
    const record = activeRuns.get(runId);
    if (!record || record.projectId !== projectId || record.pipelineId !== pipelineId) {
      throw notFound(`Pipeline run '${runId}' not found`);
    }

    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;
    const output = typeof body.output === "object" && body.output !== null ? (body.output as Record<string, unknown>) : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;

    try {
      const updatedRun = pipeline.completeNode(record.run, nodeId, { output, error });
      record.run = updatedRun;
      await saveProjectRuns(deps.config.root, projectId);
      return c.json({ run: updatedRun });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  return app;
}

export function personaRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /personas
  app.get("/", async (c) => {
    const category = c.req.query("category");
    const personas = personaRegistry.listPersonas(category);
    return c.json({ personas });
  });

  // GET /personas/:personaId
  app.get("/:personaId", async (c) => {
    const personaId = c.req.param("personaId");
    const persona = personaRegistry.getPersona(personaId);
    if (!persona) {
      throw notFound(`Persona '${personaId}' not found`);
    }
    return c.json({ persona });
  });

  return app;
}
