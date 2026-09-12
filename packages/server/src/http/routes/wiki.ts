/**
 * Persistent Knowledge Wiki & Markdown Graph Routes:
 * GET    /api/projects/:projectId/wiki/nodes - list or search nodes
 * GET    /api/projects/:projectId/wiki/graph - get graph data
 * POST   /api/projects/:projectId/wiki/nodes - add or update page
 * GET    /api/projects/:projectId/wiki/nodes/:nodeId - get page
 * DELETE /api/projects/:projectId/wiki/nodes/:nodeId - delete page
 * GET    /api/projects/:projectId/wiki/nodes/:nodeId/neighbors - explore neighbors
 * GET    /api/projects/:projectId/wiki/path - shortest path between nodes
 * GET    /api/projects/:projectId/wiki/lint - dead link & orphan lint
 */
import path from "node:path";
import fs from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import { WikiEngine, projectDir, atomicWriteFile } from "@prismshadow/penguin-core";

const projectWikis = new Map<string, WikiEngine>();

async function getOrCreateWiki(root: string, projectId: string): Promise<WikiEngine> {
  let wiki = projectWikis.get(projectId);
  if (!wiki) {
    wiki = new WikiEngine();
    projectWikis.set(projectId, wiki);
    try {
      const pDir = projectDir(root, projectId);
      const filePath = path.join(pDir, ".wiki_graph.json");
      const content = await fs.readFile(filePath, "utf-8");
      wiki.importGraphJson(content);
    } catch {
      // Start empty if not yet saved or on parse error
    }
  }
  return wiki;
}

async function saveWiki(root: string, projectId: string): Promise<void> {
  const wiki = projectWikis.get(projectId);
  if (!wiki) return;
  try {
    const pDir = projectDir(root, projectId);
    await fs.mkdir(pDir, { recursive: true });
    const filePath = path.join(pDir, ".wiki_graph.json");
    await atomicWriteFile(filePath, wiki.exportGraphJson());
  } catch {
    // Disk write error recovery
  }
}

export function wikiRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /nodes - list or search
  app.get("/nodes", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);

    const query = c.req.query("q");
    if (query) {
      const matches = wiki.search(query);
      return c.json({ matches });
    }

    return c.json({ nodes: wiki.listPages() });
  });

  // GET /graph - full graph
  app.get("/graph", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);
    return c.json(wiki.buildGraph());
  });

  // POST /nodes - add page
  app.post("/nodes", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);
    const body = await readJson(c);

    const id = requireString(body, "id", { minLen: 1, maxLen: 300, label: "id" });
    const content = requireString(body, "content", { minLen: 1, maxLen: 500000, label: "content" });
    const filePath = typeof body.filePath === "string" ? body.filePath : undefined;

    const node = wiki.addPage(id, content, filePath);
    await saveWiki(deps.config.root, projectId);
    return c.json({ node }, 201);
  });

  // GET /nodes/:nodeId - get page
  app.get("/nodes/:nodeId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);
    const nodeId = decodeURIComponent(c.req.param("nodeId"));

    const node = wiki.getPage(nodeId);
    if (!node) {
      throw notFound(`Wiki node '${nodeId}' not found`);
    }

    return c.json({ node });
  });

  // DELETE /nodes/:nodeId - delete page
  app.delete("/nodes/:nodeId", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);
    const nodeId = decodeURIComponent(c.req.param("nodeId"));

    const deleted = wiki.removePage(nodeId);
    await saveWiki(deps.config.root, projectId);
    return c.json({ deleted });
  });

  // GET /nodes/:nodeId/neighbors - explore neighbors
  app.get("/nodes/:nodeId/neighbors", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);
    const nodeId = decodeURIComponent(c.req.param("nodeId"));
    const maxHops = c.req.query("maxHops") ? parseInt(c.req.query("maxHops")!, 10) : 1;

    const neighbors = wiki.getNeighbors(nodeId, { maxHops });
    return c.json({ nodeId, neighbors });
  });

  // GET /path - shortest path
  app.get("/path", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);

    const start = c.req.query("start");
    const end = c.req.query("end");
    if (!start || !end) {
      throw badRequest("Query params 'start' and 'end' are required");
    }

    const path = wiki.findPath(start, end);
    return c.json({ start, end, path });
  });

  // GET /lint - dead links & orphans
  app.get("/lint", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const wiki = await getOrCreateWiki(deps.config.root, projectId);
    return c.json(wiki.lint());
  });

  return app;
}
