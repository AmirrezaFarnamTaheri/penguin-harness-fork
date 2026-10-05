/**
 * Persistent findings-graph routes — the project-scoped HTTP authority for server findings.
 *
 * This project-id store is intentionally separate from the core knowledge_graph builtin's
 * workspace-local store. ProjectRow has no trusted workspace mapping, so matching names or
 * paths must never cause automatic reads, writes, or migration between the two.
 *
 * The shared FindingsStore owns validation, revision caching, cross-process locking and
 * acknowledged atomic writes. Corrupt state is preserved for explicit operator recovery;
 * it must never be decoded as an empty graph and silently overwritten by a report.
 *
 * Provenance rule, enforced here rather than in the engine: `source` is built from the
 * authenticated user (`c.var.user`), never from the request body — the same host-attested
 * attribution the `knowledge_graph` builtin tool takes from ToolExecutionContext.
 */
import { Hono } from "hono";
import path from "node:path";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  FindingsGraph,
  FindingsStore,
  FindingsRecoveryError,
  FindingsRevisionError,
  FindingsCapacityError,
  FindingValidationError,
  validateReportInput,
  projectDir,
  LifecycleError,
  UnknownFindingError,
  FINDING_KINDS as KINDS,
  FINDING_STATUSES as STATUSES,
} from "@prismshadow/penguin-core";
import { HttpError } from "../errors.js";
import type { FindingMutationContext, FindingsRead } from "@prismshadow/penguin-core";

async function readGraph(
  store: FindingsStore,
  notify?: (read: FindingsRead) => void,
): Promise<FindingsGraph> {
  const read = await store.read();
  if (!read.graph || read.recovery) throw new FindingsRecoveryError(read);
  notify?.(read);
  return read.graph;
}

function revisionHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const revision =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw badRequest("If-Match must contain one findings revision.");
  return revision;
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

function findingIdParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError)
      throw badRequest("findingId contains malformed percent encoding.");
    throw error;
  }
}

function routeContext(userId: string): FindingMutationContext {
  return { actor: { kind: "user", id: userId }, method: "route" };
}

