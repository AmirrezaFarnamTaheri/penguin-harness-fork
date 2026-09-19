/**
 * Agentic vector canvas (Track 5, Tier 2 + Tier 3).
 *
 * An infinite SVG surface that lays an agent DAG out with the core layout
 * engine and renders it through a pan/zoom camera with viewport culling, so
 * 10k-node topologies only paint what is on screen. Presentational only: every
 * bit of logic — layout, camera, culling, shape paths, curve hit-testing,
 * colour — comes from the core canvas modules, reached through the workspace
 * source until the package's `./canvas` subpath export is wired up. No tests
 * live here; behaviour is covered by the core modules' own suites.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  CANVAS_THEMES,
  clampZoom,
  createPath,
  createViewport,
  cubicClosestT,
  cullByViewport,
  curveTo,
  edgeAnchors,
  ellipsePath,
  evalCubic,
  hexToRgb,
  layoutGraph,
  makeRect,
  moveTo,
  panBy,
  pathToString,
  readableForeground,
  rectPath,
  roundedRectPath,
  screenToWorld,
  setZoomCentered,
  smoothEdgeControlPoints,
  type Cubic,
  type LayoutEdge,
  type LayoutNode,
  type Viewport,
  worldToScreen,
} from "@prismshadow/penguin-core/canvas";

export type CanvasThemeKey = "dark-obsidian" | "clean-blueprint" | "technical-paper";
export type CanvasNodeShape = "rect" | "rounded" | "ellipse";

interface ThemeColors {
  readonly background: string;
  readonly grid: string;
  readonly accent: string;
  readonly panel: string;
}

const CANVAS_THEME_TABLE = CANVAS_THEMES as unknown as Record<CanvasThemeKey, ThemeColors>;
export const CANVAS_THEME_KEYS: readonly CanvasThemeKey[] = [
  "dark-obsidian",
  "clean-blueprint",
  "technical-paper",
];

/** World size of one grid cell; the pattern is scaled by the camera. */
const GRID_CELL = 24;
/** Wheel zoom speed in exponential units per pixel of deltaY. */
const ZOOM_WHEEL_STEP = 0.0015;
/** Screen pixels a click may drift while still counting as a click, not a drag. */
const CLICK_DRIFT_TOLERANCE = 4;
/** Screen-pixel tolerance for picking an edge curve. */
const EDGE_PICK_TOLERANCE = 7;

export interface VectorCanvasNode extends LayoutNode {
  readonly label: string;
  readonly shape?: CanvasNodeShape;
  /** Node fill; defaults to the theme panel colour. */
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface VectorCanvasEdge extends LayoutEdge {}

export interface VectorCanvasProps {
  readonly nodes: readonly VectorCanvasNode[];
  readonly edges?: readonly VectorCanvasEdge[];
  readonly theme?: CanvasThemeKey;
  /** Layout direction; RIGHT is the default DAG flow. */
  readonly direction?: "RIGHT" | "DOWN";
  /** Camera to start from; width/height come from the container when omitted. */
  readonly initialViewport?: Partial<Viewport>;
  readonly selectedId?: string | null;
  readonly onSelectNode?: (id: string | null) => void;
  readonly onViewportChange?: (viewport: Viewport) => void;
  readonly className?: string;
}

interface ScreenNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pathD: string;
  readonly label: string;
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly selected: boolean;
}

const NODE_STROKE_WIDTH = 1.5;

function nodePathD(shape: CanvasNodeShape, width: number, height: number): string {
  switch (shape) {
    case "ellipse":
      return pathToString(ellipsePath(width / 2, height / 2, width / 2, height / 2));
    case "rounded":
      return pathToString(
        roundedRectPath(0, 0, width, height, Math.min(10, Math.min(width, height) / 6)),
      );
    case "rect":
    default:
      return pathToString(rectPath(0, 0, width, height));
  }
}

