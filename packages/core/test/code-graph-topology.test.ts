import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodeGraph } from "../src/agent/code-graph.js";
import { CodeGraphWatcher, type CodeGraphChangeEvent } from "../src/agent/code-graph-watcher.js";

function makeCallGraph(): CodeGraph {
  const graph = new CodeGraph();
  for (const id of [
    "changed",
    "long",
    "middle",
    "shared",
    "caller",
    "outer",
    "callee",
    "isolated",
  ]) {
    graph.addNode({ id, name: id, filePath: `${id}.ts`, kind: "function" });
  }
  // Insert the long route first: DFS-first visitation would strand caller at depth 4.
  for (const [source, target] of [
    ["long", "changed"],
    ["middle", "long"],
    ["shared", "middle"],
    ["shared", "changed"],
    ["caller", "shared"],
    ["outer", "caller"],
    ["changed", "shared"], // Cycle back to the focal symbol.
    ["changed", "callee"], // Outgoing-only dependency is not impacted.
  ] as const) {
    graph.addEdge({ source, target, kind: "calls" });
  }
  graph.addEdge({ source: "shared", target: "changed", kind: "calls" });
  return graph;
}

describe("code graph topology", () => {
  it("uses shortest incoming distance, excludes outgoing-only callees, and deduplicates cycles", () => {
    const graph = makeCallGraph();
    const radius = graph.getImpactRadius("changed", 2);

    expect(radius.nodes.map((node) => node.id)).toEqual([
      "changed",
      "long",
      "shared",
      "caller",
      "middle",
    ]);
    expect(radius.edges).toEqual([
      { source: "caller", target: "shared", kind: "calls" },
      { source: "changed", target: "shared", kind: "calls" },
      { source: "long", target: "changed", kind: "calls" },
      { source: "middle", target: "long", kind: "calls" },
      { source: "shared", target: "changed", kind: "calls" },
    ]);
    expect(
      graph
        .getCallers("changed", 2)
        .map((node) => node.id)
        .sort(),
    ).toEqual(["caller", "long", "middle", "shared"]);
    expect(
      graph
        .getCallees("changed")
        .map((node) => node.id)
        .sort(),
    ).toEqual(["callee", "shared"]);
  });

  it("includes only the focal node at depth zero, defaults to three hops, and handles missing symbols", () => {
    const graph = makeCallGraph();

    expect(graph.getImpactRadius("changed", 0)).toEqual({
      nodes: [{ id: "changed", name: "changed", filePath: "changed.ts", kind: "function" }],
      edges: [],
    });
    expect(graph.getImpactRadius("changed").nodes.map((node) => node.id)).toEqual([
      "changed",
      "long",
      "shared",
      "caller",
      "middle",
      "outer",
    ]);
    expect(graph.getImpactRadius("missing")).toEqual({ nodes: [], edges: [] });
  });

  it("refreshes symbol impact through watcher parsing, import replacement, removal, and recreation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-codegraph-topology-"));
    const watcher = new CodeGraphWatcher(root);
    const changes: CodeGraphChangeEvent[] = [];
    watcher.on("change", (event: CodeGraphChangeEvent) => changes.push(event));
    const targetPath = path.join(root, "target.ts");
    const callerPath = path.join(root, "caller.ts");
    const graph = watcher.getGraph();

    try {
      fs.writeFileSync(targetPath, "export function before() { return 1; }\n");
      fs.writeFileSync(callerPath, 'import { before } from "./target.js";\n');
      fs.writeFileSync(path.join(root, "other.ts"), "export function other() { return 2; }\n");
      // No native watch or live service: use the real initial scan and incremental entry point.
      await watcher.scanWorkspace();
      expect(graph.getImpactRadius("target.ts#before", 2).nodes.map((node) => node.id)).toEqual([
        "target.ts#before",
        "target.ts",
        "caller.ts",
      ]);

      fs.writeFileSync(targetPath, "export function after() { return 3; }\n");
      expect(watcher.processFile(targetPath)?.functions).toEqual(["after"]);
      expect(graph.getImpactRadius("target.ts#before")).toEqual({ nodes: [], edges: [] });
      expect(graph.getImpactRadius("target.ts#after", 2).edges).toEqual([
        { source: "caller.ts", target: "target.ts", kind: "imports" },
        { source: "target.ts", target: "target.ts#after", kind: "contains" },
      ]);

      fs.writeFileSync(callerPath, 'import { other } from "./other.js";\n');
      watcher.processFile(callerPath);
      expect(graph.getImpactRadius("target.ts#after", 2).nodes.map((node) => node.id)).toEqual([
        "target.ts#after",
        "target.ts",
      ]);
      expect(graph.getImpactRadius("other.ts#other", 2).nodes.map((node) => node.id)).toEqual([
        "other.ts#other",
        "other.ts",
        "caller.ts",
      ]);

      fs.unlinkSync(targetPath);
      expect(watcher.processFile(targetPath)).toBeNull();
      expect(graph.getImpactRadius("target.ts#after")).toEqual({ nodes: [], edges: [] });
      expect(
        graph
          .getAllEdges()
          .some((edge) => edge.source === "target.ts" || edge.target === "target.ts"),
      ).toBe(false);
      expect(watcher.getTrackedFiles().sort()).toEqual(["caller.ts", "other.ts"]);
      expect(changes.at(-1)).toMatchObject({ action: "remove", filePath: "target.ts" });

      fs.writeFileSync(targetPath, "export function restored() { return 4; }\n");
      fs.writeFileSync(callerPath, 'import { restored } from "./target.js";\n');
      watcher.processFile(callerPath); // Importer processed before its target exists in the graph.
      watcher.processFile(targetPath);
      expect(graph.getImpactRadius("target.ts#restored", 2).nodes.map((node) => node.id)).toEqual([
        "target.ts#restored",
        "target.ts",
        "caller.ts",
      ]);
      expect(watcher.getStats().totalFiles).toBe(3);
      expect(changes.at(-1)).toMatchObject({
        action: "update",
        filePath: "target.ts",
        summary: { functions: ["restored"] },
      });
    } finally {
      watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
