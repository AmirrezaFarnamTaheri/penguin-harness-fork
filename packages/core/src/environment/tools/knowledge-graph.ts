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
 * Persistence: one authority per workspace at `<workspaceDir>/.penguin/knowledge/
 * findings-graph.json`. The shared store locks updates, validates revisions and acknowledges
 * only atomic writes. Its lock/recovery files stay beside the authority; corrupt snapshots
 * enter read-only recovery with preserved raw bytes. The tool cannot reset or prune state.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { OmniMessage } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import { FindingsStore, FindingsRecoveryError } from "../../knowledge/store.js";
import { validateReportInput } from "../../knowledge/validation.js";
import { findingsPage, boundedFindingsJson } from "../../knowledge/paging.js";
import {
  FINDING_KINDS as KINDS,
  FINDING_SEVERITIES as SEVERITIES,
  FINDING_STATUSES,
  FINDING_CONFIDENCE,
  EVIDENCE_TIERS,
} from "../../knowledge/types.js";
import type { FindingMutationContext } from "../../knowledge/types.js";
import type { BuiltinTool, ToolExecutionContext, ToolResult } from "./types.js";
import { describeArgumentError } from "./tool-arguments.js";

export const KNOWLEDGE_GRAPH_NAME = "knowledge_graph";

const DEFAULT_OUTPUT_BUDGET = 6000;

export const KNOWLEDGE_GRAPH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "report",
        "query",
        "confirm",
        "refute",
        "supersede",
        "link",
        "events",
        "snapshot",
        "archive",
        "recovery",
        "raw",
        "recall",
      ],
      description:
        "report: record a claim requiring verification (merges live duplicates, keeps provenance). query: paged ranked findings with evidence tiers and attested authorship. confirm: requires runtime or implementation evidence. refute: falsify a claim. supersede: replace a live claim. link: relate two findings. events: paged changes since a sequence number. snapshot: paged live finding readback. archive: page through bounded eviction history. recall: retrieve a full finding, archived record, or event in base64 JSON chunks. recovery: inspect authority and archive health. raw: export bounded original-byte pages. Read actions default to outputVersion 2; continue with nextCursor and identical filters.",
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
      enum: FINDING_CONFIDENCE,
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
            enum: EVIDENCE_TIERS,
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
      enum: FINDING_STATUSES,
      description: "query: lifecycle filter (default hides refuted and superseded).",
    },
    id: {
      type: "string",
      description: "Lifecycle target, or snapshot/archive/recall finding ID or recall ID.",
    },
    replacement_id: { type: "string", description: "supersede: the finding that replaces id." },
    link_id: { type: "string", description: "link: the second finding id." },
    note: { type: "string", description: "confirm/refute/supersede: why the status changed." },
    cursor: {
      type: "string",
      description:
        "query/snapshot/events/archive/recall: opaque continuation cursor; reuse the same filters.",
    },
    outputVersion: {
      type: "number",
      enum: [1, 2],
      description:
        "Read response version (default 2). Version 1 preserves only small legacy responses.",
    },
    offset: { type: "number", description: "raw: byte offset for a base64 recovery export page." },
    revision: {
      type: "string",
      description: "mutation: expected revision from recovery; stale writes fail.",
    },
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
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
        partialToolCallOutput({
          eventType: "delta",
          toolCallId,
          output: boundedFindingsJson(
            (() => {
              try {
                return JSON.parse(output);
              } catch {
                return { error: { code: "knowledge_graph_error", message: output } };
              }
            })(),
            budget,
          ),
        });
      const budget =
        definition.maxOutputLength !== undefined && definition.maxOutputLength > 0
          ? Math.max(1, Math.floor(definition.maxOutputLength))
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
      const store = new FindingsStore({
        id: `workspace:${workspaceDir}`,
        kind: "workspace",
        filePath: path.join(workspaceDir, ".penguin", "knowledge", "findings-graph.json"),
      });

      let text: string;
      try {
        // These fields are host authority, never tool arguments (including direct execution).
        if (
          args.revision !== undefined &&
          (typeof args.revision !== "string" || !args.revision.trim())
        )
          throw new Error("revision must be a non-empty string.");
        for (const field of ["actor", "method", "override", "reopen"]) {
          if (Object.hasOwn(args, field))
            throw new Error(`${field} cannot be supplied by an agent.`);
        }
        const read = await store.read();
        if (action === "recovery") {
          yield delta(
            JSON.stringify({
              scope: read.scope,
              revision: read.revision,
              recovery: read.recovery,
              bytes: read.bytes,
              highWater: read.highWater,
              archive: read.graph?.archiveStats() ?? null,
            }),
          );
          return;
        }
        if (action === "raw") {
          yield delta(
            JSON.stringify(await store.rawPage(typeof args.offset === "number" ? args.offset : 0)),
          );
          return;
        }
        if (!read.graph || read.recovery) throw new FindingsRecoveryError(read);
        if (
          action === "query" ||
          action === "snapshot" ||
          action === "events" ||
          action === "archive" ||
          action === "recall"
        ) {
          const page = findingsPage(read, action, args, budget);
          yield delta(page.text);
          return page.failed ? { stopReason: "fatal" } : undefined;
        }
        const context: FindingMutationContext = {
          method: "tool",
          actor: ctx.attribution?.agentId
            ? { kind: "agent", id: ctx.attribution.agentId }
            : { kind: "unknown", id: "unknown" },
        };
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
            const input = validateReportInput(
              args,
              ctx.attribution
                ? {
                    agentId: ctx.attribution.agentId,
                    sessionId: ctx.attribution.sessionId,
                    report: asString(args["note"]),
                  }
                : undefined,
            );
            const result = await store.update(asString(args["revision"]), (current) => {
              const report = current.report(input, context);
              return {
                ...report,
                strength: Number(current.strength(report.finding.id).toFixed(3)),
              };
            });
            text = JSON.stringify(
              {
                merged: result.merged,
                id: result.finding.id,
                status: result.finding.status,
                strength: result.strength,
                subjects: result.finding.subjects,
                sources: result.finding.sources.map((s) => s.agentId ?? s.sessionId ?? "unknown"),
              },
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
            const finding = await store.update(asString(args["revision"]), (current) =>
              action === "confirm"
                ? current.confirm(id, asString(args["note"]), context)
                : current.refute(id, asString(args["note"]), context),
            );
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
            const finding = await store.update(asString(args["revision"]), (current) =>
              current.supersede(id, replacementId, asString(args["note"]), context),
            );

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
            await store.update(asString(args["revision"]), (current) =>
              current.link(id, linkId, context),
            );

            text = JSON.stringify({ linked: [id, linkId] }, null, 2);
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
                "archive",
                "recall",
                "recovery",
                "raw",
              ].join(", ")}.`,
            );
            return { stopReason: "fatal" };
          }
        }
      } catch (err) {
        if (err instanceof FindingsRecoveryError) {
          yield delta(
            JSON.stringify({
              error: "findings_recovery_required",
              scope: err.read.scope,
              revision: err.read.revision,
              recovery: err.read.recovery,
            }),
          );
          return { stopReason: "fatal" };
        }
        yield delta(
          `knowledge_graph ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { stopReason: "fatal" };
      }

      if (signal?.aborted) return { stopReason: "aborted" };
      yield delta(text);
      return;
    },
  };
}
