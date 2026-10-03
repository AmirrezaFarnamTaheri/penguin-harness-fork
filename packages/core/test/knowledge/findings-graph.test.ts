import { describe, expect, it } from "vitest";
import {
  FindingsArchiveCapacityError,
  FindingsGraph,
  LifecycleError,
  SupersessionError,
  canTransition,
} from "../../src/knowledge/findings-graph.js";
import { FINDING_STATUSES } from "../../src/knowledge/types.js";

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
  it("archives evictions, prunes live references, survives snapshots, and rotates by count and age", () => {
    let now = 1000;
    const graph = new FindingsGraph({
      now: () => now,
      maxFindings: 2,
      maxArchiveEntries: 1,
      maxArchiveAgeMs: 1000,
    });
    expect(() => new FindingsGraph({ maxFindings: 0 })).toThrow(RangeError);
    const first = graph.report({ title: "Alpha claim proof" }).finding;
    const second = graph.report({ title: "Beta claim proof" }).finding;
    graph.link(first.id, second.id);
    now++;
    graph.report({ title: "Gamma claim proof" });
    expect(graph.get(first.id)).toBeNull();
    expect(graph.get(second.id)!.related).not.toContain(first.id);
    expect(graph.archived(first.id)[0]).toMatchObject({
      operationId: expect.any(String),
      finding: { id: first.id, title: first.title },
    });
    const exposed = graph.archived(first.id);
    exposed[0]!.finding.title = "caller mutation";
    expect(graph.archived(first.id)[0]!.finding.title).toBe(first.title);

    const restored = new FindingsGraph({
      now: () => now,
      maxFindings: 2,
      maxArchiveEntries: 1,
      maxArchiveAgeMs: 1000,
    });
    expect(restored.importSnapshot(graph.exportSnapshot())).toMatchObject({
      imported: 2,
      skipped: 0,
    });
    expect(restored.archived(first.id)[0]!.finding.title).toBe(first.title);
    now += 1001;
    expect(restored.archiveStats().count).toBe(0);
    expect(restored.exportSnapshot().archive).toBeUndefined();
  });

  it("rejects an unarchivable eviction without partially mutating the graph", () => {
    const graph = new FindingsGraph({ maxFindings: 1, maxArchiveBytes: 1 });
    const first = graph.report({ title: "First distinct claim" }).finding;
    expect(() => graph.report({ title: "Second unrelated claim" })).toThrow(
      FindingsArchiveCapacityError,
    );
    expect(graph.list().map((finding) => finding.id)).toEqual([first.id]);
    expect(graph.since()).toHaveLength(1);
    expect(graph.archived()).toEqual([]);
  });

  it("evicts in refuted, superseded, open, confirmed order", () => {
    const seed = new FindingsGraph({ now: () => 10 });
    const claims = ["Refuted", "Superseded", "Open", "Confirmed"].map(
      (label) => seed.report({ title: `${label} retention claim` }).finding,
    );
    claims[0]!.status = "refuted";
    claims[1]!.status = "superseded";
    claims[3]!.status = "confirmed";
    const graph = new FindingsGraph({ now: () => 20, maxFindings: 4 });
    graph.importSnapshot({ version: 1, findings: claims });
    graph.report({ title: "New retention claim" });
    expect(graph.archived().map((entry) => entry.finding.status)).toEqual(["refuted"]);
    graph.report({ title: "Another retention claim" });
    expect(graph.archived().map((entry) => entry.finding.status)).toEqual([
      "refuted",
      "superseded",
    ]);
    graph.report({ title: "Last retention claim" });
    expect(graph.archived().map((entry) => entry.finding.status)).toEqual([
      "refuted",
      "superseded",
      "open",
    ]);
    expect(graph.list().some((finding) => finding.status === "confirmed")).toBe(true);
  });

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

  it("merge idempotency under randomized reports", () => {
    const graph = new FindingsGraph({ now: () => 1_700_000_000_000 });
    let seed = 0x5eed1234;
    const next = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const pick = (limit: number) => Math.floor((next() / 0x1_0000_0000) * limit);
    const descriptors = [
      ["amber", "birch"],
      ["brisk", "cedar"],
      ["calm", "dahlia"],
      ["distant", "elm"],
      ["elder", "fennel"],
      ["frozen", "granite"],
      ["golden", "hemlock"],
      ["hidden", "indigo"],
      ["ivory", "juniper"],
      ["jagged", "kelp"],
      ["kind", "lilac"],
      ["lunar", "maple"],
      ["mellow", "nectar"],
      ["noble", "opal"],
      ["onyx", "pebble"],
      ["pale", "quartz"],
      ["quiet", "rattan"],
      ["rustic", "spruce"],
      ["silver", "thistle"],
      ["tidy", "willow"],
    ] as const;
    const tiers = ["documentation", "implementation", "runtime"] as const;
    const reports = Array.from({ length: 100 }, (_, reportIndex) => {
      const claim = pick(20);
      const [theme, object] = descriptors[claim]!;
      const evidenceIndex = pick(30);
      const tier = tiers[pick(tiers.length)]!;
      return {
        title: `Finding ${theme} ${object} invariant`,
        body: `The ${theme} ${object} evidence detail ${pick(9)}`,
        subjects: [`src/claim-${claim}.ts`, `src/evidence-${evidenceIndex}.ts`],
        evidence: [
          {
            path: `src/evidence-${evidenceIndex}.ts`,
            line: pick(400) + 1,
            tier,
            quote: `evidence-${pick(12)}`,
          },
        ],
        tags: [`group-${claim % 4}`, `evidence-${evidenceIndex % 5}`],
        confidence: (["low", "medium", "high"] as const)[pick(3)]!,
        severity: (["info", "low", "medium", "high", "critical"] as const)[pick(5)]!,
        source: {
          agentId: `agent-${reportIndex % 5}`,
          sessionId: `session-${reportIndex % 13}`,
          report: `report-${reportIndex}`,
        },
      };
    });

    for (const report of reports) graph.report(report);
    const firstPass = graph.list();
    expect(firstPass).toHaveLength(20);
    for (const report of reports) graph.report(report);

    expect(graph.list()).toEqual(firstPass);
    for (const finding of graph.list()) {
      expect(
        new Set(finding.sources.map((source) => `${source.agentId}:${source.sessionId}`)).size,
      ).toBe(finding.sources.length);
      expect(
        new Set(
          finding.evidence.map(
            (evidence) => `${evidence.path}:${evidence.line}:${evidence.tier}:${evidence.quote}`,
          ),
        ).size,
      ).toBe(finding.evidence.length);
    }
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
  it("preserves attested authorship beyond the event window and ignores source labels", () => {
    for (const kind of ["agent", "user", "system"] as const) {
      const graph = new FindingsGraph();
      const claim = graph.report(
        {
          title: "Loader waits",
          source: { agentId: "user:forged", report: "Authored by a trusted human" },
          evidence: [{ tier: "runtime" }],
        },
        { actor: { kind, id: "host-id" } },
      ).finding;
      expect(graph.readback(claim.id)).toMatchObject({
        authoredBy: kind,
        author: { kind, id: "host-id" },
        status: "open",
        evidenceTiers: ["runtime"],
      });
      expect(graph.readback(claim.id)).not.toHaveProperty("createdBy");
      const legacy = graph.exportSnapshot();
      legacy.findings.forEach((finding) => delete finding.createdBy);
      legacy.events!.forEach((event) => delete event.actor);
      const restored = new FindingsGraph();
      restored.importSnapshot(legacy);
      expect(restored.readback(claim.id)).toMatchObject({
        authoredBy: "legacy-unknown",
        author: { kind: "unknown", id: "unknown" },
      });
    }
    const bounded = new FindingsGraph({ maxEvents: 1 });
    const claim = bounded.report(
      { title: "Loader waits" },
      { actor: { kind: "user", id: "human" } },
    ).finding;
    bounded.refute(claim.id);
    expect(bounded.readback(claim.id)).toMatchObject({
      authoredBy: "user",
      author: { kind: "user", id: "human" },
    });
    const restoredBounded = new FindingsGraph({ maxEvents: 1 });
    restoredBounded.importSnapshot(bounded.exportSnapshot());
    expect(restoredBounded.readback(claim.id).author).toEqual({ kind: "user", id: "human" });
    const archivedGraph = new FindingsGraph({ maxFindings: 1, maxEvents: 1 });
    const archivedClaim = archivedGraph.report(
      { title: "Archived author stays attached" },
      { actor: { kind: "agent", id: "agent-7" } },
    ).finding;
    archivedGraph.report({ title: "Second archive test claim" });
    expect(archivedGraph.archivedReadback(archivedClaim.id)).toMatchObject({
      finding: { authoredBy: "agent", author: { kind: "agent", id: "agent-7" } },
    });
    expect(archivedGraph.archivedReadback(archivedClaim.id)?.finding).not.toHaveProperty(
      "createdBy",
    );
    const restoredArchive = new FindingsGraph({ maxFindings: 1, maxEvents: 1 });
    restoredArchive.importSnapshot(archivedGraph.exportSnapshot());
    expect(restoredArchive.archivedReadback(archivedClaim.id)?.finding.author).toEqual({
      kind: "agent",
      id: "agent-7",
    });
    const evidence = { tier: "documentation" as "documentation" | "runtime" };
    const protectedGraph = new FindingsGraph();
    const protectedClaim = protectedGraph.report({
      title: "Copied evidence",
      evidence: [evidence],
    }).finding;
    evidence.tier = "runtime";
    expect(() => protectedGraph.confirm(protectedClaim.id)).toThrow(/runtime or implementation/);
  });

  it("rejects non-live replacements, imported cycles, missing targets, and overlong chains", () => {
    const seed = new FindingsGraph();
    const claim = seed.report({ title: "Loader waits" }).finding;
    const replacement = seed.report({ title: "Fresh budget evidence" }).finding;
    const base = seed.exportSnapshot();
    const rejects = (snapshot: typeof base, code: string) => {
      const graph = new FindingsGraph();
      graph.importSnapshot(snapshot);
      const before = graph.exportSnapshot();
      try {
        graph.supersede(claim.id, replacement.id);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(SupersessionError);
        expect((error as SupersessionError).code).toBe(code);
      }
      expect(graph.exportSnapshot()).toEqual(before);
    };
    const dead = structuredClone(base);
    dead.findings[1]!.status = "refuted";
    rejects(dead, "replacement_not_live");
    const cycle = structuredClone(base);
    cycle.findings[1]!.supersededBy = replacement.id;
    rejects(cycle, "supersession_cycle");
    const targetCycle = structuredClone(base);
    targetCycle.findings[1]!.supersededBy = claim.id;
    rejects(targetCycle, "supersession_cycle");
    const dangling = structuredClone(base);
    dangling.findings[1]!.supersededBy = "missing";
    const sanitized = new FindingsGraph();
    sanitized.importSnapshot(dangling);
    expect(sanitized.get(replacement.id)?.supersededBy).toBeUndefined();
    const deep = structuredClone(base);
    deep.findings[1]!.supersededBy = "hop-1";
    for (let i = 1; i <= 65; i++)
      deep.findings.push({
        ...replacement,
        id: `hop-${i}`,
        ...(i < 65 ? { supersededBy: `hop-${i + 1}` } : {}),
      });
    rejects(deep, "supersession_depth");
    deep.findings.pop();
    delete deep.findings.at(-1)!.supersededBy;
    const graph = new FindingsGraph();
    graph.importSnapshot(deep);
    expect(graph.supersede(claim.id, replacement.id).status).toBe("superseded");
  });

  it("creates stable contradiction revisions without changing falsified evidence", () => {
    const graph = new FindingsGraph();
    const input = {
      title: "Loader waits",
      body: "Observed delay",
      evidence: [
        { tier: "runtime" as const, path: "b.ts" },
        { tier: "implementation" as const, path: "a.ts" },
      ],
    };
    const original = graph.report(input).finding;
    graph.refute(original.id, "Falsified");
    const revision = graph.report(input);
    expect(revision.merged).toBe(false);
    expect(revision.finding.id).not.toBe(original.id);
    expect(revision.finding.contradicts).toEqual([original.id]);
    const replay = graph.report({ ...input, evidence: [...input.evidence].reverse() });
    expect(replay.merged).toBe(true);
    expect(replay.finding.id).toBe(revision.finding.id);
    expect(graph.list()).toHaveLength(2);
    expect(graph.get(original.id)).toMatchObject({
      status: "refuted",
      evidence: input.evidence,
      contradicts: [revision.finding.id],
    });
    const restored = new FindingsGraph();
    restored.importSnapshot(graph.exportSnapshot());
    expect(restored.exportSnapshot()).toEqual(graph.exportSnapshot());
    expect(restored.report(input).finding.id).toBe(revision.finding.id);
    graph.supersede(
      revision.finding.id,
      graph.report({ title: "Fresh budget evidence" }).finding.id,
    );
    const terminal = graph.get(revision.finding.id);
    graph.report({ ...input, body: "Observed delay with additional detail" });
    expect(graph.get(revision.finding.id)).toEqual(terminal);
  });

  it("reopens only refuted claims through an attributed human action with a reason", () => {
    const graph = new FindingsGraph();
    const claim = graph.report({ title: "Loader waits" }).finding;
    const user = { actor: { kind: "user" as const, id: "human" }, method: "route" as const };
    expect(() => graph.reopen(claim.id, "reason", user)).toThrow(/Only a refuted/);
    graph.refute(claim.id);
    expect(() =>
      graph.reopen(claim.id, "reason", { actor: { kind: "agent", id: "agent" }, method: "tool" }),
    ).toThrow(LifecycleError);
    expect(() => graph.reopen(claim.id, " ", user)).toThrow(LifecycleError);
    expect(graph.reopen(claim.id, "New independent evidence", user).status).toBe("open");
    expect(graph.since().at(-1)).toMatchObject({
      type: "reopen",
      actor: user.actor,
      note: "New independent evidence",
    });
    const restored = new FindingsGraph();
    restored.importSnapshot(graph.exportSnapshot());
    expect(restored.since().at(-1)!.type).toBe("reopen");
    graph.supersede(claim.id, graph.report({ title: "Fresh budget evidence" }).finding.id);
    expect(() => graph.reopen(claim.id, "reason", user)).toThrow(/Only a refuted/);
  });

  it("enforces every lifecycle transition and leaves rejected operations unchanged", () => {
    const allowed = new Set([
      "open:confirmed",
      "open:refuted",
      "open:superseded",
      "confirmed:refuted",
      "confirmed:superseded",
    ]);
    for (const from of FINDING_STATUSES)
      for (const to of FINDING_STATUSES) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}:${to}`));
        if (to === "open") continue;
        const graph = new FindingsGraph();
        const claim = graph.report({
          title: "Loader waits",
          evidence: [{ tier: "runtime" }],
        }).finding;
        const replacement = graph.report({ title: "Fresh budget evidence" }).finding;
        const snapshot = graph.exportSnapshot();
        snapshot.findings.find((f) => f.id === claim.id)!.status = from;
        const restored = new FindingsGraph();
        restored.importSnapshot(snapshot);
        const before = restored.exportSnapshot();
        const act = () =>
          to === "confirmed"
            ? restored.confirm(claim.id)
            : to === "refuted"
              ? restored.refute(claim.id)
              : restored.supersede(claim.id, replacement.id);
        if (allowed.has(`${from}:${to}`)) expect(act().status).toBe(to);
        else {
          expect(act).toThrow(LifecycleError);
          expect(restored.exportSnapshot()).toEqual(before);
        }
      }
  });

  it("requires proof or an attributed human override and copies audit actors", () => {
    const graph = new FindingsGraph();
    const input = {
      title: "Loader waits",
      evidence: [{ tier: "documentation" as const, path: "loader.ts" }],
    };
    const claim = graph.report(input).finding;
    const before = graph.exportSnapshot();
    expect(() => graph.confirm(claim.id)).toThrow(/runtime or implementation evidence/);
    for (const context of [
      { override: true },
      { override: true, actor: { kind: "agent" as const, id: "agent" } },
      { override: true, actor: { kind: "user" as const, id: "human" }, method: "tool" as const },
    ])
      expect(() => graph.confirm(claim.id, "reason", context)).toThrow(LifecycleError);
    expect(() =>
      graph.confirm(claim.id, " ", { override: true, actor: { kind: "user", id: "human" } }),
    ).toThrow(LifecycleError);
    expect(graph.exportSnapshot()).toEqual(before);
    const actor = { kind: "user" as const, id: "human" };
    graph.confirm(claim.id, "Reviewed manually", { override: true, actor, method: "route" });
    actor.id = "changed";
    const event = graph.since().at(-1)!;
    expect(event).toMatchObject({
      actor: { kind: "user", id: "human" },
      method: "route",
      override: true,
      note: "Reviewed manually",
    });
    event.actor!.id = "changed again";
    expect(graph.since().at(-1)!.actor!.id).toBe("human");
    const legacy = graph.exportSnapshot();
    legacy.events!.forEach((e) => {
      delete e.actor;
      delete e.method;
    });
    const restored = new FindingsGraph();
    restored.importSnapshot(legacy);
    expect(restored.since().every((e) => e.actor?.kind === "unknown")).toBe(true);
    const evidenced = new FindingsGraph();
    evidenced.report(input);
    evidenced.report({ ...input, evidence: [{ tier: "implementation", path: "loader.ts" }] });
    expect(evidenced.confirm(claim.id).status).toBe("confirmed");
  });

  it("confirms, refutes and supersedes without ever deleting", () => {
    const { graph } = makeGraph();
    // Deliberately dissimilar claims: lexically-near-identical titles would MERGE (the
    // dedupe line doing its job), and a merged claim cannot supersede itself.
    const old = graph.report({
      title: "The loader awaits the cloud mirror",
      evidence: [{ tier: "implementation" }],
    });
    const replacement = graph.report({ title: "Shards render before any reconciliation" });

    expect(graph.confirm(old.finding.id).status).toBe("confirmed");
    const superseded = graph.supersede(old.finding.id, replacement.finding.id);
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededBy).toBe(replacement.finding.id);
    expect(graph.get(replacement.finding.id)?.related).toContain(old.finding.id);
    expect(graph.refute(replacement.finding.id, "falsified").status).toBe("refuted");
    expect(graph.get(replacement.finding.id)).not.toBeNull();
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
    const f = graph.report({ title: "An evented claim", evidence: [{ tier: "runtime" }] });
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
    const confirmed = graph.report({
      title: "Tokio budget finding confirmed",
      evidence: [{ tier: "implementation" }],
    });
    graph.confirm(confirmed.finding.id);
    const hits = graph.query({ text: "TOKIO" });
    expect(hits[0]?.id).toBe(confirmed.finding.id);
    expect(hits.map((f) => f.id)).toContain(open.finding.id);
  });

  it("requires every requested tag when filtering with the plural tag contract", () => {
    const { graph } = makeGraph();
    graph.report({ title: "Tagged finding", tags: ["memory", "retention"] });
    graph.report({ title: "Partially tagged finding", tags: ["memory"] });
    expect(graph.query({ tags: ["memory", "retention"] }).map((finding) => finding.title)).toEqual([
      "Tagged finding",
    ]);
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

  it("uses update age for decay and creation age for its legacy-named additive term", () => {
    const { graph, advance } = makeGraph();
    const createdAt = 1_700_000_000_000;
    const finding = graph.report({ title: "Creation-age score", confidence: "high" }).finding;

    advance(10 * 24 * 60 * 60 * 1000);
    graph.report({ title: "Creation-age score", confidence: "high" });
    advance(10 * 24 * 60 * 60 * 1000);

    const expected = Math.exp(-0.01 * 10) + 0.3 / (1 + 20);
    expect(finding.createdAt).toBe(createdAt);
    expect(graph.get(finding.id)?.updatedAt).toBe(createdAt + 10 * 24 * 60 * 60 * 1000);
    expect(graph.strength(finding.id)).toBeCloseTo(expected, 10);
  });
});

describe("FindingsGraph snapshot round-trip", () => {
  it("snapshot round-trip preserves the events log", () => {
    const graph = new FindingsGraph({ now: () => 1_700_000_000_123 });
    const { finding } = graph.report(
      {
        title: "The tool path keeps its event provenance",
        evidence: [{ path: "src/tool.ts", line: 8, tier: "runtime" }],
        source: { agentId: "reporter" },
      },
      { actor: { kind: "agent", id: "worker-1" }, method: "tool" },
    );
    graph.report(
      { title: finding.title, source: { agentId: "reviewer" } },
      { actor: { kind: "user", id: "human-1" }, method: "route" },
    );
    graph.confirm(finding.id, undefined, {
      actor: { kind: "user", id: "human-1" },
      method: "route",
    });
    graph.refute(finding.id, "The evidence was disproved.", {
      actor: { kind: "system", id: "policy-check" },
      method: "engine",
    });

    const snapshot = graph.exportSnapshot();
    const restored = new FindingsGraph({ now: () => 1_700_000_000_123 });
    expect(restored.importSnapshot(snapshot)).toEqual({ imported: 1, skipped: 0 });
    expect(restored.exportSnapshot().events).toEqual(snapshot.events);
    expect(restored.eventHighWater()).toBe(graph.eventHighWater());
    expect(
      snapshot.events?.map(({ seq, type, actor, method }) => ({ seq, type, actor, method })),
    ).toEqual([
      { seq: 1, type: "ingest", actor: { kind: "agent", id: "worker-1" }, method: "tool" },
      { seq: 2, type: "merge", actor: { kind: "user", id: "human-1" }, method: "route" },
      { seq: 3, type: "update", actor: { kind: "user", id: "human-1" }, method: "route" },
      { seq: 4, type: "refute", actor: { kind: "system", id: "policy-check" }, method: "engine" },
    ]);
  });

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

  it("preserves imported identities and provenance while pruning dangling references", () => {
    const source = new FindingsGraph();
    source.importSnapshot({
      version: 1,
      findings: [
        {
          id: "original-id",
          kind: "defect",
          title: "Long body merge identity",
          body: "A verified explanation.",
          status: "superseded",
          confidence: "high",
          severity: "medium",
          subjects: ["src/a.ts"],
          evidence: [{ path: "src/a.ts", line: 8, tier: "runtime" }],
          tags: ["state"],
          sources: [
            { agentId: "a1", report: "first source" },
            { sessionId: "s2", report: "second source" },
          ],
          related: ["related-id"],
          supersededBy: "replacement-id",
          createdAt: 100,
          updatedAt: 200,
        },
      ],
    });
    const restored = source.get("original-id");
    expect(restored).toMatchObject({
      id: "original-id",
      status: "superseded",
      sources: [{ agentId: "a1" }, { sessionId: "s2" }],
      related: [],
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it("round-trips a longer merged body without changing its id or losing sources", () => {
    const source = new FindingsGraph();
    const original = source.report({
      title: "Persist merged explanation",
      body: "Short explanation.",
      source: { agentId: "agent-one", report: "Initial source." },
    });
    const merged = source.report({
      title: "Persist merged explanation",
      body: "A substantially longer explanation that should stay attached to the original finding.",
      source: { agentId: "agent-two", report: "Expanded source." },
    });

    expect(merged.finding.id).toBe(original.finding.id);

    const fresh = new FindingsGraph();
    fresh.importSnapshot(source.exportSnapshot());
    expect(fresh.get(original.finding.id)).toMatchObject({
      id: original.finding.id,
      body: "A substantially longer explanation that should stay attached to the original finding.",
      sources: [
        { agentId: "agent-one", report: "Initial source." },
        { agentId: "agent-two", report: "Expanded source." },
      ],
    });
  });

  it("skips malformed enum and array fields without aborting later snapshot records", () => {
    const graph = new FindingsGraph();
    const result = graph.importSnapshot({
      version: 1,
      findings: [
        { id: "bad", title: "Bad", subjects: "not-an-array" },
        {
          id: "good",
          kind: "insight",
          title: "Good",
          body: "",
          status: "open",
          confidence: "medium",
          severity: "info",
          subjects: [],
          evidence: [],
          tags: [],
          sources: [],
          related: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never,
    });
    expect(result).toEqual({ imported: 1, skipped: 1 });
    expect(graph.get("good")?.title).toBe("Good");
  });

  it("tolerates garbage instead of throwing", () => {
    const { graph } = makeGraph();
    expect(graph.importSnapshot("{not json")).toEqual({ imported: 0, skipped: 0 });
    expect(graph.importSnapshot('{"findings": "nope"}')).toEqual({ imported: 0, skipped: 0 });
  });
});
