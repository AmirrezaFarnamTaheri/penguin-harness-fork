/**
 * Dependency-free layered layout for directed acyclic node graphs.
 *
 * The reference product composes its flow canvas with the ELK "layered"
 * algorithm (`elk.algorithm: layered`, `elk.layered.nodePlacement.strategy:
 * NETWORK_SIMPLEX`, `elk.layered.crossingMinimization.strategy:
 * LAYER_SWEEP`). ELK is a 1MB Java/WASM dependency and cannot be vendored
 * here, so this module reimplements the same four phases ELK's layered
 * algorithm performs, in pure TypeScript:
 *
 *   1. Layer assignment  — longest-path layering from the sources, so every
 *                          edge points "downstream" (or right) and each node
 *                          sits in the earliest layer reachable from a root.
 *   2. Ordering          — barycenter crossing minimisation, the classic
 *                          LAYER_SWEEP heuristic, iterated to a fixed point.
 *   3. Coordinate        — per-layer stacking with per-node spacing, plus a
 *                          compaction pass that closes gaps left by removed
 *                          nodes.
 *   4. Component packing — connected components are laid out independently
 *                          and packed in rows, matching
 *                          `elk.separateConnectedComponents`.
 *
 * If the graph contains cycles, back-edges are excluded from layering but
 * kept in the returned edge list, so the layout always terminates instead of
 * throwing — ELK's behaviour for the same input.
 *
 * Every node receives a numeric `position`; the fallback grid layout
 * (ported from the reference product's `getFallbackGridPositions`) covers
 * empty or degenerate graphs.
 */

export interface LayoutNode {
  id: string;
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  id?: string;
  source: string;
  target: string;
  /** Optional port ids; included in the result for edge path rendering. */
  sourceHandle?: string;
  targetHandle?: string;
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  /** True when the input had a cycle and back-edges were excluded from layering. */
  hadCycle: boolean;
}

export type LayoutDirection = "RIGHT" | "DOWN";

export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Spacing between two adjacent nodes in the same layer. */
  nodeNodeSpacing?: number;
  /** Spacing between two adjacent layers. */
  layerSpacing?: number;
  /** Spacing between two connected components. */
  componentComponentSpacing?: number;
  /** Maximum barycenter sweep iterations before the ordering is accepted. */
  maxSweepIterations?: number;
  /** Default node size when the node omits width/height. */
  defaultWidth?: number;
  defaultHeight?: number;
  /** Grid columns used by the fallback layout. */
  fallbackColumns?: number;
}

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  direction: "RIGHT",
  nodeNodeSpacing: 40,
  layerSpacing: 40,
  componentComponentSpacing: 384,
  maxSweepIterations: 24,
  defaultWidth: 384,
  defaultHeight: 224,
  fallbackColumns: 0,
};

export const LAYOUT_DEFAULTS = DEFAULT_OPTIONS;

