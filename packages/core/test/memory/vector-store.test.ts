import { describe, expect, it } from "vitest";

import { cosineSimilarity, normalize } from "../../src/memory/similarity.js";
import { type VectorRecord, InProcessVectorStore } from "../../src/memory/vector-store.js";

const DIM = 4;

/** Deterministic bag-of-characters embedding; only store mechanics are under test. */
function embed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  for (const ch of text) {
    const index = ch.charCodeAt(0) % DIM;
    vec[index] = (vec[index] ?? 0) + 1;
  }
  const norm = Math.hypot(...vec);
  return norm === 0 ? vec : vec.map((value) => value / norm);
}

function record(id: string, text: string): VectorRecord {
  return { id, vector: embed(text), payload: { text } };
}

describe("vector-store", () => {
  describe("InProcessVectorStore construction", () => {
    it("defaults dimensionality to 256 and the threshold to 0.2", () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed });
      expect(store.dimensions).toBe(256);
      expect(store.cosineBetterThanThreshold).toBe(0.2);
      expect(store.label).toBe("test");
    });

    it("honours explicit dimensionality and threshold", () => {
      const store = new InProcessVectorStore({
        label: "test",
        embedding: embed,
        dimensions: DIM,
        cosineBetterThanThreshold: 0.5,
      });
      expect(store.dimensions).toBe(DIM);
      expect(store.cosineBetterThanThreshold).toBe(0.5);
    });
  });

  describe("upsert", () => {
    it("stores records and reports size", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat"), record("car", "car")]);
      expect(store.size()).toBe(2);
    });

    it("overwrites a record with a duplicate id", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);
      await store.upsert([record("cat", "dog")]);
      expect(store.size()).toBe(1);
      const stored = await store.getByIds(["cat"]);
      expect(stored[0]?.payload).toEqual({ text: "dog" });
    });

    it("rejects a vector whose length does not match the store dimensionality", async () => {
      const store = new InProcessVectorStore({ label: "idx", embedding: embed, dimensions: DIM });
      await expect(store.upsert([{ id: "bad", vector: [1, 0, 0], payload: {} }])).rejects.toThrow(
        /idx: vector length 3 does not match store dimensionality 4/,
      );
    });

    it("normalizes a non-unit vector at insert time", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([{ id: "raw", vector: [3, 4, 0, 0], payload: {} }]);
      const vectors = await store.getVectorsByIds(["raw"]);
      expect(vectors.get("raw")).toEqual([0.6, 0.8, 0, 0]);
    });

    it("leaves an already-normalized vector untouched", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      const unit = normalize([3, 4, 0, 0]);
      await store.upsert([{ id: "unit", vector: unit, payload: {} }]);
      const vectors = await store.getVectorsByIds(["unit"]);
      expect(vectors.get("unit")).toEqual(unit);
    });
  });

  describe("query", () => {
    it("ranks by similarity and truncates to topK", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat"), record("car", "car"), record("dog", "dog")]);

      const results = await store.query("cat", { topK: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe("cat");
      expect(results[0]?.similarity).toBe(1);
    });

    it("returns every above-threshold match in descending similarity order", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat"), record("car", "car"), record("dog", "dog")]);

      const results = await store.query("cat", { topK: 10 });
      expect(results[0]?.id).toBe("cat");
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.similarity).toBeLessThanOrEqual(results[i - 1]!.similarity);
      }
      // Similarities match the cosine of the embedded query against each stored vector.
      for (const result of results) {
        const stored = await store.getByIds([result.id]);
        expect(result.similarity).toBeCloseTo(
          cosineSimilarity(embed("cat"), stored[0]!.vector),
          10,
        );
      }
    });

    it("applies the store threshold by default", async () => {
      const store = new InProcessVectorStore({
        label: "test",
        embedding: embed,
        dimensions: DIM,
        cosineBetterThanThreshold: 0.99,
      });
      await store.upsert([record("cat", "cat"), record("dog", "dog")]);

      const results = await store.query("cat", { topK: 10 });
      expect(results.map((result) => result.id)).toEqual(["cat"]);
    });

    it("honours an explicit threshold override", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat"), record("dog", "dog")]);

      const strict = await store.query("cat", { topK: 10, threshold: 0.99 });
      expect(strict.map((result) => result.id)).toEqual(["cat"]);
    });

    it("breaks similarity ties by ascending id for determinism", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      // Same text, different ids -> identical vectors -> tie.
      await store.upsert([record("b", "cat"), record("a", "cat")]);

      const results = await store.query("cat", { topK: 2 });
      expect(results.map((result) => result.id)).toEqual(["a", "b"]);
    });

    it("accepts a precomputed query vector instead of embedding", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);

      const results = await store.query("unused", {
        topK: 1,
        queryVector: embed("cat"),
      });
      expect(results[0]?.id).toBe("cat");
    });

    it("returns nothing for a query vector of mismatched dimensionality", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);

      const results = await store.query("cat", { topK: 1, queryVector: [1, 0, 0] });
      expect(results).toEqual([]);
    });

    it("clamps a negative topK to an empty result set", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);

      expect(await store.query("cat", { topK: -1 })).toEqual([]);
    });

    it("returns payload verbatim", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([{ id: "x", vector: embed("cat"), payload: { deep: { value: 7 } } }]);

      const results = await store.query("cat", { topK: 1 });
      expect(results[0]?.payload).toEqual({ deep: { value: 7 } });
    });
  });

  describe("lookup and deletion", () => {
    it("getByIds drops unknown ids", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);

      const found = await store.getByIds(["cat", "nope"]);
      expect(found.map((entry) => entry.id)).toEqual(["cat"]);
    });

    it("getVectorsByIds maps only present ids", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);

      const vectors = await store.getVectorsByIds(["cat", "nope"]);
      expect(vectors.size).toBe(1);
      expect(vectors.has("nope")).toBe(false);
    });

    it("delete removes records", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat"), record("dog", "dog")]);
      await store.delete(["cat"]);
      expect(store.size()).toBe(1);
      expect(await store.getByIds(["cat"])).toEqual([]);
    });

    it("delete is a no-op for unknown ids", async () => {
      const store = new InProcessVectorStore({ label: "test", embedding: embed, dimensions: DIM });
      await store.upsert([record("cat", "cat")]);
      await store.delete(["nope"]);
      expect(store.size()).toBe(1);
    });
  });
});
