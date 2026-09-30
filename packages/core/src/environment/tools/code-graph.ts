/**
 * code_graph builtin tool — native code intelligence for agents: index a workspace once,
 * then query symbols, callers/callees, impact radius and structure without re-reading files.
 *
 * This is the "graphify as a built-in tool" surface: the same engines the cockpit topology
 * view uses (CodeGraphWatcher's walker + SymbolIndexer + CodeGraph queries) exposed as a tool,
 * so an agent and the UI see one graph instead of two pipelines.
 *
 * Deliberate choices:
 * - **No fs watchers.** The watcher's `init()` installs OS watch handles; a tool must not leak
 *   them. `scanWorkspace()` is the pure walk, which is exactly what an on-demand query wants.
 * - **Short-TTL cache per workspace** (default 60s): a burst of queries costs one walk, and a
 *   long-running session still picks up edits within a minute. `index` with `refresh: true`
 *   forces a re-walk.
 * - **Read-only**: the tool writes nothing anywhere.
 */
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { OmniMessage } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import { CodeGraphWatcher } from "../../agent/code-graph-watcher.js";
import { WorkspaceGraphCache } from "./code-graph-cache.js";
import type { BuiltinTool, ToolExecutionContext, ToolResult } from "./types.js";
import { describeArgumentError } from "./tool-arguments.js";

export const CODE_GRAPH_NAME = "code_graph";

const DEFAULT_OUTPUT_BUDGET = 6000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 8;
const DEFAULT_DEPTH = 2;

const cache = new WorkspaceGraphCache((workspaceDir) => new CodeGraphWatcher(workspaceDir), {
  ttlMs: CACHE_TTL_MS,
  maxEntries: CACHE_MAX_ENTRIES,
});

export const CODE_GRAPH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["index", "search", "callers", "callees", "impact", "explore", "files", "hubs"],
      description:
        "index: walk the workspace and build the code graph (cached). search: find symbols/files by name fragment. callers/callees: who calls a symbol, or what it calls. impact: what transitively depends on it. explore: a small subgraph around a term. files: the indexed file list. hubs: most-connected nodes.",
    },
    term: {
      type: "string",
      description: "search/explore: symbol name fragment or concept term to look up.",
    },
    node_id: {
      type: "string",
      description:
        "callers/callees/impact: a node id as returned by search (file path or symbol id).",
    },
    depth: {
      type: "number",
      description: `callers/callees/impact: traversal depth (default ${DEFAULT_DEPTH}).`,
    },
    filter: { type: "string", description: "files: substring filter on the file path." },
    limit: { type: "number", description: "search/files/hubs: maximum results." },
    refresh: { type: "boolean", description: "index: force a re-walk even if cached." },
  },
  required: ["action"],
} as const;

function safeSlice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, limit - 1);
  return text.slice(0, limit);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asDepth(value: unknown): number {
  return typeof value === "number" && value >= 1 ? Math.min(10, Math.floor(value)) : DEFAULT_DEPTH;
}

