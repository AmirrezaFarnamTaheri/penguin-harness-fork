import { describe, expect, it } from "vitest";
import { IDENTITY, scale, translation } from "../../src/canvas/affine-transforms";
import {
  addNode,
  createSceneGraph,
  deserializeScene,
  flatten,
  getNode,
  getPath,
  getWorldBounds,
  getWorldMatrix,
  isDescendant,
  nodeAtPoint,
  nodesInRegion,
  removeNode,
  serializeScene,
  setWorldBounds,
  worldCorners,
} from "../../src/canvas/scene-graph";
import { makeRect } from "../../src/canvas/vector-primitives";
import type { SceneNode } from "../../src/canvas/scene-graph";

function leaf(
  id: string,
  parent: string | null,
  local: typeof IDENTITY,
  bounds = makeRect(0, 0, 10, 10),
): SceneNode {
  return {
    id,
    type: "agent-node",
    parentId: parent,
    local,
    localBounds: bounds,
    children: [],
    visible: true,
  };
}

describe("scene graph", () => {
  it("adds nodes and links them to their parent", () => {
    const graph = createSceneGraph();
    const root = addNode(graph, leaf("root", null, translation(10, 10)));
    addNode(graph, leaf("child", "root", translation(5, 5)));
    expect(graph.roots).toEqual(["root"]);
    expect(root.children).toEqual(["child"]);
    // Adding the same id twice does not duplicate the root entry.
    addNode(graph, leaf("root", null, translation(10, 10)));
    expect(graph.roots).toEqual(["root"]);
    expect(graph.nodes.size).toBe(2);
  });

  it("composes world transforms down the tree", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("root", null, translation(10, 10)));
    addNode(graph, leaf("child", "root", translation(5, 5)));
    expect(getWorldMatrix(graph, "root")).toEqual(translation(10, 10));
    expect(getWorldMatrix(graph, "child")).toEqual(translation(15, 15));
    // A scaled parent applies to the child's offset too: (5 * 2) + 10 = 20.
    const scaled = createSceneGraph();
    addNode(scaled, leaf("r", null, scale({ x: 2, y: 2 })));
    addNode(scaled, leaf("c", "r", translation(5, 5)));
    expect(getWorldMatrix(scaled, "c")).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 });
    // Unknown ids are the identity.
    expect(getWorldMatrix(graph, "nope")).toBe(IDENTITY);
  });

  it("walks the ancestor chain and tests descent", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("a", null, IDENTITY));
    addNode(graph, leaf("b", "a", IDENTITY));
    addNode(graph, leaf("c", "b", IDENTITY));
    expect(getPath(graph, "c")).toEqual(["a", "b", "c"]);
    expect(getPath(graph, "a")).toEqual(["a"]);
    expect(isDescendant(graph, "a", "c")).toBe(true);
    expect(isDescendant(graph, "a", "a")).toBe(true);
    expect(isDescendant(graph, "c", "a")).toBe(false);
  });

  it("removes a subtree and heals the parent list", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("a", null, IDENTITY));
    addNode(graph, leaf("b", "a", IDENTITY));
    addNode(graph, leaf("c", "b", IDENTITY));
    removeNode(graph, "b");
    expect(getNode(graph, "b")).toBeUndefined();
    expect(getNode(graph, "c")).toBeUndefined();
    expect(getNode(graph, "a")!.children).toEqual([]);
    // Removing an unknown id is a no-op.
    expect(() => removeNode(graph, "zzz")).not.toThrow();
  });

  it("expands bounds by stroke and shadow margins", () => {
    const graph = createSceneGraph();
    const node = addNode(graph, leaf("box", null, IDENTITY, makeRect(0, 0, 10, 10)));
    expect(getWorldBounds(graph, "box")).toMatchObject({ x1: 0, y1: 0, x2: 10, y2: 10 });
    // Stroke margin is w + sqrt(2) * w.
    node.strokeWidth = 2;
    const margin = 2 + Math.sqrt(2) * 2;
    expect(getWorldBounds(graph, "box")!.x1).toBeCloseTo(-margin);
    expect(getWorldBounds(graph, "box")!.width).toBeCloseTo(10 + margin * 2);
    // Shadow margin is 2 * outset + 10.
    node.effectMargin = 10;
    const total = margin + 30;
    expect(getWorldBounds(graph, "box")!.x2).toBeCloseTo(10 + total);
  });

  it("unions a parent's bounds with its children's world bounds", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("root", null, translation(100, 100), makeRect(0, 0, 10, 10)));
    // The child's local translate composes with the parent's, so it lands at
    // (600, 600) in world space, not (500, 500).
    addNode(graph, leaf("far", "root", translation(500, 500), makeRect(0, 0, 10, 10)));
    const bounds = getWorldBounds(graph, "root");
    expect(bounds.x1).toBeCloseTo(100);
    expect(bounds.y1).toBeCloseTo(100);
    expect(bounds.x2).toBeCloseTo(610);
    expect(bounds.y2).toBeCloseTo(610);
  });

  it("queries nodes in a region and at a point", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("root", null, IDENTITY, makeRect(0, 0, 100, 100)));
    addNode(graph, leaf("a", "root", translation(10, 10), makeRect(0, 0, 10, 10)));
    addNode(graph, leaf("b", "root", translation(500, 500), makeRect(0, 0, 10, 10)));
    const hits = nodesInRegion(graph, makeRect(0, 0, 50, 50));
    expect(hits).toContain("root");
    expect(hits).toContain("a");
    expect(hits).not.toContain("b");
    // Point picking prefers the deepest node.
    expect(nodeAtPoint(graph, { x: 15, y: 15 })).toBe("a");
    expect(nodeAtPoint(graph, { x: 5, y: 5 })).toBe("root");
  });

  it("skips invisible subtrees during culling", () => {
    const graph = createSceneGraph();
    const root = addNode(graph, leaf("root", null, IDENTITY, makeRect(0, 0, 100, 100)));
    addNode(graph, leaf("a", "root", translation(10, 10), makeRect(0, 0, 10, 10)));
    root.visible = false;
    expect(nodesInRegion(graph, makeRect(0, 0, 1000, 1000))).not.toContain("a");
  });

  it("moves a node by setting its world bounds", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("root", null, translation(100, 100), makeRect(0, 0, 10, 10)));
    addNode(graph, leaf("child", "root", IDENTITY, makeRect(0, 0, 10, 10)));
    setWorldBounds(graph, "child", makeRect(500, 500, 10, 10));
    // The target was expressed in world space, so the child's local bounds land
    // in the parent's inverse frame.
    expect(getWorldBounds(graph, "child")).toMatchObject({ x1: 500, y1: 500, x2: 510, y2: 510 });
  });

  it("flattens in draw order respecting z-index", () => {
    const graph = createSceneGraph();
    const root = addNode(graph, leaf("root", null, IDENTITY));
    const mid = addNode(graph, { ...leaf("mid", "root", IDENTITY), zIndex: 5 });
    addNode(graph, { ...leaf("back", "root", IDENTITY), zIndex: 1 });
    addNode(graph, { ...leaf("front", "root", IDENTITY), zIndex: 9 });
    root.zIndex = 0;
    mid.zIndex = 5;
    expect(flatten(graph)).toEqual(["root", "back", "mid", "front"]);
  });

  it("serialises and restores the tree", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("root", null, translation(10, 10), makeRect(0, 0, 10, 10)));
    addNode(graph, leaf("child", "root", translation(5, 5), makeRect(0, 0, 10, 10)));
    const restored = deserializeScene(serializeScene(graph));
    expect([...restored.nodes.keys()]).toEqual(["root", "child"]);
    expect(restored.roots).toEqual(["root"]);
    expect(getWorldMatrix(restored, "child")).toEqual(translation(15, 15));
  });

  it("reports the world-space corners", () => {
    const graph = createSceneGraph();
    addNode(graph, leaf("box", null, translation(10, 10), makeRect(0, 0, 20, 10)));
    const [tl, tr, br, bl] = worldCorners(graph, "box");
    expect(tl).toEqual({ x: 10, y: 10 });
    expect(tr).toEqual({ x: 30, y: 10 });
    expect(br).toEqual({ x: 30, y: 20 });
    expect(bl).toEqual({ x: 10, y: 20 });
    // Unknown node: a degenerate zero box.
    expect(worldCorners(graph, "nope")[0]).toEqual({ x: 0, y: 0 });
  });
});
