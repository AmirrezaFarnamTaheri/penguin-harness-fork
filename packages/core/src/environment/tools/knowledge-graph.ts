/**
 * knowledge_graph builtin tool — the agent-facing surface of the findings plane.
 *
 * Why this exists as a tool and not just a library: findings are only durable if the agent
 * can record them DURING work, with provenance, and read them back in a later session. The
 * tool is the write path (`report`) and the read path (`query`) in one place; the engine
 * (../../knowledge/findings-graph.ts) owns merging, supersession and decay.
 *
 * Provenance rule: `source` is filled from `ctx.attribution` (host-recorded identity), never
 * from model-supplied arguments, so a prompt cannot forge who reported a claim.
 *
 * Persistence: one JSON snapshot per workspace at `<workspaceDir>/.penguin/knowledge/
 * findings-graph.json`, loaded lazily and saved after every mutation (atomic temp+rename).
 * The tool never touches anything outside that file — it is read-only with respect to the
 * codebase itself and safe under any approval mode that allows state writes.
 */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { OmniMessage } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import { FindingsGraph } from "../../knowledge/findings-graph.js";
import type {
  FindingEvidence,
  FindingKind,
  FindingQuery,
  FindingSeverity,
} from "../../knowledge/types.js";
import type { BuiltinTool, ToolExecutionContext, ToolResult } from "./types.js";
import { describeArgumentError } from "./tool-arguments.js";

export const KNOWLEDGE_GRAPH_NAME = "knowledge_graph";

const DEFAULT_OUTPUT_BUDGET = 6000;
const KINDS: readonly FindingKind[] = [
  "defect",
  "insight",
  "decision",
  "pattern",
  "metric",
  "hypothesis",
];
const SEVERITIES: readonly FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

export const KNOWLEDGE_GRAPH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["report", "query", "confirm", "refute", "supersede", "link", "events", "snapshot"],
      description:
        "report: record a finding (merges duplicates, keeps provenance). query: ranked search over findings. confirm/refute: update a claim's lifecycle. supersede: mark a claim replaced by a new one. link: relate two findings. events: what changed since a sequence number. snapshot: full export.",
    },
    title: { type: "string", description: "report: the one-line claim. Required for report." },
    body: { type: "string", description: "report: the full claim text." },
    kind: {
      type: "string",
      enum: KINDS as unknown as string[],
      description: "report: what kind of claim this is (default insight).",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "report: reporter confidence (default medium).",
    },
    severity: {
      type: "string",
      enum: SEVERITIES as unknown as string[],
      description: "report: impact if true (default info).",
    },
    subjects: {
      type: "array",
      items: { type: "string" },
      description: "report: paths/modules/symbols the claim is about.",
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          line: { type: "number" },
          quote: { type: "string" },
          tier: {
            type: "string",
            enum: ["runtime", "implementation", "history", "documentation", "anecdote"],
          },
          note: { type: "string" },
        },
        required: ["tier"],
      },
      description: "report: backing evidence, strongest tier first.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "report: topic tags; query: require all listed tags.",
    },
    text: { type: "string", description: "query: free-text terms." },
    subject: { type: "string", description: "query: subject filter (exact or path prefix)." },
    status: {
      type: "string",
      enum: ["open", "confirmed", "refuted", "superseded"],
      description: "query: lifecycle filter (default hides refuted and superseded).",
    },
    id: { type: "string", description: "confirm/refute/supersede/link/events target finding id." },
    replacement_id: { type: "string", description: "supersede: the finding that replaces id." },
    link_id: { type: "string", description: "link: the second finding id." },
    note: { type: "string", description: "confirm/refute/supersede: why the status changed." },
    since: { type: "number", description: "events: return events with seq greater than this." },
    limit: { type: "number", description: "query: maximum results." },
  },
  required: ["action"],
} as const;

/**
 * One graph per workspace, stored under `.penguin/knowledge/`. The server findings route is
 * project-scoped and intentionally uses its own store: there is no trusted workspace-to-project
 * mapping here, so the two authorities must not be joined by matching paths or names.
 */
