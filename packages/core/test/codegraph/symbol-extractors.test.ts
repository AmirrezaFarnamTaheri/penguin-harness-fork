import { describe, expect, it } from "vitest";

import { computeCyclomaticComplexity } from "../../src/codegraph/symbol-extractors/complexity.js";
import {
  detectLanguage,
  stripLiteralsAndComments,
} from "../../src/codegraph/symbol-extractors/language-detect.js";
import { extractFile } from "../../src/codegraph/symbol-extractors/index.js";
import { pythonExtractor } from "../../src/codegraph/symbol-extractors/python.js";
import { rustExtractor } from "../../src/codegraph/symbol-extractors/rust.js";
import { goExtractor } from "../../src/codegraph/symbol-extractors/go.js";
import { typescriptExtractor } from "../../src/codegraph/symbol-extractors/typescript.js";

const TS_CODE = `import { Loader } from "./loader.js";
import type { Config } from "./config.js";

export interface ServiceOptions {
  retries: number;
}

export type Mode = "sync" | "async";

@injectable
export class Service extends Base implements Runnable {
  constructor(private loader: Loader) {}
  async run(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if (this.loader.ready() && i > 0) {
        await this.loader.load();
      }
    }
  }
}

export function helper(value: number): number {
  return value * 2;
}

export const compute = (n: number) => n + 1;
`;

const PY_CODE = `from pathlib import Path
import os


class Service(BaseService):
    def __init__(self, loader: Loader):
        self.loader = loader

    async def run(self) -> None:
        for i in range(3):
            if self.loader.ready() and i > 0:
                self.loader.load()


def helper(value):
    return value * 2
`;

const RS_CODE = `use std::path::Path;

pub struct Service {
    loader: Loader,
}

pub trait Runnable {
    fn run(&self);
}

impl Runnable for Service {
    fn run(&self) {
        if self.loader.ready() {
            self.loader.load();
        }
    }
}

pub fn helper(value: i32) -> i32 {
    value * 2
}
`;

const GO_CODE = `package main

import (
\t"fmt"
\t"os"
)

type Service struct {
\tloader *Loader
}

type Runnable interface {
\tRun()
}

func (s *Service) Run() {
\tif s.loader.ready() {
\t\ts.loader.load()
\t}
}

func helper(value int) int {
\treturn value * 2
}
`;

