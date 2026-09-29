/**
 * Persistent findings-graph routes — the project-scoped HTTP authority for server findings.
 *
 * This project-id store is intentionally separate from the core knowledge_graph builtin's
 * workspace-local store. ProjectRow has no trusted workspace mapping, so matching names or
 * paths must never cause automatic reads, writes, or migration between the two.
 *
 * Mirrors the wiki routes exactly (same store pattern, same access model): the JSON snapshot
 * is the authority, every request hydrates a FindingsGraph from it, mutates, and writes back
 * through the store's atomic read-modify-write. That keeps concurrent sessions serialized at
 * one place instead of inventing a second persistence mechanism.
 *
 * Provenance rule, enforced here rather than in the engine: `source` is built from the
 * authenticated user (`c.var.user`), never from the request body — the same host-attested
 * attribution the `knowledge_graph` builtin tool takes from ToolExecutionContext.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import { FindingsGraph } from "@prismshadow/penguin-core";
import type {
  EvidenceTier,
  FindingEvidence,
  FindingKind,
  FindingSeverity,
  FindingStatus,
  FindingsGraphSnapshot,
} from "@prismshadow/penguin-core";
import { ProjectJsonStore } from "../../services/project-json-store.js";

const KINDS: readonly FindingKind[] = [
  "defect",
  "insight",
  "decision",
  "pattern",
  "metric",
  "hypothesis",
];
const SEVERITIES: readonly FindingSeverity[] = ["info", "low", "medium", "high", "critical"];
const STATUSES: readonly FindingStatus[] = ["open", "confirmed", "refuted", "superseded"];
const TIERS = ["runtime", "implementation", "history", "documentation", "anecdote"] as const;

function emptyGraphJson(): string {
  return JSON.stringify({ version: 1, findings: [] } satisfies FindingsGraphSnapshot);
}

/**
 * A snapshot that is not a graph (hand edit, truncated write) reads as empty rather than 500ing
 * every route — the next write repairs the file, the same self-healing stance as the wiki store.
 */
function decodeGraphJson(raw: string): string {
  try {
    const graph = new FindingsGraph();
    const result = graph.importSnapshot(raw);
    return result.imported > 0 || result.skipped > 0 ? raw : emptyGraphJson();
  } catch {
    return emptyGraphJson();
  }
}

function hydrate(raw: string): FindingsGraph {
  const graph = new FindingsGraph();
  graph.importSnapshot(raw);
  return graph;
}

function boundedArray(
  body: Record<string, unknown>,
  field: string,
  maxItems: number,
  maxItemLength: number,
): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest(`${field} must be an array.`);
  if (value.length > maxItems) throw badRequest(`${field} must have at most ${maxItems} entries.`);
  return value.map((item) => {
    if (typeof item !== "string") throw badRequest(`${field} entries must be strings.`);
    if (item.length > maxItemLength) {
      throw badRequest(`${field} entries must be at most ${maxItemLength} characters.`);
    }
    return item.trim();
  });
}

