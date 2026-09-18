import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";

import {
  cacheKey,
  computeArgsHash,
  contentId,
  contentListDocumentId,
  deduplicatingEmbedding,
  EMBEDDING_MODEL_CATALOG,
  embeddingModelById,
  type EmbeddingFunction,
  localEmbeddingFunction,
  localEmbeddingVector,
  normalizeRerankResult,
} from "../../src/memory/embedding-pipeline.js";
import { cosineSimilarity, l2Norm } from "../../src/memory/similarity.js";

describe("embedding-pipeline", () => {
  describe("EMBEDDING_MODEL_CATALOG", () => {
    it("ships the three catalog entries", () => {
      expect(EMBEDDING_MODEL_CATALOG.map((entry) => entry.id)).toEqual([
        "default-local",
        "balanced-medium",
        "high-precision",
      ]);
    });

    it("gives every entry sane dimensionalities and thresholds", () => {
      for (const entry of EMBEDDING_MODEL_CATALOG) {
        expect(entry.dimensions).toBeGreaterThan(0);
        expect(entry.cosineThreshold).toBeGreaterThan(0);
        expect(entry.cosineThreshold).toBeLessThan(1);
        expect(entry.maxInputTokens).toBeGreaterThan(0);
      }
    });

    it("looks up an entry by id and returns undefined for an unknown one", () => {
      expect(embeddingModelById("default-local")?.dimensions).toBe(256);
      expect(embeddingModelById("nope")).toBeUndefined();
    });
  });

  describe("computeArgsHash", () => {
    it("is deterministic", () => {
      expect(computeArgsHash("a", "b")).toBe(computeArgsHash("a", "b"));
    });

    it("hashes a single argument as the raw string", () => {
      expect(computeArgsHash("hello")).toBe(createHash("md5").update("hello").digest("hex"));
      expect(computeArgsHash("hello")).toBe(computeArgsHash("hello"));
    });

    it("length-prefixes so delimiter-less joins cannot collide", () => {
      // ("abc","x") and ("ab","cx") concatenate to the same string; the length
      // prefixes make the field boundaries recoverable.
      expect(computeArgsHash("abc", "x")).not.toBe(computeArgsHash("ab", "cx"));
    });

    it("tolerates numeric and boolean arguments", () => {
      expect(typeof computeArgsHash(1, true)).toBe("string");
      expect(computeArgsHash(1, 2)).not.toBe(computeArgsHash(1, 3));
      // Arguments are stringified, so a numeric 1 and the string "1" encode
      // identically: this is a cache key, not a type-aware digest.
      expect(computeArgsHash(1)).toBe(computeArgsHash("1"));
    });
  });

  describe("contentId / cacheKey", () => {
    it("prefixes a content-derived id", () => {
      const id = contentId("some text", "doc:");
      expect(id.startsWith("doc:")).toBe(true);
      expect(contentId("some text", "doc:")).toBe(id);
      expect(contentId("other text", "doc:")).not.toBe(id);
    });

    it("namespaces a cache key", () => {
      expect(cacheKey("ns", "kind", "hash")).toBe("ns:kind:hash");
    });
  });

  describe("contentListDocumentId", () => {
    it("derives a stable id from block shape", () => {
      const blocks = [{ type: "heading", text: "A" }];
      expect(contentListDocumentId(blocks)).toBe(contentListDocumentId(blocks));
    });

    it("distinguishes documents whose blocks concatenate but boundary differently", () => {
      const oneBlock = [{ type: "text", value: "xy" }];
      const twoBlocks = [
        { type: "text", value: "x" },
        { type: "text", value: "y" },
      ];
      expect(contentListDocumentId(oneBlock)).not.toBe(contentListDocumentId(twoBlocks));
    });

    it("distinguishes documents by block type", () => {
      const a = [{ type: "text", value: "x" }];
      const b = [{ type: "code", value: "x" }];
      expect(contentListDocumentId(a)).not.toBe(contentListDocumentId(b));
    });

    it("distinguishes documents whose blocks differ only in field values", () => {
      // A shape-only id hashes both of these to the same value: the blocks have
      // identical types, keys and value types, and the values were never part
      // of the digest.
      const short = [{ type: "text", text: "A" }];
      const different = [{ type: "text", text: "totally different" }];
      expect(contentListDocumentId(short)).not.toBe(contentListDocumentId(different));
    });

    it("distinguishes one changed value in a multi-block document", () => {
      const base = [
        { type: "text", text: "one" },
        { type: "code", code: "x = 1" },
      ];
      const changed = [
        { type: "text", text: "one" },
        { type: "code", code: "x = 2" },
      ];
      expect(contentListDocumentId(base)).not.toBe(contentListDocumentId(changed));
    });
  });

  describe("localEmbeddingVector", () => {
    it("produces a fixed-dimensionality vector", () => {
      expect(localEmbeddingVector("some text", 256)).toHaveLength(256);
      expect(localEmbeddingVector("some text", 64)).toHaveLength(64);
    });

    it("is deterministic for identical input", () => {
      expect(localEmbeddingVector("redis cache", 256)).toEqual(
        localEmbeddingVector("redis cache", 256),
      );
    });

    it("is normalized onto the unit sphere for non-empty text", () => {
      expect(l2Norm(localEmbeddingVector("the quick brown fox", 256))).toBeCloseTo(1, 10);
    });

    it("is the zero vector for empty text", () => {
      const vector = localEmbeddingVector("", 256);
      expect(l2Norm(vector)).toBe(0);
    });

    it("gives identical text cosine similarity 1 and unrelated text less", () => {
      const a = localEmbeddingVector("redis cache configuration", 256);
      const b = localEmbeddingVector("redis cache configuration", 256);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);

      const c = localEmbeddingVector("qwxz phlngbdr", 256);
      expect(cosineSimilarity(a, c)).toBeLessThan(1);
    });

    it("lands lexically related text near each other", () => {
      const a = localEmbeddingVector("redis cache", 256);
      const b = localEmbeddingVector("cache redis", 256);
      expect(cosineSimilarity(a, b)).toBeGreaterThan(0);
    });
  });

  describe("localEmbeddingFunction", () => {
    it("embeds a batch in order with one vector per input", async () => {
      const vectors = await localEmbeddingFunction(["a", "b", "c"]);
      expect(vectors).toHaveLength(3);
      for (const vector of vectors) expect(vector).toHaveLength(256);
    });

    it("exposes the dimensionality and label of the contract", () => {
      expect(localEmbeddingFunction.dimensions).toBe(256);
      expect(typeof localEmbeddingFunction.label).toBe("string");
    });

    it("returns an empty list for an empty batch", async () => {
      expect(await localEmbeddingFunction([])).toEqual([]);
    });
  });

  describe("deduplicatingEmbedding", () => {
    let calls: string[][];
    let stub: EmbeddingFunction;

    beforeEach(() => {
      calls = [];
      stub = Object.assign(
        async (inputs: readonly string[]): Promise<number[][]> => {
          calls.push([...inputs]);
          return inputs.map((input) => [input.length]);
        },
        { dimensions: 1, label: "stub" },
      );
    });

    it("embeds each unique input once per batch", async () => {
      const dedup = deduplicatingEmbedding(stub);
      const out = await dedup(["a", "b", "a", "c", "b"]);
      expect(calls).toEqual([["a", "b", "c"]]);
      expect(out).toEqual([[1], [1], [1], [1], [1]]);
    });

    it("preserves the wrapped function's dimensionality and label", () => {
      const dedup = deduplicatingEmbedding(stub);
      expect(dedup.dimensions).toBe(1);
      expect(dedup.label).toBe("stub");
    });

    it("does not call the backend for an empty batch", async () => {
      const dedup = deduplicatingEmbedding(stub);
      expect(await dedup([])).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("re-deduplicates within a fresh batch only", async () => {
      const dedup = deduplicatingEmbedding(stub);
      await dedup(["a", "a"]);
      await dedup(["a", "a"]);
      expect(calls).toEqual([["a"], ["a"]]);
    });
  });

  describe("normalizeRerankResult", () => {
    it("accepts a well-formed result", () => {
      expect(normalizeRerankResult({ index: 1, relevanceScore: 0.5 }, 5)).toEqual({
        index: 1,
        relevanceScore: 0.5,
      });
    });

    it("rejects an out-of-range index", () => {
      expect(normalizeRerankResult({ index: 5, relevanceScore: 0.5 }, 5)).toBeNull();
      expect(normalizeRerankResult({ index: -1, relevanceScore: 0.5 }, 5)).toBeNull();
    });

    it("rejects a non-integer index", () => {
      expect(normalizeRerankResult({ index: 1.5, relevanceScore: 0.5 }, 5)).toBeNull();
    });

    it("rejects a missing or non-finite score", () => {
      expect(normalizeRerankResult({ index: 1 }, 5)).toBeNull();
      expect(normalizeRerankResult({ index: 1, relevanceScore: Number.NaN }, 5)).toBeNull();
      expect(
        normalizeRerankResult({ index: 1, relevanceScore: Number.POSITIVE_INFINITY }, 5),
      ).toBeNull();
    });

    it("rejects non-objects", () => {
      expect(normalizeRerankResult(null, 5)).toBeNull();
      expect(normalizeRerankResult(undefined, 5)).toBeNull();
      expect(normalizeRerankResult("nope", 5)).toBeNull();
    });
  });
});