export function createCodeGraphTool(definition: ToolDefinitionConfig): BuiltinTool {
  return {
    name: definition.name,
    definition,
    async *execute(
      args: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): AsyncGenerator<OmniMessage, ToolResult | void> {
      const { toolCallId, signal } = ctx;
      const delta = (output: string): OmniMessage =>
        partialToolCallOutput({ eventType: "delta", output, toolCallId });
      const budget =
        definition.maxOutputLength !== undefined && definition.maxOutputLength > 0
          ? definition.maxOutputLength
          : DEFAULT_OUTPUT_BUDGET;

      const action = asString(args["action"]);
      if (action === undefined) {
        yield delta(
          describeArgumentError(definition, args, { argument: "action", kind: "missing" }),
        );
        return { stopReason: "fatal" };
      }
      if (signal?.aborted) return { stopReason: "aborted" };

      try {
        const force = args["refresh"] === true;
        const { watcher, cached } = await cache.get(ctx.workspaceDir, force);
        if (signal?.aborted) return { stopReason: "aborted" };
        const graph = watcher.getGraph();
        const limit = typeof args["limit"] === "number" ? Math.max(1, args["limit"]) : 20;

        let text: string;
        switch (action) {
          case "index": {
            text = JSON.stringify({ ...watcher.getStats(), ...cache.stats(), cached }, null, 2);
            break;
          }
          case "search": {
            const term = asString(args["term"]);
            if (term === undefined) {
              yield delta(
                describeArgumentError(definition, args, { argument: "term", kind: "missing" }),
              );
              return { stopReason: "fatal" };
            }
            text = JSON.stringify(
              graph
                .queryNodes(term)
                .slice(0, limit)
                .map((n) => ({
                  id: n.id,
                  name: n.name,
                  kind: n.kind,
                  filePath: n.filePath,
                })),
              null,
              2,
            );
            break;
          }
          case "callers":
          case "callees": {
            const nodeId = asString(args["node_id"]);
            if (nodeId === undefined) {
              yield delta(
                describeArgumentError(definition, args, {
                  argument: "node_id",
                  kind: "missing",
                }),
              );
              return { stopReason: "fatal" };
            }
            const related =
              action === "callers"
                ? graph.getCallers(nodeId, asDepth(args["depth"]))
                : graph.getCallees(nodeId, asDepth(args["depth"]));
            text = JSON.stringify(
              related.slice(0, limit).map((n) => ({
                id: n.id,
                name: n.name,
                kind: n.kind,
                filePath: n.filePath,
              })),
              null,
              2,
            );
            break;
          }
          case "impact": {
            const nodeId = asString(args["node_id"]);
            if (nodeId === undefined) {
              yield delta(
                describeArgumentError(definition, args, {
                  argument: "node_id",
                  kind: "missing",
                }),
              );
              return { stopReason: "fatal" };
            }
            const impacted = graph.getImpactRadius(nodeId, asDepth(args["depth"]));
            text = JSON.stringify(
              {
                nodes: impacted.nodes.slice(0, limit).map((n) => ({
                  id: n.id,
                  name: n.name,
                  kind: n.kind,
                  filePath: n.filePath,
                })),
                edgeCount: impacted.edges.length,
              },
              null,
              2,
            );
            break;
          }
          case "explore": {
            const term = asString(args["term"]);
            if (term === undefined) {
              yield delta(
                describeArgumentError(definition, args, { argument: "term", kind: "missing" }),
              );
              return { stopReason: "fatal" };
            }
            const subgraph = graph.explore(term, asDepth(args["depth"]));
            text = JSON.stringify(
              {
                roots: subgraph.roots,
                nodes: subgraph.nodes.slice(0, limit).map((n) => ({
                  id: n.id,
                  name: n.name,
                  kind: n.kind,
                })),
                edgeCount: subgraph.edges.length,
              },
              null,
              2,
            );
            break;
          }
          case "files": {
            const filter = asString(args["filter"]);
            const all = watcher.getTrackedFiles();
            const filtered = filter ? all.filter((f) => f.includes(filter)) : all;
            text = JSON.stringify({ total: all.length, files: filtered.slice(0, limit) }, null, 2);
            break;
          }
          case "hubs": {
            text = JSON.stringify(graph.getHubNodes().slice(0, limit), null, 2);
            break;
          }
          default: {
            yield delta(
              `Unknown action "${action}". Use one of: index, search, callers, callees, impact, explore, files, hubs.`,
            );
            return { stopReason: "fatal" };
          }
        }

        if (signal?.aborted) return { stopReason: "aborted" };
        yield delta(text.length > budget ? safeSlice(text, budget) : text);
        return;
      } catch (err) {
        yield delta(`code_graph failed: ${err instanceof Error ? err.message : String(err)}`);
        return { stopReason: "fatal" };
      }
    },
  };
}
