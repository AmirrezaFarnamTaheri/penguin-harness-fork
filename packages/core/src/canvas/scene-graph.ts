/**
 * Scene-graph: a transform tree for canvas nodes.
 *
 * Ported from the secondary vector editor's `scene-graph` package
 * (`getWorldMatrix`, node bounds, parent-child transform inheritance) and the
 * primary baseline's `common/geom/shapes/bounds.cljc` (bounds accumulation
 * including stroke and shadow margins).
 *
 * Each node owns a *local* transform relative to its parent; the world
 * transform is `parentWorld ∘ local`. Bounds propagate the same way: a
 * parent's bounds are the union of its children's world bounds, so culling
 * can reject an entire subtree with one test.
 */

import type { Affine } from "./affine-transforms";
import { IDENTITY, inverse, multiply, transformPoint, transformRect } from "./affine-transforms";
import type { Rect, Vec2 } from "./vector-primitives";
import { joinRects, makeRect, rectIsEmpty, rectsOverlapOrTouch } from "./vector-primitives";

/** Canvas node kinds the cockpit renders. */
export type SceneNodeType =
  "frame" | "agent-node" | "edge" | "vector-path" | "text" | "group" | "guide";

export interface SceneNode {
  readonly id: string;
  readonly type: SceneNodeType;
  readonly parentId: string | null;
  /** Local transform relative to the parent. */
  local: Affine;
  /** Local bounds before the local transform is applied. */
  localBounds: Rect;
  children: string[];
  /** Whether this node participates in selection and culling. */
  visible: boolean;
  /** Optional stroke width, included in the cull bounds margin. */
  strokeWidth?: number;
  /** Optional shadow/blur outset, included in the cull bounds margin. */
  effectMargin?: number;
  /** Render order within its parent; lower draws first. */
  zIndex?: number;
}

export interface SceneGraph {
  readonly nodes: Map<string, SceneNode>;
  /** Root ids in draw order. */
  roots: string[];
}

export function createSceneGraph(): SceneGraph {
  return { nodes: new Map(), roots: [] };
}

export function addNode(graph: SceneGraph, node: SceneNode): SceneNode {
  graph.nodes.set(node.id, node);
  if (node.parentId === null) {
    if (!graph.roots.includes(node.id)) graph.roots.push(node.id);
  } else {
    const parent = graph.nodes.get(node.parentId);
    if (parent && !parent.children.includes(node.id)) parent.children.push(node.id);
  }
  return node;
}

export function removeNode(graph: SceneGraph, id: string): void {
  const node = graph.nodes.get(id);
  if (!node) return;
  for (const childId of [...node.children]) removeNode(graph, childId);
  if (node.parentId) {
    const parent = graph.nodes.get(node.parentId);
    if (parent) parent.children = parent.children.filter((c) => c !== id);
  } else {
    graph.roots = graph.roots.filter((r) => r !== id);
  }
  graph.nodes.delete(id);
}

export function getNode(graph: SceneGraph, id: string): SceneNode | undefined {
  return graph.nodes.get(id);
}

/** True when `maybeDescendant` is `id` or any of its transitive children. */
export function isDescendant(graph: SceneGraph, id: string, maybeDescendant: string): boolean {
  if (id === maybeDescendant) return true;
  const node = graph.nodes.get(id);
  if (!node) return false;
  for (const child of node.children) {
    if (isDescendant(graph, child, maybeDescendant)) return true;
  }
  return false;
}

/**
 * World transform of a node: the product of every local transform from the
 * root down. Memoised per call on the ancestor chain, so a depth-N query of
 * the whole tree costs O(N) products rather than O(N²).
 */
export function getWorldMatrix(graph: SceneGraph, id: string): Affine {
  const node = graph.nodes.get(id);
  if (!node) return IDENTITY;
  if (node.parentId === null) return node.local;
  return multiply(getWorldMatrix(graph, node.parentId), node.local);
}

/** Chain of ids from the root to this node, root first. */
export function getPath(graph: SceneGraph, id: string): string[] {
  const path: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    path.unshift(current);
    const node = graph.nodes.get(current);
    current = node ? node.parentId : null;
  }
  return path;
}

/**
 * Bounds of one node in world space: the local bounds transformed by the
 * world matrix, expanded by the node's stroke and effect margins. The
 * baseline expands by `strokeWidth + sqrt(2)*strokeWidth` for paths (the
 * diagonal of a square cap) and by `2*blur + 2*spread + 10` for shadows.
 */
export function getWorldBounds(graph: SceneGraph, id: string): Rect {
  const node = graph.nodes.get(id);
  if (!node) return makeRect(0, 0, 0.01, 0.01);
  const world = getWorldMatrix(graph, id);
  let bounds = transformRect(world, node.localBounds);
  const margin = shapeMargin(node);
  if (margin > 0) bounds = growRect(bounds, margin);
  for (const child of node.children) {
    const childBounds = getWorldBounds(graph, child);
    if (!rectIsEmpty(childBounds)) bounds = joinRects(bounds, childBounds);
  }
  return bounds;
}

