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
        types: [],
        functions: [],
        imports: [],
        exports: ["StateManager"],
        linesOfCode: 80,
        summary: "",
      },
    ];

    const graph = CodeGraph.fromFileSummaries(summaries);

    expect(graph.getNode("src/engine.ts")).toBeDefined();
    expect(graph.getNode("src/engine.ts#ContextEngine")).toBeDefined();
    expect(graph.getNode("src/state.ts#StateManager")).toBeDefined();

    const out = graph.getOutgoingEdges("src/engine.ts");
    expect(out.some((e) => e.kind === "contains")).toBe(true);
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
});
