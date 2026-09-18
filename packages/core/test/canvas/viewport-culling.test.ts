import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  affineToViewport,
  cullByViewport,
  cullTree,
  distanceToSegment,
  fitToBounds,
  fitToRects,
  hitsScreenRect,
  isVisibleAtZoom,
  minimapProjection,
  minimapToWorld,
  minimapViewportRect,
  panBy,
  screenDeltaToWorld,
  screenToWorld,
  setZoomCentered,
  snapPointToPixelGrid,
  snapToPixelGrid,
  transformPointThroughViewport,
  transformRectThroughViewport,
  viewportInverseAffine,
  viewportToAffine,
  visibleWorldRect,
  worldRectToScreen,
  worldToScreen,
  worldToMinimap,
  zoomBy,
  createViewport,
} from "../../src/canvas/viewport-culling";
import { makeRect } from "../../src/canvas/vector-primitives";
import type { Viewport } from "../../src/canvas/viewport-culling";

describe("viewport", () => {
  it("maps between screen and world space", () => {
    const vp = createViewport(800, 600);
    expect(vp).toEqual<Viewport>({ panX: 0, panY: 0, zoom: 1, width: 800, height: 600 });
    expect(visibleWorldRect(vp)).toMatchObject({ x1: 0, y1: 0, x2: 800, y2: 600 });
    expect(worldToScreen(vp, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    // screen = world * zoom + pan
    const moved: Viewport = { ...vp, panX: 100, panY: 50, zoom: 2 };
    expect(worldToScreen(moved, { x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
    expect(screenToWorld(moved, { x: 120, y: 70 })).toEqual({ x: 10, y: 10 });
    expect(screenDeltaToWorld(moved, { x: 20, y: 20 })).toEqual({ x: 10, y: 10 });
    // Panning pans the visible world rect the other way.
    expect(visibleWorldRect(moved)).toMatchObject({ x1: -50, y1: -25, x2: 350, y2: 275 });
    // Round-tripping through the camera is the identity.
    for (const p of [
      { x: 0, y: 0 },
      { x: -33, y: 97 },
      { x: 400, y: 300 },
    ]) {
      expect(screenToWorld(moved, worldToScreen(moved, p))).toEqual(p);
    }
  });

  it("converts to and from an affine matrix", () => {
    const vp: Viewport = { panX: 12, panY: 34, zoom: 3, width: 100, height: 50 };
    const matrix = viewportToAffine(vp);
    expect(matrix).toEqual({ a: 3, b: 0, c: 0, d: 3, e: 12, f: 34 });
    expect(affineToViewport(matrix, 100, 50)).toEqual(vp);
    // The inverse matrix maps screen back to world.
    const inverse = viewportInverseAffine(vp);
    expect(inverse.a).toBeCloseTo(1 / 3);
    expect(inverse.e).toBeCloseTo(-4);
    expect(transformPointThroughViewport({ x: 10, y: 20 }, vp)).toEqual(
      worldToScreen(vp, { x: 10, y: 20 }),
    );
    expect(transformRectThroughViewport(makeRect(0, 0, 10, 10), vp)).toMatchObject({
      x1: 12,
      y1: 34,
      x2: 42,
      y2: 64,
    });
  });

  it("pans and zooms around a chosen centre", () => {
    const vp = createViewport(800, 600);
    const panned = panBy(vp, { x: 10, y: -10 });
    expect(panned).toMatchObject({ panX: 10, panY: -10 });
    // Zooming about the viewport centre keeps that world point fixed.
    const zoomed = zoomBy(vp, 2);
    expect(zoomed.zoom).toBeCloseTo(2);
    expect(screenToWorld(zoomed, { x: 400, y: 300 })).toEqual({ x: 400, y: 300 });
    // Zooming about an off-centre point keeps THAT point fixed.
    const around = setZoomCentered(vp, 2, { x: 100, y: 200 });
    expect(screenToWorld(around, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(around.panX).toBeCloseTo(-100);
    expect(around.panY).toBeCloseTo(-200);
  });

  it("clamps the zoom range", () => {
    expect(MIN_ZOOM).toBeCloseTo(0.01);
    expect(MAX_ZOOM).toBe(256);
    const vp = createViewport(800, 600);
    expect(zoomBy(vp, 1000).zoom).toBeCloseTo(MAX_ZOOM);
    expect(zoomBy(vp, 0.00001).zoom).toBeCloseTo(MIN_ZOOM);
  });

  it("fits bounds into view with padding", () => {
    const vp = createViewport(800, 600);
    // A 100x100 square in a 800x600 viewport with 48px padding fits to the
    // height: (600 - 96) / 100 = 5.04, and is centred.
    const fitted = fitToBounds(vp, makeRect(0, 0, 100, 100));
    expect(fitted.zoom).toBeCloseTo(5.04);
    expect(fitted.panX).toBeCloseTo(148);
    expect(fitted.panY).toBeCloseTo(48);
    // The fitted bounds are centred and fully visible.
    expect(worldToScreen(fitted, { x: 0, y: 0 }).x).toBeCloseTo(148);
    expect(worldToScreen(fitted, { x: 100, y: 100 }).x).toBeCloseTo(652);
    // An empty bounds region leaves the camera alone.
    expect(fitToBounds(vp, makeRect(5, 5, 0.001, 0.001))).toEqual(vp);
    // Multiple rects fit their union.
    const multi = fitToRects(vp, [makeRect(0, 0, 10, 10), makeRect(90, 0, 10, 10)]);
    expect(multi.zoom).toBeCloseTo(fitToBounds(vp, makeRect(0, 0, 100, 10)).zoom);
    expect(fitToRects(vp, [])).toEqual(vp);
  });

  it("culls nodes by their screen bounds", () => {
    const vp = createViewport(800, 600);
    const bounds = new Map<string, ReturnType<typeof makeRect>>([
      ["in", makeRect(0, 0, 10, 10)],
      // Two pixels clear of the right-hand frame: outside the viewport itself,
      // but inside the default 8px margin that keeps strokes and shadows alive.
      ["edge", makeRect(802, 0, 10, 10)],
      ["out", makeRect(2000, 2000, 10, 10)],
    ]);
    const culled = cullByViewport(bounds, vp);
    expect(culled.visible).toContain("in");
    expect(culled.visible).toContain("edge");
    expect(culled.hidden).toEqual(["out"]);
    // A margin keeps near-frame nodes alive.
    const tight = cullByViewport(bounds, vp, 0);
    expect(tight.hidden).toContain("edge");
    // Zooming out pulls the far node back into view.
    const zoomedOut: Viewport = { ...vp, zoom: 0.25 };
    expect(cullByViewport(bounds, zoomedOut).visible).toContain("out");
  });

  it("culls through a transform tree", () => {
    const vp = createViewport(800, 600);
    const world = new Map([
      ["group", makeRect(0, 0, 10, 10)],
      ["member", makeRect(0, 0, 5, 5)],
    ]);
    const culled = cullTree(["group", "member"], (id) => world.get(id) ?? null, vp);
    expect(culled.visible).toEqual(["group", "member"]);
    // A null bounds entry is skipped rather than reported hidden.
    const partial = cullTree(["group", "ghost"], (id) => world.get(id) ?? null, vp);
    expect(partial.hidden).toEqual([]);
  });

  it("detects sub-pixel nodes", () => {
    const vp = createViewport(800, 600);
    expect(isVisibleAtZoom(makeRect(0, 0, 100, 100), vp)).toBe(true);
    const far: Viewport = { ...vp, zoom: 0.0001 };
    expect(isVisibleAtZoom(makeRect(0, 0, 100, 100), far)).toBe(false);
  });

  it("projects the canvas into a minimap", () => {
    const world = makeRect(0, 0, 100, 100);
    const map = makeRect(0, 0, 200, 200);
    const proj = minimapProjection(world, map);
    expect(proj.scale).toBeCloseTo(2);
    expect(proj.offsetX).toBeCloseTo(0);
    expect(proj.offsetY).toBeCloseTo(0);
    expect(worldToMinimap(proj, { x: 50, y: 50 })).toEqual({ x: 100, y: 100 });
    expect(minimapToWorld(proj, { x: 100, y: 100 })).toEqual({ x: 50, y: 50 });
    // A wide world is letterboxed: scale is height-limited and the y offset
    // centres it.
    const wide = minimapProjection(makeRect(0, 0, 100, 50), map);
    expect(wide.scale).toBeCloseTo(2);
    expect(wide.offsetY).toBeCloseTo(50);
    // Degenerate projections are inert.
    expect(minimapProjection(makeRect(0, 0, 0.001, 0.001), map)).toEqual({
      scale: 0,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it("draws the viewport rectangle on the minimap", () => {
    const vp: Viewport = { panX: 0, panY: 0, zoom: 1, width: 400, height: 300 };
    const proj = minimapProjection(makeRect(0, 0, 800, 600), makeRect(0, 0, 200, 200));
    const rect = minimapViewportRect(vp, proj);
    // The viewport covers the left half of the world. The projection is uniform
    // with letterboxing, so the world's 4:3 frame occupies 200x150 of the square
    // map (offset 25 in y) and the viewport maps to 100x75 of it.
    expect(rect.width).toBeCloseTo(100);
    expect(rect.height).toBeCloseTo(75);
    expect(rect.y1).toBeCloseTo(25);
  });

  it("picks guides and handles with a distance test", () => {
    const vertical = { x1: 10, y1: -100, x2: 10, y2: 100 };
    expect(distanceToSegment({ x: 0, y: 0 }, vertical)).toBeCloseTo(10);
    expect(distanceToSegment({ x: 10, y: 5 }, vertical)).toBeCloseTo(0);
    // Past the segment end the distance is to the endpoint, not the line.
    const stub = { x1: 0, y1: 0, x2: 0, y2: 10 };
    expect(distanceToSegment({ x: 30, y: 100 }, stub)).toBeCloseTo(Math.hypot(30, 90));
    // A zero-length segment is a point.
    expect(distanceToSegment({ x: 3, y: 4 }, { x1: 0, y1: 0, x2: 0, y2: 0 })).toBeCloseTo(5);
  });

  it("hits screen rects with tolerance and snaps to the pixel grid", () => {
    const rect = makeRect(100, 100, 50, 50);
    expect(hitsScreenRect({ x: 160, y: 130 }, rect)).toBe(false);
    expect(hitsScreenRect({ x: 160, y: 130 }, rect, 20)).toBe(true);
    const vp = createViewport(800, 600);
    expect(snapToPixelGrid(10.4, vp)).toBeCloseTo(10);
    // At 2x zoom, 10.4 world units land on screen pixel 20.8 → 21 → 10.5 world.
    const zoomed: Viewport = { ...vp, zoom: 2 };
    expect(snapToPixelGrid(10.4, zoomed)).toBeCloseTo(10.5);
    // Same rule on y: 20.6 → screen 41.2 → 41 → 20.5 world.
    expect(snapPointToPixelGrid({ x: 10.4, y: 20.6 }, zoomed)).toEqual({ x: 10.5, y: 20.5 });
  });
});
