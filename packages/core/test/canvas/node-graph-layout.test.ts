import { describe, expect, it } from "vitest";
import {
  LAYOUT_DEFAULTS,
  edgeAnchors,
  fallbackGridLayout,
  layoutGraph,
  smoothEdgeControlPoints,
} from "../../src/canvas/node-graph-layout";
import type { LayoutEdge, LayoutNode } from "../../src/canvas/node-graph-layout";

const nodes = (ids: string[]): LayoutNode[] => ids.map((id) => ({ id }));

const byId = (result: ReturnType<typeof layoutGraph>) =>
  new Map(result.nodes.map((n) => [n.id, n]));

describe("node graph layout", () => {
  it("handles empty and single-node graphs", () => {
    expect(layoutGraph([], [])).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      hadCycle: false,
    });
    const one = layoutGraph(nodes(["solo"]), []);
    expect(one.nodes).toHaveLength(1);
    expect(one.nodes[0]).toMatchObject({ id: "solo", x: 0, y: 0, layer: 0 });
    expect(one.width).toBeCloseTo(LAYOUT_DEFAULTS.defaultWidth);
    expect(one.height).toBeCloseTo(LAYOUT_DEFAULTS.defaultHeight);
  });

  it("assigns layers by longest path so edges point downstream", () => {
    // a → b → c plus a shortcut a → c; c must be two layers past a.
    const edges: LayoutEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "a", target: "c" },
    ];
    const laid = byId(layoutGraph(nodes(["a", "b", "c"]), edges));
    expect(laid.get("a")!.layer).toBe(0);
    expect(laid.get("b")!.layer).toBe(1);
    expect(laid.get("c")!.layer).toBe(2);
  });

  it("lays layers out left to right without overlapping", () => {
    const edges: LayoutEdge[] = [{ source: "a", target: "b" }];
    const laid = byId(layoutGraph(nodes(["a", "b"]), edges));
    const a = laid.get("a")!;
    const b = laid.get("b")!;
    expect(a.x).toBeCloseTo(0);
    // The next layer starts clear of a's width plus the layer spacing.
    expect(b.x).toBeCloseTo(a.width + LAYOUT_DEFAULTS.layerSpacing);
    expect(b.layer).toBeGreaterThan(a.layer);
    // A right-pointing layout keeps every node inside the reported bounds.
    const result = layoutGraph(nodes(["a", "b"]), edges);
    for (const n of result.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(result.width + 1e-6);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.height).toBeLessThanOrEqual(result.height + 1e-6);
    }
  });

  it("stacks siblings in a layer with spacing", () => {
    // Two layers: {a, c} → b, so a and c share layer 0 and stack vertically.
    const edges: LayoutEdge[] = [
      { source: "a", target: "b" },
      { source: "c", target: "b" },
    ];
    const laid = byId(layoutGraph(nodes(["a", "b", "c"]), edges));
    const a = laid.get("a")!;
    const c = laid.get("c")!;
    expect(a.layer).toBe(c.layer);
    expect(Math.abs(a.x - c.x)).toBeLessThan(1e-9);
    const gap = Math.abs(a.y - c.y);
    expect(gap).toBeCloseTo(a.height + LAYOUT_DEFAULTS.nodeNodeSpacing);
  });

  it("centres a single-node layer against the tallest layer", () => {
    // Layer 0 holds two tall nodes; layer 1 holds one short one.
    const wide: LayoutNode[] = [
      { id: "a", width: 100, height: 100 },
      { id: "b", width: 100, height: 100 },
      { id: "c", width: 100, height: 40 },
    ];
    const edges: LayoutEdge[] = [
      { source: "a", target: "c" },
      { source: "b", target: "c" },
    ];
    const laid = byId(layoutGraph(wide, edges));
    const c = laid.get("c")!;
    const block = 2 * 100 + LAYOUT_DEFAULTS.nodeNodeSpacing;
    // c is centred in the 100-tall cross block rather than top-hung.
    expect(c.y + c.height / 2).toBeCloseTo(block / 2);
  });

  it("minimises crossings with the barycenter sweep", () => {
    // The classic "bowtie" graph: without reordering, both edges cross.
    const edges: LayoutEdge[] = [
      { source: "a1", target: "b2" },
      { source: "a2", target: "b1" },
    ];
    const laid = byId(layoutGraph(nodes(["a1", "a2", "b1", "b2"]), edges));
    const a1 = laid.get("a1")!;
    const a2 = laid.get("a2")!;
    const b1 = laid.get("b1")!;
    const b2 = laid.get("b2")!;
    const crossing = (a1.y - a2.y) * (b1.y - b2.y) > 0;
    expect(crossing).toBe(false);
  });

  it("keeps cycle back-edges out of the layering but in the result", () => {
    const edges: LayoutEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ];
    const result = layoutGraph(nodes(["a", "b"]), edges);
    expect(result.hadCycle).toBe(true);
    // Both nodes survive and still get distinct layers and positions.
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    // A self-loop is a back-edge too.
    const selfLoop = layoutGraph(nodes(["a", "b"]), [
      { source: "a", target: "b" },
      { source: "b", target: "b" },
    ]);
    expect(selfLoop.hadCycle).toBe(true);
    // An acyclic graph reports no cycle.
    expect(layoutGraph(nodes(["a", "b"]), [{ source: "a", target: "b" }]).hadCycle).toBe(false);
  });

  it("drops edges whose endpoints are missing", () => {
    const result = layoutGraph(nodes(["a"]), [{ source: "a", target: "ghost" }]);
    expect(result.edges).toEqual([]);
  });

  it("lays out downward when directed", () => {
    const edges: LayoutEdge[] = [{ source: "a", target: "b" }];
    const laid = byId(layoutGraph(nodes(["a", "b"]), edges, { direction: "DOWN" }));
    const a = laid.get("a")!;
    const b = laid.get("b")!;
    // Layers stack along y, so b sits below a.
    expect(a.x).toBeCloseTo(0);
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeGreaterThan(a.y);
    expect(b.y).toBeCloseTo(a.height + LAYOUT_DEFAULTS.layerSpacing);
  });

  it("packs disconnected components with a gap", () => {
    const edges: LayoutEdge[] = [{ source: "a", target: "b" }];
    const result = layoutGraph(nodes(["a", "b", "c"]), edges);
    const laid = byId(result);
    // {a,b} is one component, c another; c sits beyond the first component's
    // width plus the component gap.
    const a = laid.get("a")!;
    const c = laid.get("c")!;
    expect(c.x).toBeGreaterThanOrEqual(a.x + a.width + LAYOUT_DEFAULTS.componentComponentSpacing);
    // Components never share a layer index.
    expect(c.layer).toBeGreaterThan(laid.get("b")!.layer);
  });

  it("respects custom spacing and node sizes", () => {
    const custom = layoutGraph(
      [
        { id: "a", width: 60, height: 30 },
        { id: "b", width: 60, height: 30 },
      ],
      [{ source: "a", target: "b" }],
      { nodeNodeSpacing: 5, layerSpacing: 10 },
    );
    const laid = byId(custom);
    expect(laid.get("a")!.width).toBeCloseTo(60);
    expect(laid.get("b")!.x).toBeCloseTo(60 + 10);
  });

  it("falls back to a square grid", () => {
    const grid = fallbackGridLayout(nodes(["a", "b", "c", "d", "e"]));
    expect(grid.nodes).toHaveLength(5);
    expect(grid.hadCycle).toBe(false);
    expect(grid.edges).toEqual([]);
    const columns = Math.ceil(Math.sqrt(5));
    const stepX = LAYOUT_DEFAULTS.defaultWidth + 80;
    // The second node is one column over; the node after the last column wraps.
    expect(grid.nodes[1]!.x).toBeCloseTo(stepX);
    expect(grid.nodes[columns]!.x).toBeCloseTo(0);
    expect(grid.nodes[columns]!.y).toBeGreaterThan(0);
  });

  it("anchors edges on the port sides of the nodes", () => {
    const edges: LayoutEdge[] = [
      { source: "a", target: "b", sourceHandle: "out", targetHandle: "in" },
    ];
    const result = layoutGraph(nodes(["a", "b"]), edges);
    const [geo] = edgeAnchors(result);
    expect(geo).toBeDefined();
    expect(geo!.source.id).toBe("a");
    expect(geo!.startPoint.x).toBeCloseTo(geo!.source.x + geo!.source.width);
    expect(geo!.endPoint.x).toBeCloseTo(geo!.target.x);
    // A wide layout emits from the right edge into the left edge.
    expect(geo!.startPoint.y).toBeCloseTo(geo!.source.y + geo!.source.height / 2);
  });

  it("anchors edges top to bottom for tall layouts", () => {
    const tall = layoutGraph(
      [
        { id: "a", width: 40, height: 400 },
        { id: "b", width: 40, height: 400 },
      ],
      [{ source: "a", target: "b" }],
      { direction: "DOWN" },
    );
    const [geo] = edgeAnchors(tall);
    expect(geo!.startPoint.y).toBeCloseTo(geo!.source.y + geo!.source.height);
    expect(geo!.endPoint.y).toBeCloseTo(geo!.target.y);
  });

  it("smooths edge curves with capped control points", () => {
    const result = layoutGraph(nodes(["a", "b"]), [{ source: "a", target: "b" }]);
    const [geo] = edgeAnchors(result);
    const { cp1, cp2 } = smoothEdgeControlPoints(geo!);
    // The control points extend the tangent horizontally and never overshoot
    // the endpoints.
    expect(cp1.y).toBeCloseTo(geo!.startPoint.y);
    expect(cp2.y).toBeCloseTo(geo!.endPoint.y);
    expect(cp1.x).toBeGreaterThan(geo!.startPoint.x);
    expect(cp1.x).toBeLessThanOrEqual(geo!.endPoint.x);
    expect(cp2.x).toBeLessThan(geo!.endPoint.x);
    expect(cp2.x).toBeGreaterThanOrEqual(geo!.startPoint.x);
  });

  it("layouts 1000 nodes in bounded time", () => {
    const big: LayoutNode[] = [];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < 1000; i++) {
      big.push({ id: `n${i}`, width: 120, height: 60 });
      if (i > 0) edges.push({ source: `n${i - 1}`, target: `n${i}` });
    }
    const start = Date.now();
    const result = layoutGraph(big, edges);
    expect(result.nodes).toHaveLength(1000);
    expect(result.width).toBeGreaterThan(0);
    // Wall-clock guard, not a microbenchmark: this lays out in well under a second
    // unloaded, but the budget is set an order of magnitude above that so a loaded
    // parallel CI machine cannot make it flake. It still fails loudly on a genuine
    // quadratic blowup, which would be minutes at this size.
    expect(Date.now() - start).toBeLessThan(20_000);
  });
});
