import { describe, expect, it } from "vitest";
import {
  arcTo,
  arcToCubics,
  circlePath,
  closePath,
  createPath,
  curveTo,
  ellipsePath,
  getArcCenter,
  lineTo,
  moveTo,
  pathBounds,
  pathIsClosed,
  pathSubpathCount,
  pathToString,
  polygonPath,
  rectPath,
  roundedRectPath,
  starPath,
  tightPathBounds,
} from "../../src/canvas/shape-renderers";

describe("shape renderers", () => {
  it("builds a path and tracks the current point", () => {
    const p = createPath();
    moveTo(p, { x: 1, y: 2 });
    lineTo(p, { x: 3, y: 4 });
    curveTo(p, { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 });
    expect(p.commands.map((c) => c.cmd)).toEqual(["M", "L", "C"]);
    expect(p.current).toEqual({ x: 6, y: 4 });
    // curveTo before any moveTo seeds the path at the first control point.
    const fresh = createPath();
    curveTo(fresh, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 });
    expect(fresh.commands.map((c) => c.cmd)).toEqual(["M", "C"]);
  });

  it("closes a path and restores the subpath start", () => {
    const p = createPath();
    moveTo(p, { x: 5, y: 5 });
    lineTo(p, { x: 10, y: 5 });
    closePath(p);
    expect(p.current).toEqual({ x: 5, y: 5 });
    expect(pathIsClosed(p.commands)).toBe(true);
    // A path that never closes reports open.
    const open = createPath();
    moveTo(open, { x: 0, y: 0 });
    expect(pathIsClosed(open.commands)).toBe(false);
  });

  it("renders path data with three decimals", () => {
    // The command letter needs no separator before its first coordinate —
    // `M1 2` is valid path data and keeps the serialised path small.
    const p = createPath();
    moveTo(p, { x: 1.00051, y: 2 });
    lineTo(p, { x: 3.1234, y: 4 });
    expect(pathToString(p)).toBe("M1.001 2 L3.123 4");
    expect(pathToString([])).toBe("");
    // Commands are separated by a single space.
    expect(pathToString(rectPath(0, 0, 1, 1))).toBe("M0 0 L1 0 L1 1 L0 1 Z");
  });

  it("renders rectangles", () => {
    expect(pathToString(rectPath(0, 0, 10, 10))).toBe("M0 0 L10 0 L10 10 L0 10 Z");
    // Zero radius degenerates to the plain rect.
    expect(pathToString(roundedRectPath(0, 0, 10, 10, 0))).toBe("M0 0 L10 0 L10 10 L0 10 Z");
    const rounded = roundedRectPath(0, 0, 20, 10, 4);
    expect(rounded.filter((c) => c.cmd === "C")).toHaveLength(4);
    expect(pathSubpathCount(rounded)).toBe(1);
  });

  it("clamps the corner radius to half the shorter side", () => {
    const huge = roundedRectPath(0, 0, 10, 4, 100);
    // The clamped radius is 2 (half the 4px short side), so an absurd radius
    // renders identically to the clamped one.
    expect(pathToString(huge)).toBe(pathToString(roundedRectPath(0, 0, 10, 4, 2)));
    expect(huge.filter((c) => c.cmd === "C")).toHaveLength(4);
    // The control points sit on the box edges, so the bounds are the plain rect.
    expect(pathBounds(huge)).toMatchObject({ x1: 0, y1: 0, x2: 10, y2: 4, width: 10, height: 4 });
    // Every coordinate stays inside the shape's own box.
    for (const command of huge) {
      for (const value of command.args) {
        expect(value).toBeGreaterThanOrEqual(-0.01);
        expect(value).toBeLessThanOrEqual(10.01);
      }
    }
  });

  it("renders ellipses as four cubics", () => {
    const ellipse = ellipsePath(50, 50, 40, 20);
    expect(ellipse.filter((c) => c.cmd === "C")).toHaveLength(4);
    const bounds = pathBounds(ellipse)!;
    expect(bounds.x1).toBeCloseTo(10);
    expect(bounds.x2).toBeCloseTo(90);
    expect(bounds.y1).toBeCloseTo(30);
    expect(bounds.y2).toBeCloseTo(70);
    // A circle is a special ellipse.
    expect(circlePath(0, 0, 5).filter((c) => c.cmd === "C")).toHaveLength(4);
  });

  it("renders polygons and stars", () => {
    const triangle = polygonPath(0, 0, 10, 3);
    expect(triangle.filter((c) => c.cmd === "L")).toHaveLength(2);
    expect(triangle[triangle.length - 1]!.cmd).toBe("Z");
    const star = starPath(0, 0, 10, 5);
    expect(star.filter((c) => c.cmd === "L")).toHaveLength(9);
    expect(pathSubpathCount(star)).toBe(1);
  });

  it("computes the arc centre from the SVG endpoint form", () => {
    // A semicircle from (0,50) to (100,50), large arc off, sweep on, radius 50.
    const centre = getArcCenter({
      x1: 0,
      y1: 50,
      x2: 100,
      y2: 50,
      fa: 0,
      fs: 1,
      rx: 50,
      ry: 50,
      phi: 0,
    });
    expect(centre.cx).toBeCloseTo(50);
    expect(centre.cy).toBeCloseTo(50);
    // The sweep covers half a turn.
    expect(Math.abs(centre.dtheta)).toBeCloseTo(Math.PI);
  });

  it("converts arcs to cubics", () => {
    const cubics = arcToCubics({
      x1: 0,
      y1: 50,
      x2: 100,
      y2: 50,
      fa: 0,
      fs: 1,
      rx: 50,
      ry: 50,
      phi: 0,
    });
    // A semicircle is two quarter-arc segments.
    expect(cubics).toHaveLength(2);
    expect(cubics[0]).toHaveLength(8);
    // The first cubic starts at the arc's start point.
    expect(cubics[0]![0]).toBeCloseTo(0);
    expect(cubics[0]![1]).toBeCloseTo(50);
    // The last cubic ends at the arc's end point.
    const last = cubics[cubics.length - 1]!;
    expect(last[6]).toBeCloseTo(100);
    expect(last[7]).toBeCloseTo(50);
  });

  it("rejects degenerate arcs", () => {
    const same = arcToCubics({
      x1: 10,
      y1: 10,
      x2: 10,
      y2: 10,
      fa: 0,
      fs: 1,
      rx: 50,
      ry: 50,
      phi: 0,
    });
    expect(same).toEqual([]);
    const zeroRadius = arcToCubics({
      x1: 0,
      y1: 10,
      x2: 20,
      y2: 10,
      fa: 0,
      fs: 1,
      rx: 0,
      ry: 0,
      phi: 0,
    });
    expect(zeroRadius).toEqual([]);
  });

  it("grows out-of-range radii to reach the endpoints", () => {
    // An arc whose radius cannot span its endpoints is scaled up by the spec.
    const cubics = arcToCubics({
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 0,
      fa: 1,
      fs: 1,
      rx: 1,
      ry: 1,
      phi: 0,
    });
    expect(cubics.length).toBeGreaterThan(0);
    expect(cubics[0]![0]).toBeCloseTo(0);
  });

  it("appends an arc to a path, falling back to a line when degenerate", () => {
    const p = createPath();
    moveTo(p, { x: 0, y: 50 });
    arcTo(p, { x1: 0, y1: 50, x2: 100, y2: 50, fa: 0, fs: 1, rx: 50, ry: 50, phi: 0 });
    expect(p.commands.filter((c) => c.cmd === "C").length).toBeGreaterThanOrEqual(2);

    const degenerate = createPath();
    moveTo(degenerate, { x: 0, y: 0 });
    arcTo(degenerate, { x1: 0, y1: 0, x2: 0, y2: 0, fa: 0, fs: 1, rx: 0, ry: 0, phi: 0 });
    expect(degenerate.commands.map((c) => c.cmd)).toEqual(["M", "L"]);
  });

  it("bounds paths", () => {
    const bounds = pathBounds(rectPath(5, 6, 10, 20));
    expect(bounds).toMatchObject({ x1: 5, y1: 6, x2: 15, y2: 26 });
    expect(pathBounds([])).toBeNull();
  });

  it("computes tight bounds including curve extrema", () => {
    const p = createPath();
    moveTo(p, { x: 0, y: 0 });
    curveTo(p, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 });
    // The curve bulges to x=7.5 while both endpoints and handles sit at 0/10;
    // control-point bounds would over-report as 10.
    expect(tightPathBounds(p.commands)!.width).toBeCloseTo(7.5);
    expect(pathBounds(p.commands)!.width).toBeCloseTo(10);
    // A path with only line commands falls back to the control-point bounds.
    expect(tightPathBounds(rectPath(0, 0, 1, 1))!.width).toBeCloseTo(1);
  });

  it("counts subpaths and closed state", () => {
    expect(pathSubpathCount(rectPath(0, 0, 1, 1))).toBe(1);
    expect(pathSubpathCount([...rectPath(0, 0, 1, 1), ...rectPath(0, 0, 1, 1)])).toBe(2);
    expect(pathIsClosed(rectPath(0, 0, 1, 1))).toBe(true);
    expect(pathIsClosed([])).toBe(false);
    const open = createPath();
    moveTo(open, { x: 0, y: 0 });
    lineTo(open, { x: 1, y: 0 });
    expect(pathIsClosed(open.commands)).toBe(false);
  });
});
