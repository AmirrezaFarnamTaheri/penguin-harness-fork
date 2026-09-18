import { describe, expect, it } from "vitest";

import {
  buildScopes,
  buildSymbolId,
  findScopeForLine,
  resolveBraceDelimitedRanges,
  resolveIndentationRanges,
  type RawDefinition,
} from "../../src/codegraph/scope-tracker.js";

const TS_CODE = [
  "export class Service {",
  "  constructor(private loader: Loader) {}",
  "  run() {",
  "    if (this.loader.ready()) {",
  "      this.loader.load();",
  "    }",
  "  }",
  "}",
  "",
  "export function helper(value: number): number {",
  "  return value * 2;",
  "}",
].join("\n");

const PY_CODE = [
  "class Service:",
  "    def __init__(self, loader):",
  "        self.loader = loader",
  "",
  "    def run(self):",
  "        if self.loader.ready():",
  "            self.loader.load()",
  "",
  "def helper(value):",
  "    return value * 2",
].join("\n");

describe("scope-tracker", () => {
  it("resolves brace-delimited definition end lines", () => {
    const lines = TS_CODE.split("\n");
    const defs: RawDefinition[] = [
      { name: "Service", kind: "class", startLine: 1, startColumn: 14 },
      { name: "helper", kind: "function", startLine: 10, startColumn: 16 },
    ];
    const resolved = resolveBraceDelimitedRanges(lines, defs);
    expect(resolved[0]!.endLine).toBe(8);
    expect(resolved[1]!.endLine).toBe(12);
  });

  it("resolves indentation-delimited definition end lines", () => {
    const lines = PY_CODE.split("\n");
    const defs: RawDefinition[] = [
      { name: "Service", kind: "class", startLine: 1, startColumn: 1 },
      { name: "run", kind: "method", startLine: 5, startColumn: 5, className: "Service" },
      { name: "helper", kind: "function", startLine: 9, startColumn: 1 },
    ];
    const resolved = resolveIndentationRanges(lines, defs);
    expect(resolved.find((def) => def.name === "Service")!.endLine).toBe(7);
    expect(resolved.find((def) => def.name === "run")!.endLine).toBe(7);
    expect(resolved.find((def) => def.name === "helper")!.endLine).toBe(10);
  });

  it("builds scope ids in the donor format", () => {
    const scopes = buildScopes("svc.py", [
      { name: "Service", kind: "class", startLine: 1, startColumn: 1, endLine: 7 },
      {
        name: "run",
        kind: "method",
        startLine: 5,
        startColumn: 5,
        className: "Service",
        endLine: 7,
      },
    ]);
    expect(scopes.map((scope) => scope.id)).toEqual(["class::Service", "method::Service.run"]);
  });

  it("finds the innermost containing scope", () => {
    const scopes = buildScopes("svc.py", [
      { name: "Service", kind: "class", startLine: 1, startColumn: 1, endLine: 7 },
      {
        name: "run",
        kind: "method",
        startLine: 5,
        startColumn: 5,
        className: "Service",
        endLine: 7,
      },
    ]);
    expect(findScopeForLine(scopes, 6)?.id).toBe("method::Service.run");
    expect(findScopeForLine(scopes, 2)?.id).toBe("class::Service");
    expect(findScopeForLine(scopes, 99)).toBeUndefined();
  });

  it("builds stable symbol ids", () => {
    expect(
      buildSymbolId("svc.py", {
        name: "run",
        kind: "method",
        className: "Service",
      } as RawDefinition),
    ).toBe("svc.py::Service.run");
    expect(buildSymbolId("svc.py", { name: "helper", kind: "function" } as RawDefinition)).toBe(
      "svc.py::helper",
    );
  });
});
