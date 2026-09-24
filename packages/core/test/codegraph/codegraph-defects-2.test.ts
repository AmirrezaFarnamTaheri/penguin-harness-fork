/**
 * Regression tests for the second round of codegraph review defects (9-13).
 *
 * Like the first-round file, each test is written so it fails against the pre-fix behaviour and
 * passes after the fix, and the assertions name the observable symptom (a phantom call site, a
 * type recorded as a parameter name, an amplified signal, a body attributed to the class) rather
 * than restating the implementation.
 */

import { describe, expect, it } from "vitest";

import {
  buildScopes,
  buildWeightedAdjacency,
  computeAllLifecycles,
  extractCallSites,
  extractInstanceTypes,
  extractVariableBindings,
  findScopeForLine,
  resolvePathStyleImport,
  stripCodeExtension,
  SymbolIndex,
  symmetricNormalize,
  TopologyEngine,
} from "../../src/codegraph/index.js";
import { extractFile } from "../../src/codegraph/symbol-extractors/index.js";
import { goExtractor } from "../../src/codegraph/symbol-extractors/go.js";
import { typescriptExtractor } from "../../src/codegraph/symbol-extractors/typescript.js";
import type { ImportRecord } from "../../src/codegraph/types.js";

describe("defect 9 — the line-comment syntax is chosen per language", () => {
  it("does not turn a `//` comment into a TypeScript call site", () => {
    const content = [
      "export function run() {",
      "  // helper() is only mentioned in a comment",
      "  return 1;",
      "}",
    ].join("\n");
    const extraction = extractFile("src/a.ts", content);
    const scopes = buildScopes("src/a.ts", extraction.definitions);
    const sites = extractCallSites(content, scopes, "src/a.ts");

    // Pre-fix every language was stripped with `#`, so the `//` text survived and `helper(` was
    // recorded as a real call site.
    expect(sites.filter((site) => site.callName === "helper")).toHaveLength(0);
  });

  it("still strips `#` comments for Python (guard for the per-language switch)", () => {
    const content = ["def run():", "    # helper() is only a comment", "    return 1", ""].join(
      "\n",
    );
    const extraction = extractFile("src/a.py", content);
    const scopes = buildScopes("src/a.py", extraction.definitions);

    expect(
      extractCallSites(content, scopes, "src/a.py").filter((site) => site.callName === "helper"),
    ).toHaveLength(0);
  });

  it("does not infer an instance type from a `//` comment in TypeScript", () => {
    const content = [
      "export class Service {",
      "  run() {",
      "    // this.loader: Loader",
      "  }",
      "}",
    ].join("\n");
    const extraction = extractFile("src/a.ts", content);
    const scopes = buildScopes("src/a.ts", extraction.definitions);
    const types = extractInstanceTypes(content, scopes, "src/a.ts");

    // Pre-fix the comment text was live, so `this.loader: Loader` was parsed as a type hint.
    expect(Object.values(types).some((vars) => "loader" in vars)).toBe(false);
  });

  it("does not create a phantom variable binding from a `//` comment in TypeScript", () => {
    const content = ["export function run() {", "  // value = helper()", "  return 1;", "}"].join(
      "\n",
    );
    const extraction = extractFile("src/a.ts", content);
    const scopes = buildScopes("src/a.ts", extraction.definitions);
    const bindings = extractVariableBindings(content, scopes, "src/a.ts");

    // Pre-fix the comment's `value = helper()` was scanned as a real assignment.
    expect(bindings.filter((binding) => binding.name === "value")).toHaveLength(0);
  });
});

describe("defect 10 — Go parameters record the name, not the type", () => {
  const goFunction = (params: string) =>
    goExtractor.extract(
      "src/f.go",
      `package main\n\nfunc helper(${params}) int {\n\treturn 0\n}\n`,
    );

  it("records the name for Go's `name Type` parameter syntax", () => {
    // Pre-fix the LAST token was taken, recording the types `int`/`string`.
    expect(goFunction("value int, name string").definitions[0]?.parameters).toEqual([
      "value",
      "name",
    ]);
  });

  it("records the name of a variadic parameter", () => {
    expect(goFunction("nums ...int").definitions[0]?.parameters).toEqual(["nums"]);
  });

  it("records the name of a grouped and a pointer parameter", () => {
    expect(goFunction("ctx context.Context, l *Loader").definitions[0]?.parameters).toEqual([
      "ctx",
      "l",
    ]);
  });

  it("drops unnamed parameters instead of recording their type as a name", () => {
    expect(goFunction("int, string").definitions[0]?.parameters).toEqual([]);
  });

  it("seeds a Go parameter as a definition for def-use tracking", () => {
    const content = [
      "package main",
      "",
      "func bump(counter int) int {",
      "\tcounter = counter + 1",
      "\treturn counter",
      "}",
    ].join("\n");
    const extraction = extractFile("src/bump.go", content);
    const scopes = buildScopes("src/bump.go", extraction.definitions);
    const lifecycles = computeAllLifecycles(
      extractVariableBindings(content, scopes, "src/bump.go"),
    );
    const counter = lifecycles.find((cycle) => cycle.name === "counter");

    // Pre-fix the parameter was recorded as `int`, so `counter` looked like a local defined on the
    // assignment line rather than a parameter declared on the signature.
    expect(counter?.kind).toBe("parameter");
    expect(counter?.definedAt).toBe(3);
  });
});

