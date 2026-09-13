import { describe, expect, it } from "vitest";
import { CodeGraph } from "../src/agent/code-graph.js";

describe("CodeGraph encapsulation", () => {
  it("does not retain caller-owned mutable node and edge objects", () => {
    const graph = new CodeGraph();
    const node = {
      id: "a",
      name: "A",
      filePath: "a.ts",
      kind: "file" as const,
      exports: ["alpha"],
      imports: ["./b.js"],
    };
    const edge = { source: "a", target: "b", kind: "imports" as const };

    graph.addNode(node);
    graph.addNode({ id: "b", name: "B", filePath: "b.ts", kind: "file" });
    graph.addEdge(edge);

    node.name = "mutated";
    node.exports.push("injected");
    edge.target = "missing";

    expect(graph.getNode("a")?.name).toBe("A");
    expect(graph.getNode("a")?.exports).toEqual(["alpha"]);
    expect(graph.getOutgoingEdges("a")).toEqual([{ source: "a", target: "b", kind: "imports" }]);
  });

  it("does not expose mutable internal nodes or edges through public reads", () => {
    const graph = new CodeGraph();
    graph.addNode({
      id: "hub",
      name: "Hub",
      filePath: "hub.ts",
      kind: "module",
      exports: ["Hub"],
    });
    for (let index = 0; index < 4; index += 1) {
      const id = `n${index}`;
      graph.addNode({ id, name: id, filePath: `${id}.ts`, kind: "file" });
      graph.addEdge({ source: id, target: "hub", kind: "calls" });
    }

    const node = graph.getNode("hub")!;
    node.name = "tampered";
    node.exports!.push("Injected");

    const all = graph.getAllNodes();
    all[0]!.filePath = "changed.ts";

    const edges = graph.getIncomingEdges("hub");
    edges[0]!.source = "tampered";
    edges.push({ source: "fake", target: "hub", kind: "calls" });

    const queried = graph.queryNodes("Hub");
    queried[0]!.name = "query mutation";

    const hubs = graph.getHubNodes(4);
    hubs[0]!.node.name = "hub mutation";

    expect(graph.getNode("hub")).toMatchObject({
      name: "Hub",
      filePath: "hub.ts",
      exports: ["Hub"],
    });
    expect(graph.getIncomingEdges("hub")).toHaveLength(4);
    expect(graph.getIncomingEdges("hub").some((edge) => edge.source === "tampered")).toBe(false);
  });
});
