import { describe, expect, it, vi } from "vitest";
import {
  anonymousFqn,
  constructorFqn,
  entityIdOf,
  fileScope,
  fqnOf,
  isWithinScope,
  memberFqn,
  normalizeFqnPath,
  parseEntityId,
} from "../../src/codegraph/ast/fqn.js";
import { clampWeight } from "../../src/codegraph/ast/ir.js";
import { ParserPool, editDelta, pointAt } from "../../src/codegraph/ast/parser-pool.js";

describe("FQN scheme (filePath::Name, pkg.Name)", () => {
  it("uses the package when one exists, else the file path", () => {
    expect(fileScope({ filePath: "src/A.java", packageName: "com.acme" })).toBe("com.acme");
    expect(fileScope({ filePath: "src\\app\\util.ts" })).toBe("src/app/util.ts");
    expect(fqnOf({ filePath: "src/util.ts" }, "helper")).toBe("src/util.ts::helper");
    expect(fqnOf({ filePath: "A.java", packageName: "com.acme" }, "Widget")).toBe(
      "com.acme.Widget",
    );
  });

  it("keeps members, constructors and anonymous functions unambiguous", () => {
    const type = fqnOf({ filePath: "src/model.ts" }, "User");
    expect(memberFqn(type, "save")).toBe("src/model.ts::User.save");
    expect(constructorFqn(type)).toBe("src/model.ts::User.<init>");
    expect(anonymousFqn({ filePath: "src/model.ts" }, 42)).toBe("src/model.ts::<anonymous>@42");
  });

  it("round-trips entity ids through the single id builder", () => {
    const id = entityIdOf("method", "src/model.ts::User.save");
    expect(parseEntityId(id)).toEqual({ kind: "method", fqn: "src/model.ts::User.save" });
    expect(parseEntityId("malformed")).toBeNull();
    expect(parseEntityId("kind:")).toBeNull();
  });

  it("normalizes Windows separators and contains paths without escaping", () => {
    expect(normalizeFqnPath("a\\b\\c.ts")).toBe("a/b/c.ts");
    expect(isWithinScope("src", "src/app.ts")).toBe(true);
    expect(isWithinScope("src", "src")).toBe(true);
    expect(isWithinScope("src", "src-other/app.ts")).toBe(false);
    expect(isWithinScope("src", "../secret.ts")).toBe(false);
  });

  it("clamps edge weights into 1..10", () => {
    expect(clampWeight(0)).toBe(1);
    expect(clampWeight(5.4)).toBe(5);
    expect(clampWeight(99)).toBe(10);
  });
});

describe("incremental edit deltas", () => {
  it("computes points across lines for a pure insertion", () => {
    const oldText = "line one\nline two\n";
    const delta = editDelta(oldText, 9, 9, "inserted ");
    expect(delta.startIndex).toBe(9);
    expect(delta.oldEndIndex).toBe(9);
    expect(delta.newEndIndex).toBe(18);
    expect(delta.startPosition).toEqual({ row: 1, column: 0 });
    expect(delta.oldEndPosition).toEqual({ row: 1, column: 0 });
    expect(delta.newEndPosition).toEqual({ row: 1, column: 9 });
  });

  it("measures the new end in the NEW text for a multi-line replacement", () => {
    const oldText = "aaa\nbbb\nccc";
    // Replace "bbb" (offsets 4..7) with "x\ny\nz".
    const delta = editDelta(oldText, 4, 7, "x\ny\nz");
    expect(delta.startPosition).toEqual({ row: 1, column: 0 });
    expect(delta.oldEndPosition).toEqual({ row: 1, column: 3 });
    // New text is "aaa\nx\ny\nz\nccc": the end of the replacement sits at row 3, column 1.
    expect(delta.newEndIndex).toBe(4 + 5);
    expect(delta.newEndPosition).toEqual({ row: 3, column: 1 });
  });

  it("handles deletions and clamps out-of-range offsets", () => {
    const oldText = "hello world";
    const delta = editDelta(oldText, 5, 11, "");
    expect(delta.newEndIndex).toBe(5);
    expect(delta.newEndPosition).toEqual({ row: 0, column: 5 });
    expect(pointAt(oldText, 999)).toEqual({ row: 0, column: 11 });
    expect(pointAt(oldText, -5)).toEqual({ row: 0, column: 0 });
  });
});

describe("ParserPool without grammars (fallback tier)", () => {
  it("reports fallback and never throws when web-tree-sitter is absent", async () => {
    const pool = new ParserPool();
    await expect(pool.engineFor("typescript")).resolves.toBe("fallback");
    await expect(pool.parse("a.ts", "typescript", "const x = 1;")).resolves.toBeNull();
    expect(pool.stats().tier).toBe("fallback");
  });

  it("keeps a bounded LRU cache with a byte budget", () => {
    const pool = new ParserPool({ maxCachedTrees: 2, maxCachedBytes: 10_000 });
    const handle = (n: number) => ({ language: "typescript", tree: { n }, sourceLength: n });
    pool.storeTree("a.ts", handle(1), 100);
    pool.storeTree("b.ts", handle(2), 100);
    expect(pool.cached("a.ts")).not.toBeNull();
    // Touch a.ts so b.ts is the cold entry when c.ts pushes over the size bound.
    pool.cached("a.ts");
    pool.storeTree("c.ts", handle(3), 100);
    expect(pool.cached("b.ts")).toBeNull();
    expect(pool.cached("a.ts")).not.toBeNull();
    expect(pool.cached("c.ts")).not.toBeNull();
  });

  it("evicts to the byte budget and supports explicit eviction", () => {
    const pool = new ParserPool({ maxCachedTrees: 100, maxCachedBytes: 250 });
    pool.storeTree("a.ts", { language: "typescript", tree: {}, sourceLength: 100 }, 100);
    pool.storeTree("b.ts", { language: "typescript", tree: {}, sourceLength: 100 }, 100);
    pool.storeTree("c.ts", { language: "typescript", tree: {}, sourceLength: 100 }, 100);
    expect(pool.stats().cachedBytes).toBeLessThanOrEqual(250);
    pool.evict("c.ts");
    expect(pool.cached("c.ts")).toBeNull();
  });
});

describe("ParserPool incremental tree selection", () => {
  it("edits the cached tree when edits are supplied and parses from scratch without edits", async () => {
    const pool = new ParserPool();
    const previousTree = { edit: vi.fn() };
    const parse = vi.fn((text: string, oldTree?: unknown) => ({ text, oldTree }));
    class TestParser {
      static init = vi.fn(async () => undefined);
      setLanguage = vi.fn();
      parse = parse;
    }
    const module = {
      Parser: TestParser,
      Language: { load: vi.fn(async () => ({ language: "typescript" })) },
    };
    const internals = pool as unknown as {
      module: typeof module | null;
      initPromise: Promise<void> | null;
      languages: Map<string, unknown>;
    };
    internals.module = module;
    internals.initPromise = Promise.resolve();
    internals.languages.set("typescript", { language: "typescript" });
    pool.storeTree("src/a.ts", { language: "typescript", tree: previousTree, sourceLength: 3 }, 3);

    const delta = editDelta("old", 0, 3, "new");
    await pool.parse("src/a.ts", "typescript", "new", [delta]);
    expect(previousTree.edit).toHaveBeenCalledWith(delta);
    expect(parse).toHaveBeenLastCalledWith("new", previousTree);

    parse.mockClear();
    await pool.parse("src/a.ts", "typescript", "replacement");
    expect(previousTree.edit).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]).toHaveLength(1);
  });
});