describe("defect 11 — symmetricNormalize accumulates edge weight into the degree", () => {
  it("keeps a repeated edge's row energy-preserving (row sums to 1)", () => {
    const adj = buildWeightedAdjacency([
      { source: "a", target: "b" },
      { source: "a", target: "b" }, // parallel edge -> weight 2
    ]);
    const normalized = symmetricNormalize(adj);
    const rowSum = [...(normalized.get("a")?.values() ?? [])].reduce((x, y) => x + y, 0);

    // Pre-fix the degree counted parallel edges as 1 each while the weight was 2, so D^-1/2 A D^-1/2
    // amplified the signal instead of preserving it: the row summed to 1.5, not 1.
    expect(rowSum).toBeCloseTo(1, 10);
    expect(normalized.get("a")?.get("b")).toBeCloseTo(2 / 3, 10);
  });

  it("leaves the single-edge unweighted case unchanged", () => {
    const adj = buildWeightedAdjacency([{ source: "a", target: "b" }]);
    const normalized = symmetricNormalize(adj);
    // degree 2 on both sides (self-loop + one weight-1 edge) -> a->b weight 1 * 1/sqrt(2) * 1/sqrt(2)
    expect(normalized.get("a")?.get("b")).toBeCloseTo(0.5, 10);
    expect(normalized.get("b")?.get("b")).toBeCloseTo(0.5, 10);
  });
});

