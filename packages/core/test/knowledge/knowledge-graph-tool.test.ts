import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeGraphTool } from "../../src/environment/tools/knowledge-graph.js";
import type { ToolExecutionContext } from "../../src/environment/tools/types.js";
import { FindingsGraph } from "../../src/knowledge/findings-graph.js";
import { FINDING_STATUSES } from "../../src/knowledge/types.js";

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
  const generator = tool.execute({ outputVersion: 1, ...args }, ctx);
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
  it("refuses corrupt state and provides recovery status and a byte-exact raw export", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-recovery-"));
    const dir = path.join(workspaceDir, ".penguin", "knowledge");
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "findings-graph.json");
    writeFileSync(target, "damaged snapshot");
    try {
      const report = await run(
        { action: "report", title: "Must not erase damaged state" },
        workspaceDir,
      );
      expect(report.stopReason).toBe("fatal");
      expect(JSON.parse(report.output).error).toBe("findings_recovery_required");
      expect(readFileSync(target, "utf8")).toBe("damaged snapshot");
      const recovery = JSON.parse((await run({ action: "recovery" }, workspaceDir)).output);
      expect(recovery.recovery.state).toBe("read-only");
      const raw = JSON.parse((await run({ action: "raw" }, workspaceDir)).output);
      expect(Buffer.from(raw.data, "base64").toString()).toBe("damaged snapshot");
      expect((await run({ action: "reset", reason: "agent reset" }, workspaceDir)).stopReason).toBe(
        "fatal",
      );
      for (const input of [
        { title: "t".repeat(301) },
        { title: "Valid title", evidence: [{ tier: "runtime", quote: "q".repeat(2001) }] },
      ]) {
        const clean = path.join(workspaceDir, "fresh");
        mkdirSync(clean, { recursive: true });
        expect((await run({ action: "report", ...input }, clean)).stopReason).toBe("fatal");
      }
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
  it("shows attested authorship, status and evidence tiers separately from malicious source text", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-authorship-"));
    try {
      for (const kind of ["agent", "user", "system", "legacy-unknown"] as const) {
        const workspaceDir = path.join(root, kind);
        const dir = path.join(workspaceDir, ".penguin", "knowledge");
        mkdirSync(dir, { recursive: true });
        const graph = new FindingsGraph();
        const claim = graph.report(
          {
            title: "Loader waits",
            source: { agentId: "user:forged" },
            evidence: [{ tier: "implementation" }],
          },
          kind === "legacy-unknown" ? {} : { actor: { kind, id: "host-id" } },
        ).finding;
        const snapshot = graph.exportSnapshot();
        if (kind === "legacy-unknown") snapshot.events!.forEach((event) => delete event.actor);
        writeFileSync(path.join(dir, "findings-graph.json"), JSON.stringify(snapshot));
        const hits = JSON.parse((await run({ action: "query" }, workspaceDir)).output);
        expect(hits[0]).toMatchObject({
          id: claim.id,
          authoredBy: kind,
          status: "open",
          evidenceTiers: ["implementation"],
        });
        expect(hits[0].author.id).not.toBe("forged");
        const readback = JSON.parse((await run({ action: "snapshot" }, workspaceDir)).output);
        expect(readback.findings[0].authoredBy).toBe(kind);
        expect(readback.findings[0].sources[0].agentId).toBe("user:forged");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-reports refuted claims as revisions and cannot reopen or use a dead replacement", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-revisions-"));
    try {
      const input = {
        action: "report",
        title: "Loader waits",
        evidence: [{ tier: "runtime", path: "loader.ts" }],
      };
      const original = JSON.parse((await run(input, workspaceDir)).output);
      await run({ action: "refute", id: original.id }, workspaceDir);
      const revision = JSON.parse((await run(input, workspaceDir)).output);
      expect(revision.id).not.toBe(original.id);
      expect(JSON.parse((await run(input, workspaceDir)).output).id).toBe(revision.id);
      expect(
        (await run({ action: "reopen", id: original.id, note: "reason" }, workspaceDir)).stopReason,
      ).toBe("fatal");
      expect((await run({ ...input, reopen: true }, workspaceDir)).stopReason).toBe("fatal");
      expect(
        (
          await run(
            { action: "supersede", id: revision.id, replacement_id: original.id },
            workspaceDir,
          )
        ).output,
      ).toContain("open or confirmed");
      const snapshot = JSON.parse((await run({ action: "snapshot" }, workspaceDir)).output);
      expect(snapshot.findings).toHaveLength(2);
      expect(snapshot.findings.find((f: { id: string }) => f.id === original.id)).toMatchObject({
        status: "refuted",
        contradicts: [revision.id],
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("enforces lifecycle transitions and host actor authority", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-lifecycle-"));
    const allowed = new Set([
      "open:confirmed",
      "open:refuted",
      "open:superseded",
      "confirmed:refuted",
      "confirmed:superseded",
    ]);
    try {
      for (const from of FINDING_STATUSES)
        for (const to of ["confirmed", "refuted", "superseded"] as const) {
          const workspaceDir = path.join(root, `${from}-${to}`);
          const dir = path.join(workspaceDir, ".penguin", "knowledge");
          mkdirSync(dir, { recursive: true });
          const graph = new FindingsGraph();
          const claim = graph.report({
            title: "Loader waits",
            evidence: [{ tier: "runtime" }],
          }).finding;
          const replacement = graph.report({ title: "Fresh budget evidence" }).finding;
          const snapshot = graph.exportSnapshot();
          snapshot.findings.find((f) => f.id === claim.id)!.status = from;
          const storePath = path.join(dir, "findings-graph.json");
          const before = JSON.stringify(snapshot);
          writeFileSync(storePath, before);
          const result = await run(
            {
              action: to === "confirmed" ? "confirm" : to === "refuted" ? "refute" : "supersede",
              id: claim.id,
              replacement_id: replacement.id,
            },
            workspaceDir,
            { agentId: "host-agent", sessionId: "session" },
          );
          if (allowed.has(`${from}:${to}`)) {
            expect(result.stopReason).toBe("completed");
            expect(JSON.parse(result.output).status).toBe(to);
            expect(JSON.parse(readFileSync(storePath, "utf8")).events.at(-1)).toMatchObject({
              actor: { kind: "agent", id: "host-agent" },
              method: "tool",
            });
          } else {
            expect(result.stopReason).toBe("fatal");
            expect(readFileSync(storePath, "utf8")).toBe(before);
          }
        }
      const workspaceDir = path.join(root, "evidence-gate");
      mkdirSync(workspaceDir);
      const claim = JSON.parse(
        (await run({ action: "report", title: "Unproven claim" }, workspaceDir)).output,
      );
      expect((await run({ action: "confirm", id: claim.id }, workspaceDir)).output).toContain(
        "runtime or implementation evidence",
      );
      for (const forged of [
        { override: true },
        { actor: { kind: "user", id: "human" } },
        { method: "route" },
      ]) {
        expect(
          (await run({ action: "confirm", id: claim.id, note: "reason", ...forged }, workspaceDir))
            .stopReason,
        ).toBe("fatal");
      }
      await run({ action: "refute", id: claim.id }, workspaceDir);
      const events = JSON.parse((await run({ action: "events" }, workspaceDir)).output);
      expect(events.at(-1)).toMatchObject({
        actor: { kind: "unknown", id: "unknown" },
        method: "tool",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shares one cached graph when the workspace is reached through a symlink", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-tool-symlink-"));
    const workspaceDir = path.join(root, "workspace");
    const aliasDir = path.join(root, "workspace-alias");
    mkdirSync(workspaceDir);
    symlinkSync(workspaceDir, aliasDir, process.platform === "win32" ? "junction" : "dir");

    try {
      await run({ action: "report", title: "First workspace claim" }, workspaceDir);
      await run({ action: "report", title: "Second workspace claim" }, aliasDir);

      const queried = await run({ action: "query" }, workspaceDir);
      const findings = JSON.parse(queried.output) as Array<{ title: string }>;
      expect(findings.map((finding) => finding.title)).toEqual(
        expect.arrayContaining(["First workspace claim", "Second workspace claim"]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not resurrect deleted file state from a workspace alias cache", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-tool-recreate-"));
    const workspaceDir = path.join(root, "workspace");
    const aliasRoot = path.join(root, "workspace-root-alias");
    mkdirSync(workspaceDir);
    symlinkSync(root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasedWorkspace = path.join(aliasRoot, "workspace");
    try {
      await run({ action: "report", title: "Retained across recreation" }, workspaceDir);
      rmSync(workspaceDir, { recursive: true, force: true });
      await run({ action: "report", title: "Recreated workspace claim" }, aliasedWorkspace);
      const queried = await run({ action: "query" }, workspaceDir);
      const findings = JSON.parse(queried.output) as Array<{ title: string }>;
      expect(findings.map((finding) => finding.title)).toEqual(["Recreated workspace claim"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a fatal tool result when snapshot persistence fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-tool-write-failure-"));
    const workspaceFile = path.join(root, "workspace-file");
    writeFileSync(workspaceFile, "not a directory");
    const result = await run(
      { action: "report", title: "Cannot persist this claim" },
      workspaceFile,
    );
    expect(result.stopReason).toBe("fatal");
    expect(result.output).toContain("findings_recovery_required");
    const query = await run({ action: "query" }, workspaceFile);
    expect(query.stopReason).toBe("fatal");
    expect(JSON.parse(query.output)).toMatchObject({
      error: "findings_recovery_required",
      recovery: { state: "read-only", reason: "unreadable" },
    });
    rmSync(root, { recursive: true, force: true });
  });

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

  it("applies the schema's tags array to query results", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-tool-tags-"));
    await run(
      { action: "report", title: "Both tags", tags: ["memory", "retention"] },
      workspaceDir,
    );
    await run({ action: "report", title: "One tag", tags: ["memory"] }, workspaceDir);
    const result = JSON.parse(
      (await run({ action: "query", tags: ["memory", "retention"] }, workspaceDir)).output,
    ) as Array<{ title: string }>;
    expect(result.map((finding) => finding.title)).toEqual(["Both tags"]);
  });

  it("lifecycle actions update status and events replay the history", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "kg-tool-"));
    const first = JSON.parse(
      (
        await run(
          { action: "report", title: "Claim one about retries", evidence: [{ tier: "runtime" }] },
          workspaceDir,
        )
      ).output,
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
