import { describe, expect, it } from "vitest";

import {
  ADJACENT_PAIR_GAP_CHARS,
  applyRerank,
  countAdjacentPairs,
  extractProximityTerms,
  findAllPositions,
  findMinSpan,
  fuseAndRerank,
  pickByVectorSimilarity,
  pickByWeightedPolling,
  proximityBoost,
  reciprocalRankFusion,
  roundRobinMerge,
  vectorPickQuota,
} from "../../src/memory/retrieval-fuser.js";

const RRF_K = 60;

describe("retrieval-fuser", () => {
  describe("pickByWeightedPolling", () => {
    it("returns nothing for no items or a non-positive quota", () => {
      expect(pickByWeightedPolling([], 10)).toEqual([]);
      expect(pickByWeightedPolling([{ sortedChunks: ["a"] }], 0)).toEqual([]);
    });

    it("takes the whole first list when there is one item", () => {
      const out = pickByWeightedPolling([{ sortedChunks: ["a", "b", "c"] }], 2);
      expect(out).toEqual(["a", "b"]);
    });

    it("allocates on a linear gradient from maxQuota down to minQuota", () => {
      const out = pickByWeightedPolling(
        [{ sortedChunks: ["a1", "a2", "a3", "a4", "a5"] }, { sortedChunks: ["b1", "b2", "b3"] }],
        4,
        1,
      );
      expect(out).toEqual(["a1", "a2", "a3", "a4", "b1"]);
    });

    it("redistributes leftover quota to the highest-ranked items that still have chunks", () => {
      const out = pickByWeightedPolling(
        [{ sortedChunks: ["a1"] }, { sortedChunks: ["b1", "b2", "b3", "b4"] }],
        4,
        1,
      );
      expect(out).toEqual(["a1", "b1", "b2", "b3", "b4"]);
    });

    it("deduplicates a chunk that evidences several items", () => {
      // A chunk already taken from a higher-ranked item burns the lower item's
      // slot without being re-added: allocation consumes on the duplicate.
      const out = pickByWeightedPolling(
        [{ sortedChunks: ["x", "a"] }, { sortedChunks: ["x", "b"] }],
        2,
        1,
      );
      expect(out).toEqual(["x", "a"]);
    });

    it("stops when every item is exhausted", () => {
      const out = pickByWeightedPolling([{ sortedChunks: ["a1"] }, { sortedChunks: ["b1"] }], 5, 1);
      expect(out).toEqual(["a1", "b1"]);
    });
  });

  describe("pickByVectorSimilarity", () => {
    const query = [1, 0];
    const vectors = new Map<string, number[]>([
      ["c1", [1, 0]],
      ["c2", [0.6, 0.8]],
      ["c3", [0, 1]],
    ]);

    it("returns nothing for a non-positive quota or no candidates", () => {
      expect(
        pickByVectorSimilarity({ queryVector: query, candidates: [], vectors, quota: 5 }),
      ).toEqual([]);
      expect(
        pickByVectorSimilarity({ queryVector: query, candidates: ["c1"], vectors, quota: 0 }),
      ).toEqual([]);
    });

    it("keeps the quota most similar to the query, ordered by similarity", () => {
      expect(
        pickByVectorSimilarity({
          queryVector: query,
          candidates: ["c1", "c2", "c3"],
          vectors,
          quota: 5,
        }),
      ).toEqual(["c1", "c2"]);
    });

    it("honours an explicit threshold", () => {
      // The map must carry exactly the candidates, or the deliberate
      // size-mismatch abort fires and nothing is returned.
      const exact = new Map<string, number[]>([
        ["c1", [1, 0]],
        ["c2", [0.6, 0.8]],
      ]);
      expect(
        pickByVectorSimilarity({
          queryVector: query,
          candidates: ["c1", "c2"],
          vectors: exact,
          quota: 5,
          threshold: 0.8,
        }),
      ).toEqual(["c1"]);
    });

    it("breaks similarity ties by ascending id", () => {
      const tied = new Map<string, number[]>([
        ["b", [1, 0]],
        ["a", [1, 0]],
      ]);
      expect(
        pickByVectorSimilarity({
          queryVector: query,
          candidates: ["b", "a"],
          vectors: tied,
          quota: 5,
        }),
      ).toEqual(["a", "b"]);
    });

    it("aborts when a referenced chunk has no stored vector", () => {
      const partial = new Map<string, number[]>([["c1", [1, 0]]]);
      expect(
        pickByVectorSimilarity({
          queryVector: query,
          candidates: ["c1", "c2"],
          vectors: partial,
          quota: 5,
        }),
      ).toEqual([]);
    });

    it("aborts when the vector map and the candidates disagree in size", () => {
      const extra = new Map<string, number[]>([
        ["c1", [1, 0]],
        ["c9", [1, 0]],
      ]);
      expect(
        pickByVectorSimilarity({
          queryVector: query,
          candidates: ["c1"],
          vectors: extra,
          quota: 5,
        }),
      ).toEqual([]);
    });
  });

  describe("vectorPickQuota", () => {
    it("is half the product, floored at one", () => {
      expect(vectorPickQuota(4, 3)).toBe(6);
      expect(vectorPickQuota(5, 3)).toBe(7);
      expect(vectorPickQuota(1, 1)).toBe(1);
    });
  });

  describe("roundRobinMerge", () => {
    it("interleaves sources so no source crowds out the others", () => {
      const merged = roundRobinMerge([[{ chunkId: "a1" }, { chunkId: "a2" }], [{ chunkId: "b1" }]]);
      expect(merged.map((item) => item.chunkId)).toEqual(["a1", "b1", "a2"]);
    });

    it("deduplicates by chunk id", () => {
      const merged = roundRobinMerge([[{ chunkId: "x" }], [{ chunkId: "x" }, { chunkId: "y" }]]);
      expect(merged.map((item) => item.chunkId)).toEqual(["x", "y"]);
    });

    it("returns nothing for empty sources", () => {
      expect(roundRobinMerge([])).toEqual([]);
      expect(roundRobinMerge([[], []])).toEqual([]);
    });

    it("never repeats an id", () => {
      const merged = roundRobinMerge([
        [{ chunkId: "a" }, { chunkId: "b" }],
        [{ chunkId: "b" }, { chunkId: "a" }],
        [{ chunkId: "a" }],
      ]);
      const ids = merged.map((item) => item.chunkId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("findAllPositions", () => {
    it("lists every occurrence ascending", () => {
      expect(findAllPositions("a x a x a", "a")).toEqual([0, 4, 8]);
      expect(findAllPositions("a x a x a", "x")).toEqual([2, 6]);
    });

    it("is empty for an empty or absent term", () => {
      expect(findAllPositions("abc", "")).toEqual([]);
      expect(findAllPositions("abc", "z")).toEqual([]);
    });
  });

  describe("countAdjacentPairs", () => {
    it("counts each left position against at most one right position", () => {
      expect(countAdjacentPairs([[0, 4], [8]], ["foo", "bar"])).toBe(1);
    });

    it("counts repeated occurrences in order", () => {
      expect(
        countAdjacentPairs(
          [
            [0, 8],
            [4, 12],
          ],
          ["foo", "bar"],
        ),
      ).toBe(2);
    });

    it("needs at least two terms and two position lists", () => {
      expect(countAdjacentPairs([[0]], ["foo"])).toBe(0);
      expect(countAdjacentPairs([[0], [1]], ["foo"])).toBe(0);
    });

    it("honours the gap window", () => {
      // "aa bb": right starts 3 chars in, left ends at 2, so a 0-char gap misses it.
      expect(countAdjacentPairs([[0], [3]], ["aa", "bb"], 0)).toBe(0);
      expect(countAdjacentPairs([[0], [3]], ["aa", "bb"], 1)).toBe(1);
    });

    it("uses the shipped default gap", () => {
      expect(ADJACENT_PAIR_GAP_CHARS).toBe(30);
      expect(countAdjacentPairs([[0], [35]], ["aa", "bb"])).toBe(0);
      expect(countAdjacentPairs([[0], [32]], ["aa", "bb"])).toBe(1);
    });
  });

  describe("findMinSpan", () => {
    it("is 0 for a single list and Infinity for none", () => {
      expect(findMinSpan([[1, 2, 3]])).toBe(0);
      expect(findMinSpan([])).toBe(Number.POSITIVE_INFINITY);
    });

    it("is Infinity when any term is absent", () => {
      expect(findMinSpan([[0], []])).toBe(Number.POSITIVE_INFINITY);
    });

    it("finds the smallest window covering every term", () => {
      expect(findMinSpan([[0, 100], [50]])).toBe(50);
      expect(findMinSpan([[0], [10], [20]])).toBe(20);
    });
  });

  describe("extractProximityTerms", () => {
    it("lowercases and drops short terms and stopwords", () => {
      expect(extractProximityTerms("The Redis cache config", new Set(["the"]))).toEqual([
        "redis",
        "cache",
        "config",
      ]);
    });

    it("drops terms shorter than the minimum length", () => {
      expect(extractProximityTerms("a b cd ef")).toEqual(["cd", "ef"]);
    });

    it("falls back to the raw terms when the query is only stopwords", () => {
      expect(extractProximityTerms("the be", new Set(["the", "be"]))).toEqual(["the", "be"]);
    });

    it("is empty for an empty query", () => {
      expect(extractProximityTerms("")).toEqual([]);
    });
  });

  describe("proximityBoost", () => {
    it("is zero when the query yields no terms", () => {
      expect(proximityBoost({ query: "", title: "t", content: "c", isCode: false })).toBe(0);
    });

    it("weights a code title higher than a prose title", () => {
      const args = {
        query: "redis",
        title: "Redis guide",
        content: "unrelated",
      } as const;
      expect(proximityBoost({ ...args, isCode: true })).toBeCloseTo(0.6, 10);
      expect(proximityBoost({ ...args, isCode: false })).toBeCloseTo(0.3, 10);
    });

    it("scales the title boost by how many terms matched", () => {
      const boost = proximityBoost({
        query: "redis cache",
        title: "Redis notes",
        content: "unrelated",
        isCode: false,
      });
      // One of two terms hits the title: 0.3 * 1/2.
      expect(boost).toBeCloseTo(0.15, 10);
    });

    it("is only the title boost when a single term is queried", () => {
      expect(
        proximityBoost({
          query: "redis",
          title: "other",
          content: "redis is great",
          isCode: false,
        }),
      ).toBe(0);
    });

    it("combines title, proximity and phrase boosts for a tight match", () => {
      const content = "the redis cache is fast";
      const boost = proximityBoost({
        query: "redis cache",
        title: "",
        content,
        isCode: false,
      });
      const length = content.length;
      const expectedProximity = 1 / (1 + 6 / length);
      const expectedPhrase = 0.5 * (1 / 4);
      expect(boost).toBeCloseTo(expectedProximity + expectedPhrase, 10);
    });

    it("falls back to the title boost when a term is absent from the content", () => {
      expect(
        proximityBoost({
          query: "redis cache",
          title: "Redis notes",
          content: "nothing here",
          isCode: false,
        }),
      ).toBeCloseTo(0.15, 10);
    });

    it("honours explicit terms over the extracted ones", () => {
      const boost = proximityBoost({
        query: "zzz",
        title: "Redis notes",
        content: "the redis cache is fast",
        isCode: false,
        options: { terms: ["redis"] },
      });
      expect(boost).toBeCloseTo(0.3, 10);
    });
  });

  describe("reciprocalRankFusion", () => {
    it("returns nothing for a non-positive topN", () => {
      expect(reciprocalRankFusion([[{ chunkId: "a" }]], (item) => item.chunkId, 0)).toEqual([]);
    });

    it("ranks an item both lists agreed on first, by summed reciprocal rank", () => {
      const fused = reciprocalRankFusion(
        [
          [{ chunkId: "a" }, { chunkId: "b" }],
          [{ chunkId: "b" }, { chunkId: "c" }],
        ],
        (item) => item.chunkId,
        3,
      );
      expect(fused.map((item) => item.chunkId)).toEqual(["b", "a", "c"]);
      expect(fused[0]?.fusedScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 10);
    });

    it("truncates to topN", () => {
      const fused = reciprocalRankFusion(
        [
          [{ chunkId: "a" }, { chunkId: "b" }],
          [{ chunkId: "b" }, { chunkId: "c" }],
        ],
        (item) => item.chunkId,
        2,
      );
      expect(fused).toHaveLength(2);
      expect(fused.map((item) => item.chunkId)).toEqual(["b", "a"]);
    });

    it("preserves single-list order", () => {
      const fused = reciprocalRankFusion(
        [[{ chunkId: "a" }, { chunkId: "b" }, { chunkId: "c" }]],
        (item) => item.chunkId,
        10,
      );
      expect(fused.map((item) => item.chunkId)).toEqual(["a", "b", "c"]);
    });

    it("handles empty lists and no lists", () => {
      expect(reciprocalRankFusion([], (item: { chunkId: string }) => item.chunkId, 5)).toEqual([]);
      expect(reciprocalRankFusion([[]], (item: { chunkId: string }) => item.chunkId, 5)).toEqual(
        [],
      );
    });
  });

  describe("applyRerank", () => {
    it("returns nothing for no documents", async () => {
      expect(await applyRerank("q", [], async () => [])).toEqual([]);
    });

    it("reorders by the reranker and attaches the score", async () => {
      const docs = [{ chunkId: "a" }, { chunkId: "b" }, { chunkId: "c" }];
      const out = await applyRerank("q", docs, async () => [
        { index: 2, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.1 },
      ]);
      expect(out).toEqual([
        { chunkId: "c", rerankScore: 0.9 },
        { chunkId: "a", rerankScore: 0.1 },
      ]);
    });

    it("truncates to topN", async () => {
      const docs = [{ chunkId: "a" }, { chunkId: "b" }];
      const out = await applyRerank(
        "q",
        docs,
        async () => [
          { index: 0, relevanceScore: 0.1 },
          { index: 1, relevanceScore: 0.9 },
        ],
        1,
      );
      expect(out).toEqual([{ chunkId: "a", rerankScore: 0.1 }]);
    });

    it("drops invalid results rather than trusting them", async () => {
      const docs = [{ chunkId: "a" }, { chunkId: "b" }];
      const out = await applyRerank("q", docs, async () => [
        { index: 5, relevanceScore: 0.9 },
        { index: -1, relevanceScore: 0.9 },
        { index: 0, relevanceScore: Number.NaN },
        { index: 1, relevanceScore: 0.5 },
      ]);
      expect(out).toEqual([{ chunkId: "b", rerankScore: 0.5 }]);
    });

    it("keeps only the first score for a duplicated index", async () => {
      const docs = [{ chunkId: "a" }, { chunkId: "b" }];
      const out = await applyRerank("q", docs, async () => [
        { index: 0, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.1 },
      ]);
      expect(out).toEqual([{ chunkId: "a", rerankScore: 0.9 }]);
    });
  });

  describe("fuseAndRerank", () => {
    const lists = [
      [{ chunkId: "a" }, { chunkId: "b" }],
      [{ chunkId: "b" }, { chunkId: "c" }],
    ];

    it("is plain RRF when no reranking stage is configured", async () => {
      const out = await fuseAndRerank({ candidateLists: lists, topN: 3 });
      expect(out.map((item) => item.chunkId)).toEqual(["b", "a", "c"]);
      expect(out.every((item) => typeof item.fusedScore === "number")).toBe(true);
    });

    it("keeps every fused item when proximity reranking is configured", async () => {
      const out = await fuseAndRerank({
        candidateLists: lists,
        topN: 3,
        proximity: {
          query: "redis cache",
          titleOf: () => "",
          contentOf: (item) => item.chunkId,
          isCode: () => false,
        },
      });
      expect(out.map((item) => item.chunkId).sort()).toEqual(["a", "b", "c"]);
      expect(out.every((item) => typeof item.fusedScore === "number")).toBe(true);
    });

    it("applies the model reranker as the final authority", async () => {
      const out = await fuseAndRerank({
        candidateLists: lists,
        topN: 2,
        proximity: {
          query: "q",
          titleOf: () => "",
          contentOf: () => "x",
          isCode: () => false,
        },
        rerank: async () => [
          { index: 1, relevanceScore: 0.9 },
          { index: 0, relevanceScore: 0.1 },
        ],
      });
      expect(out).toHaveLength(2);
      expect(out.every((item) => typeof item.rerankScore === "number")).toBe(true);
    });
  });
});
