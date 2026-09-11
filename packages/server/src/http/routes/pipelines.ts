/**
 * Autonomous Workflow Pipelines & Persona Presets Routes:
 * GET    /api/projects/:projectId/pipelines - list pipeline definitions
 * POST   /api/projects/:projectId/pipelines - create pipeline
 * POST   /api/projects/:projectId/pipelines/:pipelineId/runs - create run
 * GET    /api/projects/:projectId/pipelines/:pipelineId/runs/:runId - get run
 * POST   /api/projects/:projectId/pipelines/:pipelineId/runs/:runId/nodes/:nodeId/complete - step run
 * GET    /api/personas - list personas
 * GET    /api/personas/:personaId - get persona
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  WorkflowPipeline,
  PersonaRegistry,
  BUILTIN_PERSONA_MASKS,
} from "@prismshadow/penguin-core";
import type { WorkflowNode, WorkflowEdge, WorkflowRunState } from "@prismshadow/penguin-core";

const projectPipelines = new Map<string, Map<string, WorkflowPipeline>>();
const activeRuns = new Map<string, WorkflowRunState>();
const personaRegistry = new PersonaRegistry(BUILTIN_PERSONA_MASKS);

function getProjectPipelineMap(projectId: string): Map<string, WorkflowPipeline> {
  let map = projectPipelines.get(projectId);
  if (!map) {
    map = new Map<string, WorkflowPipeline>();
    projectPipelines.set(projectId, map);
  }
  return map;
}

export function pipelineRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /pipelines
  app.get("/pipelines", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = getProjectPipelineMap(projectId);

    const pipelines = Array.from(map.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      nodeCount: p.listNodes().length,
      edgeCount: p.listEdges().length,
    }));

    return c.json({ pipelines });
  });

  // POST /pipelines
  app.post("/pipelines", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = getProjectPipelineMap(projectId);
    const body = await readJson(c);

    const id = requireString(body, "id", { minLen: 1, maxLen: 64, label: "id" });
    const name = requireString(body, "name", { minLen: 1, maxLen: 200, label: "name" });
    const description = typeof body.description === "string" ? body.description : undefined;
    const nodes = Array.isArray(body.nodes) ? (body.nodes as WorkflowNode[]) : [];
    const edges = Array.isArray(body.edges) ? (body.edges as WorkflowEdge[]) : [];

    const pipeline = new WorkflowPipeline({ id, name, description, nodes, edges });
    const check = pipeline.validateDAG();
    if (!check.isValid) {
      throw badRequest(`Invalid DAG: ${check.errors.join("; ")}`);
    }

    map.set(id, pipeline);
    return c.json({
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description,
      nodes: pipeline.listNodes(),
      edges: pipeline.listEdges(),
    }, 201);
  });

  // POST /pipelines/:pipelineId/runs
  app.post("/pipelines/:pipelineId/runs", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = getProjectPipelineMap(projectId);
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
    activeRuns.set(run.runId, run);

    return c.json({ run }, 201);
  });

  // GET /pipelines/:pipelineId/runs/:runId
  app.get("/pipelines/:pipelineId/runs/:runId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const runId = c.req.param("runId");

    const run = activeRuns.get(runId);
    if (!run) {
      throw notFound(`Pipeline run '${runId}' not found`);
    }

    return c.json({ run });
  });

  // POST /pipelines/:pipelineId/runs/:runId/nodes/:nodeId/complete
  app.post("/pipelines/:pipelineId/runs/:runId/nodes/:nodeId/complete", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const map = getProjectPipelineMap(projectId);
    const pipelineId = c.req.param("pipelineId");
    const runId = c.req.param("runId");
    const nodeId = c.req.param("nodeId");

    const pipeline = map.get(pipelineId);
    if (!pipeline) {
      throw notFound(`Pipeline '${pipelineId}' not found`);
    }

    const run = activeRuns.get(runId);
    if (!run) {
      throw notFound(`Pipeline run '${runId}' not found`);
    }

    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;
    const output = typeof body.output === "object" && body.output !== null ? (body.output as Record<string, unknown>) : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;

    try {
      const updatedRun = pipeline.completeNode(run, nodeId, { output, error });
      activeRuns.set(runId, updatedRun);
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