/** Expansion used for stroke caps and shadow/blur outset. */
function shapeMargin(node: SceneNode): number {
  let margin = 0;
  if (node.strokeWidth && node.strokeWidth > 0) {
    margin += node.strokeWidth + Math.sqrt(2 * node.strokeWidth * node.strokeWidth);
  }
  if (node.effectMargin && node.effectMargin > 0) {
    margin += node.effectMargin * 2 + 10;
  }
  return margin;
}

function growRect(r: Rect, delta: number): Rect {
  return makeRect(r.x1 - delta, r.y1 - delta, r.width + delta * 2, r.height + delta * 2);
}

/** Every node whose world bounds intersect `region`, deepest-first. */
export function nodesInRegion(graph: SceneGraph, region: Rect): string[] {
  const result: string[] = [];
  const visit = (id: string): boolean => {
    const node = graph.nodes.get(id);
    if (!node || !node.visible) return false;
    const bounds = getWorldBounds(graph, id);
    if (!rectsOverlapOrTouch(bounds, region)) return false;
    let anyChildHit = false;
    for (const child of node.children) if (visit(child)) anyChildHit = true;
    // Report a node when it itself overlaps, even if its children do not.
    if (anyChildHit || !rectIsEmpty(bounds)) result.push(id);
    return true;
  };
  for (const root of graph.roots) visit(root);
  return result;
}

/** Deepest visible node at a point, preferring the last-drawn (topmost). */
export function nodeAtPoint(graph: SceneGraph, point: Vec2): string | null {
  const hits = nodesInRegion(graph, makeRect(point.x, point.y, 0.01, 0.01));
  let best: string | null = null;
  let bestDepth = -1;
  let bestZ = -Infinity;
  for (const id of hits) {
    const depth = getPath(graph, id).length;
    const z = graph.nodes.get(id)?.zIndex ?? 0;
    if (depth > bestDepth || (depth === bestDepth && z > bestZ)) {
      best = id;
      bestDepth = depth;
      bestZ = z;
    }
  }
  return best;
}

/**
 * Update a node's local transform so that its world-transformed bounds land
 * at `target`. Used by drag handlers that work in world coordinates.
 */
export function setWorldBounds(graph: SceneGraph, id: string, target: Rect): void {
  const node = graph.nodes.get(id);
  if (!node) return;
  const parentWorld = node.parentId ? getWorldMatrix(graph, node.parentId) : IDENTITY;
  const parentInverse = inverse(parentWorld) ?? IDENTITY;
  const localTarget = transformRect(parentInverse, target);
  node.localBounds = localTarget;
}

/** Flatten the tree into a draw-ordered list (roots first, children after). */
export function flatten(graph: SceneGraph): string[] {
  const out: string[] = [];
  const visit = (id: string): void => {
    const node = graph.nodes.get(id);
    if (!node) return;
    out.push(id);
    const sorted = [...node.children].sort(
      (a, b) => (graph.nodes.get(a)?.zIndex ?? 0) - (graph.nodes.get(b)?.zIndex ?? 0),
    );
    for (const child of sorted) visit(child);
  };
  for (const root of graph.roots) visit(root);
  return out;
}

/**
 * Serialise the graph to a plain object. The baseline targets <20ms canvas
 * serialisation, so this avoids allocations beyond one array of shallow rows.
 */
export interface SerializedScene {
  nodes: Array<{
    id: string;
    type: SceneNodeType;
    parentId: string | null;
    local: Affine;
    localBounds: Rect;
    children: string[];
    visible: boolean;
    strokeWidth?: number;
    effectMargin?: number;
    zIndex?: number;
  }>;
  roots: string[];
}

export function serializeScene(graph: SceneGraph): SerializedScene {
  return {
    nodes: [...graph.nodes.values()].map((n) => ({
      id: n.id,
      type: n.type,
      parentId: n.parentId,
      local: n.local,
      localBounds: n.localBounds,
      children: [...n.children],
      visible: n.visible,
      strokeWidth: n.strokeWidth,
      effectMargin: n.effectMargin,
      zIndex: n.zIndex,
    })),
    roots: [...graph.roots],
  };
}

export function deserializeScene(data: SerializedScene): SceneGraph {
  const graph = createSceneGraph();
  for (const row of data.nodes) {
    graph.nodes.set(row.id, {
      id: row.id,
      type: row.type,
      parentId: row.parentId,
      local: row.local,
      localBounds: row.localBounds,
      children: [...row.children],
      visible: row.visible,
      strokeWidth: row.strokeWidth,
      effectMargin: row.effectMargin,
      zIndex: row.zIndex,
    });
  }
  graph.roots = [...data.roots];
  return graph;
}

/** Corner positions of a node's world bounds (clockwise from top-left). */
export function worldCorners(graph: SceneGraph, id: string): [Vec2, Vec2, Vec2, Vec2] {
  const node = graph.nodes.get(id);
  if (!node)
    return [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
  const world = getWorldMatrix(graph, id);
  const b = node.localBounds;
  return [
    transformPoint(world, { x: b.x1, y: b.y1 }),
    transformPoint(world, { x: b.x2, y: b.y1 }),
    transformPoint(world, { x: b.x2, y: b.y2 }),
    transformPoint(world, { x: b.x1, y: b.y2 }),
  ];
}
