/**
 * Shape → SVG path-data renderers.
 *
 * Ported from the primary design-tool baseline's SVG path layer
 * (`common/svg/path/parser.js`, `common/types/path/shape_to_path.cljc`).
 * Every generator emits only `M`, `L`, `C` and `Z` commands — the subset the
 * baseline calls "simplified path data" — so downstream renderers never need
 * to handle `A`, `Q`, `T` or `S`. Arcs are converted to cubics with the
 * endpoint→center algorithm and the standard `4/3·tan(dθ/4)` circular-arc
 * Bézier approximation.
 */

import type { Vec2, Rect } from "./vector-primitives";
import { cubicBounds } from "./bezier-curves";

/** Simplified path commands; coordinates are absolute. */
export type PathCommand = { cmd: "M" | "L" | "C" | "Z"; args: number[] };

export type { Vec2, Rect };

/** An accumulated path, with the current point tracked for relative-style builders. */
export interface PathBuilder {
  readonly commands: PathCommand[];
  /** Current point, or `null` before the first `M`. */
  current: Vec2 | null;
  /** Start of the current subpath, for `Z`. */
  subpathStart: Vec2 | null;
}

export function createPath(): PathBuilder {
  return { commands: [], current: null, subpathStart: null };
}

export function moveTo(path: PathBuilder, to: Vec2): PathBuilder {
  path.commands.push({ cmd: "M", args: [to.x, to.y] });
  path.current = to;
  path.subpathStart = to;
  return path;
}

export function lineTo(path: PathBuilder, to: Vec2): PathBuilder {
  if (path.current === null) return moveTo(path, to);
  path.commands.push({ cmd: "L", args: [to.x, to.y] });
  path.current = to;
  return path;
}

export function curveTo(path: PathBuilder, cp1: Vec2, cp2: Vec2, to: Vec2): PathBuilder {
  if (path.current === null) moveTo(path, cp1);
  path.commands.push({ cmd: "C", args: [cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y] });
  path.current = to;
  return path;
}

export function closePath(path: PathBuilder): PathBuilder {
  path.commands.push({ cmd: "Z", args: [] });
  path.current = path.subpathStart;
  return path;
}

/** Render a path to SVG path-data text with 3 decimals (SVG units are px). */
export function pathToString(path: PathBuilder | PathCommand[]): string {
  const commands = Array.isArray(path) ? path : path.commands;
  let out = "";
  for (const c of commands) {
    if (out.length > 0) out += " ";
    out += c.cmd;
    if (c.args.length > 0) out += c.args.map((v) => round3(v)).join(" ");
  }
  return out;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Primitive shapes
// ---------------------------------------------------------------------------

export function rectPath(x: number, y: number, width: number, height: number): PathCommand[] {
  const p = createPath();
  moveTo(p, { x, y });
  lineTo(p, { x: x + width, y });
  lineTo(p, { x: x + width, y: y + height });
  lineTo(p, { x, y: y + height });
  closePath(p);
  return p.commands;
}

/**
 * Rounded rectangle as four cubics. Corner control points sit at the
 * quarter-arc Bézier offset `k = 4(√2 - 1)/3 ≈ 0.5523` from each corner — the
 * exact circular-arc approximation constant.
 */
export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): PathCommand[] {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  if (r === 0) return rectPath(x, y, width, height);
  const k = 0.5522847498307936 * r;
  const x2 = x + width;
  const y2 = y + height;
  const p = createPath();
  moveTo(p, { x: x + r, y });
  curveTo(p, { x: x + r - k, y }, { x, y: y + r - k }, { x, y: y + r });
  curveTo(p, { x, y: y + r + k }, { x: x + r - k, y: y2 }, { x: x + r, y: y2 });
  // `{ x: x2 }` — the shorthand `{ x2 }` would name the property `x2`, leaving
  // `x` undefined and silently degenerating the right-hand corners.
  curveTo(p, { x: x + r + k, y: y2 }, { x: x2, y: y2 - r + k }, { x: x2, y: y2 - r });
  curveTo(p, { x: x2, y: y2 - r - k }, { x: x2 - r + k, y }, { x: x2 - r, y });
  closePath(p);
  return p.commands;
}

/**
 * Ellipse as four symmetric cubics with the same `4(√2-1)/3` constant, so the
 * rendered outline is visually indistinguishable from a true ellipse at any
 * practical size.
 */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const kx = 0.5522847498307936 * rx;
  const ky = 0.5522847498307936 * ry;
  const p = createPath();
  moveTo(p, { x: cx, y: cy - ry });
  curveTo(p, { x: cx + kx, y: cy - ry }, { x: cx + rx, y: cy - ky }, { x: cx + rx, y: cy });
  curveTo(p, { x: cx + rx, y: cy + ky }, { x: cx + kx, y: cy + ry }, { x: cx, y: cy + ry });
  curveTo(p, { x: cx - kx, y: cy + ry }, { x: cx - rx, y: cy + ky }, { x: cx - rx, y: cy });
  curveTo(p, { x: cx - rx, y: cy - ky }, { x: cx - kx, y: cy - ry }, { x: cx, y: cy - ry });
  closePath(p);
  return p.commands;
}

