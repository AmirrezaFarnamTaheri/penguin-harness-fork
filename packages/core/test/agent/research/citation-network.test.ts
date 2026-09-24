import { describe, it, expect } from "vitest";
import {
  CitationNetwork,
  buildNetworkFromPapers,
  type CitationEdge,
} from "../../../src/agent/research/citation-network.js";

describe("CitationNetwork", () => {
  it("adds nodes and resolves their markers case-insensitively", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "Paper A", marker: "[12]" });
    expect(network.size).toBe(1);
    expect(network.resolveMarker("[12]")).toBe("a");
    expect(network.resolveMarker("CITE{12}")).toBe("a");
    expect(network.resolveMarker("[99]")).toBeUndefined();
  });

  it("synthesises an id from the DOI or arXiv id when none is given", () => {
    const network = new CitationNetwork();
    const doiId = network.addPaper({ title: "With DOI", doi: "10.1000/xyz" });
    const arxivId = network.addPaper({ title: "With arXiv", arxivId: "2305.09781" });
    const synthId = network.addPaper({ title: "Neither Here Nor There" });
    expect(doiId).toBe("10.1000/xyz");
    expect(arxivId).toBe("2305.09781");
    expect(synthId).toMatch(/^paper_\d+_neither-here-nor-there$/);
  });

  it("preserves a node's fetched flag when text arrives in an earlier upsert", () => {
    // `addNode` kept the earlier text but recomputed `fetched` from the textless write, so
    // a node carrying full source text reported itself unfetched and `verifyMarkers`
    // flagged its own citations as hallucinated.
    const network = new CitationNetwork();
    network.addNode({
      id: "p1",
      title: "Photonic Tensor Cores",
      authors: [],
      text: "Full text of the photonic paper.",
      fetched: true,
    });
    network.addNode({ id: "p1", title: "Photonic Tensor Cores", authors: [], fetched: false });
    expect(network.report().coverage).toBe(1);
  });

  it("adds edges and rejects self-citations and unknown endpoints", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "A" });
    network.addPaper({ id: "b", title: "B" });
    expect(network.addEdge({ source: "a", target: "b", relation: "cites" })).toBe(true);
    expect(network.addEdge({ source: "a", target: "a", relation: "cites" })).toBe(false);
    expect(network.addEdge({ source: "a", target: "ghost", relation: "cites" })).toBe(false);
    expect(network.citedBy("a")).toEqual(["b"]);
    expect(network.citing("b")).toEqual(["a"]);
    expect(network.relation("a", "b")).toBe("cites");
    expect(network.edgeCount).toBe(1);
  });

  it("traverses descendants and ancestors transitively", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "A" });
    network.addPaper({ id: "b", title: "B" });
    network.addPaper({ id: "c", title: "C" });
    network.addEdge({ source: "a", target: "b", relation: "cites" });
    network.addEdge({ source: "b", target: "c", relation: "cites" });
    // BFS order: the immediate citation comes before the transitive one.
    expect([...network.descendants("a")]).toEqual(["b", "c"]);
    expect([...network.descendants("a", 1)]).toEqual(["b"]);
    expect([...network.ancestors("c")]).toEqual(["b", "a"]);
  });

  it("topologically sorts an acyclic graph and refuses a cyclic one", () => {
    const acyclic = new CitationNetwork();
    acyclic.addPaper({ id: "a", title: "A" });
    acyclic.addPaper({ id: "b", title: "B" });
    acyclic.addPaper({ id: "c", title: "C" });
    acyclic.addEdge({ source: "a", target: "b", relation: "cites" });
    acyclic.addEdge({ source: "b", target: "c", relation: "cites" });
    // Papers with no outgoing citations come first.
    expect(acyclic.topologicalOrder()).toEqual(["c", "b", "a"]);

    const cyclic = new CitationNetwork();
    cyclic.addPaper({ id: "a", title: "A" });
    cyclic.addPaper({ id: "b", title: "B" });
    cyclic.addEdge({ source: "a", target: "b", relation: "cites" });
    cyclic.addEdge({ source: "b", target: "a", relation: "cites" });
    expect(cyclic.topologicalOrder()).toBeNull();
    expect(cyclic.detectCycles()).toHaveLength(1);
  });

  it("scores a cited paper higher than a leaf under damped iteration", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "A" });
    network.addPaper({ id: "b", title: "B" });
    network.addPaper({ id: "c", title: "C" });
    network.addEdge({ source: "a", target: "b", relation: "cites" });
    network.addEdge({ source: "b", target: "c", relation: "cites" });
    const scores = network.influenceScores();
    expect(scores.get("c")!).toBeGreaterThan(scores.get("a")!);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("a")!);
  });

  it("returns an empty influence map for an empty network", () => {
    expect(new CitationNetwork().influenceScores().size).toBe(0);
  });
});