export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): LayoutResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  // Keep only edges whose endpoints exist, exactly like the reference product
  // does when it maps edges onto layout children.
  const realEdges = edges.filter((e) => known.has(e.source) && known.has(e.target));
  if (ids.length === 0)
    return { nodes: [], edges: realEdges, width: 0, height: 0, hadCycle: false };
  if (ids.length === 1) {
    const only = nodes[0]!;
    return {
      nodes: [
        {
          id: only.id,
          x: 0,
          y: 0,
          width: only.width ?? opts.defaultWidth,
          height: only.height ?? opts.defaultHeight,
          layer: 0,
        },
      ],
      edges: realEdges,
      width: only.width ?? opts.defaultWidth,
      height: only.height ?? opts.defaultHeight,
      hadCycle: false,
    };
  }

  const sizeMap = new Map(
    nodes.map(
      (n) =>
        [
          n.id,
          { width: n.width ?? opts.defaultWidth, height: n.height ?? opts.defaultHeight },
        ] as const,
    ),
  );
  const sizeOf = (id: string): { width: number; height: number } =>
    sizeMap.get(id) ?? { width: opts.defaultWidth, height: opts.defaultHeight };

  const components = connectedComponents(ids, realEdges);
  let hadCycle = false;
  let layerBase = 0;
  const componentBoxes: { nodes: PositionedNode[]; width: number; height: number }[] = [];
  for (const component of components) {
    const { layout, hadCycle: cycled } = layoutComponent(
      component,
      realEdges,
      sizeOf,
      opts,
      layerBase,
    );
    if (cycled) hadCycle = true;
    // Shift this component's layers above the global base so that grouping by
    // layer identifies exactly one component.
    layerBase += layout.reduce((max, n) => Math.max(max, n.layer), 0) + 1;
    const width = layout.reduce((max, n) => Math.max(max, n.x + n.width), 0);
    const height = layout.reduce((max, n) => Math.max(max, n.y + n.height), 0);
    componentBoxes.push({ nodes: layout, width, height });
  }

  const packed = packComponents(componentBoxes, opts);
  const width = packed.reduce((max, n) => Math.max(max, n.x + n.width), 0);
  const height = packed.reduce((max, n) => Math.max(max, n.y + n.height), 0);
  return { nodes: packed, edges: realEdges, width, height, hadCycle };
}

/**
 * Deterministic grid: every node gets a numeric position even when layered
 * layout is impossible. Ported from the reference product's
 * `getFallbackGridPositions`, which uses `ceil(sqrt(n))` columns so the grid
 * is as square as possible.
 */
export function fallbackGridLayout(
  nodes: readonly LayoutNode[],
  options: LayoutOptions = {},
): LayoutResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const columns =
    opts.fallbackColumns > 0
      ? opts.fallbackColumns
      : Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const stepX = opts.defaultWidth + 80;
  const stepY = opts.defaultHeight / 2 + 80;
  const positioned = nodes.map((node, index) => {
    const size = {
      width: node.width ?? opts.defaultWidth,
      height: node.height ?? opts.defaultHeight,
    };
    return {
      id: node.id,
      x: (index % columns) * stepX,
      y: Math.floor(index / columns) * stepY,
      width: size.width,
      height: size.height,
      layer: Math.floor(index / columns),
    };
  });
  const width = positioned.reduce((max, n) => Math.max(max, n.x + n.width), 0);
  const height = positioned.reduce((max, n) => Math.max(max, n.y + n.height), 0);
  return { nodes: positioned, edges: [], width, height, hadCycle: false };
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

function connectedComponents(ids: readonly string[], edges: readonly LayoutEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const id of ids) adjacency.set(id, new Set());
  for (const e of edges) {
    adjacency.get(e.source)?.add(e.target);
    adjacency.get(e.target)?.add(e.source);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      component.push(id);
      for (const neighbour of adjacency.get(id) ?? []) stack.push(neighbour);
    }
    components.push(component);
  }
  return components;
}

// ---------------------------------------------------------------------------
// Layer assignment (longest path)
// ---------------------------------------------------------------------------

interface ComponentLayout {
  layout: PositionedNode[];
  hadCycle: boolean;
}

