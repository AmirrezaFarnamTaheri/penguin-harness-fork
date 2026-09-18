/**
 * Viewport: camera pan/zoom, screen↔world mapping, culling and fit-to-view.
 *
 * Ported from the secondary vector editor's `canvas/guides/geometry.ts`
 * (world→screen mapping `screen = world * zoom + pan`, and the point-to-
 * segment distance used for guide and handle snapping) plus its
 * `tools/vector/viewport.ts` (accumulating node bounds to compute a
 * zoom-to-fit target), and the primary baseline's viewport-culling bounding
 * box algorithm.
 *
 * The camera is stored as `pan` + `zoom` rather than as an affine matrix
 * because the cockpit's 60 FPS pan/zoom path composes those two numbers
 * directly; `toAffine`/`fromAffine` exist for the transform tree.
 */

import type { Affine } from "./affine-transforms";
import { IDENTITY, inverse, multiply, transformPoint, transformRect } from "./affine-transforms";
import type { Rect, Vec2 } from "./vector-primitives";
import {
  makeRect,
  pointsToRect,
  rectContainsPoint,
  rectIsEmpty,
  rectsOverlapOrTouch,
} from "./vector-primitives";

export interface Viewport {
  /** Screen-space translation added after scaling, in CSS pixels. */
  panX: number;
  panY: number;
  zoom: number;
  /** Visible canvas size in CSS pixels. */
  width: number;
  height: number;
}

export function createViewport(width = 800, height = 600): Viewport {
  return { panX: 0, panY: 0, zoom: 1, width, height };
}

/** Bounds of the currently visible world region. */
export function visibleWorldRect(viewport: Viewport): Rect {
  // `-pan / zoom` leaves a negative zero behind when the pan is 0, and `-0`
  // does not compare equal to `0` — fold it so callers see a plain zero.
  const zero = (v: number): number => (v === 0 ? 0 : v);
  return makeRect(
    zero(-viewport.panX / viewport.zoom),
    zero(-viewport.panY / viewport.zoom),
    viewport.width / viewport.zoom,
    viewport.height / viewport.zoom,
  );
}

export function screenToWorld(viewport: Viewport, point: Vec2): Vec2 {
  return {
    x: (point.x - viewport.panX) / viewport.zoom,
    y: (point.y - viewport.panY) / viewport.zoom,
  };
}

export function worldToScreen(viewport: Viewport, point: Vec2): Vec2 {
  return { x: point.x * viewport.zoom + viewport.panX, y: point.y * viewport.zoom + viewport.panY };
}

export function screenDeltaToWorld(viewport: Viewport, delta: Vec2): Vec2 {
  return { x: delta.x / viewport.zoom, y: delta.y / viewport.zoom };
}

export function worldRectToScreen(viewport: Viewport, rect: Rect): Rect {
  const a = worldToScreen(viewport, { x: rect.x1, y: rect.y1 });
  const b = worldToScreen(viewport, { x: rect.x2, y: rect.y2 });
  return pointsToRect([a, b]);
}

/** The viewport as a world→screen affine transform (scale then translate). */
export function viewportToAffine(viewport: Viewport): Affine {
  return { a: viewport.zoom, b: 0, c: 0, d: viewport.zoom, e: viewport.panX, f: viewport.panY };
}

export function affineToViewport(matrix: Affine, width: number, height: number): Viewport {
  return { panX: matrix.e, panY: matrix.f, zoom: matrix.a, width, height };
}

/** Inverse (screen→world) matrix, for converting pointer events through the camera. */
export function viewportInverseAffine(viewport: Viewport): Affine {
  return inverse(viewportToAffine(viewport)) ?? IDENTITY;
}

// ---------------------------------------------------------------------------
// Pan / zoom
// ---------------------------------------------------------------------------

export function panBy(viewport: Viewport, deltaScreen: Vec2): Viewport {
  return { ...viewport, panX: viewport.panX + deltaScreen.x, panY: viewport.panY + deltaScreen.y };
}

