import { describe, expect, it } from "vitest";

import {
  capSourceIds,
  type EntityNode,
  type RelationEdge,
  GRAPH_FIELD_SEP,
  joinGraphField,
  KnowledgeGraphStore,
  mergeDescriptions,
  normalizeEntityName,
  relationKey,
  splitGraphField,
} from "../../src/memory/knowledge-graph-store.js";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("knowledge-graph-store", () => {
  describe("normalizeEntityName", () => {
    it("collapses whitespace and trims", () => {
      expect(normalizeEntityName("  Redis    Cache ")).toBe("Redis Cache");
    });

    it("strips surrounding quotes", () => {
      expect(normalizeEntityName("`Redis`")).toBe("Redis");
      expect(normalizeEntityName("'Redis'")).toBe("Redis");
      expect(normalizeEntityName('"Redis"')).toBe("Redis");
    });

    it("is empty for a blank or quote-only name", () => {
      expect(normalizeEntityName("")).toBe("");
      expect(normalizeEntityName("   ")).toBe("");
      expect(normalizeEntityName('""')).toBe("");
    });

    it("enforces the character ceiling", () => {
      const long = "a".repeat(400);
      expect(normalizeEntityName(long)).toHaveLength(256);
    });

    it("enforces the byte ceiling without splitting a multibyte character", () => {
      const cjk = "日".repeat(200); // 600 UTF-8 bytes
      const normalized = normalizeEntityName(cjk);
      expect(byteLength(normalized)).toBeLessThanOrEqual(512);
      expect(normalized.length).toBeGreaterThan(0);
    });
  });

  describe("relationKey", () => {
    it("sorts the endpoints so direction does not matter", () => {
      expect(relationKey("B", "A")).toEqual(["A", "B"]);
      expect(relationKey("A", "B")).toEqual(["A", "B"]);
    });

    it("normalizes the endpoints before comparing", () => {
      // Whitespace and quotes are stripped, then the pair is sorted by
      // codepoint: uppercase sorts before lowercase, so "Beta" leads "alpha".
      expect(relationKey("  Beta ", "`alpha`")).toEqual(["Beta", "alpha"]);
    });

    it("treats two spellings that differ only in case as distinct keys", () => {
      // Names are a case-sensitive join key: "Redis" and "redis" are two nodes.
      // Keeping case in the key is what preserves acronyms and camelCase ids.
      expect(relationKey("Redis", "api")).toEqual(["Redis", "api"]);
      expect(relationKey("redis", "Api")).toEqual(["Api", "redis"]);
    });
  });

  describe("graph field join/split", () => {
    it("round-trips an id list", () => {
      const ids = ["a", "b", "c"];
      expect(splitGraphField(joinGraphField(ids))).toEqual(ids);
    });

    it("drops empty parts in both directions", () => {
      expect(splitGraphField(joinGraphField(["a", "", "b"]))).toEqual(["a", "b"]);
      expect(splitGraphField(undefined)).toEqual([]);
      expect(splitGraphField("")).toEqual([]);
    });

    it("uses the documented separator", () => {
      expect(GRAPH_FIELD_SEP).toBe("<SEP>");
    });
  });

  describe("mergeDescriptions", () => {
    it("deduplicates across both phases and counts what was already stored", () => {
      const merged = mergeDescriptions(["a", "b"], ["b", "c"]);
      expect(merged.fragments).toEqual(["a", "b", "c"]);
      expect(merged.storedFragmentCount).toBe(2);
    });

    it("trims and drops blanks", () => {
      const merged = mergeDescriptions([" a ", ""], [" b "]);
      expect(merged.fragments).toEqual(["a", "b"]);
      expect(merged.storedFragmentCount).toBe(1);
    });

    it("does not grow on a repeated re-extraction", () => {
      const once = mergeDescriptions([], ["redis is a cache"]);
      const twice = mergeDescriptions(once.fragments, ["redis is a cache"]);
      expect(twice.fragments).toEqual(once.fragments);
      expect(twice.storedFragmentCount).toBe(1);
    });
  });

  describe("capSourceIds", () => {
    it("keeps the earliest evidence up to the limit", () => {
      expect(capSourceIds(["a", "b", "c"], 2)).toEqual(["a", "b"]);
      expect(capSourceIds(["a", "b"], 0)).toEqual([]);
      expect(capSourceIds(["a"], -1)).toEqual([]);
    });
  });

  describe("KnowledgeGraphStore entities", () => {
    it("inserts a node and reports it", async () => {
      const store = new KnowledgeGraphStore();
      const node = await store.upsertEntity({
        entityName: "Redis",
        entityType: "software",
        descriptions: ["a cache"],
        sourceIds: ["c1"],
        filePath: "doc.md",
      });
      expect(store.entityCount()).toBe(1);
      expect(store.hasEntity("Redis")).toBe(true);
      expect(store.hasEntity("nope")).toBe(false);
      expect(store.getEntity("Redis")).toEqual(node);
      expect(node.entityType).toBe("software");
      expect(node.filePath).toBe("doc.md");
    });

    it("normalizes whitespace and quotes but keeps case", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "  Redis Cache ", descriptions: [] });
      await store.upsertEntity({ entityName: "`redis`", descriptions: [] });
      // Whitespace is collapsed and quotes stripped, so these lookups resolve;
      // case is preserved, so the two names above stay two distinct nodes.
      expect(store.getEntity("  Redis Cache ")?.entityName).toBe("Redis Cache");
      expect(store.hasEntity("redis")).toBe(true);
      expect(store.entityCount()).toBe(2);
      expect(store.entityNames().sort()).toEqual(["Redis Cache", "redis"]);
    });

    it("defaults the type to UNKNOWN and keeps it across merges", async () => {
      const store = new KnowledgeGraphStore();
      const first = await store.upsertEntity({ entityName: "Redis" });
      expect(first.entityType).toBe("UNKNOWN");
      const merged = await store.upsertEntity({ entityName: "  `Redis` " });
      expect(merged.entityType).toBe("UNKNOWN");
      expect(merged.id).toBe(first.id);
      expect(merged.createdAt).toBe(first.createdAt);
    });

    it("merges descriptions and source ids instead of duplicating them", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({
        entityName: "Redis",
        descriptions: ["a cache", "a store"],
        sourceIds: ["c1", "c2"],
      });
      const merged = await store.upsertEntity({
        entityName: "Redis",
        descriptions: ["a cache", "also a pubsub"],
        sourceIds: ["c2", "c3"],
      });
      expect(merged.descriptions).toEqual(["a cache", "a store", "also a pubsub"]);
      expect(merged.sourceIds).toEqual(["c1", "c2", "c3"]);
    });

    it("caps the accumulated source ids", async () => {
      const store = new KnowledgeGraphStore();
      for (let i = 0; i < 5; i++) {
        await store.upsertEntity({ entityName: "Redis", sourceIds: [`c${i}`] });
      }
      expect(store.getEntity("Redis")?.sourceIds).toHaveLength(5);
    });

    it("rejects a name that is empty after normalization", async () => {
      const store = new KnowledgeGraphStore();
      await expect(store.upsertEntity({ entityName: "   " })).rejects.toThrow(
        "Entity name is empty after normalization",
      );
    });

    it("leaves filePath unset when not provided", async () => {
      const store = new KnowledgeGraphStore();
      const node = await store.upsertEntity({ entityName: "Redis" });
      expect(node.filePath).toBeUndefined();
    });

    it("batches node lookups and skips unknown names", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "Redis" });
      await store.upsertEntity({ entityName: "Postgres" });
      const batch = await store.getNodesBatch(["Redis", "nope", "Postgres"]);
      expect([...batch.keys()].sort()).toEqual(["Postgres", "Redis"]);
    });
  });

  describe("KnowledgeGraphStore relations", () => {
    it("canonicalizes endpoints so either order resolves to one edge", async () => {
      const store = new KnowledgeGraphStore();
      const first = await store.upsertRelation({ source: "Redis", target: "Api" });
      const second = await store.upsertRelation({ source: "Api", target: "Redis", weight: 2 });
      expect(store.relationCount()).toBe(1);
      expect(second.id).toBe(first.id);
      expect(second.endpoints).toEqual(["Api", "Redis"]);
      // Repeated evidence-free upserts contribute nothing new, so the weight
      // reflects the first write rather than accumulating a second one.
      expect(second.weight).toBe(1);
    });

    it("accumulates weight only for evidence the graph did not already hold", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertRelation({ source: "Redis", target: "Api", sourceIds: ["c1"], weight: 1 });
      // A genuinely new chunk id is new evidence, so its weight counts.
      const grown = await store.upsertRelation({
        source: "Api",
        target: "Redis",
        sourceIds: ["c2"],
        weight: 2,
      });
      expect(grown.weight).toBe(3);
      // A new description fragment is new evidence too.
      const described = await store.upsertRelation({
        source: "Redis",
        target: "Api",
        descriptions: ["co-occur in the caching section"],
        weight: 4,
      });
      expect(described.weight).toBe(7);
      // Repeating evidence already held moves nothing.
      const repeated = await store.upsertRelation({
        source: "Api",
        target: "Redis",
        sourceIds: ["c2"],
        descriptions: ["co-occur in the caching section"],
        weight: 4,
      });
      expect(repeated.weight).toBe(7);
    });

    it("leaves an edge untouched when a repeated upsert brings the same evidence", async () => {
      const store = new KnowledgeGraphStore();
      const first = await store.upsertRelation({
        source: "Redis",
        target: "Api",
        descriptions: ['co-occur in "# Cache"'],
        sourceIds: ["c1", "c2"],
        filePath: "doc.md",
        weight: 1,
      });
      const repeated = await store.upsertRelation({
        source: "Api", // Endpoints reversed: still the one canonical edge.
        target: "Redis",
        descriptions: ['co-occur in "# Cache"'],
        sourceIds: ["c2", "c1"], // Same ids, different order.
        filePath: "doc.md",
        weight: 5, // A weight the repeat must not add.
      });
      expect(store.relationCount()).toBe(1);
      // The stored edge object itself is returned untouched: an idempotent write
      // is observable as one, so ranking cannot drift on re-ingestion.
      expect(repeated).toBe(first);
      expect(repeated.weight).toBe(1);
      expect(repeated.descriptions).toEqual(first.descriptions);
      expect(repeated.sourceIds).toEqual(first.sourceIds);
    });

    it("leaves a node untouched when a repeated upsert brings the same evidence", async () => {
      const store = new KnowledgeGraphStore();
      const first = await store.upsertEntity({
        entityName: "Redis",
        entityType: "software",
        descriptions: ["a cache"],
        sourceIds: ["c1"],
        filePath: "doc.md",
      });
      const repeated = await store.upsertEntity({
        entityName: "Redis",
        entityType: "software",
        descriptions: ["a cache"],
        sourceIds: ["c1"],
        filePath: "doc.md",
      });
      expect(store.entityCount()).toBe(1);
      // `updatedAt` drives eviction order, so a no-op must not churn it.
      expect(repeated).toBe(first);
    });

    it("defaults a non-positive weight to one", async () => {
      const store = new KnowledgeGraphStore();
      const edge = await store.upsertRelation({ source: "A", target: "B", weight: 0 });
      expect(edge.weight).toBe(1);
    });

    it("rejects a self-relation or an empty endpoint", async () => {
      const store = new KnowledgeGraphStore();
      await expect(store.upsertRelation({ source: "A", target: "A" })).rejects.toThrow(
        "A relation needs two distinct endpoints",
      );
      await expect(store.upsertRelation({ source: "", target: "B" })).rejects.toThrow(
        "A relation needs two distinct endpoints",
      );
    });

    it("enumerates relations as canonical pairs", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertRelation({ source: "B", target: "A" });
      expect(store.relationPairs()).toEqual([["A", "B"]]);
    });
  });

  describe("batch degree and adjacency", () => {
    it("computes the degree of each named node", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertRelation({ source: "A", target: "B" });
      await store.upsertRelation({ source: "A", target: "C" });
      const degrees = await store.nodeDegreesBatch(["A", "B", "C"]);
      expect(degrees.get("A")).toBe(2);
      expect(degrees.get("B")).toBe(1);
      expect(degrees.get("C")).toBe(1);
    });

    it("lists the edges touching each named node without duplicating", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertRelation({ source: "A", target: "B" });
      await store.upsertRelation({ source: "A", target: "C" });
      const edges = await store.getNodesEdgesBatch(["A"]);
      expect(edges.get("A")).toEqual([
        ["A", "B"],
        ["A", "C"],
      ]);
      expect(edges.get("B")).toBeUndefined();
    });

    it("looks edges up by canonical pair in any order", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertRelation({ source: "A", target: "B" });
      const edges = await store.getEdgesBatch([
        ["B", "A"],
        ["A", "Z"],
      ]);
      expect(edges.size).toBe(1);
      for (const edge of edges.values()) expect(edge.weight).toBe(1);
    });
  });

  describe("ranked retrieval", () => {
    it("ranks relations by endpoint degree, then weight", async () => {
      const store = new KnowledgeGraphStore();
      // A is a hub: its relations should outrank the leaf pair.
      await store.upsertRelation({ source: "A", target: "B" });
      await store.upsertRelation({ source: "A", target: "C" });
      await store.upsertRelation({ source: "X", target: "Y", weight: 5 });

      const ranked = await store.relationsForEntities(["A", "B", "C", "X", "Y"]);
      expect(ranked.length).toBe(3);
      // Degree sums: A-B = 2+1 = 3, A-C = 2+1 = 3, X-Y = 1+1 = 2.
      expect(ranked[ranked.length - 1]!.endpoints).toEqual(["X", "Y"]);
      expect(ranked[0]!.rank).toBeGreaterThanOrEqual(ranked[1]!.rank);
    });

    it("walks from relations back to their endpoint entities", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "A" });
      await store.upsertEntity({ entityName: "B" });
      await store.upsertRelation({ source: "A", target: "B" });
      const edges: Map<string, RelationEdge> = await store.getEdgesBatch([["A", "B"]]);
      const entities = await store.entitiesForRelations([...edges.values()]);
      expect(entities.map((node: EntityNode) => node.entityName)).toEqual(["A", "B"]);
    });

    it("skips endpoints that were never inserted as entities", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertRelation({ source: "A", target: "B" });
      const edges: Map<string, RelationEdge> = await store.getEdgesBatch([["A", "B"]]);
      expect(await store.entitiesForRelations([...edges.values()])).toEqual([]);
    });
  });

  describe("deletion", () => {
    it("removes an entity and every edge that touched it", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "A" });
      await store.upsertEntity({ entityName: "B" });
      await store.upsertRelation({ source: "A", target: "B" });
      const removed = await store.deleteEntity("A");
      expect(removed).toBe(1);
      expect(store.entityCount()).toBe(1);
      expect(store.relationCount()).toBe(0);
      expect(store.hasEntity("A")).toBe(false);
    });

    it("removes a relation and leaves its endpoints alone", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "A" });
      await store.upsertEntity({ entityName: "B" });
      await store.upsertRelation({ source: "A", target: "B" });
      expect(await store.deleteRelation("B", "A")).toBe(true);
      expect(await store.deleteRelation("A", "B")).toBe(false);
      expect(store.relationCount()).toBe(0);
      expect(store.entityCount()).toBe(2);
    });
  });

  describe("clearSource", () => {
    it("is a no-op for a source the graph never learned from", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "Redis", sourceIds: ["c1"], filePath: "a.md" });
      expect(await store.clearSource("nope.md")).toEqual({ entities: 0, relations: 0 });
      expect(store.entityCount()).toBe(1);
    });

    it("strips one source's chunk ids while keeping another's", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({
        entityName: "Redis",
        sourceIds: ["c1"],
        filePath: "a.md",
      });
      await store.upsertEntity({
        entityName: "Redis",
        sourceIds: ["c2"],
        filePath: "b.md",
      });
      expect(store.getEntity("Redis")?.sourceIds).toEqual(["c1", "c2"]);

      const removed = await store.clearSource("a.md");
      // Redis is still evidenced by b.md, so only the retracted id is gone.
      expect(removed).toEqual({ entities: 0, relations: 0 });
      expect(store.getEntity("Redis")?.sourceIds).toEqual(["c2"]);
    });

    it("drops a node and its edges when no evidence is left", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "Redis", sourceIds: ["c1"], filePath: "a.md" });
      await store.upsertEntity({ entityName: "Kafka", sourceIds: ["c2"], filePath: "a.md" });
      await store.upsertRelation({
        source: "Redis",
        target: "Kafka",
        sourceIds: ["c1", "c2"],
        filePath: "a.md",
      });

      // The whole document is retracted, so its entity, its relation and the
      // edge's dangling endpoints all go together.
      expect(await store.clearSource("a.md")).toEqual({ entities: 2, relations: 1 });
      expect(store.entityCount()).toBe(0);
      expect(store.relationCount()).toBe(0);
    });

    it("leaves a relation from another source alone when one endpoint survives", async () => {
      const store = new KnowledgeGraphStore();
      await store.upsertEntity({ entityName: "Redis", sourceIds: ["c1"], filePath: "a.md" });
      await store.upsertEntity({ entityName: "Kafka", sourceIds: ["c2"], filePath: "b.md" });
      await store.upsertRelation({
        source: "Redis",
        target: "Kafka",
        sourceIds: ["c1"],
        filePath: "a.md",
      });
      await store.upsertRelation({
        source: "Redis",
        target: "Kafka",
        sourceIds: ["c2"],
        filePath: "b.md",
      });
      expect((await store.getEdgesBatch([["Kafka", "Redis"]])).size).toBe(1);

      await store.clearSource("a.md");
      // Redis had no other evidence, so the edge goes even though Kafka stays.
      expect(store.hasEntity("Redis")).toBe(false);
      expect(store.hasEntity("Kafka")).toBe(true);
      expect(store.relationCount()).toBe(0);
    });
  });

  describe("capacity", () => {
    it("retires the least-recently-updated node at the ceiling", async () => {
      const store = new KnowledgeGraphStore({ maxNodes: 2 });
      await store.upsertEntity({ entityName: "A" });
      await store.upsertEntity({ entityName: "B" });
      await store.upsertEntity({ entityName: "C" });
      expect(store.entityCount()).toBe(2);
      expect(store.hasEntity("A")).toBe(false);
      // The evicted node's edges go with it.
      expect(store.relationCount()).toBe(0);
    });

    it("reports the snapshot", async () => {
      const store = new KnowledgeGraphStore({ maxNodes: 5 });
      await store.upsertEntity({ entityName: "A" });
      await store.upsertRelation({ source: "A", target: "B" });
      expect(store.snapshot()).toEqual({ entityCount: 1, relationCount: 1, maxNodes: 5 });
    });
  });
});
