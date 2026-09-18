import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLOOD_GUARD,
  HierarchicalMemoryStore,
} from "../../src/memory/hierarchical-memory-store.js";
import type { UsageRecord } from "../../src/memory/token-math.js";

/** A document that names one entity in several emphasized spellings. */
const MULTI_SECTION_DOC = `# Cache layer
The **Redis** store and the **Postgres** store back the API.

# Messaging
**Redis**, **Kafka** and **NATS** move events between services.
`;

/** A document whose emphasized terms come from code spans and link text. */
const CODE_AND_LINK_DOC = `# Infrastructure
Uses [Redis](https://redis.io) as a cache and \`Postgres\` as the system of record.
`;

describe("hierarchical-memory-store", () => {
  describe("construction", () => {
    it("applies the shipped defaults", () => {
      const store = new HierarchicalMemoryStore();
      expect(store.mode.id).toBe("balanced");
      expect(store.contextWindow).toBe(120_000);
      expect(store.preset.id).toBe("default");
      expect(store.coreSize()).toBe(0);
      expect(store.coreCharacters()).toBe(0);
      expect(store.floodGuard).not.toBeNull();
    });

    it("builds the three tiers from the preset retention bounds", async () => {
      const store = new HierarchicalMemoryStore();
      // The graph ceiling is the preset's, not the module default of 1000, when
      // the preset narrows it; here the shipped default is what applies.
      expect(store.graph.snapshot().maxNodes).toBe(1000);
      // An untouched recall tier has nothing recent to report.
      expect(await store.recentRecall(10)).toEqual([]);
    });

    it("honours an explicit window, mode and disabled guard", () => {
      const store = new HierarchicalMemoryStore({
        contextWindow: 50_000,
        mode: "conservative",
        floodGuard: null,
      });
      expect(store.contextWindow).toBe(50_000);
      expect(store.mode.id).toBe("conservative");
      expect(store.floodGuard).toBeNull();
    });

    it("ships the documented flood-guard defaults", () => {
      expect(DEFAULT_FLOOD_GUARD).toEqual({
        windowMs: 60_000,
        softCapAfter: 20,
        blockAfter: 60,
      });
    });
  });

  describe("core memory", () => {
    it("stores, replaces and deletes entries", () => {
      const store = new HierarchicalMemoryStore();
      const entry = store.setCoreMemory("identity", "Identity", "You are a helper.");
      expect(entry).toMatchObject({ key: "identity", label: "Identity", pinned: false });
      expect(store.coreSize()).toBe(1);
      expect(store.coreCharacters()).toBe("You are a helper.".length);

      store.setCoreMemory("identity", "Identity", "You are a coder.");
      expect(store.coreSize()).toBe(1);
      expect(store.coreCharacters()).toBe("You are a coder.".length);

      expect(store.deleteCoreMemory("identity")).toBe(true);
      expect(store.deleteCoreMemory("identity")).toBe(false);
      expect(store.coreSize()).toBe(0);
    });

    it("keeps a pinned flag and sorts entries by key", () => {
      const store = new HierarchicalMemoryStore();
      store.setCoreMemory("zeta", "Zeta", "z", true);
      store.setCoreMemory("alpha", "Alpha", "a");
      store.setCoreMemory("mid", "Mid", "m");
      const keys = store.coreMemoryEntries().map((entry) => entry.key);
      expect(keys).toEqual(["alpha", "mid", "zeta"]);
      expect(store.coreMemoryEntries()[0]!.pinned).toBe(false);
      expect(store.coreMemoryEntries()[2]!.pinned).toBe(true);
    });

    it("renders one labelled block per entry", () => {
      const store = new HierarchicalMemoryStore();
      store.setCoreMemory("alpha", "Alpha", "first");
      store.setCoreMemory("zeta", "Zeta", "second");
      expect(store.coreMemoryText()).toBe("[Alpha]\nfirst\n\n[Zeta]\nsecond");
    });
  });

  describe("recordEvent and the flood guard", () => {
    it("records events and replays them most-recent-last", async () => {
      const store = new HierarchicalMemoryStore({ floodGuard: null });
      await store.recordEvent("e1", "tool", "call", "ran a search");
      await store.recordEvent("e2", "tool", "call", "ran a grep", "warning");
      const recent = await store.recentRecall(10);
      expect(recent.map((event) => event.id)).toEqual(["e1", "e2"]);
      expect(recent[1]!.severity).toBe("warning");
    });

    it("drops an event to a sentinel once the hard cap is passed", async () => {
      const store = new HierarchicalMemoryStore({
        floodGuard: { windowMs: 60_000, softCapAfter: 5, blockAfter: 1 },
      });
      const kept = await store.recordEvent("e1", "tool", "call", "kept");
      const dropped = await store.recordEvent("e2", "tool", "call", "flooded");
      expect(kept.data).toBe("kept");
      // The sentinel preserves identity but replaces payload, severity and cost.
      expect(dropped.id).toBe("e2");
      expect(dropped.data).toBe("[event dropped: recall tier under flood guard]");
      expect(dropped.severity).toBe("warning");
      expect(dropped.tokens).toBe(8);
      // A dropped event never reaches the tier.
      expect((await store.recentRecall(10)).map((event) => event.id)).toEqual(["e1"]);
    });

    it("partitions the guard per agent key", async () => {
      const store = new HierarchicalMemoryStore({
        floodGuard: { windowMs: 60_000, softCapAfter: 5, blockAfter: 1 },
      });
      await store.recordEvent("e1", "tool", "call", "one", "info", "agent-a");
      // Agent B's budget is its own, so this one is kept despite A being capped.
      const kept = await store.recordEvent("e2", "tool", "call", "two", "info", "agent-b");
      expect(kept.data).toBe("two");
    });
  });

  describe("ingestDocument", () => {
    it("extracts entities from emphasis and relates co-occurring names", async () => {
      const store = new HierarchicalMemoryStore();
      const result = await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      expect(result.chunkCount).toBeGreaterThan(0);
      // Five upsert calls: two names in section 1, three in section 2.
      expect(result.entityCount).toBe(5);
      // One pair in section 1, three pairs in section 2.
      expect(result.relationCount).toBe(4);
      // Four distinct names; Redis is shared across both sections.
      expect(store.graph.entityCount()).toBe(4);
      expect(store.graph.relationCount()).toBe(4);
      expect([...store.graph.entityNames()].sort()).toEqual(["Kafka", "NATS", "Postgres", "Redis"]);
    });

    it("is idempotent: a re-ingest adds nothing to the graph", async () => {
      const store = new HierarchicalMemoryStore();
      const first = await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const second = await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      // Per-call counts are unchanged because the extractor still runs.
      expect(second.entityCount).toBe(first.entityCount);
      expect(second.relationCount).toBe(first.relationCount);
      // ...and the graph did not grow.
      expect(store.graph.entityCount()).toBe(4);
      expect(store.graph.relationCount()).toBe(4);
    });

    it("extracts code spans and link text, not only bold", async () => {
      const store = new HierarchicalMemoryStore();
      await store.ingestDocument("infra.md", CODE_AND_LINK_DOC);
      expect([...store.graph.entityNames()].sort()).toEqual(["Postgres", "Redis"]);
      expect(store.graph.relationCount()).toBe(1);
    });

    it("extracts single-backtick inline code and still honours double backticks", async () => {
      const store = new HierarchicalMemoryStore();
      // Inline code in Markdown is single-backtick; the double-backtick form is
      // a distinct but legitimate case and must keep working alongside it.
      await store.ingestDocument(
        "spans.md",
        "# Spans\nThe `redis` client talks to ``postgres`` over tls.",
      );
      expect([...store.graph.entityNames()].sort()).toEqual(["postgres", "redis"]);
    });

    it("records chunk ids as evidence so the graph branch resolves real chunks", async () => {
      const store = new HierarchicalMemoryStore();
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const redis = store.graph.getEntity("Redis");
      expect(redis).toBeDefined();
      expect(redis!.sourceIds.length).toBeGreaterThan(0);
      // Every recorded evidence id is a chunk the archival tier can serve — a
      // document id resolves to nothing on that path.
      for (const id of redis!.sourceIds) {
        expect(id.startsWith("chunk:")).toBe(true);
        const [chunk] = await store.archival.getByIds([id]);
        expect(chunk).toBeDefined();
        expect(chunk!.content).toContain("Redis");
      }
      // And retrieval reaches those chunks through the graph branch rather than
      // resolving the entity to nothing.
      const result = await store.retrieve("Redis", { topK: 5 });
      const evidence = new Set(redis!.sourceIds);
      expect(result.graphSelected).toBe(true);
      expect(result.chunks.some((chunk) => evidence.has(chunk.chunkId))).toBe(true);
    });

    it("leaves the graph exactly as it was after an unchanged re-ingest", async () => {
      const store = new HierarchicalMemoryStore();
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const before = await graphState(store);
      const second = await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      // The extractor still runs, so the per-call counts still describe the
      // document.
      expect(second.entityCount).toBe(5);
      expect(second.relationCount).toBe(4);
      // ...and the graph is untouched: no new ids, no reordered nodes, no
      // accumulated relation weights, no churned timestamps.
      expect(await graphState(store)).toBe(before);
    });

    it("replaces a changed document's graph evidence without duplicating it", async () => {
      const store = new HierarchicalMemoryStore();
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const oldRedisEvidence = store.graph.getEntity("Redis")!.sourceIds;

      // Postgres leaves the document; the section that mentioned it is gone.
      const replaced = await store.ingestDocument(
        "services.md",
        "# Messaging\n**Redis**, **Kafka** and **NATS** move events between services.",
      );
      expect(replaced.entityCount).toBe(3);
      expect(replaced.relationCount).toBe(3);
      // The stale entity is gone, nothing duplicated, and the surviving entity's
      // evidence points at the new chunks rather than the old ones.
      expect(store.graph.hasEntity("Postgres")).toBe(false);
      expect(store.graph.entityCount()).toBe(3);
      expect(store.graph.relationCount()).toBe(3);
      expect(store.graph.getEntity("Redis")!.sourceIds).not.toEqual(oldRedisEvidence);
      for (const node of store.graph.entityNames().map((name) => store.graph.getEntity(name))) {
        for (const id of node!.sourceIds) {
          expect(id.startsWith("chunk:")).toBe(true);
          const [chunk] = await store.archival.getByIds([id]);
          expect(chunk).toBeDefined();
        }
      }
      // A relation weight is not re-accumulated by the replacement.
      const edges = await store.graph.getEdgesBatch([["Redis", "Kafka"]]);
      expect([...edges.values()][0]!.weight).toBe(1);
    });

    it("treats a document with no heading as one untitled section", async () => {
      const store = new HierarchicalMemoryStore();
      const result = await store.ingestDocument("note.txt", "Plain note about **Saturn**.");
      expect(result.entityCount).toBe(1);
      expect(store.graph.hasEntity("Saturn")).toBe(true);
    });
  });

  describe("retrieve", () => {
    it("resolves a named entity through the graph branch", async () => {
      const store = new HierarchicalMemoryStore();
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const result = await store.retrieve("Redis", { topK: 4 });
      expect(result.entities.map((node) => node.entityName)).toContain("Redis");
      expect(result.relations.length).toBeGreaterThan(0);
      expect(result.mode.id).toBe("balanced");
      expect(typeof result.graphSelected).toBe("boolean");
    });

    it("caps the result set once the soft cap is passed", async () => {
      const store = new HierarchicalMemoryStore({
        floodGuard: { windowMs: 60_000, softCapAfter: 1, blockAfter: 100 },
      });
      await store.ingestDocument("big.md", "# Redis\n" + "redis redis redis.\n".repeat(600));
      const query = "redis";
      // First call on this key: not capped, so the full topK applies.
      const uncapped = await store.retrieve(query, { topK: 8 });
      expect(uncapped.chunks.length).toBeGreaterThan(0);
      // Second call on the same key: soft-capped, so topK tapers to 1 and the
      // merged set is bounded to twice that.
      const capped = await store.retrieve(query, { topK: 8 });
      expect(capped.chunks.length).toBeLessThanOrEqual(2);
      expect(capped.chunks.length).toBeLessThanOrEqual(uncapped.chunks.length);
    });

    it("refuses entirely once the hard cap is passed", async () => {
      const store = new HierarchicalMemoryStore({
        floodGuard: { windowMs: 60_000, softCapAfter: 1, blockAfter: 2 },
      });
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const query = "Redis";
      await store.retrieve(query);
      await store.retrieve(query);
      const blocked = await store.retrieve(query);
      expect(blocked.chunks).toEqual([]);
      expect(blocked.entities).toEqual([]);
      expect(blocked.relations).toEqual([]);
      expect(blocked.graphSelected).toBe(false);
    });
  });

  describe("mode escalation", () => {
    it("escalates as the window fills and never de-escalates", () => {
      const store = new HierarchicalMemoryStore();
      expect(store.mode.id).toBe("balanced");
      // 0 used: ratio 0 wants "aggressive", but a hand-set mode survives.
      expect(store.adjustModeForUtilization(0)).toBe("balanced");
      // 0.7 of the window wants "conservative", which is stricter, so it wins.
      expect(store.adjustModeForUtilization(84_000)).toBe("conservative");
      // A later empty window must not widen the profile again.
      expect(store.adjustModeForUtilization(0)).toBe("conservative");
    });

    it("reaches minimal at 0.85 and stays there", () => {
      const store = new HierarchicalMemoryStore();
      expect(store.adjustModeForUtilization(102_000)).toBe("minimal");
      expect(store.adjustModeForUtilization(0)).toBe("minimal");
    });

    it("escalates an aggressive mode one step at a time", () => {
      const store = new HierarchicalMemoryStore({ mode: "aggressive" });
      expect(store.escalateMode()).toBe("balanced");
      expect(store.escalateMode()).toBe("conservative");
      expect(store.escalateMode()).toBe("minimal");
      // The ladder is strict: minimal is the floor.
      expect(store.escalateMode()).toBe("minimal");
      expect(store.mode.id).toBe("minimal");
    });

    it("lets setMode override the automatic choice", () => {
      const store = new HierarchicalMemoryStore();
      store.setMode("minimal");
      expect(store.mode.id).toBe("minimal");
      // The automatic pass still only escalates.
      expect(store.adjustModeForUtilization(0)).toBe("minimal");
    });
  });

  describe("compaction thresholds", () => {
    it("derives a trigger and target from the mode and window", () => {
      const store = new HierarchicalMemoryStore();
      // Balanced: 0.8 trigger ratio, 0.3 sliding ratio.
      expect(store.compactionThresholds()).toEqual({ trigger: 96_000, target: 84_000 });
    });

    it("targets the whole window when the window is below the minimum", () => {
      const store = new HierarchicalMemoryStore({ contextWindow: 20_000 });
      // A 0.7 target would be 14_000, below the 30_000 minimum, so the clamp
      // keeps the entire window: compacting a window that small would leave
      // nothing worth keeping.
      expect(store.compactionThresholds()).toEqual({ trigger: 16_000, target: 20_000 });
    });
  });

  describe("usageTokens", () => {
    it("reads the context cost off a provider usage record", () => {
      const store = new HierarchicalMemoryStore();
      expect(store.usageTokens({ totalTokens: 500 })).toBe(500);
      expect(store.usageTokens({ input: 100, output: 200, cacheRead: 50 })).toBe(350);
    });

    it("treats a signal-free record as no anchor at all", () => {
      const store = new HierarchicalMemoryStore();
      const empty: UsageRecord = {};
      expect(store.usageTokens(empty)).toBe(0);
      expect(store.usageTokens({ input: 0, output: 0 })).toBe(0);
    });
  });

  describe("assemble", () => {
    it("guarantees the whole context fits the window, keeping core", async () => {
      const store = new HierarchicalMemoryStore({ contextWindow: 2_000 });
      const huge = "x".repeat(20_000);
      store.setCoreMemory("identity", "Identity", huge);
      const assembled = await store.assemble({ query: "hello" });

      expect(assembled.trimmed).toBe(true);
      expect(assembled.tokens).toBeLessThanOrEqual(2_000);
      expect(assembled.contextWindow).toBe(2_000);
      // Core is truncated to the window, never dropped.
      expect(assembled.core.length).toBeLessThanOrEqual(2_000 * 4);
      expect(assembled.core.length).toBeGreaterThan(0);
      expect(assembled.budget.core).toBeGreaterThan(0);
      // The reported budget accounts for every token exactly.
      expect(sum(Object.values(assembled.budget))).toBe(assembled.tokens);
      expect(Object.keys(assembled.budget).sort()).toEqual(
        ["chunks", "core", "entities", "recall", "relations"].sort(),
      );
    });

    it("leaves an empty store untrimmed", async () => {
      const store = new HierarchicalMemoryStore();
      const assembled = await store.assemble({ query: "hello" });
      expect(assembled.trimmed).toBe(false);
      expect(assembled.tokens).toBe(0);
      expect(assembled.core).toBe("");
      expect(sum(Object.values(assembled.budget))).toBe(assembled.tokens);
    });

    it("drops recall, then chunks, then relations before touching core", async () => {
      const store = new HierarchicalMemoryStore({ contextWindow: 2_500 });
      // Core alone is 3_000 tokens once sectioned, so the overflow path runs.
      store.setCoreMemory("identity", "Identity", "y".repeat(12_000));
      await store.recordEvent("e1", "tool", "call", "an event that will be dropped");
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const assembled = await store.assemble({ query: "Redis" });

      expect(assembled.trimmed).toBe(true);
      // The three least valuable sections are zeroed first...
      expect(assembled.budget.recall).toBe(0);
      expect(assembled.budget.chunks).toBe(0);
      expect(assembled.budget.relations).toBe(0);
      // ...and core is truncated to the window rather than dropped.
      expect(assembled.budget.core).toBeGreaterThan(0);
      expect(assembled.core.length).toBeLessThanOrEqual(2_500 * 4);
      expect(assembled.core.length).toBeGreaterThan(0);
      expect(sum(Object.values(assembled.budget))).toBe(assembled.tokens);
    });

    it("counts the system prompt, the query and the framing against the budget", async () => {
      const store = new HierarchicalMemoryStore({ contextWindow: 2_000 });
      store.setCoreMemory("identity", "Identity", "y".repeat(4_000));
      // 500 tokens of system prompt and 1_000 of query leave only 300 of the
      // 2_000-token window, so a 1_000-token core has to be cut down to fit.
      const assembled = await store.assemble({
        query: "x".repeat(4_000),
        systemPromptTokens: 500,
      });
      expect(assembled.tokens).toBe(300);
      expect(assembled.budget.core).toBe(300);
      expect(assembled.core.length).toBeLessThan(4_000);
      expect(assembled.trimmed).toBe(true);
    });

    it("drops entities too when that is what fitting the window takes", async () => {
      const store = new HierarchicalMemoryStore({ contextWindow: 2_000 });
      // Core is 1_900 tokens, and the retrieved sections add another ~90, which
      // is past the 1_796 left after the query and framing are paid for. The
      // overflow pass has to reach entities, not stop at relations.
      store.setCoreMemory("identity", "Identity", "y".repeat(7_600));
      await store.ingestDocument("services.md", MULTI_SECTION_DOC);
      const assembled = await store.assemble({ query: "Redis" });

      expect(assembled.budget.entities).toBe(0);
      expect(assembled.budget.core).toBeGreaterThan(0);
      expect(assembled.tokens).toBeLessThanOrEqual(2_000);
      expect(assembled.core.length).toBeLessThanOrEqual(2_000 * 4);
      expect(sum(Object.values(assembled.budget))).toBe(assembled.tokens);
    });

    it("applies the mode's recall budget rather than the retention profile's", async () => {
      const store = new HierarchicalMemoryStore();
      // Eight events of 1_000 tokens: 8_000 tokens, inside the retention
      // profile's 8_000-token cap, so the tier keeps all of them.
      for (let i = 0; i < 8; i++) {
        await store.recordEvent(`e${i}`, "user", "message", "x".repeat(4_000), "info");
      }
      store.setMode("minimal");
      const minimal = await store.assemble({ query: "x" });
      store.setMode("balanced");
      const balanced = await store.assemble({ query: "x" });

      // Minimal mode reserves 6_000 tokens for recall, balanced 16_000, and the
      // emitted section has to follow the mode in force — not the profile the
      // tier was built with.
      expect(minimal.recall).toHaveLength(5);
      expect(balanced.recall).toHaveLength(8);
      expect(minimal.budget.recall ?? 0).toBeLessThan(balanced.budget.recall ?? 0);
      expect(minimal.budget.recall ?? 0).toBeLessThanOrEqual(6_000);
    });

    it("reports a section cut to its own budget as trimmed", async () => {
      const store = new HierarchicalMemoryStore({ mode: "minimal" });
      for (let i = 0; i < 8; i++) {
        await store.recordEvent(`e${i}`, "user", "message", "x".repeat(4_000), "info");
      }
      const assembled = await store.assemble({ query: "x" });
      // Recall was cut to the mode's budget while the total still fit, so the
      // overflow pass never ran — the context was trimmed all the same.
      expect(assembled.recall.length).toBeLessThan(8);
      expect(assembled.trimmed).toBe(true);
      expect(assembled.tokens).toBeLessThanOrEqual(assembled.contextWindow);
    });
  });
});

/** Serialised graph state, to assert a re-ingest changed nothing at all. */
async function graphState(store: HierarchicalMemoryStore): Promise<string> {
  const names = store.graph.entityNames();
  const edges = await store.graph.getEdgesBatch(store.graph.relationPairs());
  return JSON.stringify({
    names,
    nodes: names.map((name) => store.graph.getEntity(name)),
    edges: [...edges.values()],
  });
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