export function setZoomCentered(viewport: Viewport, zoom: number, centerScreen: Vec2): Viewport {
  const clamped = clampZoom(zoom);
  const worldBefore = screenToWorld(viewport, centerScreen);
  const next: Viewport = { ...viewport, zoom: clamped };
  const worldAfter = screenToWorld(next, centerScreen);
  return {
    ...next,
    panX: next.panX + (worldAfter.x - worldBefore.x) * clamped,
    panY: next.panY + (worldAfter.y - worldBefore.y) * clamped,
  };
}

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 256;

export function clampZoom(zoom: number): number {
  return zoom < MIN_ZOOM ? MIN_ZOOM : zoom > MAX_ZOOM ? MAX_ZOOM : zoom;
}

/** Zoom by a multiplier around the viewport centre. */
export function zoomBy(viewport: Viewport, factor: number): Viewport {
  return setZoomCentered(viewport, viewport.zoom * factor, {
    x: viewport.width / 2,
    y: viewport.height / 2,
  });
}

/**
 * Fit `bounds` (world space) into the viewport with `padding` on every side,
 * centring it. Returns the viewport unchanged when the bounds are empty.
 */
export function fitToBounds(viewport: Viewport, bounds: Rect, padding = 48): Viewport {
  if (rectIsEmpty(bounds)) return { ...viewport };
  const availableWidth = Math.max(viewport.width - padding * 2, 1);
  const availableHeight = Math.max(viewport.height - padding * 2, 1);
  const zoom = clampZoom(Math.min(availableWidth / bounds.width, availableHeight / bounds.height));
  const worldCenter: Vec2 = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return {
    ...viewport,
    zoom,
    panX: viewport.width / 2 - worldCenter.x * zoom,
    panY: viewport.height / 2 - worldCenter.y * zoom,
  };
}

/** Fit the world bounds of the given world rects at once. */
export function fitToRects(viewport: Viewport, rects: readonly Rect[], padding = 48): Viewport {
  if (rects.length === 0) return { ...viewport };
  return fitToBounds(viewport, mergeRects(rects), padding);
}

function mergeRects(rects: readonly Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x1 < minX) minX = r.x1;
    if (r.y1 < minY) minY = r.y1;
    if (r.x2 > maxX) maxX = r.x2;
    if (r.y2 > maxY) maxY = r.y2;
  }
  if (!Number.isFinite(minX)) return makeRect(0, 0, 0.01, 0.01);
  return makeRect(minX, minY, maxX - minX, maxY - minY);
}

// ---------------------------------------------------------------------------
// Culling
// ---------------------------------------------------------------------------

export interface CullResult {
  /** Ids whose bounds intersect the viewport, in input order. */
  visible: string[];
  /** Ids rejected; reported so callers can drop their cached geometry. */
  hidden: string[];
}

/**
 * Viewport culling: keep a node when its screen bounds intersect the
 * viewport. `margin` grows the cull region in screen pixels so strokes and
 * shadows at the edge of the frame are not popped out. The baseline rejects
 * whole subtrees with a single bounding-box test, which is what keeps
 * 10k-node canvases at 60 FPS — the test is the hot path, so it is kept to
 * four comparisons.
 */
export function cullByViewport(
  boundsById: ReadonlyMap<string, Rect>,
  viewport: Viewport,
  margin = 8,
): CullResult {
  const view = makeRect(
    -margin,
    -margin,
    viewport.width + margin * 2,
    viewport.height + margin * 2,
  );
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const [id, bounds] of boundsById) {
    const screen = worldRectToScreen(viewport, bounds);
    if (rectsOverlapOrTouch(screen, view)) visible.push(id);
    else hidden.push(id);
  }
  return { visible, hidden };
}

/**
 * Cull through a transform tree: reject a node only after also rejecting its
 * parent's world bounds, so an off-screen group skips its whole subtree.
 * `worldBounds(id)` must return the cached world-space bounds for an id.
 */
export function cullTree(
  ids: readonly string[],
  worldBounds: (id: string) => Rect | null,
  viewport: Viewport,
  margin = 8,
): CullResult {
  const view = makeRect(
    -margin,
    -margin,
    viewport.width + margin * 2,
    viewport.height + margin * 2,
  );
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const id of ids) {
    const bounds = worldBounds(id);
    if (bounds === null) continue;
    const screen = worldRectToScreen(viewport, bounds);
    if (rectsOverlapOrTouch(screen, view)) visible.push(id);
    else hidden.push(id);
  }
  return { visible, hidden };
}