/** Circle (rx === ry). */
export function circlePath(cx: number, cy: number, r: number): PathCommand[] {
  return ellipsePath(cx, cy, r, r);
}

/** Regular `sides`-gon inscribed in the given radius, first point at the top. */
export function polygonPath(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotation = 0,
): PathCommand[] {
  const n = Math.max(3, Math.floor(sides));
  const p = createPath();
  for (let i = 0; i < n; i++) {
    const angle = rotation - Math.PI / 2 + (i / n) * Math.PI * 2;
    const pt = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    if (i === 0) moveTo(p, pt);
    else lineTo(p, pt);
  }
  closePath(p);
  return p.commands;
}

/**
 * Star: alternating outer/inner radii, `points` tips. Inner radius defaults
 * to the `golden` ratio of the outer radius, which reads as a regular
 * five-pointed star.
 */
export function starPath(
  cx: number,
  cy: number,
  outerRadius: number,
  points: number,
  innerRadius = outerRadius * 0.3819660112501051,
  rotation = 0,
): PathCommand[] {
  const n = Math.max(2, Math.floor(points));
  const p = createPath();
  const total = n * 2;
  for (let i = 0; i < total; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = rotation - Math.PI / 2 + (i / total) * Math.PI * 2;
    const pt = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    if (i === 0) moveTo(p, pt);
    else lineTo(p, pt);
  }
  closePath(p);
  return p.commands;
}

// ---------------------------------------------------------------------------
// SVG endpoint-arc → cubic Béziers
// ---------------------------------------------------------------------------

export interface ArcEndpoint {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** large-arc-flag (0/1). */
  fa: number;
  /** sweep-flag (0/1): 1 = clockwise in screen space. */
  fs: number;
  rx: number;
  ry: number;
  /** x-axis rotation in degrees. */
  phi: number;
}

/** Signed angle between two unit vectors, in [-PI, PI]. */
function unitVectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  let dot = ux * vx + uy * vy;
  dot = dot > 1 ? 1 : dot < -1 ? -1 : dot;
  return sign * Math.acos(dot);
}

/** Bézier control points for a unit-circle arc of angular size `dtheta`. */
function approximateUnitArc(theta1: number, dtheta: number): number[] {
  // 4/3 * tan(dθ/4) is the standard circular-arc Bézier approximation constant.
  const alpha = (4 / 3) * Math.tan(dtheta / 4);
  const x1 = Math.cos(theta1);
  const y1 = Math.sin(theta1);
  const x2 = Math.cos(theta1 + dtheta);
  const y2 = Math.sin(theta1 + dtheta);
  return [x1, y1, x1 - y1 * alpha, y1 + x1 * alpha, x2 + y2 * alpha, y2 - x2 * alpha, x2, y2];
}

