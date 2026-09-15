/**
 * Persistent Knowledge Wiki & Markdown Graph Routes.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import { WikiEngine } from "@prismshadow/penguin-core";
import { ProjectJsonStore } from "../../services/project-json-store.js";

function emptyGraphJson(): string {
  return new WikiEngine().exportGraphJson();
}

function validateGraphJson(raw: string): string {
  JSON.parse(raw);
  return raw;
}

function hydrateWiki(raw: string): WikiEngine {
  const wiki = new WikiEngine();
  wiki.importGraphJson(raw);
  return wiki;
}

export function wikiRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = new ProjectJsonStore<string>(
    deps.config.root,
    ".wiki_graph.json",
    emptyGraphJson,
    validateGraphJson,
    (value) => value,
  );

  app.get("/nodes", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = hydrateWiki(await store.read(projectId));
    const query = c.req.query("q");
    return query ? c.json({ matches: wiki.search(query) }) : c.json({ nodes: wiki.listPages() });
  });

  app.get("/graph", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(hydrateWiki(await store.read(projectId)).buildGraph());
  });

  app.post("/nodes", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const id = requireString(body, "id", { minLen: 1, maxLen: 300, label: "id" });
    const content = requireString(body, "content", { minLen: 1, maxLen: 500000, label: "content" });
    const filePath = typeof body.filePath === "string" ? body.filePath : undefined;

    const node = await store.update(projectId, (current) => {
      const wiki = hydrateWiki(current);
      const created = wiki.addPage(id, content, filePath);
      return { value: wiki.exportGraphJson(), result: created };
    });
    return c.json({ node }, 201);
  });

  app.get("/nodes/:nodeId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const nodeId = decodeURIComponent(c.req.param("nodeId"));
    const node = hydrateWiki(await store.read(projectId)).getPage(nodeId);
    if (!node) throw notFound(`Wiki node '${nodeId}' not found`);
    return c.json({ node });
  });

  app.delete("/nodes/:nodeId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const nodeId = decodeURIComponent(c.req.param("nodeId"));
    const deleted = await store.update(projectId, (current) => {
      const wiki = hydrateWiki(current);
      const result = wiki.removePage(nodeId);
      return { value: wiki.exportGraphJson(), result };
    });
    return c.json({ deleted });
  });

  app.get("/nodes/:nodeId/neighbors", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const nodeId = decodeURIComponent(c.req.param("nodeId"));
    const rawMaxHops = c.req.query("maxHops");
    const maxHops = rawMaxHops ? Number.parseInt(rawMaxHops, 10) : 1;
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 20) {
      throw badRequest("maxHops must be an integer between 1 and 20.");
    }
    const neighbors = hydrateWiki(await store.read(projectId)).getNeighbors(nodeId, { maxHops });
    return c.json({ nodeId, neighbors });
  });

  app.get("/path", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const start = c.req.query("start") ?? c.req.query("from");
    const end = c.req.query("end") ?? c.req.query("to");
    if (!start || !end)
      throw badRequest("Query params 'start' (or 'from') and 'end' (or 'to') are required");
    const graphPath = hydrateWiki(await store.read(projectId)).findPath(start, end);
    return c.json({ start, end, from: start, to: end, path: graphPath });
  });

  app.get("/lint", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(hydrateWiki(await store.read(projectId)).lint());
  });

  return app;
}
