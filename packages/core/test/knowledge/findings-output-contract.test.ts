import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledgeGraphTool } from "../../src/environment/tools/knowledge-graph.js";
import { FindingsGraph } from "../../src/knowledge/findings-graph.js";
import type { FindingsGraphSnapshot, FindingsPageEnvelope } from "../../src/knowledge/types.js";

describe("knowledge_graph versioned output contract", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "kg-output-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = (workspace = root) =>
    path.join(workspace, ".penguin", "knowledge", "findings-graph.json");
  async function seed(
    count: number,
    body = "Verified claim",
    workspace = root,
  ): Promise<FindingsGraphSnapshot> {
    const graph = new FindingsGraph();
    const template = graph.report({ title: "Seed", body, evidence: [{ tier: "runtime" }] }).finding;
    const snapshot: FindingsGraphSnapshot = {
      version: 1,
      findings: Array.from({ length: count }, (_, i) => ({
        ...template,
        id: `record-${String(i).padStart(4, "0")}`,
        title: `发现🚀 ${i}`,
        updatedAt: template.updatedAt + i,
      })),
      events: Array.from({ length: count }, (_, i) => ({
        seq: i + 1,
        type: "ingest",
        findingId: `record-${String(i).padStart(4, "0")}`,
        at: template.updatedAt,
        actor: { kind: "agent", id: "host-agent" },
        method: "tool",
      })),
    };
    await fs.mkdir(path.dirname(target(workspace)), { recursive: true });
    await fs.writeFile(target(workspace), JSON.stringify(snapshot));
    return snapshot;
  }
  async function run(
    args: Record<string, unknown>,
    budget = 2048,
    workspace = root,
  ): Promise<{ value: any; text: string; fatal: boolean }> {
    const tool = createKnowledgeGraphTool({
      name: "knowledge_graph",
      description: "Findings",
      parameters: {},
      maxOutputLength: budget,
    });
    const generator = tool.execute(args, {
      workspaceDir: workspace,
      toolCallId: "contract",
      attribution: { agentId: "host-agent", sessionId: "session" },
    });
    let text = "";
    for (;;) {
      const step = await generator.next();
      if (step.done) {
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(budget);
        return { value: JSON.parse(text), text, fatal: step.value?.stopReason === "fatal" };
      }
      const payload = (step.value as unknown as { payload: { output?: string } }).payload;
      text += payload.output ?? "";
    }
  }

  it("pages 500 findings without duplicate or missing IDs on a fixed revision", async () => {
    const snapshot = await seed(500);
    for (const action of ["query", "snapshot"] as const) {
      let cursor: string | undefined;
      let revision: string | undefined;
      const ids: string[] = [];
      let pages = 0;
      do {
        const result = await run({ action, cursor });
        const page = result.value as FindingsPageEnvelope;
        expect(result.fatal).toBe(false);
        expect(page.version).toBe(2);
        expect(page.action).toBe(action);
        if (revision) expect(page.scopeRevision).toBe(revision);
        revision = page.scopeRevision;
        ids.push(...page.items.map((item: any) => item.id));
        expect(page.omittedCount).toBe(500 - ids.length);
        cursor = page.nextCursor ?? undefined;
        expect(++pages).toBeLessThan(501);
      } while (cursor);
      expect(new Set(ids).size).toBe(500);
      expect([...ids].sort()).toEqual(snapshot.findings.map((f) => f.id).sort());
    }
  });

  it("pages archived tombstones and recalls their full finding readback", async () => {
    const snapshot = await seed(1);
    snapshot.archive = Array.from({ length: 3 }, (_, i) => ({
      operationId: `archive-operation-${i}`,
      archivedAt: Date.now() + i,
      finding: {
        ...snapshot.findings[0]!,
        id: `archived-record-${i}`,
        title: `Archived claim ${i}`,
      },
    }));
    await fs.writeFile(target(), JSON.stringify(snapshot));
    const archivedIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await run({ action: "archive", limit: 1, cursor });
      expect(page.fatal).toBe(false);
      expect(page.value.latestSequence).toBe(1);
      archivedIds.push(page.value.items[0].finding.id);
      cursor = page.value.nextCursor ?? undefined;
    } while (cursor);
    expect(archivedIds).toEqual(["archived-record-0", "archived-record-1", "archived-record-2"]);
    const recalled = await run({ action: "recall", id: archivedIds[0] });
    expect(recalled.value.items[0].encoding).toBe("base64-json");
    const bytes = Buffer.from(recalled.value.items[0].data, "base64");
    const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
    expect(value).toMatchObject({
      operationId: "archive-operation-0",
      finding: { id: "archived-record-0", authoredBy: "legacy-unknown" },
    });
  });

  it("binds cursors to scope, filter and revision and rejects malformed tokens", async () => {
    await seed(20);
    const { value: first } = await run({ action: "query", limit: 2 });
    expect(first.nextCursor).toBeTypeOf("string");
    const mismatched = await run({
      action: "query",
      limit: 2,
      text: "other",
      cursor: first.nextCursor,
    });
    expect(mismatched.value.error.code).toBe("cursor_mismatch");
    const other = path.join(root, "other");
    await seed(20, "Verified claim", other);
    expect(
      (await run({ action: "query", limit: 2, cursor: first.nextCursor }, 2048, other)).value.error
        .code,
    ).toBe("cursor_mismatch");
    expect((await run({ action: "query", cursor: "%zz" })).value.error.code).toBe("invalid_cursor");
    await run({ action: "report", title: "Concurrent mutation" });
    const stale = await run({ action: "query", limit: 2, cursor: first.nextCursor });
    expect(stale.fatal).toBe(true);
    expect(stale.value.error).toMatchObject({ code: "stale_cursor", restart: true });
    expect(stale.value.items).toEqual([]);
  });

  it("summarizes oversized records and recalls their full multibyte JSON without losing bytes", async () => {
    const body = "汉🚀".repeat(10000);
    const snapshot = await seed(1, body);
    const summary = (await run({ action: "snapshot" })).value;
    expect(summary.items[0]).toMatchObject({
      id: snapshot.findings[0]!.id,
      oversized: true,
      recallAction: "recall",
    });
    const pieces: Buffer[] = [];
    let cursor: string | undefined;
    let offset = 0;
    let pages = 0;
    do {
      const result = await run({ action: "recall", id: summary.items[0].recallId, cursor });
      expect(result.fatal).toBe(false);
      const part = result.value.items[0];
      expect(part.offset).toBe(offset);
      const bytes = Buffer.from(part.data, "base64");
      pieces.push(bytes);
      offset += bytes.length;
      cursor = result.value.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(1000);
    } while (cursor);
    const recalled = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(pieces)),
    );
    expect(recalled.body).toBe(body);
    expect(recalled.id).toBe(snapshot.findings[0]!.id);
    expect(recalled.authoredBy).toBe("agent");
  });

  it("reports event gaps before claiming complete replay and supports oversized event recall", async () => {
    const snapshot = await seed(20);
    snapshot.events![0]!.note = "汉🚀".repeat(1000);
    await fs.writeFile(target(), JSON.stringify(snapshot));
    const first = (await run({ action: "events", limit: 2 })).value;
    expect(first.items[0]).toMatchObject({ seq: 1, oversized: true, recallId: "event:1" });
    expect((await run({ action: "recall", id: "event:1" })).value.items[0].encoding).toBe(
      "base64-json",
    );
    snapshot.events = snapshot.events!.slice(-2).map((event, i) => ({ ...event, seq: 100 + i }));
    await fs.writeFile(target(), JSON.stringify(snapshot));
    const gap = await run({ action: "events", limit: 2, cursor: first.nextCursor });
    expect(gap.value.error).toMatchObject({
      code: "event_gap",
      restart: true,
      earliestSequence: 100,
    });
    expect(gap.fatal).toBe(true);
    expect((await run({ action: "events", since: 99 })).value.items).toHaveLength(2);
  });

  it("preserves small version-1 consumer shapes and refuses oversized compatibility results", async () => {
    await seed(1);
    const query = await run({ action: "query", outputVersion: 1 });
    expect(Array.isArray(query.value)).toBe(true);
    expect(query.value[0].id).toBe("record-0000");
    const snapshot = await run({ action: "snapshot", outputVersion: 1 });
    expect(snapshot.value.version).toBe(1);
    expect(snapshot.value.findings).toHaveLength(1);
    expect(Array.isArray((await run({ action: "events", outputVersion: 1 })).value)).toBe(true);
    await seed(1, "汉🚀".repeat(10000));
    const tooLarge = await run({ action: "snapshot", outputVersion: 1 });
    expect(tooLarge.value.error.code).toBe("compatibility_output_too_large");
    expect(tooLarge.fatal).toBe(true);
  });

  it("keeps failures and tiny-budget responses parseable, and keeps queries out of bodies", async () => {
    await seed(2, "Private claim body");
    for (const budget of [1, 2, 30, 120, 300, 1024, 2048]) {
      const result = await run({ action: "snapshot" }, budget);
      expect(result.text).toBeTypeOf("string");
    }
    for (const args of [
      { action: "query", limit: -1 },
      { action: "events", since: 1.5 },
      { action: "query", kind: "vibes" },
      { action: "recall", id: "unknown" },
      { action: "unknown" },
      { action: "report" },
    ]) {
      expect((await run(args)).fatal).toBe(true);
    }
    const query = await run({ action: "query" });
    expect(query.text).not.toContain("Private claim body");
  });
});
