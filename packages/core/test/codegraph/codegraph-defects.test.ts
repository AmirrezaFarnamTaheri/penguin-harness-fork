/**
 * Regression tests for the eight code-graph correctness defects from the Track-3 review.
 *
 * Each test is written so it fails against the pre-fix behaviour and passes after the fix; the
 * assertions name the exact symptom the defect produced (a dropped citation, a missing dependent,
 * a cross-file finding) rather than restating the implementation.
 */

import { describe, expect, it } from "vitest";

import { IncrementalGraphCache } from "../../src/codegraph/incremental-graph-cache.js";
import {
  SymbolIndex,
  TopologyEngine,
  buildScopes,
  computeAllLifecycles,
  extractVariableBindings,
  extractSideLines,
  normalizeLine,
  parseCitations,
  parseDiffText,
  parseHunks,
  validateCitations,
} from "../../src/codegraph/index.js";
import { extractFile } from "../../src/codegraph/symbol-extractors/index.js";
import type { ImportRecord } from "../../src/codegraph/types.js";

describe("defect 1 — incremental invalidation uses one canonical key", () => {
  it("finds dependents of an imported file (reverse-import lookup was extension-stripped)", () => {
    const cache = new IncrementalGraphCache("src");
    // Register the *target* first so the importer's link actually resolves, isolating this defect
    // from cold-build ordering (defect 2).
    cache.update("src/b.ts", "export const b = 1;\n");
    cache.update("src/a.ts", "import { b } from './b';\nexport const a = b;\n");

    // Pre-fix: reverseImports held the full path "src/b.ts" but dependentsOf looked up "src/b".
    expect(cache.dependentsOf("src/b.ts")).toContain("src/a.ts");
  });

  it("walks the reverse-import closure transitively", () => {
    const cache = new IncrementalGraphCache("src");
    cache.update("src/base.ts", "export const base = 0;\n");
    cache.update("src/mid.ts", "import { base } from './base';\nexport const mid = base;\n");
    cache.update("src/leaf.ts", "import { mid } from './mid';\nexport const leaf = mid;\n");

    expect(cache.dependentsOf("src/base.ts").sort()).toEqual(["src/leaf.ts", "src/mid.ts"]);
  });
});

describe("defect 2 — cold build must not depend on file order", () => {
  it("resolves an import of a file added later (importer registered first)", () => {
    const engine = new TopologyEngine("src");
    engine.build([
      {
        path: "src/a.ts",
        content: "import { b } from './b';\nexport function useB() {\n  return b();\n}\n",
      },
      { path: "src/b.ts", content: "export function b() {\n  return 1;\n}\n" },
    ]);

    const imports = engine.snapshot().edges.filter((edge) => edge.kind === "imports");

    // Pre-fix: `build()` called updateFile() sequentially, so a.ts never saw b.ts in the index and
    // no a.ts -> b.ts import edge was ever built.
    expect(imports).toContainEqual({ source: "src/a.ts", target: "src/b.ts", kind: "imports" });
  });

  it("produces the same import edges regardless of registration order", () => {
    const files = [
      { path: "src/a.ts", content: "import { b } from './b';\nexport const a = 1;\n" },
      { path: "src/b.ts", content: "import { c } from './c';\nexport const b = 2;\n" },
      { path: "src/c.ts", content: "export const c = 3;\n" },
    ];
    const forward = new TopologyEngine("src");
    forward.build(files);
    const reverse = new TopologyEngine("src");
    reverse.build([...files].reverse());

    const sorted = (engine: TopologyEngine) =>
      engine
        .snapshot()
        .edges.filter((edge) => edge.kind === "imports")
        .map((edge) => `${edge.source}->${edge.target}`)
        .sort();
    expect(sorted(reverse)).toEqual(sorted(forward));
  });
});

describe("defect 3 — relative-import resolution must match the byFile key", () => {
  it("resolves a `./`-import to a file indexed under its full name", () => {
    const index = new SymbolIndex();
    index.registerFile(
      "src/b.ts",
      [
        {
          id: "src/b.ts::b",
          name: "b",
          kind: "function",
          filePath: "src/b.ts",
          startLine: 1,
          endLine: 1,
          startColumn: 1,
          qualifiedName: "b",
          isExported: true,
        },
      ],
      "src",
    );
    const imports: ImportRecord[] = [{ module: "./b", names: ["b"], level: 0, line: 1 }];

    // resolveImported (not resolveSymbol) to stay inside the relative-import branch: resolveSymbol
    // would mask the miss with its global same-name fallback.
    expect(index.resolveImported("b", imports, "src/a.ts")).toBe("src/b.ts::b");
  });
});

describe("defect 4 — citation range parsing keeps the end line", () => {
  it("parses `foo.ts:10-20` into a real two-part range", () => {
    const citations = parseCitations("src/foo.ts:10-20");
    // Pre-fix: `split("-", 1)` returned only "10", so `end` was undefined and the whole citation
    // was silently dropped.
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ path: "src/foo.ts", startLine: 10, endLine: 20 });
  });

  it("still parses a single-line citation", () => {
    expect(parseCitations("src/foo.ts:42")).toMatchObject([
      { path: "src/foo.ts", startLine: 42, endLine: 42 },
    ]);
  });
});

