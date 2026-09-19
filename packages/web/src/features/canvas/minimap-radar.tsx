/**
 * Mini-map radar view (Track 5, Tier 3).
 *
 * Renders the whole canvas as a small overview using the core minimap
 * projection (aspect-preserving, centred) and marks the viewport's visible
 * region as a rectangle. Clicking converts the click into a world point and
 * hands it back so the parent camera can jump there. Presentational only.
 */
import { useMemo, useRef } from "react";

import {
  CANVAS_THEMES,
  joinRects,
  makeRect,
  minimapProjection,
  minimapViewportRect,
  minimapToWorld,
  rectIsEmpty,
  type Viewport,
  worldToMinimap,
} from "@prismshadow/penguin-core/canvas";
import type { CanvasThemeKey } from "./vector-canvas.js";

interface ThemeColors {
  readonly background: string;
  readonly grid: string;
  readonly accent: string;
  readonly panel: string;
}

// The three cockpit themes are known keys; the cast drops the `| undefined`
// that noUncheckedIndexedAccess otherwise adds to index-signature access.
const THEME_TABLE = CANVAS_THEMES as unknown as Record<CanvasThemeKey, ThemeColors>;

export interface MinimapNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MinimapRadarProps {
  /** Nodes in world coordinates; their union defines the map's content bounds. */
  readonly nodes: readonly MinimapNode[];
  readonly viewport: Viewport;
  readonly selectedId?: string | null;
  readonly theme?: CanvasThemeKey;
  readonly width?: number;
  readonly height?: number;
  /** Called with the world point a click should centre the camera on. */
  readonly onJumpTo?: (world: { x: number; y: number }) => void;
  readonly className?: string;
}

export function MinimapRadar({
  nodes,
  viewport,
  selectedId = null,
  theme = "dark-obsidian",
  width = 160,
  height = 104,
  onJumpTo,
  className = "",
}: MinimapRadarProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const themeColors = THEME_TABLE[theme];

  // Union of every node rect; an empty canvas degenerates to a zero rect and
  // the projection returns scale 0, which the render path handles.
  const worldBounds = useMemo(() => {
    if (nodes.length === 0) return makeRect(0, 0, 0, 0);
    return nodes.reduce(
      (acc, node) => joinRects(acc, makeRect(node.x, node.y, node.width, node.height)),
      makeRect(nodes[0]!.x, nodes[0]!.y, nodes[0]!.width, nodes[0]!.height),
    );
  }, [nodes]);

  const map = useMemo(() => makeRect(0, 0, width, height), [width, height]);
  const projection = useMemo(() => minimapProjection(worldBounds, map), [worldBounds, map]);

  const nodeRects = useMemo(() => {
    if (rectIsEmpty(worldBounds) || projection.scale === 0) return [];
    return nodes.map((node) => {
      const topLeft = worldToMinimap(projection, { x: node.x, y: node.y });
      const bottomRight = worldToMinimap(projection, {
        x: node.x + node.width,
        y: node.y + node.height,
      });
      return {
        id: node.id,
        x: topLeft.x,
        y: topLeft.y,
        width: Math.max(bottomRight.x - topLeft.x, 1),
        height: Math.max(bottomRight.y - topLeft.y, 1),
        selected: node.id === selectedId,
      };
    });
  }, [nodes, projection, worldBounds, selectedId]);

  const viewRect = useMemo(
    () => (projection.scale === 0 ? null : minimapViewportRect(viewport, projection)),
    [viewport, projection],
  );

  const handleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!onJumpTo || projection.scale === 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const local = {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
    onJumpTo(minimapToWorld(projection, local));
  };

  const empty = projection.scale === 0;

  return (
    <div
      className={`overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900 ${className}`}
      title="Mini-map: click to jump"
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onClick={handleClick}
        style={{
          backgroundColor: themeColors.background,
          cursor: empty ? "default" : "crosshair",
        }}
        role="img"
        aria-label="Canvas overview mini-map"
      >
        {empty ? (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={10}
            fill={themeColors.grid}
          >
            empty canvas
          </text>
        ) : (
          <>
            {nodeRects.map((node) => (
              <rect
                key={`mm-${node.id}`}
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={1}
                fill={node.selected ? themeColors.accent : themeColors.panel}
                stroke={node.selected ? themeColors.accent : themeColors.grid}
                strokeWidth={node.selected ? 1.5 : 0.5}
              />
            ))}
            {viewRect ? (
              <rect
                x={viewRect.x}
                y={viewRect.y}
                width={Math.max(viewRect.width, 2)}
                height={Math.max(viewRect.height, 2)}
                fill="none"
                stroke={themeColors.accent}
                strokeWidth={1.5}
                strokeDasharray="3 2"
              />
            ) : null}
          </>
        )}
      </svg>
    </div>
  );
}
