/**
 * Vector primitives: 2D points, vectors and rectangles.
 *
 * Ported from the primary design-tool baseline's geometry layer
 * (`common/geom/point.cljc`, `common/geom/rect.cljc`) and the secondary
 * vector editor's `scene-graph/primitives`. Pure math, no DOM.
 *
 * Conventions:
 * - Screen space: +x right, +y DOWN (canvas convention, matches SVG/CSS).
 * - Rectangles are always stored normalised (width/height >= 0); the
 *   constructors take the min corner as `x`/`y` and keep redundant `x1/y1`
 *   (top-left) and `x2/y2` (bottom-right) as derived fields so hot loops can
 *   test overlap without recomputing them.
 */

/** A point or a direction in canvas space. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned rectangle. `x1/y1` and `x2/y2` must stay consistent. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Epsilon used for "close enough" comparisons on canvas-space coordinates. */
export const EPSILON = 1e-9;
/** A rect is considered empty below this side length; guards zero division. */
export const MIN_RECT_SIDE = 0.01;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function isVec2(v: unknown): v is Vec2 {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Vec2).x === "number" &&
    typeof (v as Vec2).y === "number"
  );
}

export function vecZero(): Vec2 {
  return { x: 0, y: 0 };
}

export function vecEquals(a: Vec2, b: Vec2): boolean {
  return almostZero(a.x - b.x) && almostZero(a.y - b.y);
}

export function almostZero(v: number, epsilon = EPSILON): boolean {
  return Math.abs(v) < epsilon;
}

export function almostEqual(a: number, b: number, epsilon = EPSILON): boolean {
  return Math.abs(a - b) < epsilon;
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function negate(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y };
}

export function scale(a: Vec2, factor: number): Vec2 {
  return { x: a.x * factor, y: a.y * factor };
}

/** Component-wise multiply (useful for scale matrices). */
export function multiplyComponents(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x * b.x, y: a.y * b.y };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** The 2D cross product — signed area of the parallelogram, sign gives turn direction. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** The vector from `from` to `to`. */
export function toVec(from: Vec2, to: Vec2): Vec2 {
  return { x: to.x - from.x, y: to.y - from.y };
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function lengthSquared(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len > EPSILON ? { x: a.x / len, y: a.y / len } : { x: 0, y: 0 };
}

/**
 * Angle of `a` in radians, measured clockwise from +x in screen space
 * (because +y points down, the usual atan2 negation applies).
 */
export function angle(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

/** Signed angle from `a` to `b`, in radians, normalised to [-PI, PI]. */
export function angleBetween(a: Vec2, b: Vec2): number {
  const cos = clamp(dot(normalize(a), normalize(b)), -1, 1);
  const signed = Math.atan2(cross(a, b), dot(a, b));
  return Math.sign(signed) * Math.acos(cos);
}

export function rotate(a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** The point arrived at by travelling `distance` from `origin` along `radians`. */
export function pointAtAngle(origin: Vec2, radians: number, distance: number): Vec2 {
  return { x: origin.x + distance * Math.cos(radians), y: origin.y - distance * Math.sin(radians) };
}

// ---------------------------------------------------------------------------
// Rectangles
// ---------------------------------------------------------------------------

export function makeRect(x = 0, y = 0, width = 0, height = 0): Rect {
  const w = Math.max(width, MIN_RECT_SIDE);
  const h = Math.max(height, MIN_RECT_SIDE);
  return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
}

export const emptyRect: Rect = makeRect(0, 0, MIN_RECT_SIDE, MIN_RECT_SIDE);

/** Build the smallest rect containing every point (handles 0/1/many points). */
export function pointsToRect(points: readonly Vec2[]): Rect {
  if (points.length === 0) return makeRect(0, 0, MIN_RECT_SIDE, MIN_RECT_SIDE);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return makeRect(0, 0, MIN_RECT_SIDE, MIN_RECT_SIDE);
  return makeRect(
    minX,
    minY,
    Math.max(maxX - minX, MIN_RECT_SIDE),
    Math.max(maxY - minY, MIN_RECT_SIDE),
  );
}

/** Rect from two opposite corners (any ordering). */
export function rectFromCorners(p1: Vec2, p2: Vec2): Rect {
  return makeRect(
    Math.min(p1.x, p2.x),
    Math.min(p1.y, p2.y),
    Math.abs(p2.x - p1.x),
    Math.abs(p2.y - p1.y),
  );
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectTopLeft(r: Rect): Vec2 {
  return { x: r.x1, y: r.y1 };
}

export function rectBottomRight(r: Rect): Vec2 {
  return { x: r.x2, y: r.y2 };
}

export function rectCorners(r: Rect): [Vec2, Vec2, Vec2, Vec2] {
  return [
    { x: r.x1, y: r.y1 },
    { x: r.x2, y: r.y1 },
    { x: r.x2, y: r.y2 },
    { x: r.x1, y: r.y2 },
  ];
}

export function rectArea(r: Rect): number {
  return r.width * r.height;
}

export function rectIsEmpty(r: Rect): boolean {
  return r.width <= MIN_RECT_SIDE || r.height <= MIN_RECT_SIDE;
}

export function expandRect(r: Rect, delta: number): Rect {
  return makeRect(r.x1 - delta, r.y1 - delta, r.width + delta * 2, r.height + delta * 2);
}

export function translateRect(r: Rect, by: Vec2): Rect {
  return makeRect(r.x + by.x, r.y + by.y, r.width, r.height);
}

export function scaleRect(r: Rect, by: Vec2, center: Vec2 = rectCenter(r)): Rect {
  const p1 = scalePointAbout(rTopLeft(r), by, center);
  const p2 = scalePointAbout(rectBottomRight(r), by, center);
  return rectFromCorners(p1, p2);
}

function rTopLeft(r: Rect): Vec2 {
  return { x: r.x1, y: r.y1 };
}

function scalePointAbout(p: Vec2, by: Vec2, center: Vec2): Vec2 {
  return { x: center.x + (p.x - center.x) * by.x, y: center.y + (p.y - center.y) * by.y };
}

/** Smallest rect containing both inputs. */
export function joinRects(a: Rect, b: Rect): Rect {
  return makeRect(
    Math.min(a.x1, b.x1),
    Math.min(a.y1, b.y1),
    Math.max(a.x2, b.x2) - Math.min(a.x1, b.x1),
    Math.max(a.y2, b.y2) - Math.min(a.y1, b.y1),
  );
}

/** Smallest rect contained in both inputs, or `emptyRect` when they do not overlap. */
export function intersectRects(a: Rect, b: Rect): Rect {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 < x1 || y2 < y1) return makeRect(0, 0, MIN_RECT_SIDE, MIN_RECT_SIDE);
  return makeRect(x1, y1, x2 - x1, y2 - y1);
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/** Touching edges count, so a shape flush with the viewport edge is visible. */
export function rectsOverlapOrTouch(a: Rect, b: Rect): boolean {
  return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
}

export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x1 >= outer.x1 && inner.x2 <= outer.x2 && inner.y1 >= outer.y1 && inner.y2 <= outer.y2
  );
}