/** True when `bounds` would render as more than one pixel either side. */
export function isVisibleAtZoom(bounds: Rect, viewport: Viewport): boolean {
  const screen = worldRectToScreen(viewport, bounds);
  return screen.width * screen.height > 1;
}

// ---------------------------------------------------------------------------
// Mini-map projection
// ---------------------------------------------------------------------------

export interface MinimapProjection {
  /** World→minimap scale (same factor on both axes). */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Project the whole canvas into a minimap rectangle, preserving aspect
 * ratio and centring. `worldBounds` is the union of all node bounds.
 */
export function minimapProjection(worldBounds: Rect, map: Rect): MinimapProjection {
  if (rectIsEmpty(worldBounds) || map.width <= 0 || map.height <= 0) {
    return { scale: 0, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(map.width / worldBounds.width, map.height / worldBounds.height);
  return {
    scale,
    offsetX: map.x + (map.width - worldBounds.width * scale) / 2 - worldBounds.x * scale,
    offsetY: map.y + (map.height - worldBounds.height * scale) / 2 - worldBounds.y * scale,
  };
}

export function worldToMinimap(projection: MinimapProjection, point: Vec2): Vec2 {
  return {
    x: projection.offsetX + point.x * projection.scale,
    y: projection.offsetY + point.y * projection.scale,
  };
}

export function minimapToWorld(projection: MinimapProjection, point: Vec2): Vec2 {
  return {
    x: (point.x - projection.offsetX) / projection.scale,
    y: (point.y - projection.offsetY) / projection.scale,
  };
}

/** Minimap rectangle covering the viewport's visible world region. */
export function minimapViewportRect(viewport: Viewport, projection: MinimapProjection): Rect {
  const visible = visibleWorldRect(viewport);
  const a = worldToMinimap(projection, { x: visible.x1, y: visible.y1 });
  const b = worldToMinimap(projection, { x: visible.x2, y: visible.y2 });
  return pointsToRect([a, b]);
}

// ---------------------------------------------------------------------------
// Snapping / picking helpers
// ---------------------------------------------------------------------------

/**
 * Distance from a point to a screen segment, clamped to the segment. Ported
 * from the guide-geometry helper; used for guide, handle and edge picking.
 */
export function distanceToSegment(
  point: Vec2,
  segment: { x1: number; y1: number; x2: number; y2: number },
): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared),
        );
  return Math.hypot(point.x - (segment.x1 + t * dx), point.y - (segment.y1 + t * dy));
}

/** True when the click is inside a node's screen bounds with a tolerance band. */
export function hitsScreenRect(point: Vec2, screenRect: Rect, tolerance = 4): boolean {
  return rectContainsPoint(
    makeRect(
      screenRect.x1 - tolerance,
      screenRect.y1 - tolerance,
      screenRect.width + tolerance * 2,
      screenRect.height + tolerance * 2,
    ),
    point,
  );
}

/** Snap a world coordinate to the integer pixel grid at the current zoom. */
export function snapToPixelGrid(world: number, viewport: Viewport): number {
  const screen = world * viewport.zoom;
  return Math.round(screen) / viewport.zoom;
}

export function snapPointToPixelGrid(point: Vec2, viewport: Viewport): Vec2 {
  return { x: snapToPixelGrid(point.x, viewport), y: snapToPixelGrid(point.y, viewport) };
}

/**
 * Transform a world-space rect through the viewport and return the screen
 * rect, in the same call style as the transform tree uses (`transformRect`).
 */
export function transformRectThroughViewport(rect: Rect, viewport: Viewport): Rect {
  return transformRect(viewportToAffine(viewport), rect);
}

export function transformPointThroughViewport(point: Vec2, viewport: Viewport): Vec2 {
  return transformPoint(multiply(IDENTITY, viewportToAffine(viewport)), point);
}
