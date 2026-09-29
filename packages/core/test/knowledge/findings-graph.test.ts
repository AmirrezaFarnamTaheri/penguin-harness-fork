import { describe, expect, it } from "vitest";
import { FindingsGraph } from "../../src/knowledge/findings-graph.js";

/** A graph with a controllable clock so decay assertions are deterministic. */
function makeGraph(startAt = 1_700_000_000_000) {
  let clock = startAt;
  const graph = new FindingsGraph({ now: () => clock });
  return {
    graph,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("FindingsGraph reporting and merging", () => {
  it("creates a finding and assigns a deterministic id", () => {
    const { graph } = makeGraph();
    const { finding, merged } = graph.report({
      title: "Session loader reads local shards",
      kind: "insight",
      subjects: ["packages/server/src/services/trace-service.ts"],
      evidence: [
        {
          path: "packages/server/src/services/trace-service.ts",
          line: 306,
          tier: "implementation",
        },
      ],
      source: { agentId: "a1", sessionId: "s1" },
    });
    expect(merged).toBe(false);
    expect(finding.id).toContain("session-loader-reads-local-shards");
    // Same claim reported again lands on the same id deterministically.
    const again = graph.report({ title: "Session loader reads local shards" });
    expect(again.finding.id.split("-").slice(0, -1).join("-")).toBe(
      finding.id.split("-").slice(0, -1).join("-"),
    );
  });

  it("merges duplicate wordings of one claim and unions evidence and sources", () => {
    const { graph } = makeGraph();
    const first = graph.report({
      title: "The graph watcher ignores node_modules directories during traversal",
      body: "DEFAULT_IGNORES keeps vendor trees out of the code graph.",
      evidence: [{ path: "a.ts", line: 56, tier: "implementation" }],
      source: { agentId: "a1" },
      confidence: "medium",
    });
    const second = graph.report({
      title: "The graph watcher ignores node_modules directories during traversal",
      body: "DEFAULT_IGNORES keeps vendor trees out of the code graph and .git too.",
      evidence: [
        { path: "a.ts", line: 56, tier: "implementation" },
        { path: "b.ts", line: 2, tier: "runtime" },
      ],
      source: { agentId: "a2" },
      confidence: "high",
    });
    expect(second.merged).toBe(true);
    expect(second.finding.id).toBe(first.finding.id);
    expect(second.finding.evidence).toHaveLength(2);
    expect(second.finding.sources.map((s) => s.agentId).sort()).toEqual(["a1", "a2"]);
    // Merge moves confidence upward, never downward.
    expect(second.finding.confidence).toBe("high");
  });

  it("replaces, not appends, a repeated report from the same source", () => {
    const { graph } = makeGraph();
    graph.report({
      title: "Replace-by-source accounting keeps one reporter honest",
      evidence: [{ path: "x.ts", line: 1, tier: "implementation", quote: "v1" }],
      source: { agentId: "a1", report: "first pass" },
    });
    const second = graph.report({
      title: "Replace-by-source accounting keeps one reporter honest",
      evidence: [{ path: "x.ts", line: 1, tier: "implementation", quote: "v2" }],
      source: { agentId: "a1", report: "second pass" },
    });
    expect(second.finding.sources).toHaveLength(1);
    expect(second.finding.sources[0]?.report).toBe("second pass");
  });

  it("links near-misses as related instead of merging them", () => {
    // Explicit thresholds so the test exercises the LINK behavior rather than token luck:
    // these two are close enough to relate (>= 0.3) but not to merge (< 0.7).
    let clock = 1_700_000_000_000;
    const graph = new FindingsGraph({
      now: () => clock,
      relateJaccard: 0.3,
      mergeJaccard: 0.7,
    });
    const a = graph.report({
      title: "The cache key ignores the workspace root dimension",
      body: "Sync seams returned the first root's runtime for a project id.",
    });
    const b = graph.report({
      title: "The cache key ignores the workspace root dimension in tests",
      body: "A stale watcher is returned when roots differ per call in the suite.",
    });
    expect(b.merged).toBe(false);
    expect(b.finding.id).not.toBe(a.finding.id);
    expect(b.finding.related).toContain(a.finding.id);
    expect(graph.get(a.finding.id)?.related).toContain(b.finding.id);
    void clock;
  });
});

describe("FindingsGraph lifecycle", () => {
  it("confirms, refutes and supersedes without ever deleting", () => {
    const { graph } = makeGraph();
    // Deliberately dissimilar claims: lexically-near-identical titles would MERGE (the
    // dedupe line doing its job), and a merged claim cannot supersede itself.
    const old = graph.report({ title: "The loader awaits the cloud mirror" });
    const replacement = graph.report({ title: "Shards render before any reconciliation" });

    expect(graph.confirm(old.finding.id).status).toBe("confirmed");
    expect(graph.refute(old.finding.id, "falsified").status).toBe("refuted");
    expect(graph.get(old.finding.id)).not.toBeNull();

    const superseded = graph.supersede(old.finding.id, replacement.finding.id);
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe(replacement.finding.id);
    expect(graph.get(replacement.finding.id)?.related).toContain(old.finding.id);
  });

  it("rejects self-supersession and unknown ids", () => {
    const { graph } = makeGraph();
    const f = graph.report({ title: "Solo claim" });
    expect(() => graph.supersede(f.finding.id, f.finding.id)).toThrow(/cannot supersede itself/);
    expect(() => graph.confirm("nope")).toThrow(/Unknown finding/);
    expect(() => graph.report({ title: "   " })).toThrow(/title/);
  });

  it("records every mutation in the bounded event log with monotonic seq", () => {
    const { graph } = makeGraph();
    const f = graph.report({ title: "An evented claim" });
    graph.confirm(f.finding.id);
    graph.refute(f.finding.id);
    const events = graph.since(0);
    expect(events.map((e) => e.type)).toEqual(["ingest", "update", "refute"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(graph.since(2)).toHaveLength(1);
  });
});

describe("FindingsGraph query and strength", () => {
  it("filters by subject prefix so a directory query reaches its files", () => {
    const { graph } = makeGraph();
    graph.report({ title: "Server finding", subjects: ["packages/server/src/a.ts"] });
    graph.report({ title: "Web finding", subjects: ["packages/web/src/b.ts"] });
    const hits = graph.query({ subject: "packages/server" });
    expect(hits.map((f) => f.title)).toEqual(["Server finding"]);
  });

  it("hides refuted and superseded claims unless asked", () => {
    const { graph } = makeGraph();
    const a = graph.report({ title: "Live claim one" });
    const b = graph.report({ title: "Dead claim two" });
    graph.refute(b.finding.id);
    expect(graph.query().map((f) => f.id)).toEqual([a.finding.id]);
    expect(graph.query({ status: "refuted" }).map((f) => f.id)).toEqual([b.finding.id]);
  });

  it("ranks confirmed over open and matches text case-insensitively", () => {
    const { graph } = makeGraph();
    const open = graph.report({ title: "Tokio runtime budget finding" });
    const confirmed = graph.report({ title: "Tokio budget finding confirmed" });
    graph.confirm(confirmed.finding.id);
    const hits = graph.query({ text: "TOKIO" });
    expect(hits[0]?.id).toBe(confirmed.finding.id);
    expect(hits.map((f) => f.id)).toContain(open.finding.id);
  });

  it("decays strength at read time and never stores the decayed value", () => {
    const { graph, advance } = makeGraph();
    const f = graph.report({ title: "Decaying claim", confidence: "high" });
    const fresh = graph.strength(f.finding.id);
    advance(30 * 24 * 60 * 60 * 1000);
    const aged = graph.strength(f.finding.id);
    expect(aged).toBeLessThan(fresh);
    expect(fresh).toBeGreaterThan(0);
    expect(aged).toBeGreaterThan(0);
    // The stored record still carries its original updatedAt: decay is read-only.
    expect(graph.get(f.finding.id)?.updatedAt).toBe(1_700_000_000_000);
    // A later report refreshes the clock anchor.
    graph.report({ title: "Decaying claim" });
    const refreshed = graph.strength(f.finding.id);
    expect(refreshed).toBeGreaterThan(aged);
  });
});

describe("FindingsGraph snapshot round-trip", () => {
  it("round-trips through export/import idempotently, skipping malformed records", () => {
    const { graph } = makeGraph();
    const a = graph.report({
      title: "Round trip claim",
      body: "Lives through a snapshot.",
      kind: "decision",
      subjects: ["x.ts"],
      confidence: "high",
    });
    graph.refute(a.finding.id);
    const snapshot = graph.exportSnapshot();
    const wire = JSON.stringify({
      version: 1,
      findings: [...snapshot.findings, { id: "broken" }, null],
    });

    const fresh = new FindingsGraph();
    const result = fresh.importSnapshot(wire);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    const restored = fresh.get(a.finding.id);
    expect(restored?.status).toBe("refuted");
    expect(restored?.kind).toBe("decision");
    expect(restored?.subjects).toEqual(["x.ts"]);

    // Re-import is idempotent: no duplicates.
    fresh.importSnapshot(wire);
    expect(fresh.list()).toHaveLength(1);
  });

  it("tolerates garbage instead of throwing", () => {
    const { graph } = makeGraph();
    expect(graph.importSnapshot("{not json")).toEqual({ imported: 0, skipped: 0 });
    expect(graph.importSnapshot('{"findings": "nope"}')).toEqual({ imported: 0, skipped: 0 });
  });
});