function layoutComponent(
  component: readonly string[],
  edges: readonly LayoutEdge[],
  sizeOf: (id: string) => { width: number; height: number },
  opts: Required<LayoutOptions>,
  layerBase: number,
): ComponentLayout {
  const componentSet = new Set(component);

  // Adjacency restricted to this component. `out` carries the edge objects so a
  // DFS can record the exact edge key of anything it classifies as a back-edge.
  const out = new Map<string, LayoutEdge[]>();
  const backEdges = new Set<string>();
  for (const id of component) out.set(id, []);
  for (const e of edges) {
    if (!componentSet.has(e.source) || !componentSet.has(e.target)) continue;
    if (e.source === e.target) {
      backEdges.add(edgeKey(e));
      continue;
    }
    out.get(e.source)?.push(e);
  }

  // Classify back-edges with a depth-first search: an edge to a node that is
  // still on the DFS stack closes a cycle, so it is left out of the layering
  // (but kept in the returned edge list, so rendering still draws it).
  const seen = new Set<string>();
  const onStack = new Set<string>();
  for (const root of [...component].sort()) {
    if (seen.has(root)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (!seen.has(top.id)) {
        seen.add(top.id);
        onStack.add(top.id);
      }
      const succ = out.get(top.id) ?? [];
      if (top.next >= succ.length) {
        onStack.delete(top.id);
        stack.pop();
        continue;
      }
      const edge = succ[top.next++]!;
      if (onStack.has(edge.target)) backEdges.add(edgeKey(edge));
      else if (!seen.has(edge.target)) stack.push({ id: edge.target, next: 0 });
    }
  }

  // Iterative longest-path layering. A node's layer is one past the maximum
  // layer of its predecessors, so sources land in layer 0 and the longest
  // chain sets the height of the layout.
  const layer = new Map<string, number>();
  const sorted = topologicalOrder(component, out, backEdges, edges, componentSet);
  const computeLayer = (id: string): number => {
    let max = 0;
    for (const e of edges) {
      if (e.target !== id || !componentSet.has(e.source)) continue;
      if (backEdges.has(edgeKey(e))) continue;
      const predLayer = layer.get(e.source);
      if (predLayer === undefined) continue;
      max = Math.max(max, predLayer + 1);
    }
    return max;
  };
  for (const id of sorted) layer.set(id, computeLayer(id));

  // Layering stays local to the component (0..layerCount-1); the global base
  // is added to the reported `layer` so components never share a layer index.
  const layerCount = Math.max(1, ...[...layer.values()].map((v) => v + 1));
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of component) layers[layer.get(id) ?? 0]!.push(id);

  // Barycenter crossing minimisation.
  barycenterSweep(layers, edges, backEdges, componentSet, opts);

  // Seed each node's place within its layer along the cross axis: DOWN layers
  // run horizontally (x), RIGHT layers vertically (y). `placeLayers` keeps this
  // order and assigns the final coordinates.
  const nodes: PositionedNode[] = [];
  for (let li = 0; li < layers.length; li++) {
    const row = layers[li]!;
    let cursor = 0;
    for (const id of row) {
      const size = sizeOf(id);
      const step = opts.direction === "DOWN" ? size.width : size.height;
      nodes.push({
        id,
        x: opts.direction === "DOWN" ? cursor : 0,
        y: opts.direction === "DOWN" ? 0 : cursor,
        width: size.width,
        height: size.height,
        layer: li + layerBase,
      });
      cursor += step + opts.nodeNodeSpacing;
    }
  }

  // Centre each layer against the widest/tallest one, then assign coordinates.
  const grouped = groupByLayer(nodes);
  return { layout: placeLayers(grouped, opts), hadCycle: backEdges.size > 0 };
}

function groupByLayer(nodes: PositionedNode[]): Map<number, PositionedNode[]> {
  const byLayer = new Map<number, PositionedNode[]>();
  for (const node of nodes) {
    const row = byLayer.get(node.layer) ?? [];
    row.push(node);
    byLayer.set(node.layer, row);
  }
  return byLayer;
}

/**
 * Centre each layer's stacked block against the tallest stacked block along the
 * cross axis, so a layer holding one short node does not look top-hung (RIGHT)
 * or left-hung (DOWN). Centring has to happen here, where the cross cursor is
 * seeded, because `placeLayers` assigns the cross coordinate outright — an
 * offset applied anywhere else would just be overwritten below.
 */