function enumField<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function findingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = new ProjectJsonStore<string>(
    deps.config.root,
    ".findings_graph.json",
    emptyGraphJson,
    decodeGraphJson,
    (value) => value,
  );

  app.get("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const graph = hydrate(await store.read(projectId));
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw badRequest("limit must be an integer between 1 and 200.");
    }
    const status = c.req.query("status");
    const findings = graph.query({
      text: c.req.query("text"),
      subject: c.req.query("subject"),
      tag: c.req.query("tag"),
      kind: c.req.query("kind") as FindingKind | undefined,
      status: status === undefined ? undefined : (status as FindingStatus),
      limit,
    });
    return c.json({ findings });
  });

  app.post("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const title = requireString(body, "title", { minLen: 1, maxLen: 300, label: "title" });
    const bodyText =
      body["body"] === undefined || body["body"] === null
        ? undefined
        : requireString(body, "body", { minLen: 1, maxLen: 50_000, label: "body" });

    const evidenceRaw = body["evidence"];
    let evidence: FindingEvidence[] | undefined;
    if (evidenceRaw !== undefined && evidenceRaw !== null) {
      if (!Array.isArray(evidenceRaw) || evidenceRaw.length > 100) {
        throw badRequest("evidence must be an array of at most 100 entries.");
      }
      evidence = evidenceRaw.map((entry) => {
        if (entry === null || typeof entry !== "object") {
          throw badRequest("evidence entries must be objects.");
        }
        const e = entry as Record<string, unknown>;
        const tier = typeof e["tier"] === "string" ? e["tier"] : "";
        if (!(TIERS as readonly string[]).includes(tier)) {
          throw badRequest(`evidence tier must be one of: ${TIERS.join(", ")}.`);
        }
        const line = e["line"];
        if (
          line !== undefined &&
          (typeof line !== "number" || !Number.isInteger(line) || line < 0)
        ) {
          throw badRequest("evidence line must be a non-negative integer.");
        }
        return {
          path: typeof e["path"] === "string" ? e["path"].slice(0, 500) : undefined,
          line: typeof line === "number" ? line : undefined,
          quote: typeof e["quote"] === "string" ? e["quote"].slice(0, 2000) : undefined,
          tier: tier as EvidenceTier,
          note: typeof e["note"] === "string" ? e["note"].slice(0, 2000) : undefined,
        };
      });
    }

    const result = await store.update(projectId, (current) => {
      const graph = hydrate(current);
      const reported = graph.report({
        title,
        body: bodyText,
        kind: enumField(body, "kind", KINDS),
        confidence: enumField(body, "confidence", ["low", "medium", "high"] as const),
        severity: enumField(body, "severity", SEVERITIES),
        subjects: boundedArray(body, "subjects", 100, 500),
        evidence,
        tags: boundedArray(body, "tags", 50, 100),
        // Host-attested provenance: the authenticated user, never the body.
        source: { agentId: `user:${c.var.user.userId}`, report: undefined },
      });
      return { value: JSON.stringify(graph.exportSnapshot()), result: reported };
    });
    return c.json({ finding: result.finding, merged: result.merged }, 201);
  });

  app.post("/:findingId/confirm", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = decodeURIComponent(c.req.param("findingId"));
    const body = await readJson(c);
    const note =
      body["note"] === undefined
        ? undefined
        : requireString(body, "note", { maxLen: 2000, label: "note" });
    const finding = await mutate(c, store, projectId, findingId, (graph) =>
      graph.confirm(findingId, note),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/refute", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = decodeURIComponent(c.req.param("findingId"));
    const body = await readJson(c);
    const note =
      body["note"] === undefined
        ? undefined
        : requireString(body, "note", { maxLen: 2000, label: "note" });
    const finding = await mutate(c, store, projectId, findingId, (graph) =>
      graph.refute(findingId, note),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/supersede", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = decodeURIComponent(c.req.param("findingId"));
    const body = await readJson(c);
    const replacementId = requireString(body, "replacement_id", {
      minLen: 1,
      maxLen: 300,
      label: "replacement_id",
    });
    const note =
      body["note"] === undefined
        ? undefined
        : requireString(body, "note", { maxLen: 2000, label: "note" });
    const finding = await mutate(c, store, projectId, findingId, (graph) =>
      graph.supersede(findingId, replacementId, note),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/link", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = decodeURIComponent(c.req.param("findingId"));
    const body = await readJson(c);
    const linkId = requireString(body, "link_id", { minLen: 1, maxLen: 300, label: "link_id" });
    await mutate(c, store, projectId, findingId, (graph) => {
      graph.link(findingId, linkId);
      return graph.get(findingId)!;
    });
    return c.json({ linked: [findingId, linkId] });
  });

  app.get("/events", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : 0;
    if (!Number.isInteger(since) || since < 0)
      throw badRequest("since must be a non-negative integer.");
    const graph = hydrate(await store.read(projectId));
    return c.json({ events: graph.since(since) });
  });

  app.get("/snapshot", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(hydrate(await store.read(projectId)).exportSnapshot());
  });

  return app;
}

/**
 * One mutate-and-persist cycle with uniform not-found handling: the engine throws on unknown
 * ids; the API answers 404 with the engine's message so clients can tell "bad id" from "gone".
 */
async function mutate<T>(
  _c: unknown,
  store: ProjectJsonStore<string>,
  projectId: string,
  findingId: string,
  action: (graph: FindingsGraph) => T,
): Promise<T> {
  return store.update(projectId, (current) => {
    const graph = hydrate(current);
    try {
      const result = action(graph);
      return { value: JSON.stringify(graph.exportSnapshot()), result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Unknown finding")) throw notFound(message);
      throw badRequest(message);
    }
  });
}
