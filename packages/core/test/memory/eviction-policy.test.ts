import { describe, expect, it } from "vitest";

import {
  characterLimitFor,
  DEFAULT_MEMORY_CONSTRAINTS,
  evictToTokenBudget,
  FloodGuard,
  globToRegExp,
  keepMostValuable,
  LruCache,
  type MemoryConstraintsConfig,
  type MemoryTreeReader,
  pathDepth,
  validateMemoryTreeConstraints,
} from "../../src/memory/eviction-policy.js";

/**
 * An in-memory memory-tree reader. `stream` attaches the optional
 * `countCharacters` path; without it the validator must fall back to `readFile`,
 * which is the path the missing-file and character-cap tests need to exercise.
 */
function fakeReader(
  files: Array<{
    path: string;
    mode?: string;
    content?: string | null;
    characters?: number;
  }>,
  stream = false,
): MemoryTreeReader {
  const contents = new Map(files.map((file) => [file.path, file.content ?? null]));
  const counts = new Map(files.map((file) => [file.path, file.characters]));
  const reader: MemoryTreeReader = {
    async listFiles() {
      return files.map((file) => ({ path: file.path, mode: file.mode ?? "100644" }));
    },
    async readFile(path: string) {
      const content = contents.get(path);
      return content === null || content === undefined ? null : new TextEncoder().encode(content);
    },
  };
  if (stream) {
    reader.countCharacters = async (path: string) => counts.get(path) ?? 0;
  }
  return reader;
}