describe("marker verification", () => {
  it("flags unknown, ambiguous and unfetched markers", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "A", marker: "[1]", text: "body a" });
    network.addPaper({ id: "b", title: "B", marker: "[2]" });
    network.addPaper({ id: "c1", title: "C one", marker: "[9]", text: "body c1" });
    network.addPaper({ id: "c2", title: "C two", marker: "[9]", text: "body c2" });

    const { resolved, unresolved } = network.verifyMarkers([
      { citations: ["[1]"], text: "known and fetched" },
      { citations: ["[2]"], text: "known but unfetched" },
      { citations: ["[42]"], text: "does not exist" },
      { citations: ["[9]"], text: "ambiguous" },
    ]);
    expect(resolved).toEqual(["[1]"]);
    const reasons = unresolved.map((entry) => entry.reason);
    expect(reasons).toContain("unfetched-node");
    expect(reasons).toContain("unknown-marker");
    expect(reasons).toContain("marker-ambiguous");
  });

  it("reports a hallucination rate of zero when every marker resolves", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "A", marker: "[1]", text: "body a" });
    const report = network.report([{ citations: ["[1]"], text: "a claim" }]);
    expect(report.unresolvedMarkers).toHaveLength(0);
    expect(report.hallucinationRate).toBe(0);
    expect(report.coverage).toBe(1);
  });

  it("reports dangling edges pointing at unfetched targets", () => {
    const network = new CitationNetwork();
    network.addPaper({ id: "a", title: "A", text: "body a" });
    network.addPaper({ id: "b", title: "B" });
    network.addEdge({ source: "a", target: "b", relation: "cites" });
    const report = network.report();
    expect(report.danglingEdges).toEqual(["b"]);
    expect(report.coverage).toBeLessThan(1);
  });
});

describe("buildNetworkFromPapers", () => {
  it("wires citation edges from each paper's reference markers", () => {
    const network = buildNetworkFromPapers([
      {
        id: "a",
        title: "A",
        marker: "[1]",
        text: "body a",
        references: [{ marker: "[2]", text: "B paper" }],
      },
      { id: "b", title: "B", marker: "[2]", text: "body b", references: [] },
    ]);
    expect(network.size).toBe(2);
    expect(network.citedBy("a")).toEqual(["b"]);
    expect(network.citedBy("b")).toHaveLength(0);
  });

  it("adds referenced-but-unfetched papers as placeholders so markers still resolve", () => {
    const network = buildNetworkFromPapers([
      {
        id: "a",
        title: "A",
        marker: "[1]",
        text: "body a",
        references: [{ marker: "smith2020", text: "Smith 2020" }],
      },
    ]);
    const report = network.report();
    expect(report.nodeCount).toBe(2);
    expect(report.coverage).toBe(0.5);
    // The placeholder resolves but is unfetched, so a claim leaning on it is flagged.
    expect(network.resolveMarker("smith2020")).toBeDefined();
    expect(network.getNode("ref::smith2020")?.fetched).toBe(false);
    const verification = network.verifyMarkers([{ citations: ["smith2020"], text: "a claim" }]);
    expect(verification.unresolved.map((entry) => entry.reason)).toContain("unfetched-node");
  });

  it("never wires a self-citation edge", () => {
    const network = buildNetworkFromPapers([
      {
        id: "a",
        title: "A",
        marker: "[1]",
        text: "body a",
        references: [{ marker: "[1]", text: "itself" }],
      },
    ]);
    expect([...network.toJSON().edges]).toHaveLength(0);
  });

  it("serialises to and from a plain object", () => {
    const network = buildNetworkFromPapers([
      {
        id: "a",
        title: "A",
        marker: "[1]",
        text: "body a",
        references: [{ marker: "[2]", text: "B paper" }],
      },
      { id: "b", title: "B", marker: "[2]", text: "body b" },
    ]);
    const json = network.toJSON();
    expect(json.nodes).toHaveLength(2);
    const edges: CitationEdge[] = json.edges;
    expect(edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual(["a->b"]);
  });
});
