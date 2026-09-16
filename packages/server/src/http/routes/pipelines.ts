/**
 * Autonomous Workflow Pipelines & Persona Presets Routes:
 * Mounted at /api/projects/:projectId/pipelines
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../errors.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  WorkflowPipeline,
  PersonaRegistry,
  BUILTIN_PERSONA_MASKS,
  isValidId,
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

function requireApiId(obj: Record<string, unknown>, key: string, label: string): string {
  const value = requireString(obj, key, { minLen: 1, maxLen: 64, label });
  if (!isValidId(value)) {
    throw badRequest(`${label} must contain only letters, numbers, underscores, and hyphens.`);
  }
  return value;
}

function migrateLegacyId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (isValidId(value) && value.length <= 64) return value;

  const stem =
    value
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "legacy";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${stem}-${digest}`;
}

function migratePersistedDefinition(
  definition: PipelineDefinitionRecord,
  label: string,
): PipelineDefinitionRecord {
  if (!definition || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    throw new Error(`${label} must contain node and edge arrays.`);
  }

  const idMap = new Map<string, string>();
  const nodes = definition.nodes.map((node, index) => {
    const oldId = typeof node?.id === "string" ? node.id : "";
    const nextId = migrateLegacyId(node?.id, `${label}.nodes[${index}].id`);
    if (idMap.has(oldId) && idMap.get(oldId) !== nextId) {
      throw new Error(`${label} contains an ambiguous duplicate legacy node id '${oldId}'.`);
    }
    idMap.set(oldId, nextId);
    return { ...node, id: nextId, config: node.config ? { ...node.config } : undefined };
  });

  const edges = definition.edges.map((edge, index) => {
    if (typeof edge?.from !== "string" || typeof edge?.to !== "string") {
      throw new Error(`${label}.edges[${index}] must contain string from/to ids.`);
    }
    return {
      ...edge,
      from: idMap.get(edge.from) ?? migrateLegacyId(edge.from, `${label}.edges[${index}].from`),
      to: idMap.get(edge.to) ?? migrateLegacyId(edge.to, `${label}.edges[${index}].to`),
    };
  });

  return {
    ...definition,
    id: migrateLegacyId(definition.id, `${label}.id`),
    nodes,
    edges,
  };
}

function decodePipelineDefinitions(raw: string): PipelineDefinitionRecord[] {
  return decodeArray<PipelineDefinitionRecord>("Pipeline", raw).map((definition, index) =>
    migratePersistedDefinition(definition, `pipelines[${index}]`),
  );
}

function decodeRunRecords(raw: string): ScopedRunRecord[] {
  return decodeArray<ScopedRunRecord>("Pipeline run", raw).map((record, index) => {
    if (typeof record?.projectId !== "string" || !isValidId(record.projectId)) {
      throw new Error(`pipelineRuns[${index}].projectId is invalid.`);
    }
    const pipelineId = migrateLegacyId(record.pipelineId, `pipelineRuns[${index}].pipelineId`);
    const definition = record.definition
      ? migratePersistedDefinition(record.definition, `pipelineRuns[${index}].definition`)
      : undefined;
    return {
      ...record,
      pipelineId,
      definition,
      run: { ...record.run, pipelineId },
    };
  });
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
    decodePipelineDefinitions,
  );
  const runs = new ProjectJsonStore<ScopedRunRecord[]>(
    deps.config.root,
    ".pipeline_runs.json",
    () => [],
    decodeRunRecords,
  );

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
        nodes: definition.nodes,
        edges: definition.edges,
      })),
    });
  });

  app.get("/:pipelineId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = requireValidId(c, "pipelineId");
    const definitions = await pipelines.read(projectId);
    const definition = definitions.find((candidate) => candidate.id === pipelineId);
    if (!definition) throw notFound(`Pipeline '${pipelineId}' not found in project`);
    return c.json({ pipeline: cloneDefinition(definition) });
  });

  app.post("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);

    const id = requireApiId(body, "id", "id");
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
      const nodeId = requireApiId(raw, "id", `nodes[${i}].id`);
      if (seenIds.has(nodeId)) throw badRequest(`Duplicate node ID '${nodeId}' at nodes[${i}]`);
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
        if (typeof item !== "object" || item === null)
          throw badRequest(`edges[${i}] must be an object`);
        const raw = item as Record<string, unknown>;
        const from = requireApiId(raw, "from", `edges[${i}].from`);
        const to = requireApiId(raw, "to", `edges[${i}].to`);
        if (!seenIds.has(from) || !seenIds.has(to)) {
          throw badRequest(`edges[${i}] must reference existing node IDs.`);
        }
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
    if (!check.isValid) throw badRequest(`Invalid DAG: ${check.errors.join("; ")}`);
    const definition = definitionFromPipeline(pipeline);

    await pipelines.update(projectId, (current) => {
      if (current.some((existing) => existing.id === id)) {
        throw new HttpError(
          409,
          "pipeline_already_exists",
          `Pipeline '${id}' already exists. Pipeline IDs are immutable; create a new ID for a new revision.`,
        );
      }
      return { value: [...current, cloneDefinition(definition)], result: undefined };
    });

    return c.json(definition, 201);
  });

  app.post("/:pipelineId/runs", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = requireValidId(c, "pipelineId");
    const definitions = await pipelines.read(projectId);
    const definition = definitions.find((candidate) => candidate.id === pipelineId);
    if (!definition) throw notFound(`Pipeline '${pipelineId}' not found in project`);

    const body = await readJson(c);
    if (
      body.context !== undefined &&
      (typeof body.context !== "object" || body.context === null || Array.isArray(body.context))
    ) {
      throw badRequest("context must be a JSON object when provided.");
    }
    const initialContext = (body.context as Record<string, unknown> | undefined) ?? {};

    const definitionSnapshot = cloneDefinition(definition);
    const pipeline = new WorkflowPipeline(definitionSnapshot);
    const run = pipeline.createRun(initialContext);
    const record: ScopedRunRecord = { projectId, pipelineId, definition: definitionSnapshot, run };

    await runs.update(projectId, (current) => {
      if (current.some((existing) => existing.run.runId === run.runId)) {
        throw new HttpError(
          409,
          "pipeline_run_id_collision",
          "Generated pipeline run ID already exists.",
        );
      }
      return { value: [...current, record], result: undefined };
    });

    return c.json({ run }, 201);
  });

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
    if (!record) throw notFound(`Pipeline run '${runId}' not found`);
    return c.json({ run: record.run });
  });

  app.post("/:pipelineId/runs/:runId/nodes/:nodeId/complete", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const pipelineId = requireValidId(c, "pipelineId");
    const runId = requireValidId(c, "runId");
    const nodeId = requireValidId(c, "nodeId");
    const body = await readJson(c);
    if (
      body.output !== undefined &&
      (typeof body.output !== "object" || body.output === null || Array.isArray(body.output))
    ) {
      throw badRequest("output must be a JSON object when provided.");
    }
    const output = body.output as Record<string, unknown> | undefined;
    const error = typeof body.error === "string" ? body.error : undefined;

    try {
      const updatedRun = await runs.update(projectId, (records) => {
        const index = records.findIndex(
          (candidate) =>
            candidate.run.runId === runId &&
            candidate.projectId === projectId &&
            candidate.pipelineId === pipelineId,
        );
        if (index < 0) throw notFound(`Pipeline run '${runId}' not found`);

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
    if (!persona) throw notFound(`Persona '${personaId}' not found`);
    return c.json({ persona });
  });

  return app;
}