describe("eviction-policy", () => {
  describe("LruCache", () => {
    it("clamps the capacity to at least one", () => {
      const cache = new LruCache<string>(0);
      cache.set("a", "A");
      cache.set("b", "B");
      expect(cache.size).toBe(1);
    });

    it("stores and reads entries", () => {
      const cache = new LruCache<string>(4);
      cache.set("a", "A");
      expect(cache.get("a")).toBe("A");
      expect(cache.has("a")).toBe(true);
      expect(cache.has("missing")).toBe(false);
      expect(cache.get("missing")).toBeUndefined();
    });

    it("returns the evicted key when the capacity is exceeded", () => {
      const cache = new LruCache<string>(2);
      expect(cache.set("a", "A")).toBeUndefined();
      expect(cache.set("b", "B")).toBeUndefined();
      expect(cache.set("c", "C")).toBe("a");
      expect(cache.has("a")).toBe(false);
    });

    it("promotes an entry on read so a queried item survives", () => {
      const cache = new LruCache<string>(2);
      cache.set("a", "A");
      cache.set("b", "B");
      expect(cache.get("a")).toBe("A");
      expect(cache.set("c", "C")).toBe("b");
      expect(cache.get("a")).toBe("A");
    });

    it("re-setting an existing key does not evict", () => {
      const cache = new LruCache<string>(2);
      cache.set("a", "A");
      cache.set("b", "B");
      expect(cache.set("a", "A2")).toBeUndefined();
      expect(cache.size).toBe(2);
      expect(cache.get("a")).toBe("A2");
    });

    it("deletes and clears", () => {
      const cache = new LruCache<string>(4);
      cache.set("a", "A");
      expect(cache.delete("a")).toBe(true);
      expect(cache.delete("a")).toBe(false);
      cache.set("b", "B");
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it("iterates in least-recently-used order", () => {
      const cache = new LruCache<string>(3);
      cache.set("a", "A");
      cache.set("b", "B");
      cache.set("c", "C");
      cache.get("a");
      expect([...cache].map(([key]) => key)).toEqual(["b", "c", "a"]);
    });
  });

  describe("evictToTokenBudget", () => {
    it("drops the cheapest items until the budget fits", () => {
      const items = [
        { id: "a", tokens: 100 },
        { id: "b", tokens: 4_000 },
        { id: "c", tokens: 50 },
      ];
      expect(evictToTokenBudget(items, 200)).toEqual(["b"]);
    });

    it("keeps everything when the budget is generous", () => {
      expect(evictToTokenBudget([{ id: "a", tokens: 10 }], 1_000)).toEqual([]);
    });

    it("evicts everything for a non-positive budget", () => {
      expect(evictToTokenBudget([{ id: "a", tokens: 10 }], 0)).toEqual(["a"]);
    });

    it("breaks equal-cost ties by insertion order", () => {
      const items = [
        { id: "x", tokens: 10 },
        { id: "y", tokens: 10 },
      ];
      expect(evictToTokenBudget(items, 10)).toEqual(["y"]);
    });

    it("does not mutate the input array", () => {
      const items = [
        { id: "a", tokens: 3 },
        { id: "b", tokens: 1 },
      ];
      evictToTokenBudget(items, 1);
      expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    });
  });

  describe("keepMostValuable", () => {
    it("keeps all items when the count covers them", () => {
      const items = [1, 2];
      expect(keepMostValuable(items, 5, (value) => value)).toEqual({ keep: [1, 2], drop: [] });
    });

    it("drops all items for a non-positive count", () => {
      expect(keepMostValuable([1], 0, (value) => value)).toEqual({ keep: [], drop: [1] });
    });

    it("keeps the most valuable and preserves their original order", () => {
      const items = [3, 1, 2];
      expect(keepMostValuable(items, 2, (value) => value)).toEqual({ keep: [3, 2], drop: [1] });
    });

    it("breaks equal-value ties by original order", () => {
      const items = [{ v: 5 }, { v: 5 }];
      expect(keepMostValuable(items, 1, (item) => item.v).keep).toEqual([{ v: 5 }]);
    });
  });

  describe("FloodGuard", () => {
    const config = { windowMs: 1_000, softCapAfter: 2, blockAfter: 4 };

    it("leaves an under-cap key unthrottled", () => {
      const guard = new FloodGuard(config);
      const decision = guard.record("agent-a", 0);
      expect(decision.count).toBe(1);
      expect(decision.softCapped).toBe(false);
      expect(decision.blocked).toBe(false);
    });

    it("soft-caps only past the soft cap and blocks only past the hard cap", () => {
      const guard = new FloodGuard(config);
      // Record once per tick and reuse the decision: record() increments.
      const decisions = [1, 2, 3, 4, 5].map((now) => guard.record("agent-a", now));
      expect(decisions[0]!.count).toBe(1);
      expect(decisions[0]!.softCapped).toBe(false);
      expect(decisions[1]!.softCapped).toBe(false); // strictly greater than the cap
      expect(decisions[2]!.softCapped).toBe(true);
      expect(decisions[2]!.blocked).toBe(false);
      expect(decisions[3]!.blocked).toBe(false); // count 4 is not past blockAfter 4
      expect(decisions[4]!.blocked).toBe(true);
    });

    it("resets a key's window when it elapses", () => {
      const guard = new FloodGuard(config);
      guard.record("agent-a", 0);
      guard.record("agent-a", 100);
      expect(guard.record("agent-a", 5_000).count).toBe(1);
    });

    it("tracks keys independently", () => {
      const guard = new FloodGuard(config);
      expect(guard.size).toBe(0);
      guard.record("agent-a", 0);
      const bFirst = guard.record("agent-b", 0);
      expect(guard.size).toBe(2);
      const aSecond = guard.record("agent-a", 0);
      expect(aSecond.count).toBe(2);
      expect(bFirst.count).toBe(1);
    });

    it("drops the oldest bucket at the key ceiling and fails open", () => {
      const guard = new FloodGuard(config, 1);
      guard.record("agent-a", 0);
      guard.record("agent-b", 100);
      expect(guard.size).toBe(1);
      // The evicted actor gets a fresh window rather than a manufactured block.
      const decision = guard.record("agent-a", 200);
      expect(decision.blocked).toBe(false);
      expect(decision.count).toBe(1);
    });
  });

  describe("globToRegExp", () => {
    it("matches a single star as a non-separator run", () => {
      const re = globToRegExp("*.md");
      expect(re.test("notes.md")).toBe(true);
      expect(re.test("a.md")).toBe(true);
      expect(re.test("dir/a.md")).toBe(false);
    });

    it("matches a double star as any directories", () => {
      const re = globToRegExp("**/*.md");
      expect(re.test("a.md")).toBe(true);
      expect(re.test("dir/a.md")).toBe(true);
      expect(re.test("a/b/c.md")).toBe(true);
    });

    it("matches a bare double star as anything", () => {
      const re = globToRegExp("**");
      expect(re.test("anything/at/all.md")).toBe(true);
    });

    it("matches a question mark as one non-separator character", () => {
      const re = globToRegExp("a?c.md");
      expect(re.test("abc.md")).toBe(true);
      expect(re.test("ac.md")).toBe(false);
      expect(re.test("a/c.md")).toBe(false);
    });

    it("escapes regex metacharacters in the pattern", () => {
      expect(globToRegExp("file(1).md").test("file(1).md")).toBe(true);
      expect(globToRegExp("a+b.md").test("a+b.md")).toBe(true);
      expect(globToRegExp("a+b.md").test("axxb.md")).toBe(false);
    });

    it("anchors the pattern at both ends", () => {
      expect(globToRegExp("foo.md").test("prefix/foo.md")).toBe(false);
    });
  });

  describe("characterLimitFor", () => {
    it("falls back to the config default when no glob matches", () => {
      const config: MemoryConstraintsConfig = { version: 1, maxFileCharacters: 1_000 };
      expect(characterLimitFor("notes.md", config)).toEqual({
        limit: 1_000,
        source: "maxFileCharacters",
      });
    });

    it("uses the first matching glob override", () => {
      const config: MemoryConstraintsConfig = {
        version: 1,
        maxFileCharacters: 1_000,
        fileCharacterLimits: [
          { pattern: "*.md", maxCharacters: null },
          { pattern: "notes.md", maxCharacters: 100 },
        ],
      };
      expect(characterLimitFor("notes.md", config)).toEqual({
        limit: null,
        source: "glob '*.md'",
      });
    });

    it("falls through a non-matching override to the default", () => {
      const config: MemoryConstraintsConfig = {
        version: 1,
        maxFileCharacters: 1_000,
        fileCharacterLimits: [{ pattern: "special.md", maxCharacters: 50 }],
      };
      expect(characterLimitFor("notes.md", config).limit).toBe(1_000);
    });
  });

  describe("pathDepth", () => {
    it("counts directory separators", () => {
      expect(pathDepth("a.md")).toBe(0);
      expect(pathDepth("dir/a.md")).toBe(1);
      expect(pathDepth("a/b/c.md")).toBe(2);
    });
  });

  describe("validateMemoryTreeConstraints", () => {
    it("passes a clean, shallow tree", async () => {
      expect(
        await validateMemoryTreeConstraints(
          fakeReader([{ path: "notes.md", content: "short" }]),
          DEFAULT_MEMORY_CONSTRAINTS,
        ),
      ).toEqual([]);
    });

    it("ignores non-Markdown files", async () => {
      expect(
        await validateMemoryTreeConstraints(
          fakeReader([{ path: "deep/nested/image.png", content: "x" }]),
          DEFAULT_MEMORY_CONSTRAINTS,
        ),
      ).toEqual([]);
    });

    it("reports a file deeper than maxDepth", async () => {
      const violations = await validateMemoryTreeConstraints(
        fakeReader([{ path: "a/b/c.md", content: "x" }]),
        { version: 1, maxDepth: 1 },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("depth 2 exceeds maxDepth 1");
    });

    it("rejects a non-regular file", async () => {
      const violations = await validateMemoryTreeConstraints(
        fakeReader([{ path: "link.md", mode: "120000", content: "x" }]),
        DEFAULT_MEMORY_CONSTRAINTS,
      );
      expect(violations[0]?.message).toBe("memory Markdown must be a regular file");
    });

    it("reports a listed file that cannot be read", async () => {
      const violations = await validateMemoryTreeConstraints(
        fakeReader([{ path: "gone.md", content: null }]),
        DEFAULT_MEMORY_CONSTRAINTS,
      );
      expect(violations[0]?.message).toBe("listed memory file is missing");
    });

    it("reports a file over its character limit and names the source", async () => {
      const violations = await validateMemoryTreeConstraints(
        fakeReader([{ path: "big.md", content: "x".repeat(10) }]),
        { version: 1, maxFileCharacters: 5 },
      );
      expect(violations[0]?.message).toBe("10 characters exceeds 5 from maxFileCharacters");
    });

    it("skips the per-file check for a glob override of null", async () => {
      expect(
        await validateMemoryTreeConstraints(
          fakeReader([{ path: "uncapped.md", content: "x".repeat(10) }]),
          {
            version: 1,
            fileCharacterLimits: [{ pattern: "uncapped.md", maxCharacters: null }],
          },
        ),
      ).toEqual([]);
    });

    it("accumulates root-level files against the core-memory cap", async () => {
      const violations = await validateMemoryTreeConstraints(
        fakeReader([
          { path: "one.md", content: "x".repeat(30_000) },
          { path: "two.md", content: "x".repeat(30_000) },
        ]),
        { version: 1, maxCoreMemoryCharacters: 50_000 },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.path).toBe("core memory");
      expect(violations[0]?.message).toContain("exceeds 50000");
    });

    it("uses countCharacters when the reader provides it", async () => {
      const reader = fakeReader([{ path: "counted.md", characters: 99 }], true);
      const violations = await validateMemoryTreeConstraints(reader, {
        version: 1,
        maxFileCharacters: 10,
      });
      expect(violations[0]?.message).toContain("99 characters exceeds 10");
    });
  });
});