const CanvasNodeShape = memo(function CanvasNodeShape({ node }: { readonly node: ScreenNode }) {
  // Path is authored in world units; the parent group supplies translate + scale.
  return (
    <path
      d={node.pathD}
      fill={node.fill}
      stroke={node.stroke}
      strokeWidth={node.strokeWidth}
      vectorEffect="non-scaling-stroke"
      data-node-id={node.id}
      style={{ cursor: "grab" }}
    />
  );
});
CanvasNodeShape.displayName = "CanvasNodeShape";

export function VectorCanvas({
  nodes,
  edges,
  theme = "dark-obsidian",
  direction = "RIGHT",
  initialViewport,
  selectedId = null,
  onSelectNode,
  onViewportChange,
  className = "",
}: VectorCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const themeColors = CANVAS_THEME_TABLE[theme];

  const [viewport, setViewport] = useState<Viewport>(() =>
    createViewport(initialViewport?.width ?? 800, initialViewport?.height ?? 600),
  );
  // Applied on top of the camera state: the caller may drive zoom/pan externally.
  const effective: Viewport = useMemo(
    () => ({
      panX: initialViewport?.panX ?? viewport.panX,
      panY: initialViewport?.panY ?? viewport.panY,
      zoom: initialViewport?.zoom ?? viewport.zoom,
      width: viewport.width,
      height: viewport.height,
    }),
    [initialViewport, viewport],
  );

  const update = useCallback(
    (next: Viewport) => {
      setViewport(next);
      onViewportChange?.(next);
    },
    [onViewportChange],
  );

  // Size the camera to the container. The SVG itself is 100%×100% so the only
  // numbers the camera needs are the CSS pixel dimensions of that box.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewport((prev) =>
          prev.width === rect.width && prev.height === rect.height
            ? prev
            : { ...prev, width: rect.width, height: rect.height },
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Layout is pure: re-run only when the DAG changes.
  const layout = useMemo(
    () => layoutGraph(nodes, edges ?? [], { direction }),
    [nodes, edges, direction],
  );

  const boundsById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof makeRect>>();
    for (const node of layout.nodes) {
      map.set(node.id, makeRect(node.x, node.y, node.width, node.height));
    }
    return map;
  }, [layout]);

  // The hot path for large topologies: reject everything off-screen before
  // React ever builds the element tree for it.
  const cull = useMemo(
    () => cullByViewport(boundsById, effective, NODE_STROKE_WIDTH),
    [boundsById, effective],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, VectorCanvasNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const visibleNodes = useMemo<ScreenNode[]>(() => {
    const panel = themeColors.panel;
    const accent = themeColors.accent;
    return cull.visible
      .map((id) => layout.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map((n) => {
        const source = nodeById.get(n.id);
        const screen = worldToScreen(effective, { x: n.x, y: n.y });
        const size = { x: n.width * effective.zoom, y: n.height * effective.zoom };
        const shape = source?.shape ?? "rounded";
        const isSelected = n.id === selectedId;
        return {
          id: n.id,
          x: screen.x,
          y: screen.y,
          width: size.x,
          height: size.y,
          // Path is authored in world units inside a group that the zoom scales.
          pathD: nodePathD(shape, n.width, n.height),
          label: source?.label ?? n.id,
          fill: source?.fill ?? panel,
          stroke: isSelected ? accent : (source?.stroke ?? accent),
          strokeWidth: NODE_STROKE_WIDTH,
          selected: isSelected,
        } satisfies ScreenNode;
      });
  }, [cull.visible, layout.nodes, nodeById, effective, themeColors, selectedId]);

  // Edge geometry is computed in world space, then flattened to a screen-space
  // cubic both for drawing and for picking.
  const edgeCurves = useMemo(() => {
    const geometry = edgeAnchors(layout);
    return geometry.map((geo) => {
      const { cp1, cp2 } = smoothEdgeControlPoints(geo);
      const start = worldToScreen(effective, geo.startPoint);
      const end = worldToScreen(effective, geo.endPoint);
      const sCp1 = worldToScreen(effective, cp1);
      const sCp2 = worldToScreen(effective, cp2);
      const curve: Cubic = { p0: start, cp1: sCp1, cp2: sCp2, p3: end };
      const d = pathToString(curveTo(moveTo(createPath(), start), sCp1, sCp2, end));
      return { id: geo.edge.id ?? `${geo.edge.source}->${geo.edge.target}`, curve, d };
    });
  }, [layout, effective]);

  // Pan with pointer capture; select on click-without-drag.
  const pointerState = useRef<{ lastX: number; lastY: number; moved: boolean } | null>(null);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(event.pointerId);
    pointerState.current = { lastX: event.clientX, lastY: event.clientY, moved: false };
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const state = pointerState.current;
      if (!state) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (Math.abs(dx) + Math.abs(dy) > CLICK_DRIFT_TOLERANCE) state.moved = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      if (state.moved) update(panBy(effective, { x: dx, y: dy }));
    },
    [effective, update],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const state = pointerState.current;
      pointerState.current = null;
      const svg = svgRef.current;
      svg?.releasePointerCapture?.(event.pointerId);
      if (!state || state.moved || !onSelectNode) return;
      // Background click clears selection unless it landed on an edge curve.
      const rect = svg?.getBoundingClientRect();
      if (!rect) return;
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const hitEdge = edgeCurves.find((edge) => {
        const t = cubicClosestT(edge.curve, point);
        const p = evalCubic(edge.curve, t);
        return Math.hypot(p.x - point.x, p.y - point.y) <= EDGE_PICK_TOLERANCE;
      });
      onSelectNode(hitEdge ? hitEdge.id : null);
    },
    [edgeCurves, onSelectNode],
  );

  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      event.stopPropagation();
      const id = event.currentTarget.getAttribute("data-node-id");
      if (id) onSelectNode?.(id);
    },
    [onSelectNode],
  );

  // React's onWheel is passive; zoom-to-cursor needs preventDefault, so the
  // listener is attached natively with { passive: false }.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const center = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * ZOOM_WHEEL_STEP);
      update(setZoomCentered(effective, clampZoom(effective.zoom * factor), center));
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [effective, update]);

  const gridCell = GRID_CELL * effective.zoom;
  const labelColor = readableForeground(hexToRgb(themeColors.panel));

  return (
    <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${className}`}>
      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none"
        style={{ backgroundColor: themeColors.background }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <defs>
          <pattern
            id="canvas-grid"
            width={gridCell}
            height={gridCell}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${effective.panX % gridCell} ${effective.panY % gridCell})`}
          >
            <path
              d={`M ${gridCell} 0 L 0 0 0 ${gridCell}`}
              fill="none"
              stroke={themeColors.grid}
              strokeWidth={1}
            />
          </pattern>
        </defs>
        <rect
          x={0}
          y={0}
          width={effective.width}
          height={effective.height}
          fill="url(#canvas-grid)"
        />

        <g>
          {edgeCurves.map((edge) => (
            <path
              key={`edge-${edge.id}`}
              d={edge.d}
              fill="none"
              stroke={themeColors.accent}
              strokeWidth={1.5}
              opacity={0.65}
            />
          ))}
        </g>

        <g>
          {visibleNodes.map((node) => (
            <g
              key={`node-${node.id}`}
              transform={`translate(${node.x} ${node.y}) scale(${effective.zoom})`}
              onPointerDown={handleNodePointerDown}
            >
              <CanvasNodeShape node={node} />
              {node.selected ? (
                <path
                  d={node.pathD}
                  fill="none"
                  stroke={themeColors.accent}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </g>
          ))}
        </g>

        {/* Labels stay at a constant screen size regardless of zoom. */}
        <g>
          {visibleNodes.map((node) => (
            <text
              key={`label-${node.id}`}
              x={node.x + node.width / 2}
              y={node.y + node.height / 2}
              fill={labelColor}
              fontSize={12}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              textAnchor="middle"
              dominantBaseline="middle"
              pointerEvents="none"
              style={{ paintOrder: "stroke" }}
              stroke={themeColors.background}
              strokeWidth={3}
            >
              {node.label}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
