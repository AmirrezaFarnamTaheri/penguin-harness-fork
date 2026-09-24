import { describe, it, expect } from "vitest";
import { CodeGraph } from "../src/agent/code-graph.js";
import type { FileSummary } from "../src/agent/symbol-indexer.js";

describe("code-graph", () => {
  it("constructs graph from file summaries with containment and import edges", () => {
    const summaries: FileSummary[] = [
      {
        filePath: "src/engine.ts",
        language: "typescript",
        classes: ["ContextEngine"],
        interfaces: [],
        types: [],
        functions: ["startEngine"],
        imports: ["./state.js"],
        exports: ["ContextEngine"],
        linesOfCode: 150,
        summary: "",
      },
      {
        filePath: "src/state.ts",
        language: "typescript",
        classes: ["StateManager"],
        interfaces: ["StateObserver"],
        types: ["StateToken"],
        functions: [],
        imports: [],
        exports: ["StateManager", "StateToken"],
        linesOfCode: 80,
        summary: "",
      },
    ];

    const graph = CodeGraph.fromFileSummaries(summaries);

    expect(graph.getNode("src/engine.ts")).toBeDefined();
    expect(graph.getNode("src/engine.ts#ContextEngine")).toBeDefined();
    expect(graph.getNode("src/state.ts#StateManager")).toBeDefined();
    expect(graph.getNode("src/state.ts#StateToken")?.kind).toBe("type");

    const out = graph.getOutgoingEdges("src/engine.ts");
    expect(out.some((e) => e.kind === "contains")).toBe(true);
    expect(out.some((e) => e.kind === "imports" && e.target === "src/state.ts")).toBe(true);

    // Verify updating state.ts preserves incoming import edge from engine.ts
    graph.updateFile({
      filePath: "src/state.ts",
      language: "typescript",
      classes: ["StateManager"],
      interfaces: ["StateObserver"],
      types: ["StateToken", "NewType"],
      functions: [],
      imports: [],
      exports: ["StateManager"],
      linesOfCode: 85,
      summary: "",
    });
    const incomingToState = graph.getIncomingEdges("src/state.ts");
    expect(incomingToState.some((e) => e.source === "src/engine.ts" && e.kind === "imports")).toBe(
      true,
    );
    expect(graph.getNode("src/state.ts#NewType")?.kind).toBe("type");
  });

  it("finds shortest path through connected nodes", () => {
    const graph = new CodeGraph();
    graph.addNode({ id: "A", name: "A", filePath: "A.ts", kind: "file" });
    graph.addNode({ id: "B", name: "B", filePath: "B.ts", kind: "file" });
    graph.addNode({ id: "C", name: "C", filePath: "C.ts", kind: "file" });
    graph.addNode({ id: "D", name: "D", filePath: "D.ts", kind: "file" });

    graph.addEdge({ source: "A", target: "B", kind: "imports" });
    graph.addEdge({ source: "B", target: "C", kind: "imports" });
    graph.addEdge({ source: "A", target: "D", kind: "imports" });
    graph.addEdge({ source: "D", target: "C", kind: "imports" });

    const path = graph.findShortestPath("A", "C");
    expect(path).not.toBeNull();
    expect(path!.length).toBe(3); // A -> B -> C or A -> D -> C
    expect(path![0]!.node.id).toBe("A");
    expect(path![2]!.node.id).toBe("C");
  });

  it("computes impact radius and call graph", () => {
    const graph = new CodeGraph();
    graph.addNode({ id: "core", name: "core", filePath: "core.ts", kind: "file" });
    graph.addNode({ id: "server", name: "server", filePath: "server.ts", kind: "file" });
    graph.addNode({ id: "web", name: "web", filePath: "web.ts", kind: "file" });

    graph.addEdge({ source: "server", target: "core", kind: "imports" });
    graph.addEdge({ source: "web", target: "server", kind: "imports" });

    const impact = graph.getImpactRadius("core", 2);
    expect(impact.nodes.some((n) => n.id === "core")).toBe(true);
    expect(impact.nodes.some((n) => n.id === "server")).toBe(true);
    expect(impact.nodes.some((n) => n.id === "web")).toBe(true);

    const callers = graph.getCallers("core", 1);
    expect(callers.length).toBe(1);
    expect(callers[0]!.id).toBe("server");
  });

  it("queries nodes and explains concepts", () => {
    const graph = new CodeGraph();
    graph.addNode({
      id: "symbol-indexer",
      name: "SymbolIndexer",
      filePath: "src/agent/symbol-indexer.ts",
      kind: "class",
      exports: ["SymbolIndexer", "FileSummary"],
    });

    const matches = graph.queryNodes("indexer");
    expect(matches.length).toBe(1);
    expect(matches[0]!.id).toBe("symbol-indexer");

    const explanation = graph.explainConcept("SymbolIndexer");
    expect(explanation.focal).not.toBeNull();
    expect(explanation.focal!.name).toBe("SymbolIndexer");
  });

  it("identifies hub nodes based on in/out degree", () => {
    const graph = new CodeGraph();
    graph.addNode({ id: "hub", name: "HubModule", filePath: "hub.ts", kind: "module" });
    graph.addNode({ id: "n1", name: "N1", filePath: "n1.ts", kind: "file" });
    graph.addNode({ id: "n2", name: "N2", filePath: "n2.ts", kind: "file" });
    graph.addNode({ id: "n3", name: "N3", filePath: "n3.ts", kind: "file" });
    graph.addNode({ id: "n4", name: "N4", filePath: "n4.ts", kind: "file" });

    graph.addEdge({ source: "n1", target: "hub", kind: "calls" });
    graph.addEdge({ source: "n2", target: "hub", kind: "calls" });
    graph.addEdge({ source: "hub", target: "n3", kind: "calls" });
    graph.addEdge({ source: "hub", target: "n4", kind: "calls" });

    const hubs = graph.getHubNodes(4);
    expect(hubs.length).toBe(1);
    expect(hubs[0]!.node.id).toBe("hub");
    expect(hubs[0]!.degree).toBe(4);
  });

  it("identifies bridge nodes (articulation points) connecting components", () => {
    const graph = new CodeGraph();
    // Graph: A - B - C, where B is the bridge connecting A and C
    graph.addNode({ id: "A", name: "A", filePath: "a.ts", kind: "file" });
    graph.addNode({ id: "B", name: "B", filePath: "b.ts", kind: "file" });
    graph.addNode({ id: "C", name: "C", filePath: "c.ts", kind: "file" });

    graph.addEdge({ source: "A", target: "B", kind: "calls" });
    graph.addEdge({ source: "B", target: "C", kind: "calls" });

    const bridges = graph.getBridgeNodes();
    expect(bridges.some((b) => b.id === "B")).toBe(true);
    expect(bridges.some((b) => b.id === "A")).toBe(false);
    expect(bridges.some((b) => b.id === "C")).toBe(false);
  });

  it("explores neighborhood subgraph around queried nodes", () => {
    const graph = new CodeGraph();
    graph.addNode({ id: "agent", name: "AgentEngine", filePath: "agent.ts", kind: "class" });
    graph.addNode({ id: "planner", name: "Planner", filePath: "planner.ts", kind: "class" });
    graph.addNode({ id: "memory", name: "Memory", filePath: "memory.ts", kind: "class" });
    graph.addNode({ id: "remote", name: "Remote", filePath: "remote.ts", kind: "class" });

    graph.addEdge({ source: "agent", target: "planner", kind: "contains" });
    graph.addEdge({ source: "agent", target: "memory", kind: "contains" });
    graph.addEdge({ source: "memory", target: "remote", kind: "calls" });

    const sub = graph.explore("Agent", 1);
    expect(sub.roots).toContain("agent");
    expect(sub.nodes.some((n) => n.id === "agent")).toBe(true);
    expect(sub.nodes.some((n) => n.id === "planner")).toBe(true);
    expect(sub.nodes.some((n) => n.id === "memory")).toBe(true);
    // Depth 1 should NOT include remote (which is depth 2)
    expect(sub.nodes.some((n) => n.id === "remote")).toBe(false);
  });

  describe("addEdge validation and deduplication", () => {
    it("collapses two identical edges into one instead of accumulating duplicates", () => {
      const graph = new CodeGraph();
      graph.addNode({ id: "a", name: "A", filePath: "a.ts", kind: "file" });
      graph.addNode({ id: "b", name: "B", filePath: "b.ts", kind: "file" });

      expect(graph.addEdge({ source: "a", target: "b", kind: "imports" })).toBe(true);
      // The same edge again (import + `export * from` resolving to the same file) must not dupe.
      expect(graph.addEdge({ source: "a", target: "b", kind: "imports" })).toBe(false);

      expect(graph.getAllEdges()).toHaveLength(1);
      expect(graph.getOutgoingEdges("a")).toHaveLength(1);
      expect(graph.getIncomingEdges("b")).toHaveLength(1);
      // Duplicate adjacency would have double-counted the hub degree.
      expect(graph.getHubNodes(1).find((h) => h.node.id === "b")?.degree).toBe(1);
    });

    it("keeps distinct call sites at different lines as separate edges", () => {
      const graph = new CodeGraph();
      graph.addNode({ id: "svc", name: "Svc", filePath: "svc.ts", kind: "function" });
      graph.addNode({ id: "util", name: "Util", filePath: "util.ts", kind: "function" });

      expect(graph.addEdge({ source: "svc", target: "util", kind: "calls", line: 12 })).toBe(true);
      expect(graph.addEdge({ source: "svc", target: "util", kind: "calls", line: 47 })).toBe(true);
      expect(graph.getAllEdges()).toHaveLength(2);
    });

    it("refuses edges whose endpoints were never added as nodes", () => {
      const graph = new CodeGraph();
      graph.addNode({ id: "a", name: "A", filePath: "a.ts", kind: "file" });
      graph.addNode({ id: "b", name: "B", filePath: "b.ts", kind: "file" });
      graph.addEdge({ source: "a", target: "b", kind: "imports" });

      expect(graph.addEdge({ source: "a", target: "ghost", kind: "imports" })).toBe(false);
      expect(graph.addEdge({ source: "ghost", target: "b", kind: "imports" })).toBe(false);
      expect(graph.getAllEdges()).toHaveLength(1);
      // No dangling adjacency is left behind for removeNode to miss.
      expect(graph.getIncomingEdges("ghost")).toHaveLength(0);
      expect(graph.getOutgoingEdges("ghost")).toHaveLength(0);
    });

    it("does not leave dangling adjacency when fromJSON contains a broken edge", () => {
      const graph = CodeGraph.fromJSON({
        nodes: [{ id: "n1", name: "n1", filePath: "n1.ts", kind: "file" }],
        edges: [{ source: "n1", target: "gone", kind: "imports" }],
      });
      expect(graph.getAllEdges()).toHaveLength(0);
      expect(graph.getOutgoingEdges("n1")).toHaveLength(0);
      // The traversal view of the graph stays consistent (only the focal node, no dangling edges).
      const radius = graph.getImpactRadius("n1");
      expect(radius.edges).toHaveLength(0);
      expect(radius.nodes.map((n) => n.id)).toEqual(["n1"]);
    });

    it("deduplicates the import edges updateFile records from both directions", () => {
      // A file importing the same module twice, plus the reverse-scan pass, must yield one edge.
      const graph = CodeGraph.fromFileSummaries([
        {
          filePath: "a.ts",
          language: "typescript",
          classes: [],
          interfaces: [],
          types: [],
          functions: [],
          imports: ["./b.js", "./b.js"],
          exports: [],
          linesOfCode: 1,
          summary: "",
        },
        {
          filePath: "b.ts",
          language: "typescript",
          classes: [],
          interfaces: [],
          types: [],
          functions: [],
          imports: [],
          exports: [],
          linesOfCode: 1,
          summary: "",
        },
      ]);

      const imports = graph.getOutgoingEdges("a.ts", ["imports"]);
      expect(imports).toHaveLength(1);
      expect(imports[0]!.target).toBe("b.ts");
    });

    it("still cleans up both adjacency lists when a node is removed after dedup", () => {
      const graph = new CodeGraph();
      graph.addNode({ id: "a", name: "A", filePath: "a.ts", kind: "file" });
      graph.addNode({ id: "b", name: "B", filePath: "b.ts", kind: "file" });
      graph.addEdge({ source: "a", target: "b", kind: "imports" });
      graph.addEdge({ source: "a", target: "b", kind: "imports" });

      graph.removeNode("a");
      expect(graph.getAllEdges()).toHaveLength(0);
      expect(graph.getIncomingEdges("b")).toHaveLength(0);
    });
  });
});
