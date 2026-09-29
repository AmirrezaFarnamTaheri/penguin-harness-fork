import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeGraphTool } from "../../src/environment/tools/knowledge-graph.js";
import type { ToolExecutionContext } from "../../src/environment/tools/types.js";

const definition = {
  name: "knowledge_graph",
  description: "Record and query findings",
  parameters: {},
};

/** Drives the tool's generator to completion and collects its text deltas. */
async function run(
  args: Record<string, unknown>,
  workspaceDir: string,
  attribution?: { agentId: string; sessionId: string },
): Promise<{ output: string; stopReason: string }> {
  const tool = createKnowledgeGraphTool(definition);
  const ctx: ToolExecutionContext = {
    workspaceDir,
    toolCallId: "call_test",
    attribution,
  };
  let output = "";
  const generator = tool.execute(args, ctx);
  for (;;) {
    const step = await generator.next();
    if (step.done) {
      return {
        output,
        stopReason: step.value?.stopReason ?? "completed",
      };
    }
    // Envelope shape: { type: "model_msg", payload: { type: "partial_tool_call_output",
    // event_type, output } } — see omnimessage/builders.ts model()/partialToolCallOutput().
    const message = step.value as unknown as {
      type?: string;
      payload?: { type?: string; event_type?: string; output?: string };
    };
    if (
      message.type === "model_msg" &&
      message.payload?.type === "partial_tool_call_output" &&
      message.payload.event_type === "delta"
    ) {
      output += message.payload.output ?? "";
    }
  }
}

describe("knowledge_graph builtin tool", () => {
  it("reports with host-attested provenance and queries the claim back", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-tool-"));
    const reported = await run(
      {
        action: "report",
        title: "The graph watcher skips node_modules",
        kind: "insight",
        subjects: ["packages/core/src/agent/code-graph-watcher.ts"],
        evidence: [
          {
            path: "packages/core/src/agent/code-graph-watcher.ts",
            line: 56,
            tier: "implementation",
          },
        ],
        confidence: "high",
      },
      workspaceDir,
      { agentId: "agent-7", sessionId: "sess-9" },
    );
    expect(reported.stopReason).toBe("completed");
    const report = JSON.parse(reported.output) as {
      merged: boolean;
      id: string;
      sources: string[];
    };
    expect(report.merged).toBe(false);
    expect(report.sources).toEqual(["agent-7"]);

    const queried = await run({ action: "query", text: "node_modules watcher" }, workspaceDir);
    const hits = JSON.parse(queried.output) as Array<{ id: string; strength: number }>;
    expect(hits[0]?.id).toBe(report.id);
    expect(hits[0]?.strength).toBeGreaterThan(0);

    // The store exists under .penguin/knowledge and carries the claim.
    const raw = readFileSync(
      path.join(workspaceDir, ".penguin", "knowledge", "findings-graph.json"),
      "utf8",
    );
    expect(raw).toContain("The graph watcher skips node_modules");
  });

  it("lifecycle actions update status and events replay the history", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-tool-"));
    const first = JSON.parse(
      (await run({ action: "report", title: "Claim one about retries" }, workspaceDir)).output,
    ) as { id: string };
    const second = JSON.parse(
      (await run({ action: "report", title: "Claim two about budgets" }, workspaceDir)).output,
    ) as { id: string };

    const confirmed = JSON.parse(
      (await run({ action: "confirm", id: first.id, note: "verified" }, workspaceDir)).output,
    ) as { status: string };
    expect(confirmed.status).toBe("confirmed");

    const superseded = JSON.parse(
      (
        await run(
          {
            action: "supersede",
            id: first.id,
            replacement_id: second.id,
            note: "replaced by budget work",
          },
          workspaceDir,
        )
      ).output,
    ) as { status: string; supersededBy: string };
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe(second.id);

    const events = JSON.parse(
      (await run({ action: "events", since: 0 }, workspaceDir)).output,
    ) as Array<{
      type: string;
      seq: number;
    }>;
    expect(events.map((e) => e.type)).toEqual(["ingest", "ingest", "update", "supersede"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("fails cleanly on missing arguments and unknown actions", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-tool-"));
    const noAction = await run({}, workspaceDir);
    expect(noAction.stopReason).toBe("fatal");
    expect(noAction.output).toContain("action");

    const noTitle = await run({ action: "report" }, workspaceDir);
    expect(noTitle.stopReason).toBe("fatal");
    expect(noTitle.output).toContain("title");

    const unknown = await run({ action: "destroy" }, workspaceDir);
    expect(unknown.stopReason).toBe("fatal");
    expect(unknown.output).toContain("Unknown action");
  });
});