describe("defect 12 — TypeScript method bodies get their brace ranges resolved", () => {
  const CODE = [
    "export class Service {",
    "  constructor(private loader: Loader) {}",
    "  async run(): Promise<void> {",
    "    for (let i = 0; i < 3; i++) {",
    "      if (this.loader.ready()) {",
    "        await this.loader.load();",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");

  it("resolves a multi-line method's end line past its declaration", () => {
    const run = typescriptExtractor
      .extract("src/service.ts", CODE)
      .definitions.find((def) => def.name === "run");
    // Pre-fix methods were collected AFTER resolveBraceDelimitedRanges ran, so a multi-line method
    // ended on its own declaration line (3).
    expect(run?.endLine).toBe(9);
  });

  it("attributes a call inside a method body to the method scope, not the class", () => {
    const result = typescriptExtractor.extract("src/service.ts", CODE);
    const scopes = buildScopes("src/service.ts", result.definitions);
    const scope = findScopeForLine(scopes, 6); // `await this.loader.load();`

    expect(scope?.id).toBe("method::Service.run");
  });
});

describe("defect 13 — import resolution picks the module-correct symbol", () => {
  const HELPER = 'def load():\n    return "helper"\n';
  // A same-named global in a sibling module: without module-correct resolution this one wins
  // because it is registered first and byName returns the first bucket entry.
  const OTHER = 'def load():\n    return "other"\n';

  const buildPython = (mainBody: string): TopologyEngine => {
    const engine = new TopologyEngine("");
    engine.build([
      { path: "pkg/other.py", content: OTHER },
      { path: "pkg/helper.py", content: HELPER },
      { path: "pkg/main.py", content: mainBody },
    ]);
    return engine;
  };

  it("resolves a Python relative import against the real repo root", () => {
    const engine = buildPython("from .helper import load\n\n\ndef run():\n    return load()\n");
    // Pre-fix the current file's own directory was used as the repo root, collapsing
    // `pkg/main.py` to module `main` so the target resolved to `helper` instead of `pkg.helper`.
    expect(engine.resolveSymbol("load", "pkg/main.py")).toBe("pkg/helper.py::load");
  });

  it("resolves an imported symbol through its alias", () => {
    const engine = buildPython(
      "from .helper import load as fetch\n\n\ndef run():\n    return fetch()\n",
    );
    // Pre-fix the `as` spelling was discarded by the name split and the alias was never recorded,
    // so `fetch` fell all the way through to an undefined resolution.
    expect(engine.resolveSymbol("fetch", "pkg/main.py")).toBe("pkg/helper.py::load");
  });

  it("builds a calls edge to the imported symbol, not the same-name global", () => {
    const engine = buildPython("from .helper import load\n\n\ndef run():\n    return load()\n");
    const calls = engine
      .snapshot()
      .edges.filter((edge) => edge.kind === "calls" && edge.callName === "load");
    expect(calls.map((edge) => edge.target)).toContain("pkg/helper.py::load");
    expect(calls.map((edge) => edge.target)).not.toContain("pkg/other.py::load");
  });

  it("resolves a `./`-style relative import to a file keyed extension-stripped", () => {
    const engine = new TopologyEngine("src");
    engine.build([
      { path: "src/loader.ts", content: "export function load(): void {}\n" },
      {
        path: "src/index.ts",
        content:
          "import { load } from './loader';\nexport function start() {\n  return load();\n}\n",
      },
    ]);
    // `resolvePathStyleImport` and the `byFile` index must reduce to one canonical key form.
    expect(resolvePathStyleImport("src/index.ts", "./loader")).toBe("src/loader");
    expect(stripCodeExtension("src/loader.ts")).toBe("src/loader");
    expect(engine.resolveSymbol("load", "src/index.ts")).toBe("src/loader.ts::load");
  });

  it("matches a relative import spelled with its extension", () => {
    const engine = new TopologyEngine("src");
    engine.build([
      { path: "src/loader.ts", content: "export function load(): void {}\n" },
      {
        path: "src/index.ts",
        content:
          "import { load } from './loader.js';\nexport function start() {\n  return load();\n}\n",
      },
    ]);
    expect(engine.resolveSymbol("load", "src/index.ts")).toBe("src/loader.ts::load");
  });

  it("resolves an aliased TypeScript named import through the alias map", () => {
    const engine = new TopologyEngine("src");
    engine.build([
      { path: "src/loader.ts", content: "export function load(): void {}\n" },
      {
        path: "src/index.ts",
        content:
          "import { load as fetch } from './loader';\nexport function start() {\n  return fetch();\n}\n",
      },
    ]);
    expect(engine.resolveSymbol("fetch", "src/index.ts")).toBe("src/loader.ts::load");
  });

  it("exposes the alias on the import record for a single renamed name", () => {
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
    const imports: ImportRecord[] = [
      { module: "./b", names: ["b"], alias: "bee", level: 0, line: 1 },
    ];

    // The single-alias spelling stays resolvable through the legacy `alias` field.
    expect(index.resolveImported("bee", imports, "src/a.ts")).toBe("src/b.ts::b");
  });
});

describe("defect 14 — the import path-suffix fallback must not bind a deeper import to a shallower module", () => {
  // A hand-built index, so the two modules differ only in depth.
  const register = (index: SymbolIndex, file: string, name: string, repoRoot = "") => {
    index.registerFile(
      file,
      [
        {
          id: `${file}::${name}`,
          name,
          kind: "function",
          filePath: file,
          startLine: 1,
          endLine: 1,
          startColumn: 1,
          qualifiedName: name,
          isExported: true,
        },
      ],
      repoRoot,
    );
  };

  it("leaves an import unresolved when it names a path the indexed module does not lie on", () => {
    const index = new SymbolIndex();
    register(index, "b.ts", "thing");
    register(index, "pkg/mod.ts", "thing");
    const imports: ImportRecord[] = [{ module: "a/b", names: ["thing"], level: 0, line: 1 }];

    // `a/b` does not name the root module `b`; resolving it would emit an edge to a symbol the
    // import never mentioned. The old fallback matched any module whose path was a *tail* of the
    // import, in either direction.
    expect(index.resolveImported("thing", imports, "root.ts")).toBeUndefined();
  });

  it("still resolves by path tail when the import cannot know the module's full path", () => {
    const index = new SymbolIndex();
    // A file indexed under its full path because it sits outside the repo root.
    register(index, "/abs/other/pkg/mod.ts", "thing", "/abs/repo");

    // The import spells only the tail, so the deeper indexed path has to accept it — in both
    // spellings, a bare segment and a two-segment tail.
    expect(
      index.resolveImported(
        "thing",
        [{ module: "mod", names: ["thing"], level: 0, line: 1 }],
        "/abs/repo/root.ts",
      ),
    ).toBe("/abs/other/pkg/mod.ts::thing");
    expect(
      index.resolveImported(
        "thing",
        [{ module: "pkg/mod", names: ["thing"], level: 0, line: 1 }],
        "/abs/repo/root.ts",
      ),
    ).toBe("/abs/other/pkg/mod.ts::thing");
  });
});
