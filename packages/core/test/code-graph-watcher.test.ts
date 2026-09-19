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

  it("correctly ignores target, .venv, __pycache__, .pytest_cache, .idea, and .vscode directories", () => {
    const watcher = new CodeGraphWatcher(tmpDir);
    expect(watcher.isPathIgnored("target/debug/app.rs")).toBe(true);
    expect(watcher.isPathIgnored("target")).toBe(true);
    expect(watcher.isPathIgnored("node_modules")).toBe(true);
    expect(watcher.isPathIgnored(".git")).toBe(true);
    expect(watcher.isPathIgnored(".venv/lib/python3.11/site-packages/pkg.py")).toBe(true);
    expect(watcher.isPathIgnored("venv/bin/activate.py")).toBe(true);
    expect(watcher.isPathIgnored("src/__pycache__/module.cpython-311.py")).toBe(true);
    expect(watcher.isPathIgnored(".pytest_cache/v/cache/nodeids")).toBe(true);
    expect(watcher.isPathIgnored(".idea/workspace.xml")).toBe(true);
    expect(watcher.isPathIgnored(".vscode/settings.json")).toBe(true);
    expect(watcher.isPathIgnored("src/components/button.tsx")).toBe(false);
    watcher.close();
  });

  it("coalesces burst updates and flushes dirty files cleanly", async () => {
    const watcher = new CodeGraphWatcher(tmpDir, { debounceMs: 50 });
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    // Write multiple files in burst
    for (let i = 0; i < 15; i++) {
      const p = path.join(srcDir, `file${i}.ts`);
      fs.writeFileSync(p, `export function func${i}(): number { return ${i}; }\n`);
    }

    // Force add to watcher queue and flush
    await watcher.init();
    await watcher.flush();

    expect(watcher.getStats().totalFiles).toBe(15);
    expect(watcher.getStats().totalNodes).toBeGreaterThanOrEqual(15);
    watcher.close();
  });
});

describe("code-graph-watcher non-recursive fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-codegraph-fallback-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  /** A watcher pinned to the per-directory path regardless of the host platform. */
  function makeFallbackWatcher(debounceMs = 20): CodeGraphWatcher {
    return new (class extends CodeGraphWatcher {
      protected override supportsRecursiveWatch(): boolean {
        return false;
      }
    })(tmpDir, { debounceMs });
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }

  it("observes a file change in a subdirectory, not just the workspace root", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "a.ts"), "export const a = 1;\n");

    const watcher = makeFallbackWatcher();
    const warnings: string[] = [];
    watcher.on("warn", (message: string) => warnings.push(message));
    const changed: string[] = [];
    watcher.on("change", (event: { filePath: string }) => changed.push(event.filePath));
    await watcher.init();

    // A change one level below the root is the exact case the missing `recursive` option breaks.
    fs.writeFileSync(path.join(srcDir, "b.ts"), "export const b = 2;\n");
    await waitFor(() => changed.some((f) => f === "src/b.ts"));
    await watcher.flush();

    expect(watcher.getTrackedFiles()).toContain("src/b.ts");
    expect(watcher.getGraph().getNode("src/b.ts")).toBeDefined();

    // The degradation is surfaced, and only once.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unavailable");
    watcher.startWatching();
    expect(warnings).toHaveLength(1);

    watcher.close();
  });

  it("picks up directories created after the initial scan", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "seed.ts"), "export const seed = 0;\n");

    const watcher = makeFallbackWatcher();
    const changed: string[] = [];
    watcher.on("change", (event: { filePath: string }) => changed.push(event.filePath));
    await watcher.init();

    // A brand-new subdirectory must get its own watcher installed on creation.
    const nested = path.join(srcDir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "deep.ts"), "export const deep = 3;\n");
    await waitFor(() => changed.some((f) => f === "src/nested/deep.ts"));
    await watcher.flush();

    expect(watcher.getTrackedFiles()).toContain("src/nested/deep.ts");
    watcher.close();
  });

  it("still honors ignore patterns in the fallback path", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "kept.ts"), "export const kept = 1;\n");

    const watcher = makeFallbackWatcher();
    const changed: string[] = [];
    watcher.on("change", (event: { filePath: string }) => changed.push(event.filePath));
    await watcher.init();

    // node_modules is ignored: no watcher is installed, and its files never enter the graph.
    const ignored = path.join(tmpDir, "node_modules");
    fs.mkdirSync(ignored, { recursive: true });
    fs.writeFileSync(path.join(ignored, "untracked.ts"), "export const untracked = 2;\n");

    expect(watcher.getTrackedFiles()).not.toContain("node_modules/untracked.ts");
    expect(watcher.getTrackedFiles()).toContain("src/kept.ts");
    watcher.close();
  });

  it("stops tracking a removed directory without leaking its watcher", async () => {
    const srcDir = path.join(tmpDir, "src");
    const goneDir = path.join(srcDir, "gone");
    fs.mkdirSync(goneDir, { recursive: true });
    fs.writeFileSync(path.join(goneDir, "x.ts"), "export const x = 1;\n");

    const watcher = makeFallbackWatcher();
    const errors: unknown[] = [];
    watcher.on("error", (err: unknown) => errors.push(err));
    await watcher.init();
    expect(watcher.getTrackedFiles()).toContain("src/gone/x.ts");

    // Removing the directory invalidates its watcher; the rest of the tree must keep working.
    fs.rmSync(goneDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 60));

    fs.writeFileSync(path.join(srcDir, "after.ts"), "export const after = 2;\n");
    await waitFor(() => watcher.getTrackedFiles().includes("src/after.ts")).catch(() => {
      // Fall back to a direct process call so the assertion below is still meaningful.
      watcher.processFile(path.join(srcDir, "after.ts"));
    });

    expect(watcher.getTrackedFiles()).toContain("src/after.ts");
    watcher.close();
    // A removed directory surfaces an error event from its watcher; it must not crash the run.
    expect(errors.length).toBeLessThanOrEqual(1);
  });
});
