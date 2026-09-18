import { describe, expect, it } from "vitest";

import {
  cosineSimilarity,
  dotProduct,
  l2Norm,
  normalize,
  passesThreshold,
  topBySimilarity,
} from "../../src/memory/similarity.js";

describe("similarity", () => {
  describe("l2Norm", () => {
    it("computes the Euclidean norm", () => {
      expect(l2Norm([3, 4])).toBe(5);
      expect(l2Norm([1, 2, 2])).toBe(3);
      expect(l2Norm([0, 0, 0])).toBe(0);
    });

    it("returns 0 for an empty vector rather than NaN", () => {
      expect(l2Norm([])).toBe(0);
    });
  });

  describe("dotProduct", () => {
    it("computes the dot product of equal-length vectors", () => {
      expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
    });

    it("scores 0 for mismatched dimensionalities", () => {
      expect(dotProduct([1, 2], [1, 2, 3])).toBe(0);
    });

    it("scores 0 for empty vectors", () => {
      expect(dotProduct([], [])).toBe(0);
    });
  });

  describe("cosineSimilarity", () => {
    it("is 1 for parallel vectors", () => {
      expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 10);
    });

    it("never returns a magnitude outside [-1, 1]", () => {
      for (const pair of [
        [
          [1, 1],
          [2, 2],
        ],
        [
          [3, 4],
          [6, 8],
        ],
        [
          [1, 2, 3],
          [2, 4, 6],
        ],
        [
          [5, 0],
          [5, 0],
        ],
      ] as const) {
        const similarity = cosineSimilarity(pair[0], pair[1]);
        expect(similarity).toBeGreaterThanOrEqual(-1);
        expect(similarity).toBeLessThanOrEqual(1);
      }
    });

    it("is 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });

    it("is -1 for anti-parallel vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
    });

    it("defines a zero vector as orthogonal to everything instead of NaN", () => {
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
      expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it("collapses a non-finite intermediate to 0 rather than propagating it", () => {
      expect(cosineSimilarity([Number.POSITIVE_INFINITY], [1])).toBe(0);
      expect(cosineSimilarity([Number.NaN], [1])).toBe(0);
    });
  });

  describe("normalize", () => {
    it("scales a vector onto the unit sphere", () => {
      expect(normalize([3, 4])).toEqual([0.6, 0.8]);
      expect(l2Norm(normalize([1, 2, 3, 4]))).toBeCloseTo(1, 10);
    });

    it("leaves the zero vector untouched", () => {
      expect(normalize([0, 0])).toEqual([0, 0]);
      expect(normalize([])).toEqual([]);
    });

    it("does not mutate the input vector", () => {
      const input = [3, 4];
      normalize(input);
      expect(input).toEqual([3, 4]);
    });
  });

  describe("passesThreshold", () => {
    it("is strictly greater than the threshold", () => {
      expect(passesThreshold(0.5, 0.2)).toBe(true);
      expect(passesThreshold(0.2, 0.2)).toBe(false);
      expect(passesThreshold(0.1, 0.2)).toBe(false);
    });

    it("rejects non-finite similarities", () => {
      expect(passesThreshold(Number.NaN, 0)).toBe(false);
      expect(passesThreshold(Number.POSITIVE_INFINITY, 0)).toBe(false);
    });
  });

  describe("topBySimilarity", () => {
    const embed = (candidate: { id: string; vec: number[] }): number[] => candidate.vec;
    const candidates = [
      { id: "exact", vec: [1, 0] },
      { id: "near", vec: [0.6, 0.8] },
      { id: "orthogonal", vec: [0, 1] },
    ];

    it("ranks candidates by similarity and keeps the top k", () => {
      const ranked = topBySimilarity([1, 0], candidates, embed, 2);
      expect(ranked.map((entry) => entry.id)).toEqual(["exact", "near"]);
      expect(ranked[0]?.similarity).toBe(1);
      expect(ranked[1]?.similarity).toBeCloseTo(0.6, 10);
    });

    it("attaches the score to a copy of the candidate", () => {
      const ranked = topBySimilarity([1, 0], candidates, embed, 1);
      expect(ranked[0]).toMatchObject({ id: "exact", vec: [1, 0], similarity: 1 });
      // The original candidate object is not mutated with a similarity field.
      expect("similarity" in candidates[0]!).toBe(false);
    });

    it("filters out candidates below the threshold", () => {
      const ranked = topBySimilarity([1, 0], candidates, embed, 3, 0.7);
      expect(ranked.map((entry) => entry.id)).toEqual(["exact"]);
    });

    it("returns an empty list for a non-positive k", () => {
      expect(topBySimilarity([1, 0], candidates, embed, 0)).toEqual([]);
      expect(topBySimilarity([1, 0], candidates, embed, -1)).toEqual([]);
    });

    it("breaks ties by insertion order for deterministic ranking", () => {
      const tied = [
        { id: "first", vec: [1, 0] },
        { id: "second", vec: [1, 0] },
      ];
      const ranked = topBySimilarity([1, 0], tied, embed, 2);
      expect(ranked.map((entry) => entry.id)).toEqual(["first", "second"]);
    });
  });
});