const graphs = new Map<string, FindingsGraph>();

function storePathFor(workspaceDir: string): string {
  return path.join(workspaceDir, ".penguin", "knowledge", "findings-graph.json");
}

function canonicalWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  try {
    return realpathSync(resolved);
  } catch (error) {
    // Keep the canonical key stable if the workspace is temporarily absent. Resolve the
    // nearest existing ancestor through symlinks, then append the missing suffix.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      let ancestor = resolved;
      const suffix: string[] = [];
      for (;;) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
        try {
          return path.join(realpathSync(ancestor), ...suffix);
        } catch (ancestorError) {
          if (!(
            ancestorError instanceof Error &&
            "code" in ancestorError &&
            ancestorError.code === "ENOENT"
          )) {
            throw ancestorError;
          }
        }
      }
    }
    throw error;
  }
}

function loadGraph(workspaceDir: string): FindingsGraph {
  const cached = graphs.get(workspaceDir);
  if (cached) return cached;
  const graph = new FindingsGraph();
  try {
    const raw = readFileSync(storePathFor(workspaceDir), "utf8");
    graph.importSnapshot(raw);
  } catch {
    // No store yet (or unreadable): start empty. importSnapshot already degrades record-wise.
  }
  graphs.set(workspaceDir, graph);
  return graph;
}