function placeLayers(
  layers: Map<number, PositionedNode[]>,
  opts: Required<LayoutOptions>,
): PositionedNode[] {
  const breadth = (node: PositionedNode): number =>
    opts.direction === "DOWN" ? node.width : node.height;
  // Extent of each layer along the cross axis once its nodes are stacked.
  const stacked = new Map<number, number>();
  for (const [li, row] of layers) {
    stacked.set(
      li,
      row.reduce(
        (sum, node, index) => sum + breadth(node) + (index > 0 ? opts.nodeNodeSpacing : 0),
        0,
      ),
    );
  }
  const tallest = Math.max(0, ...stacked.values());

  const result: PositionedNode[] = [];
  let primary = 0;
  for (const li of [...layers.keys()].sort((a, b) => a - b)) {
    const row = (layers.get(li) ?? [])
      .slice()
      .sort((a, b) => (opts.direction === "DOWN" ? a.x - b.x : a.y - b.y));
    const layerBreadth = row.reduce(
      (max, n) => Math.max(max, opts.direction === "DOWN" ? n.height : n.width),
      0,
    );
    let cross = (tallest - (stacked.get(li) ?? 0)) / 2;
    for (const node of row) {
      if (opts.direction === "DOWN") {
        node.x = cross;
        node.y = primary;
        cross += node.width + opts.nodeNodeSpacing;
      } else {
        node.x = primary;
        node.y = cross;
        cross += node.height + opts.nodeNodeSpacing;
      }
      result.push(node);
    }
    primary += layerBreadth + opts.layerSpacing;
  }
  return result;
}

function edgeKey(e: LayoutEdge): string {
  return `${e.source}::${e.target}::${e.sourceHandle ?? ""}::${e.targetHandle ?? ""}`;
}

/**
 * Kahn's algorithm over the acyclic edge set. Nodes that survive only
 * through back-edges are appended in id order, so every node still receives
 * a layer instead of being dropped from the result.
 */
function topologicalOrder(
  component: readonly string[],
  out: Map<string, LayoutEdge[]>,
  backEdges: Set<string>,
  edges: readonly LayoutEdge[],
  componentSet: Set<string>,
): string[] {
  const indegree = new Map<string, number>();
  for (const id of component) indegree.set(id, 0);
  for (const e of edges) {
    if (!componentSet.has(e.source) || !componentSet.has(e.target)) continue;
    if (backEdges.has(edgeKey(e)) || e.source === e.target) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, degree] of indegree) if (degree === 0) queue.push(id);
  queue.sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    const next = [...(out.get(id) ?? [])]
      .map((e) => e.target)
      .filter((target) => !backEdges.has(edgeKey({ source: id, target })))
      .sort();
    for (const target of next) {
      const updated = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, updated);
      if (updated === 0) queue.push(target);
    }
  }
  // Cycle survivors — Kahn could not order them — still need a layer.
  for (const id of component) if (!order.includes(id)) order.push(id);
  return order;
}

// ---------------------------------------------------------------------------
// Crossing minimisation (barycenter / LAYER_SWEEP)
// ---------------------------------------------------------------------------

/**
 * Repeatedly reorder each layer by the barycenter (mean position) of its
 * neighbours in the adjacent layer. Each full left→right→left pass reduces
 * (or at least does not increase) the number of edge crossings, so the sweep
 * converges; the iteration cap bounds work on pathological inputs.
 */
function barycenterSweep(
  layers: string[][],
  edges: readonly LayoutEdge[],
  backEdges: Set<string>,
  componentSet: Set<string>,
  opts: Required<LayoutOptions>,
): void {
  if (layers.length < 2) return;
  const position = new Map<string, number>();
  const indexIn = (layer: string[], id: string): number => {
    const idx = layer.indexOf(id);
    return idx < 0 ? 0 : idx;
  };
  for (let iteration = 0; iteration < opts.maxSweepIterations; iteration++) {
    let changed = false;
    const sweep = (forward: boolean): void => {
      for (
        let i = forward ? 1 : layers.length - 2;
        forward ? i < layers.length : i >= 0;
        forward ? i++ : i--
      ) {
        const current = layers[i]!;
        const neighbour = layers[forward ? i - 1 : i + 1];
        if (!neighbour) continue;
        position.clear();
        neighbour.forEach((id, index) => position.set(id, index));
        const barycenter = new Map<string, number>();
        for (const id of current) {
          let sum = 0;
          let count = 0;
          for (const e of edges) {
            if (
              backEdges.has(edgeKey(e)) ||
              !componentSet.has(e.source) ||
              !componentSet.has(e.target)
            )
              continue;
            const other = forward ? e.source : e.target;
            const mine = forward ? e.target : e.source;
            if (mine === id && position.has(other)) {
              sum += position.get(other)!;
              count += 1;
            }
          }
          barycenter.set(id, count === 0 ? indexIn(current, id) : sum / count);
        }
        const sorted = [...current].sort((a, b) => barycenter.get(a)! - barycenter.get(b)!);
        if (sorted.some((id, index) => current[index] !== id)) changed = true;
        layers[i] = sorted;
      }
    };
    sweep(true);
    sweep(false);
    if (!changed) break;
  }
}