describe("symbol-extractors", () => {
  it("detects languages from extensions", () => {
    expect(detectLanguage("src/a.ts")).toBe("typescript");
    expect(detectLanguage("src/a.tsx")).toBe("typescript");
    expect(detectLanguage("src/a.js")).toBe("javascript");
    expect(detectLanguage("src/a.py")).toBe("python");
    expect(detectLanguage("src/a.go")).toBe("go");
    expect(detectLanguage("src/a.rs")).toBe("rust");
    expect(detectLanguage("src/a.cpp")).toBe("cpp");
    expect(detectLanguage("README.md")).toBe("unknown");
  });

  it("strips literals and comments without touching keywords inside strings", () => {
    expect(stripLiteralsAndComments('const x = "if for while"; // if')).toBe("const x = ;");
    // Removing a trailing comment swallows the whitespace that preceded it.
    expect(stripLiteralsAndComments("x = 1; // note")).toBe("x = 1;");
    // A literal at end of line leaves the preceding code, trimmed of trailing space.
    expect(stripLiteralsAndComments("const y = 'a'")).toBe("const y =");
    // A hash line comment (Python) is honoured via the option.
    expect(stripLiteralsAndComments("x = 1  # note", { lineComment: "#" })).toBe("x = 1");
    // Escaped quotes do not terminate a string literal.
    expect(stripLiteralsAndComments('const s = "a\\"b"; // c')).toBe("const s = ;");
  });

  it("extracts TypeScript symbols with ranges, bases, params and decorators", () => {
    const result = typescriptExtractor.extract("src/service.ts", TS_CODE);
    const byName = new Map(result.definitions.map((def) => [def.name, def]));

    expect(result.language).toBe("typescript");
    expect(byName.get("Service")?.kind).toBe("class");
    expect(byName.get("Service")?.bases).toContain("Base");
    expect(byName.get("Service")?.decorators).toContain("injectable");
    expect(byName.get("ServiceOptions")?.kind).toBe("interface");
    expect(byName.get("Mode")?.kind).toBe("type");
    expect(byName.get("helper")?.kind).toBe("function");
    expect(byName.get("helper")?.parameters).toEqual(["value: number"]);
    expect(byName.get("compute")?.kind).toBe("function");
    expect(result.definitions.find((def) => def.name === "run")?.className).toBe("Service");
    expect(result.definitions.find((def) => def.name === "run")?.isAsync).toBe(true);
    expect(result.exports).toContain("Service");
    expect(result.imports.map((imp) => imp.module)).toEqual(["./loader.js", "./config.js"]);
    expect(result.linesOfCode).toBeGreaterThan(10);
  });

  it("extracts Python symbols with inheritance and method attribution", () => {
    const result = pythonExtractor.extract("src/service.py", PY_CODE);
    const cls = result.definitions.find((def) => def.name === "Service");
    const method = result.definitions.find((def) => def.name === "run");

    expect(cls?.kind).toBe("class");
    expect(cls?.bases).toEqual(["BaseService"]);
    expect(method?.kind).toBe("method");
    expect(method?.className).toBe("Service");
    expect(method?.isAsync).toBe(true);
    expect(result.definitions.find((def) => def.name === "helper")?.kind).toBe("function");
    // Relative import level arithmetic.
    expect(result.imports.find((imp) => imp.module === "pathlib")).toEqual({
      module: "pathlib",
      names: ["Path"],
      alias: undefined,
      level: 0,
      line: 1,
    });
  });

  it("extracts Rust symbols with trait/impl attribution", () => {
    const result = rustExtractor.extract("src/service.rs", RS_CODE);
    expect(result.definitions.find((def) => def.name === "Service")?.kind).toBe("struct");
    expect(result.definitions.find((def) => def.name === "Runnable")?.kind).toBe("trait");
    expect(result.definitions.find((def) => def.name === "helper")?.kind).toBe("function");
    expect(result.imports[0]!.module).toContain("std::path::Path");

    // A trait signature `fn` and its impl `fn` share a name; both must be reported, each
    // attributed to its own enclosing type. `find` alone would always hit the trait first.
    const runs = result.definitions.filter((def) => def.name === "run");
    expect(runs).toHaveLength(2);

    const traitRun = runs.find((def) => def.className === "Runnable");
    const implRun = runs.find((def) => def.className === "Service");
    expect(traitRun).toBeDefined();
    expect(implRun).toBeDefined();
    expect(traitRun?.kind).toBe("method");
    expect(implRun?.kind).toBe("method");
    expect(traitRun?.startLine).toBe(8);
    expect(implRun?.startLine).toBe(12);
    // The impl `fn` owns a brace-delimited body: header at 12, closing brace at 16
    // (the enclosing impl block itself runs on to 17).
    expect(implRun?.endLine).toBe(16);
    expect(implRun?.parameters).toEqual([]);
  });

  it("extracts Go symbols with receiver attribution", () => {
    const result = goExtractor.extract("src/service.go", GO_CODE);
    expect(result.definitions.find((def) => def.name === "Service")?.kind).toBe("struct");
    expect(result.definitions.find((def) => def.name === "Runnable")?.kind).toBe("interface");
    expect(result.definitions.find((def) => def.name === "Run")?.className).toBe("Service");
    expect(result.definitions.find((def) => def.name === "Run")?.kind).toBe("method");
    expect(result.definitions.find((def) => def.name === "helper")?.kind).toBe("function");
    expect(result.imports.map((imp) => imp.module)).toEqual(["fmt", "os"]);
  });

  it("dispatches through the registry and no-ops unknown languages", () => {
    expect(extractFile("src/a.ts", TS_CODE).definitions.length).toBeGreaterThan(3);
    expect(extractFile("README.md", "# hello").definitions).toEqual([]);
  });

  it("computes cyclomatic complexity from decision points", () => {
    const tsComplexity = computeCyclomaticComplexity(
      "if (a) { for (;;) {} while (x) {} }",
      1,
      1,
      "typescript",
    );
    // 1 base + if + for + while = 4
    expect(tsComplexity).toBe(4);

    const pyComplexity = computeCyclomaticComplexity(
      "if a:\n  for b in c:\n    while d:\n      pass",
      1,
      4,
      "python",
    );
    // 1 base + if + for + while = 4
    expect(pyComplexity).toBe(4);
  });
});
