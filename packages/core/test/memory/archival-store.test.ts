import { describe, expect, it } from "vitest";

import {
  type ArchivalQueryResult,
  ArchivalStore,
  ARCHIVAL_STOPWORDS,
  lexicalScore,
} from "../../src/memory/archival-store.js";

const DOC = "# Redis Cache\n\nThe redis cache stores session data for the api gateway.";

describe("archival-store", () => {
  describe("lexicalScore", () => {
    it("is zero for no terms and for no match", () => {
      expect(lexicalScore("some document", [])).toBe(0);
      expect(lexicalScore("some document", ["nope"])).toBe(0);
    });

    it("scores term frequency against document length", () => {
      expect(lexicalScore("redis cache", ["redis"])).toBeCloseTo(1 / 11, 10);
      expect(lexicalScore("redis redis", ["redis"])).toBeCloseTo(2 / 11, 10);
    });

    it("drops stopwords from the query", () => {
      expect(lexicalScore("the redis", ["the", "redis"])).toBeCloseTo(1 / 9, 10);
    });

    it("falls back to the raw terms when the query is only stopwords", () => {
      // Both terms are stopwords, so the meaningful set is empty and the raw
      // terms are used rather than scoring nothing at all.
      expect(lexicalScore("the way", ["the", "way"])).toBeCloseTo(2 / 7, 10);
    });

    it("matches case-insensitively", () => {
      expect(lexicalScore("Redis CACHE", ["redis", "cache"])).toBeCloseTo(2 / 11, 10);
    });

    it("uses the shipped stopword set by default", () => {
      expect(ARCHIVAL_STOPWORDS.has("the")).toBe(true);
      expect(ARCHIVAL_STOPWORDS.has("redis")).toBe(false);
    });
  });

  describe("ingest", () => {
    it("chunks, embeds and indexes a document", async () => {
      const store = new ArchivalStore();
      const result = await store.ingest("notes.md", DOC);
      expect(result.chunkCount).toBeGreaterThan(0);
      expect(store.size()).toBe(result.chunkCount);
      expect(store.documentCount()).toBe(1);
      expect(store.hasDocument("notes.md")).toBe(true);
      expect(store.hasDocument("other.md")).toBe(false);
    });

    it("derives a stable document id from source and text", async () => {
      const store = new ArchivalStore();
      const first = await store.ingest("notes.md", DOC);
      const second = await store.ingest("notes.md", DOC);
      expect(second.documentId).toBe(first.documentId);
      // An unchanged re-ingest is observable as a no-op, not a duplicate.
      expect(store.size()).toBe(first.chunkCount);
      expect(store.documentCount()).toBe(1);
    });

    it("replaces a changed document without leaving orphan chunks", async () => {
      const store = new ArchivalStore();
      const first = await store.ingest("notes.md", DOC);
      const second = await store.ingest("notes.md", "# Postgres\n\nA different database entirely.");
      expect(second.documentId).not.toBe(first.documentId);
      expect(store.documentCount()).toBe(1);
      expect(store.size()).toBe(second.chunkCount);
    });

    it("records the source kind", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC, { sourceKind: "note" });
      const found = await store.query("redis", { topK: 5 });
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((chunk) => chunk.sourceKind === "note")).toBe(true);
    });

    it("honours an explicit chunk byte cap", async () => {
      const store = new ArchivalStore();
      const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some body text.`).join(
        "\n\n",
      );
      const small = await store.ingest("big.md", long, { maxChunkBytes: 100 });
      const big = await store.ingest("bigger.md", long, { maxChunkBytes: 4096 });
      expect(small.chunkCount).toBeGreaterThan(big.chunkCount);
    });

    it("can chunk plain text instead of Markdown", async () => {
      const store = new ArchivalStore();
      const lines = Array.from({ length: 50 }, (_, i) => `log line number ${i}`).join("\n");
      const result = await store.ingest("log.txt", lines, {
        plainText: 1,
        linesPerChunk: 10,
      });
      expect(result.chunkCount).toBe(5);
    });
  });

  describe("deleteDocument", () => {
    it("removes a document and every chunk it owned", async () => {
      const store = new ArchivalStore();
      const result = await store.ingest("notes.md", DOC);
      const removed = await store.deleteDocument("notes.md");
      expect(removed).toBe(result.chunkCount);
      expect(store.size()).toBe(0);
      expect(store.documentCount()).toBe(0);
      expect(store.hasDocument("notes.md")).toBe(false);
    });

    it("is a no-op for an unknown source", async () => {
      const store = new ArchivalStore();
      expect(await store.deleteDocument("nope.md")).toBe(0);
    });
  });

  describe("query", () => {
    it("returns nothing from an empty store", async () => {
      const store = new ArchivalStore();
      expect(await store.query("redis", {})).toEqual([]);
    });

    it("returns semantic results in descending similarity order", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);
      await store.ingest("other.md", "# Postgres\n\nA relational database for reporting.");

      const results = await store.query("redis cache", { topK: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((result) => result.matchLayer === "semantic")).toBe(true);
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.similarity).toBeLessThanOrEqual(results[i - 1]!.similarity);
      }
    });

    it("truncates to topK", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);
      expect((await store.query("redis", { topK: 1 })).length).toBeLessThanOrEqual(1);
      expect((await store.query("redis", { topK: 0 })).length).toBe(0);
    });

    it("runs the lexical branch and fuses by reciprocal rank", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);

      const fused = await store.query("redis cache", { topK: 5, lexical: true });
      expect(fused.length).toBeGreaterThan(0);
      for (const result of fused) {
        expect(result.matchLayer === "semantic" || result.matchLayer === "lexical").toBe(true);
        expect(typeof result.fusedScore).toBe("number");
      }
    });

    it("reranks by term proximity when asked", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);
      const results = await store.query("redis cache", {
        topK: 5,
        lexical: true,
        proximity: true,
      });
      expect(results.length).toBeGreaterThan(0);
    });

    it("excludes everything below the semantic threshold", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);
      // Similarity is clamped to 1, so a threshold of 1 is strictly unreachable.
      expect(await store.query("redis cache", { semanticThreshold: 1 })).toEqual([]);
    });

    it("restricts results to one source", async () => {
      const store = new ArchivalStore();
      await store.ingest("api.md", "# Redis\n\nRedis cache for the api gateway.");
      await store.ingest("workers.md", "# Redis\n\nRedis cache for the worker pool.");

      const results = await store.query("redis cache", { topK: 10, source: "api.md" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((result) => result.source === "api.md")).toBe(true);
    });

    it("restricts results to one source kind", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC, { sourceKind: "note" });
      await store.ingest("code.md", "# Redis\n\nconst redis = new Client();", {
        sourceKind: "code",
      });

      const results = await store.query("redis", { topK: 10, sourceKind: "code" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((result) => result.sourceKind === "code")).toBe(true);
    });
  });

  describe("lookup", () => {
    it("fetches chunks by id in the order requested", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);
      const results: ArchivalQueryResult[] = await store.query("redis", { topK: 5 });
      const ids = results.map((result) => result.chunkId);
      const found = await store.getByIds(ids);
      expect(found.map((chunk) => chunk.chunkId)).toEqual(ids);
      // Unknown ids are simply dropped.
      expect(await store.getByIds([...ids, "nope"])).toHaveLength(ids.length);
    });

    it("serves stored vectors for a caller that wants to rerank itself", async () => {
      const store = new ArchivalStore();
      await store.ingest("notes.md", DOC);
      const results = await store.query("redis", { topK: 5 });
      const vectors = await store.vectorsByIds(results.map((result) => result.chunkId));
      expect(vectors.size).toBe(results.length);
      for (const vector of vectors.values()) expect(vector).toHaveLength(256);
    });

    it("embeds a query into this store's space", async () => {
      const store = new ArchivalStore();
      const vector = await store.embedQuery("redis cache");
      expect(vector).toHaveLength(256);
    });
  });
});