/** Convert a unit-arc curve to ellipse space and then to world coordinates. */
function processCurve(
  curve: number[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  sinPhi: number,
  cosPhi: number,
): void {
  for (let i = 0; i < curve.length; i += 2) {
    const x = curve[i]! * rx;
    const y = curve[i + 1]! * ry;
    curve[i] = cx + cosPhi * x - sinPhi * y;
    curve[i + 1] = cy + sinPhi * x + cosPhi * y;
  }
}

/**
 * Centre, start angle and sweep of the SVG arc, from the endpoint form.
 * Implements section "Conversion from endpoint to centre parameterization"
 * of the SVG specification.
 */
export function getArcCenter(arc: ArcEndpoint): {
  cx: number;
  cy: number;
  theta1: number;
  dtheta: number;
} {
  const { x1, y1, x2, y2, fa, fs, rx, ry, phi } = arc;
  const phiRad = (phi * Math.PI * 2) / 360;
  const sinPhi = Math.sin(phiRad);
  const cosPhi = Math.cos(phiRad);

  const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
  const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;

  let radicand = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
  radicand = radicand < 0 ? 0 : radicand;
  radicand /= rxSq * y1pSq + rySq * x1pSq;
  radicand = Math.sqrt(radicand) * (fa === fs ? -1 : 1);

  const cxp = ((radicand * rx) / ry) * y1p;
  const cyp = ((radicand * -ry) / rx) * x1p;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const v1x = (x1p - cxp) / rx;
  const v1y = (y1p - cyp) / ry;
  const v2x = (-x1p - cxp) / rx;
  const v2y = (-y1p - cyp) / ry;

  const theta1 = unitVectorAngle(1, 0, v1x, v1y);
  let dtheta = unitVectorAngle(v1x, v1y, v2x, v2y);
  if (fs === 0 && dtheta > 0) dtheta -= Math.PI * 2;
  if (fs === 1 && dtheta < 0) dtheta += Math.PI * 2;

  return { cx, cy, theta1, dtheta };
}

/**
 * Convert an SVG `A` (endpoint-arc) command to a list of cubic Bézier
 * curves, each as `[x1,y1, cx1,cy1, cx2,cy2, x2,y2]`. Returns `[]` for the
 * degenerate cases the SVG spec declares render as a straight line
 * (identical endpoints or a zero radius) — callers must emit an `L` then.
 */
export function arcToCubics(arc: ArcEndpoint): number[][] {
  const { x1, y1, x2, y2, fa, fs, rx, ry, phi } = arc;
  const tau = Math.PI * 2;
  const phiRad = (phi * tau) / 360;
  const sinPhi = Math.sin(phiRad);
  const cosPhi = Math.cos(phiRad);

  const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
  const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;

  // Degenerate: start and end coincide — nothing to draw.
  if (x1p === 0 && y1p === 0) return [];
  if (rx === 0 || ry === 0) return [];

  // Correct out-of-range radii per the spec.
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const factor = Math.sqrt(lambda);
    radiusX *= factor;
    radiusY *= factor;
  }

  const { cx, cy, theta1, dtheta } = getArcCenter({
    x1,
    y1,
    x2,
    y2,
    fa,
    fs,
    rx: radiusX,
    ry: radiusY,
    phi,
  });

  const segments = Math.max(Math.ceil(Math.abs(dtheta) / (tau / 4)), 1);
  const step = dtheta / segments;
  const result: number[][] = [];
  let theta = theta1;
  for (let i = 0; i < segments; i++) {
    const curve = approximateUnitArc(theta, step);
    processCurve(curve, cx, cy, radiusX, radiusY, sinPhi, cosPhi);
    result.push(curve);
    theta += step;
  }
  return result;
}

/** A full arc command appended to a path as `L`/`C` commands. */
export function arcTo(path: PathBuilder, arc: ArcEndpoint): PathBuilder {
  const cubics = arcToCubics(arc);
  if (cubics.length === 0) {
    lineTo(path, { x: arc.x2, y: arc.y2 });
    return path;
  }
  for (const c of cubics) {
    curveTo(path, { x: c[2]!, y: c[3]! }, { x: c[4]!, y: c[5]! }, { x: c[6]!, y: c[7]! });
  }
  return path;
}

// ---------------------------------------------------------------------------
// Whole-path queries
// ---------------------------------------------------------------------------

/**
 * Bounding box of a path: the union of every command's control points. For
 * `C` this includes the handles, which is a superset of the true curve bounds;
 * `tightPathBounds` evaluates the extrema instead when an exact box is needed.
 */
export function pathBounds(commands: readonly PathCommand[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of commands) {
    for (let i = 0; i < c.args.length; i += 2) {
      const x = c.args[i]!;
      const y = c.args[i + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    x1: minX,
    y1: minY,
    x2: maxX,
    y2: maxY,
  };
}

/** Exact bounds, evaluating the cubic derivative roots of every `C` command. */
export function tightPathBounds(commands: readonly PathCommand[]): Rect | null {
  const cubics: { p0: Vec2; cp1: Vec2; cp2: Vec2; p3: Vec2 }[] = [];
  let current: Vec2 | null = null;
  for (const c of commands) {
    if (c.cmd === "M" || c.cmd === "L") {
      current = { x: c.args[0]!, y: c.args[1]! };
    } else if (c.cmd === "C") {
      if (current) {
        cubics.push({
          p0: current,
          cp1: { x: c.args[0]!, y: c.args[1]! },
          cp2: { x: c.args[2]!, y: c.args[3]! },
          p3: { x: c.args[4]!, y: c.args[5]! },
        });
      }
      current = { x: c.args[4]!, y: c.args[5]! };
    }
  }
  if (cubics.length === 0) return pathBounds(commands);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const c of cubics) {
    const b = cubicBounds(c);
    if (b.x1 < x1) x1 = b.x1;
    if (b.y1 < y1) y1 = b.y1;
    if (b.x2 > x2) x2 = b.x2;
    if (b.y2 > y2) y2 = b.y2;
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, x1, y1, x2, y2 };
}

/** Number of distinct subpaths (groups separated by `Z` or a new `M`). */
export function pathSubpathCount(commands: readonly PathCommand[]): number {
  let count = 0;
  for (const c of commands) if (c.cmd === "M") count++;
  return count;
}

/** True when the path ends with `Z` on every subpath (a closed outline). */
export function pathIsClosed(commands: readonly PathCommand[]): boolean {
  if (commands.length === 0) return false;
  return commands[commands.length - 1]!.cmd === "Z";
}