export function findingsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = (projectId: string) =>
    new FindingsStore({
      id: `project:${projectId}`,
      kind: "project",
      filePath: path.join(projectDir(deps.config.root, projectId), ".findings_graph.json"),
    });
  app.onError((error) => {
    if (error instanceof FindingValidationError) throw badRequest(error.message);
    if (error instanceof FindingsRecoveryError)
      throw new HttpError(409, "findings_recovery_required", error.message);
    if (error instanceof FindingsRevisionError)
      throw new HttpError(409, "findings_revision_conflict", error.message);
    if (error instanceof FindingsCapacityError)
      throw new HttpError(409, "findings_capacity_exceeded", error.message);
    throw error;
  });

  app.get("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (
      limitRaw !== undefined &&
      (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(limit) || limit! < 1 || limit! > 200)
    ) {
      throw badRequest("limit must be an integer between 1 and 200.");
    }
    const filters = { kind: c.req.query("kind"), status: c.req.query("status") };
    const kind = enumField(filters, "kind", KINDS);
    const status = enumField(filters, "status", STATUSES);
    const graph = await readGraph(store(projectId), (read) => {
      c.header("ETag", `"${read.revision}"`);
      c.header("X-Findings-High-Water", read.highWater ? "1" : "0");
    });
    const findings = graph.query({
      text: c.req.query("text"),
      subject: c.req.query("subject"),
      tag: c.req.query("tag"),
      kind,
      status,
      limit,
    });
    return c.json({ findings: findings.map((finding) => graph.readback(finding.id)) });
  });

  app.post("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const input = validateReportInput(body, { agentId: `user:${c.var.user.userId}` });
    const result = await store(projectId).update(
      revisionHeader(c.req.header("If-Match")),
      (graph) => graph.report(input, routeContext(c.var.user.userId)),
    );
    return c.json({ finding: result.finding, merged: result.merged }, 201);
  });

  app.post("/:findingId/confirm", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = findingIdParam(c.req.param("findingId"));
    const body = await readJson(c);
    const note =
      body["note"] === undefined
        ? undefined
        : requireString(body, "note", { maxLen: 2000, label: "note" });
    if (body["override"] !== undefined && typeof body["override"] !== "boolean") {
      throw badRequest("override must be a boolean.");
    }
    if (body["override"] === true && !note?.trim()) {
      throw badRequest("Confirmation override requires a non-empty reason in note.");
    }
    const finding = await mutate(
      store,
      projectId,
      revisionHeader(c.req.header("If-Match")),
      (graph) =>
        graph.confirm(findingId, note, {
          ...routeContext(c.var.user.userId),
          override: body["override"] === true,
        }),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/reopen", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = findingIdParam(c.req.param("findingId"));
    const body = await readJson(c);
    const note = requireString(body, "note", { minLen: 1, maxLen: 2000, label: "note" });
    const finding = await mutate(
      store,
      projectId,
      revisionHeader(c.req.header("If-Match")),
      (graph) => graph.reopen(findingId, note, routeContext(c.var.user.userId)),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/refute", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = findingIdParam(c.req.param("findingId"));
    const body = await readJson(c);
    const note =
      body["note"] === undefined
        ? undefined
        : requireString(body, "note", { maxLen: 2000, label: "note" });
    const finding = await mutate(
      store,
      projectId,
      revisionHeader(c.req.header("If-Match")),
      (graph) => graph.refute(findingId, note, routeContext(c.var.user.userId)),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/supersede", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = findingIdParam(c.req.param("findingId"));
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
    const finding = await mutate(
      store,
      projectId,
      revisionHeader(c.req.header("If-Match")),
      (graph) => graph.supersede(findingId, replacementId, note, routeContext(c.var.user.userId)),
    );
    return c.json({ finding });
  });

  app.post("/:findingId/link", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const findingId = findingIdParam(c.req.param("findingId"));
    const body = await readJson(c);
    const linkId = requireString(body, "link_id", { minLen: 1, maxLen: 300, label: "link_id" });
    await mutate(store, projectId, revisionHeader(c.req.header("If-Match")), (graph) => {
      graph.link(findingId, linkId, routeContext(c.var.user.userId));
      return graph.get(findingId)!;
    });
    return c.json({ linked: [findingId, linkId] });
  });

  app.get("/events", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : 0;
    if (
      (sinceRaw !== undefined && !/^\d+$/.test(sinceRaw)) ||
      !Number.isSafeInteger(since) ||
      since < 0
    )
      throw badRequest("since must be a non-negative integer.");
    const graph = await readGraph(store(projectId), (read) => {
      c.header("ETag", `"${read.revision}"`);
      c.header("X-Findings-High-Water", read.highWater ? "1" : "0");
    });
    return c.json({ events: graph.since(since) });
  });

  app.get("/snapshot", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(
      (
        await readGraph(store(projectId), (read) => {
          c.header("ETag", `"${read.revision}"`);
          c.header("X-Findings-High-Water", read.highWater ? "1" : "0");
        })
      ).exportReadbackSnapshot(),
    );
  });

  app.get("/recovery", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const read = await store(projectId).read();
    return c.json({
      scope: read.scope,
      revision: read.revision,
      recovery: read.recovery,
      bytes: read.bytes,
      highWater: read.highWater,
      archive: read.graph?.archiveStats() ?? null,
    });
  });

  app.get("/raw", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const offsetRaw = c.req.query("offset") ?? "0";
    if (!/^\d+$/.test(offsetRaw) || !Number.isSafeInteger(Number(offsetRaw)))
      throw badRequest("offset must be a non-negative safe integer.");
    return c.json(await store(projectId).rawPage(Number(offsetRaw)));
  });

  app.post("/recovery/:operation", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const reason = requireString(body, "reason", { minLen: 1, maxLen: 2000 });
    const revision = requireString(body, "revision", { minLen: 1, maxLen: 100 });
    if (body.acknowledge !== true) throw badRequest("Explicit acknowledgement is required.");
    const operation = c.req.param("operation");
    if (operation === "prune") {
      if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string"))
        throw badRequest("ids must be an array of finding IDs.");
      await store(projectId).prune(
        body.ids as string[],
        revision,
        reason,
        routeContext(c.var.user.userId),
      );
    } else if (operation === "reset" || operation === "restore") {
      const backup =
        operation === "restore"
          ? Buffer.from(
              requireString(body, "snapshot", { minLen: 1, maxLen: 32 * 1024 * 1024 }),
              "utf8",
            )
          : undefined;
      await store(projectId).recover(
        operation,
        revision,
        reason,
        routeContext(c.var.user.userId),
        backup,
      );
    } else throw badRequest("Unknown recovery operation.");
    const read = await store(projectId).read();
    return c.json({ revision: read.revision, recovery: read.recovery });
  });

  return app;
}

/**
 * One mutate-and-persist cycle with uniform not-found handling: the engine throws on unknown
 * ids; the API answers 404 with the engine's message so clients can tell "bad id" from "gone".
 */
async function mutate<T>(
  store: (projectId: string) => FindingsStore,
  projectId: string,
  expectedRevision: string | undefined,
  action: (graph: FindingsGraph) => T,
): Promise<T> {
  try {
    return await store(projectId).update(expectedRevision, action);
  } catch (err) {
    if (err instanceof UnknownFindingError) throw notFound(err.message);
    if (err instanceof LifecycleError)
      throw new HttpError(
        err.status,
        err.status === 409 ? "finding_conflict" : "bad_request",
        err.message,
      );
    throw err;
  }
}