describe("defect 5 — citation validation requires the range to be substantially visible", () => {
  const diff = [
    "diff --git a/foo.ts b/foo.ts",
    "index 0000000..1111111 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -8,3 +10,3 @@",
    " context",
    "-old",
    "+new",
    " more",
  ].join("\n");

  it("accepts a range fully inside the hunk", () => {
    const diffs = parseDiffText(diff);
    const valid = validateCitations(
      [{ path: "foo.ts", side: "unified", startLine: 10, endLine: 12 }],
      diffs,
    );
    expect(valid).toHaveLength(1);
  });

  it("rejects a range that merely grazes the hunk", () => {
    const diffs = parseDiffText(diff);
    // Pre-fix: one visible line inside [10, 10000] was enough to certify all 9991 lines.
    const invalid = validateCitations(
      [{ path: "foo.ts", side: "unified", startLine: 10, endLine: 10000 }],
      diffs,
    );
    expect(invalid).toHaveLength(0);
  });
});

describe("defect 6 — normalizeLine must not strip a diff marker twice", () => {
  it("keeps real source whose first character is a diff marker", () => {
    expect(normalizeLine("++i;")).toBe("++i;");
    expect(normalizeLine("--remaining;")).toBe("--remaining;");
  });

  it("preserves `++i` in the extracted side lines of a hunk", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-int i = 0;", "+    ++i;"].join("\n");
    const hunks = parseHunks(patch);
    // The observable damage: parseHunks had already removed the diff marker, so a second strip in
    // normalizeLine turned the real source `++i;` into `+i;`. (An excerpt search is *not* a good
    // witness here: the excerpt goes through the same buggy trim, so both sides corrupt equally and
    // still match each other.)
    expect(extractSideLines(hunks[0]!, true).map((line) => line.content)).toContain("++i;");
  });
});

describe("defect 7 — symbol statistics must not leak across files", () => {
  // A 46-line function starting at line 20 — enough to trip `a-long-method` (>40 lines) — and a
  // second file whose diff touches exactly line 20.
  const aLines: string[] = [];
  for (let i = 1; i <= 19; i += 1) aLines.push(`// filler ${i}`);
  aLines.push("export function big() {");
  for (let i = 0; i < 45; i += 1) aLines.push("  let value = 0;");
  aLines.push("}");
  const FILE_A = aLines.join("\n");
  const FILE_B = Array.from({ length: 25 }, (_, i) => `// b filler ${i + 1}`).join("\n");

  const addedLine = 20;
  const diffFor = (path: string): string =>
    [
      `diff --git a/${path} b/${path}`,
      "index 0000000..1111111 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,1 +20,1 @@`,
      "-old",
      "+new",
    ].join("\n");

  const buildEngine = (): TopologyEngine => {
    const engine = new TopologyEngine("src");
    engine.build([
      { path: "src/a.ts", content: FILE_A },
      { path: "src/b.ts", content: FILE_B },
    ]);
    return engine;
  };

  it("does not emit a finding for a symbol in another file (pre-fix cross-file overlap)", () => {
    const issues = buildEngine().reviewDiff(diffFor("src/b.ts"));
    // `big` lives in src/a.ts; its [20,66] range overlaps src/b.ts's hunk at line 20 numerically
    // only. Pre-fix SymbolReviewStats carried no filePath, so the finding fired against src/b.ts.
    expect(issues.filter((issue) => issue.ruleId === "a-long-method")).toHaveLength(0);
  });

  it("still fires the same rule for a symbol in the diff's own file", () => {
    const issues = buildEngine().reviewDiff(diffFor("src/a.ts"));
    expect(issues.filter((issue) => issue.ruleId === "a-long-method")).toHaveLength(1);
  });
});

describe("defect 8 — variable lifecycle records RHS reads and parameters", () => {
  const run = (content: string) => {
    const extraction = extractFile("src/f.ts", content);
    const scopes = buildScopes("src/f.ts", extraction.definitions);
    return computeAllLifecycles(extractVariableBindings(content, scopes, "src/f.ts"));
  };

  it("records the right-hand-side read of an assigned variable", () => {
    const content = [
      "export function bump(total: number) {",
      "  total = total + 1;",
      "  return total;",
      "}",
    ].join("\n");
    const total = run(content).find((cycle) => cycle.name === "total");
    expect(total).toBeDefined();
    // Pre-fix the assignment branch `continue`d before the use scan, so `total = total + 1` never
    // recorded the RHS read on line 2.
    expect(total!.usedAt).toContain(2);
    expect(total!.usedAt).toContain(3);
  });

  it("seeds parameters as definitions on the signature line", () => {
    const content = [
      "export function scale(value: number, factor: number) {",
      "  const result = value * factor;",
      "  return result;",
      "}",
    ].join("\n");
    const lifecycles = run(content);
    const value = lifecycles.find((cycle) => cycle.name === "value");
    const result = lifecycles.find((cycle) => cycle.name === "result");

    expect(value?.kind).toBe("parameter");
    expect(value?.definedAt).toBe(1);
    expect(value?.usedAt).toContain(2);
    expect(result?.kind).toBe("local");
    expect(result?.definedAt).toBe(2);
  });

  it("treats a reassigned parameter as a parameter, not a local", () => {
    const content = [
      "export function tick(counter: number) {",
      "  counter = counter + 1;",
      "  return counter;",
      "}",
    ].join("\n");
    const counter = run(content).find((cycle) => cycle.name === "counter");
    expect(counter?.kind).toBe("parameter");
    expect(counter?.definedAt).toBe(1);
    expect(counter?.reassignedAt).toEqual([2]);
  });
});