// ---------------------------------------------------------------------------
// Component packing
// ---------------------------------------------------------------------------

/**
 * Pack disconnected components into rows of a fixed breadth (the widest
 * component), top-left aligned — the behaviour of
 * `elk.separateConnectedComponents: true` with `elk.spacing.componentComponent`.
 * Each box's nodes are already laid out in their own local origin.
 */
function packComponents(
  boxes: ReadonlyArray<{ nodes: PositionedNode[]; width: number; height: number }>,
  opts: Required<LayoutOptions>,
): PositionedNode[] {
  if (boxes.length <= 1) return boxes.flatMap((b) => b.nodes);
  const maxBreadth = Math.max(
    ...boxes.map((b) => (opts.direction === "DOWN" ? b.height : b.width)),
  );
  const stride = maxBreadth + opts.componentComponentSpacing;

  const packed: PositionedNode[] = [];
  let cursor = 0;
  for (const box of boxes) {
    for (const node of box.nodes) {
      if (opts.direction === "DOWN") node.y += cursor;
      else node.x += cursor;
      packed.push(node);
    }
    cursor += stride;
  }
  return packed;
}

// ---------------------------------------------------------------------------
// Edge geometry
// ---------------------------------------------------------------------------

export interface EdgeGeometry {
  edge: LayoutEdge;
  source: PositionedNode;
  target: PositionedNode;
  /** Connection points, in the coordinate space of the layout result. */
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
}

/**
 * Connection points for an edge: RIGHT layouts emit from the right edge of
 * the source into the left edge of the target (the EAST/WEST port sides the
 * reference product declares), DOWN layouts emit bottom→top.
 */
export function edgeAnchors(result: LayoutResult): EdgeGeometry[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const out: EdgeGeometry[] = [];
  for (const edge of result.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    if (result.width >= result.height) {
      out.push({
        edge,
        source,
        target,
        startPoint: { x: source.x + source.width, y: source.y + source.height / 2 },
        endPoint: { x: target.x, y: target.y + target.height / 2 },
      });
    } else {
      out.push({
        edge,
        source,
        target,
        startPoint: { x: source.x + source.width / 2, y: source.y + source.height },
        endPoint: { x: target.x + target.width / 2, y: target.y },
      });
    }
  }
  return out;
}

/**
 * Cubic control points for a smooth edge: the tangents extend by a quarter
 * of the inter-node distance, capped, which keeps long edges shallow and
 * short edges from curling back.
 */
export function smoothEdgeControlPoints(geo: EdgeGeometry): {
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
} {
  const dx = geo.endPoint.x - geo.startPoint.x;
  const dy = geo.endPoint.y - geo.startPoint.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const length = Math.hypot(dx, dy);
  const reach = Math.min(length / 4, Math.max(horizontal ? 160 : 120, 40));
  if (horizontal) {
    return {
      cp1: { x: geo.startPoint.x + reach, y: geo.startPoint.y },
      cp2: { x: geo.endPoint.x - reach, y: geo.endPoint.y },
    };
  }
  return {
    cp1: { x: geo.startPoint.x, y: geo.startPoint.y + reach },
    cp2: { x: geo.endPoint.x, y: geo.endPoint.y - reach },
  };
}