function saveGraph(workspaceDir: string, graph: FindingsGraph): void {
  const target = storePathFor(workspaceDir);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(graph.exportSnapshot(), null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    graphs.delete(workspaceDir);
    try {
      unlinkSync(tmp);
    } catch {
      /* preserve the original persistence failure */
    }
    throw new Error(
      `Unable to persist knowledge graph at ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

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

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function asEvidence(value: unknown): FindingEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: FindingEvidence[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const tier = asString(e["tier"]);
    if (
      tier !== "runtime" &&
      tier !== "implementation" &&
      tier !== "history" &&
      tier !== "documentation" &&
      tier !== "anecdote"
    ) {
      continue;
    }
    out.push({
      tier,
      path: asString(e["path"]),
      line: typeof e["line"] === "number" ? e["line"] : undefined,
      quote: asString(e["quote"]),
      note: asString(e["note"]),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function createKnowledgeGraphTool(definition: ToolDefinitionConfig): BuiltinTool {
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
          describeArgumentError(definition, args, {
            argument: "action",
            kind: "missing",
          }),
        );
        return { stopReason: "fatal" };
      }
      if (signal?.aborted) return { stopReason: "aborted" };

      const workspaceDir = canonicalWorkspaceDir(ctx.workspaceDir);
      const graph = loadGraph(workspaceDir);

      let text: string;
      try {
        switch (action) {
          case "report": {
            const title = asString(args["title"]);
            if (title === undefined) {
              yield delta(
                describeArgumentError(definition, args, {
                  argument: "title",
                  kind: "missing",
                }),
              );
              return { stopReason: "fatal" };
            }
            const result = graph.report({
              title,
              body: asString(args["body"]),
              kind: KINDS.includes(args["kind"] as FindingKind)
                ? (args["kind"] as FindingKind)
                : undefined,
              confidence:
                args["confidence"] === "low" || args["confidence"] === "high"
                  ? args["confidence"]
                  : args["confidence"] === "medium"
                    ? "medium"
                    : undefined,
              severity: SEVERITIES.includes(args["severity"] as FindingSeverity)
                ? (args["severity"] as FindingSeverity)
                : undefined,
              subjects: asStringArray(args["subjects"]),
              evidence: asEvidence(args["evidence"]),
              tags: asStringArray(args["tags"]),
              // Host-recorded identity: a prompt cannot forge who reported this.
              source: ctx.attribution
                ? {
                    agentId: ctx.attribution.agentId,
                    sessionId: ctx.attribution.sessionId,
                    report: asString(args["note"]),
                  }
                : undefined,
            });
            saveGraph(workspaceDir, graph);
            text = JSON.stringify(
              {
                merged: result.merged,
                id: result.finding.id,
                status: result.finding.status,
                strength: Number(graph.strength(result.finding.id).toFixed(3)),
                subjects: result.finding.subjects,
                sources: result.finding.sources.map((s) => s.agentId ?? s.sessionId ?? "host"),
              },
              null,
              2,
            );
            break;
          }
          case "query": {
            const query: FindingQuery = {
              text: asString(args["text"]),
              subject: asString(args["subject"]),
              tags: asStringArray(args["tags"]),
              kind: KINDS.includes(args["kind"] as FindingKind)
                ? (args["kind"] as FindingKind)
                : undefined,
              status:
                args["status"] === "open" ||
                args["status"] === "confirmed" ||
                args["status"] === "refuted" ||
                args["status"] === "superseded"
                  ? args["status"]
                  : undefined,
              limit: typeof args["limit"] === "number" ? args["limit"] : 20,
            };
            const hits = graph.query(query);
            text = JSON.stringify(
              hits.map((f) => ({
                id: f.id,
                title: f.title,
                kind: f.kind,
                status: f.status,
                confidence: f.confidence,
                severity: f.severity,
                subjects: f.subjects,
                strength: Number(graph.strength(f.id).toFixed(3)),
              })),
              null,
              2,
            );
            break;
          }
          case "confirm":
          case "refute": {
            const id = asString(args["id"]);
            if (id === undefined) {
              yield delta(
                describeArgumentError(definition, args, { argument: "id", kind: "missing" }),
              );
              return { stopReason: "fatal" };
            }
            const finding =
              action === "confirm"
                ? graph.confirm(id, asString(args["note"]))
                : graph.refute(id, asString(args["note"]));
            saveGraph(workspaceDir, graph);
            text = JSON.stringify({ id: finding.id, status: finding.status }, null, 2);
            break;
          }
          case "supersede": {
            const id = asString(args["id"]);
            const replacementId = asString(args["replacement_id"]);
            if (id === undefined || replacementId === undefined) {
              yield delta(
                describeArgumentError(definition, args, {
                  argument: replacementId === undefined ? "replacement_id" : "id",
                  kind: "missing",
                }),
              );
              return { stopReason: "fatal" };
            }
            const finding = graph.supersede(id, replacementId, asString(args["note"]));
            saveGraph(workspaceDir, graph);
            text = JSON.stringify(
              { id: finding.id, status: finding.status, supersededBy: finding.supersededBy },
              null,
              2,
            );
            break;
          }
          case "link": {
            const id = asString(args["id"]);
            const linkId = asString(args["link_id"]);
            if (id === undefined || linkId === undefined) {
              yield delta(
                describeArgumentError(definition, args, {
                  argument: linkId === undefined ? "link_id" : "id",
                  kind: "missing",
                }),
              );
              return { stopReason: "fatal" };
            }
            graph.link(id, linkId);
            saveGraph(workspaceDir, graph);
            text = JSON.stringify({ linked: [id, linkId] }, null, 2);
            break;
          }
          case "events": {
            const since = typeof args["since"] === "number" ? args["since"] : 0;
            text = JSON.stringify(graph.since(since), null, 2);
            break;
          }
          case "snapshot": {
            text = JSON.stringify(graph.exportSnapshot(), null, 2);
            break;
          }
          default: {
            yield delta(
              `Unknown action "${action}". Use one of: ${[
                "report",
                "query",
                "confirm",
                "refute",
                "supersede",
                "link",
                "events",
                "snapshot",
              ].join(", ")}.`,
            );
            return { stopReason: "fatal" };
          }
        }
      } catch (err) {
        yield delta(
          `knowledge_graph ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { stopReason: "fatal" };
      }

      if (signal?.aborted) return { stopReason: "aborted" };
      yield delta(text.length > budget ? safeSlice(text, budget) : text);
      return;
    },
  };
}
