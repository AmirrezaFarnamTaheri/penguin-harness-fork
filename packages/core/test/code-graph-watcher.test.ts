import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CodeGraph } from "../src/agent/code-graph.js";
import { CodeGraphWatcher } from "../src/agent/code-graph-watcher.js";

describe("code-graph-watcher and incremental graph updates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-codegraph-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("updates and removes files incrementally in CodeGraph", () => {
    const graph = new CodeGraph();

    graph.updateFile({
      filePath: "src/utils.ts",
      language: "typescript",
      classes: ["DataHelper"],
      interfaces: ["HelperConfig"],
      types: [],
      functions: ["formatDate", "slugify"],
      imports: [],
      exports: ["DataHelper", "formatDate"],
      linesOfCode: 42,
      summary: "Utils helper",
    });

    expect(graph.getNode("src/utils.ts")).toBeDefined();
    expect(graph.getNode("src/utils.ts#DataHelper")).toBeDefined();
    expect(graph.getNode("src/utils.ts#formatDate")).toBeDefined();
    expect(graph.getOutgoingEdges("src/utils.ts").length).toBe(4);

    // Update with fewer functions
    graph.updateFile({
      filePath: "src/utils.ts",
      language: "typescript",
      classes: ["DataHelper"],
      interfaces: [],
      types: [],
      functions: ["formatDate"],
      imports: [],
      exports: ["DataHelper"],
      linesOfCode: 30,
      summary: "Utils helper v2",
    });

    expect(graph.getNode("src/utils.ts#slugify")).toBeUndefined();
    expect(graph.getNode("src/utils.ts#HelperConfig")).toBeUndefined();
    expect(graph.getNode("src/utils.ts#formatDate")).toBeDefined();

    // Remove file completely
    graph.removeFile("src/utils.ts");
    expect(graph.getNode("src/utils.ts")).toBeUndefined();
    expect(graph.getNode("src/utils.ts#DataHelper")).toBeUndefined();
    expect(graph.getOutgoingEdges("src/utils.ts").length).toBe(0);
  });

  it("serializes and deserializes graph to and from JSON", () => {
    const graph = new CodeGraph();
    graph.addNode({ id: "file1", name: "file1.ts", filePath: "file1.ts", kind: "file" });
    graph.addNode({ id: "file2", name: "file2.ts", filePath: "file2.ts", kind: "file" });
    graph.addEdge({ source: "file1", target: "file2", kind: "imports" });

    const json = graph.toJSON();
    expect(json.nodes.length).toBe(2);
    expect(json.edges.length).toBe(1);

    const rehydrated = CodeGraph.fromJSON(json);
    expect(rehydrated.getNode("file1")).toBeDefined();
    expect(rehydrated.getNode("file2")).toBeDefined();
    expect(rehydrated.getOutgoingEdges("file1").length).toBe(1);
  });

  it("watches workspace and incrementally builds AST graph", async () => {
    // Populate test files in temp directory
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const mathPath = path.join(srcDir, "math.ts");
    fs.writeFileSync(
      mathPath,
      `export class Calculator {
  public add(a: number, b: number): number { return a + b; }
}
export function multiply(a: number, b: number): number { return a * b; }
`,
    );

    const mainPath = path.join(srcDir, "main.ts");
    fs.writeFileSync(
      mainPath,
      `import { Calculator, multiply } from "./math.js";
export function run(): void {
  const c = new Calculator();
}
`,
    );

    const watcher = new CodeGraphWatcher(tmpDir, { debounceMs: 20 });
    await watcher.init();

    const graph = watcher.getGraph();
    const stats = watcher.getStats();

    expect(stats.totalFiles).toBe(2);
    expect(stats.totalNodes).toBeGreaterThanOrEqual(4);

    const snapshot = watcher.exportSnapshot();
    expect(snapshot.nodes.some((n) => n.name === "Calculator")).toBe(true);
    expect(snapshot.nodes.some((n) => n.name === "multiply")).toBe(true);

    // Update file
    fs.writeFileSync(
      mathPath,
      `export class Calculator {
  public add(a: number, b: number): number { return a + b; }
}
export function divide(a: number, b: number): number { return a / b; }
`,
    );

    watcher.processFile(mathPath);
    const updatedNodes = watcher.getGraph().getAllNodes();
    expect(updatedNodes.some((n) => n.name === "divide")).toBe(true);

    // Remove file
    fs.unlinkSync(mainPath);
    watcher.removeFile(mainPath);
    expect(watcher.getTrackedFiles().some((f) => f.includes("main.ts"))).toBe(false);

    watcher.close();
  });
});
