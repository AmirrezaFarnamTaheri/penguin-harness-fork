/**
 * Autonomous Workflow Pipelines & Persona Presets Routes:
 * Mounted at /api/projects/:projectId/pipelines
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  WorkflowPipeline,
  PersonaRegistry,
  BUILTIN_PERSONA_MASKS,
} from "@prismshadow/penguin-core";
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowRunState,
  WorkflowNodeKind,
} from "@prismshadow/penguin-core";
import { ProjectJsonStore } from "../../services/project-json-store.js";

export interface PipelineDefinitionRecord {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface ScopedRunRecord {
  projectId: string;
  pipelineId: string;
  /** Immutable definition snapshot used for the lifetime of this run. */
  definition?: PipelineDefinitionRecord;
  run: WorkflowRunState;
}

const personaRegistry = new PersonaRegistry(BUILTIN_PERSONA_MASKS);

const ALLOWED_NODE_KINDS: readonly WorkflowNodeKind[] = [
  "trigger",
  "agent",
  "condition",
  "gate",
  "output",
];

function decodeArray<T>(label: string, raw: string): T[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} persistence file must contain a JSON array.`);
  }
  return parsed as T[];
}

function cloneDefinition(definition: PipelineDefinitionRecord): PipelineDefinitionRecord {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    nodes: definition.nodes.map((node) => ({
      ...node,
      config: node.config ? { ...node.config } : undefined,
    })),
    edges: definition.edges.map((edge) => ({ ...edge })),
  };
}

function definitionFromPipeline(pipeline: WorkflowPipeline): PipelineDefinitionRecord {
  return {
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    nodes: pipeline.listNodes(),
    edges: pipeline.listEdges(),
  };
}

export function pipelineRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const pipelines = new ProjectJsonStore<PipelineDefinitionRecord[]>(
    deps.config.root,
    ".pipelines.json",
    () => [],
    (raw) => decodeArray<PipelineDefinitionRecord>("Pipeline", raw),
  );
  const runs = new ProjectJsonStore<ScopedRunRecord[]>(
    deps.config.root,
    ".pipeline_runs.json",
    () => [],
    (raw) => decodeArray<ScopedRunRecord>("Pipeline run", raw),
  );

  // GET / (list pipelines)
  app.get("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const definitions = await pipelines.read(projectId);

    return c.json({
      pipelines: definitions.map((definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        nodeCount: definition.nodes.length,
        edgeCount: definition.edges.length,
      })),
    });
  });

  // POST / (create an immutable pipeline definition)
  app.post("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
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
      const nodeId = requireString(raw, "id", {
        minLen: 1,
        maxLen: 64,
        label: `nodes[${i}].id`,
      });
      if (seenIds.has(nodeId)) {
        throw badRequest(`Duplicate node ID '${nodeId}' at nodes[${i}]`);
      }
      seenIds.add(nodeId);

      const nodeName = requireString(raw, "name", {
        minLen: 1,
        maxLen: 200,
        label: `nodes[${i}].name`,
      });
      const kindStr = requireString(raw, "kind", {
        minLen: 1,
        maxLen: 32,
        label: `nodes[${i}].kind`,
      }) as WorkflowNodeKind;
      if (!ALLOWED_NODE_KINDS.includes(kindStr)) {
        throw badRequest(
          `Invalid kind '${kindStr}' for node '${nodeId}'. Must be one of: ${ALLOWED_NODE_KINDS.join(", ")}`,
        );
      }

      nodes.push({
        id: nodeId,
        name: nodeName,
        kind: kindStr,
        summary: typeof raw.summary === "string" ? raw.summary : undefined,
        agentRole: typeof raw.agentRole === "string" ? raw.agentRole : undefined,
        conditionField: typeof raw.conditionField === "string" ? raw.conditionField : undefined,
        conditionExpected:
          typeof raw.conditionExpected === "string" ||
          typeof raw.conditionExpected === "boolean" ||
          typeof raw.conditionExpected === "number"
            ? raw.conditionExpected
            : undefined,
        config:
          typeof raw.config === "object" && raw.config !== null
            ? (raw.config as Record<string, unknown>)
            : undefined,
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
        const from = requireString(raw, "from", {
          minLen: 1,
          maxLen: 64,
          label: `edges[${i}].from`,
        });
        const to = requireString(raw, "to", {
          minLen: 1,
          maxLen: 64,
          label: `edges[${i}].to`,
        });
        const conditionValue =
          typeof raw.conditionValue === "string" ||
          typeof raw.conditionValue === "boolean" ||
          typeof raw.conditionValue === "number"
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
    const definition = definitionFromPipeline(pipeline);

    await pipelines.update(projectId, (current) => {
      if (current.some((existing) => existing.id === id)) {
        throw new HttpError(
          409,
          "pipeline_already_exists",
          `Pipeline '${id}' already exists. Pipeline IDs are immutable; create a new ID for a new revision.`,
        );
      }
      return {
        value: [...current, cloneDefinition(definition)],
        result: undefined,
      };
    });

    return c.json(definition, 201);
  });

  // POST /:pipelineId/runs
  app.post("/:pipelineId/runs", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = requireValidId(c, "pipelineId");
    const definitions = await pipelines.read(projectId);
    const definition = definitions.find((candidate) => candidate.id === pipelineId);
    if (!definition) {
      throw notFound(`Pipeline '${pipelineId}' not found in project`);
    }

    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;
    const initialContext =
      typeof body.context === "object" && body.context !== null
        ? (body.context as Record<string, unknown>)
        : {};

    const definitionSnapshot = cloneDefinition(definition);
    const pipeline = new WorkflowPipeline(definitionSnapshot);
    const run = pipeline.createRun(initialContext);
    const record: ScopedRunRecord = {
      projectId,
      pipelineId,
      definition: definitionSnapshot,
      run,
    };

    await runs.update(projectId, (current) => {
      if (current.some((existing) => existing.run.runId === run.runId)) {
        throw new HttpError(409, "pipeline_run_id_collision", "Generated pipeline run ID already exists.");
      }
      return { value: [...current, record], result: undefined };
    });

    return c.json({ run }, 201);
  });

  // GET /:pipelineId/runs/:runId
  app.get("/:pipelineId/runs/:runId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = requireValidId(c, "pipelineId");
    const runId = requireValidId(c, "runId");
    const records = await runs.read(projectId);
    const record = records.find(
      (candidate) =>
        candidate.run.runId === runId &&
        candidate.projectId === projectId &&
        candidate.pipelineId === pipelineId,
    );
    if (!record) {
      throw notFound(`Pipeline run '${runId}' not found`);
    }
    return c.json({ run: record.run });
  });

  // POST /:pipelineId/runs/:runId/nodes/:nodeId/complete
  app.post("/:pipelineId/runs/:runId/nodes/:nodeId/complete", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = requireValidId(c, "pipelineId");
    const runId = requireValidId(c, "runId");
    const nodeId = requireValidId(c, "nodeId");
    const body = (await readJson(c).catch(() => ({}))) as Record<string, unknown>;
    const output =
      typeof body.output === "object" && body.output !== null
        ? (body.output as Record<string, unknown>)
        : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;

    try {
      const updatedRun = await runs.update(projectId, (records) => {
        const index = records.findIndex(
          (candidate) =>
            candidate.run.runId === runId &&
            candidate.projectId === projectId &&
            candidate.pipelineId === pipelineId,
        );
        if (index < 0) {
          throw notFound(`Pipeline run '${runId}' not found`);
        }

        const record = records[index]!;
        if (!record.definition) {
          throw new HttpError(
            409,
            "pipeline_definition_snapshot_missing",
            "This legacy in-flight run has no immutable pipeline definition snapshot and cannot be completed safely. Start a new run.",
          );
        }

        const pipeline = new WorkflowPipeline(cloneDefinition(record.definition));
        const nextRun = pipeline.completeNode(record.run, nodeId, { output, error });
        const nextRecords = records.slice();
        nextRecords[index] = { ...record, run: nextRun };
        return { value: nextRecords, result: nextRun };
      });
      return c.json({ run: updatedRun });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest((err as Error).message);
    }
  });

  return app;
}

export function personaRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const category = c.req.query("category");
    const personas = personaRegistry.listPersonas(category);
    return c.json({ personas });
  });

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
