/**
 * 2D affine transforms in the DOMMatrix / SVG `matrix(a,b,c,d,e,f)` convention.
 *
 * Ported from the primary design-tool baseline's `common/geom/matrix.cljc`.
 * The matrix is stored as the 2x3 linear+translation block of a 3x3 matrix:
 *
 * ```
 * | a c e |   | x |   | a*x + c*y + e |
 * | b d f | * | y | = | b*x + d*y + f |
 * | 0 0 1 |   | 1 |   |      1        |
 * ```
 *
 * so `a/d` are the x/y scale components, `b/c` the rotation/skew shear, and
 * `e/f` the translation. Composition is `multiply(a, b) == a ∘ b`, meaning
 * `b` is applied to the point first and `a` second.
 */

import type { Vec2, Rect } from "./vector-primitives";
import {
  add,
  multiplyComponents,
  pointsToRect,
  scale as scaleVec,
  subtract,
} from "./vector-primitives";

export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function affine(a: number, b: number, c: number, d: number, e: number, f: number): Affine {
  return { a, b, c, d, e, f };
}

export function isAffine(v: unknown): v is Affine {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Affine).a === "number" &&
    typeof (v as Affine).b === "number" &&
    typeof (v as Affine).c === "number" &&
    typeof (v as Affine).d === "number" &&
    typeof (v as Affine).e === "number" &&
    typeof (v as Affine).f === "number"
  );
}

export function equals(a: Affine, b: Affine): boolean {
  return (
    Math.abs(a.a - b.a) < 1e-9 &&
    Math.abs(a.b - b.b) < 1e-9 &&
    Math.abs(a.c - b.c) < 1e-9 &&
    Math.abs(a.d - b.d) < 1e-9 &&
    Math.abs(a.e - b.e) < 1e-9 &&
    Math.abs(a.f - b.f) < 1e-9
  );
}

export function isIdentity(a: Affine): boolean {
  return equals(a, IDENTITY);
}

/** True when only `e`/`f` differ from identity, i.e. a pure translation. */
export function isTranslationOnly(a: Affine): boolean {
  return (
    Math.abs(a.a - 1) < 1e-9 &&
    Math.abs(a.b) < 1e-9 &&
    Math.abs(a.c) < 1e-9 &&
    Math.abs(a.d - 1) < 1e-9
  );
}

/**
 * Compose two matrices. `multiply(a, b)` applies `b` first, then `a` —
 * the same order as SVG's `transform="a b"` list and DOMMatrix.multiply.
 * `null`/`undefined` operands are treated as the identity.
 */
export function multiply(a: Affine | null, b: Affine | null): Affine {
  if (a === null || a === undefined) return b ?? IDENTITY;
  if (b === null || b === undefined) return a;
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

/** Left-fold a chain: `multiplyChain(m0, m1, m2)` == m0∘m1∘m2. */
export function multiplyChain(...matrices: (Affine | null)[]): Affine {
  return matrices.reduce<Affine>((acc, m) => multiply(acc, m), IDENTITY);
}

/** Fast path for composing two translations — only `e`/`f` can be non-zero. */
export function addTranslate(a: Affine, b: Affine): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: a.e + b.e, f: a.f + b.f };
}

/** Component-wise difference of two matrices; used by delta-based change detection. */
export function subtractMatrices(a: Affine, b: Affine): Affine {
  return {
    a: a.a - b.a,
    b: a.b - b.b,
    c: a.c - b.c,
    d: a.d - b.d,
    e: a.e - b.e,
    f: a.f - b.f,
  };
}

/** Determinant of the linear part (negative means the transform mirrors). */
export function determinant(a: Affine): number {
  return a.a * a.d - a.c * a.b;
}

/** True when the transform flips handedness (reflection or negative scale). */
export function isMirrored(a: Affine): boolean {
  return determinant(a) < 0;
}

/** Inverse, or `null` if the transform is singular (degenerate scale). */
export function inverse(a: Affine): Affine | null {
  const det = determinant(a);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return {
    a: a.d * invDet,
    b: -a.b * invDet,
    c: -a.c * invDet,
    d: a.a * invDet,
    e: (a.c * a.f - a.d * a.e) * invDet,
    f: (a.b * a.e - a.a * a.f) * invDet,
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function translation(x: number, y: number): Affine;
export function translation(by: Vec2): Affine;
export function translation(xOrVec: number | Vec2, y?: number): Affine {
  if (typeof xOrVec === "number") return { a: 1, b: 0, c: 0, d: 1, e: xOrVec, f: y ?? 0 };
  return { a: 1, b: 0, c: 0, d: 1, e: xOrVec.x, f: xOrVec.y };
}

export function translationNeg(by: Vec2): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: -by.x, f: -by.y };
}

/** Scale about the origin, or about `center` when given. */
export function scale(by: Vec2): Affine;
export function scale(by: Vec2, center: Vec2): Affine;
export function scale(by: Vec2, center?: Vec2): Affine {
  if (!center) return { a: by.x, b: 0, c: 0, d: by.y, e: 0, f: 0 };
  return {
    a: by.x,
    b: 0,
    c: 0,
    d: by.y,
    e: center.x - center.x * by.x,
    f: center.y - center.y * by.y,
  };
}

/** Uniform scale. */
export function uniformScale(factor: number, center?: Vec2): Affine {
  const by: Vec2 = { x: factor, y: factor };
  // Split on presence: `scale`'s overloads take `center: Vec2`, so a possibly-undefined
  // value has to route to the one-argument form rather than the two-argument one.
  return center ? scale(by, center) : scale(by);
}

/** Rotation in radians about the origin, or about `center` when given. */
export function rotation(radians: number): Affine;
export function rotation(radians: number, center: Vec2): Affine;
export function rotation(radians: number, center?: Vec2): Affine {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  if (!center) return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
  const nx = -center.x;
  const ny = -center.y;
  return {
    a: c,
    b: s,
    c: -s,
    d: c,
    e: c * nx - s * ny + center.x,
    f: s * nx + c * ny + center.y,
  };
}

/** Skew (shear) in radians; `angleX` shears x along y, `angleY` shears y along x. */
export function skew(angleX: number, angleY: number, center?: Vec2): Affine {
  const m: Affine = { a: 1, b: Math.tan(angleY), c: Math.tan(angleX), d: 1, e: 0, f: 0 };
  if (!center) return m;
  return multiplyChain(translation(center), m, translationNeg(center));
}

/**
 * Re-express `m` in a coordinate system rooted at `pivot`:
 * `translate(pivot) ∘ m ∘ translate(-pivot)`.
 */
export function transformIn(m: Affine, pivot: Vec2): Affine {
  return multiplyChain(translation(pivot), m, translationNeg(pivot));
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Transform a position (translation applies). */
export function transformPoint(m: Affine, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Transform a direction/vector (translation ignored) — for normals and offsets. */
export function transformVector(m: Affine, v: Vec2): Vec2 {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

/** Transform every point and return the tight axis-aligned bounding box. */
export function transformRect(m: Affine, r: Rect): Rect {
  const x1 = r.x1;
  const y1 = r.y1;
  const x2 = r.x2;
  const y2 = r.y2;
  return pointsToRect([
    transformPoint(m, { x: x1, y: y1 }),
    transformPoint(m, { x: x2, y: y1 }),
    transformPoint(m, { x: x2, y: y2 }),
    transformPoint(m, { x: x1, y: y2 }),
  ]);
}

/** Decompose into translate / rotate / scale / skew (rotation in radians). */
export function decompose(m: Affine): {
  translate: Vec2;
  rotate: number;
  scale: Vec2;
  skew: number;
} {
  const det = determinant(m);
  const sx = Math.sqrt(m.a * m.a + m.b * m.b);
  const sy = Math.sqrt(m.c * m.c + m.d * m.d);
  const rotation = Math.atan2(m.b, m.a);
  const skewX = Math.abs(det) > 1e-12 ? Math.atan2(m.c, m.d) - rotation : 0;
  return {
    translate: { x: m.e, y: m.f },
    rotate: rotation,
    scale: { x: det < 0 ? -sx : sx, y: sy },
    skew: skewX,
  };
}

// ---------------------------------------------------------------------------
// String <-> matrix (SVG `transform` and CSS `matrix()`)
// ---------------------------------------------------------------------------

const NUMBER_RE = /[+-]?\d*(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function toMatrixString(m: Affine): string {
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((v) => roundTo(v, 6)).join(",")})`;
}

export function toCssMatrix(m: Affine): string {
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((v) => roundTo(v, 6)).join(",")})`;
}

function roundTo(v: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(v * factor) / factor;
}

/** Parse `matrix(a,b,c,d,e,f)` (SVG/CSS) into an affine; `null` when malformed. */
export function parseMatrixString(text: string): Affine | null {
  if (typeof text !== "string") return null;
  const numbers = (text.match(NUMBER_RE) ?? []).filter((s) => s.length > 0);
  if (numbers.length < 6) return null;
  const values = numbers.slice(0, 6).map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  // `values` is `number[]` and `noUncheckedIndexedAccess` makes element access
  // `number | undefined`; the length- and finiteness checks above guarantee six
  // good values, so the defaults below are unreachable and stay zero.
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = values;
  return { a, b, c, d, e, f };
}

// ---------------------------------------------------------------------------
// Convenience operators mirroring the baseline's fluent API
// ---------------------------------------------------------------------------

export function translate(m: Affine, by: Vec2): Affine {
  return multiply(m, translation(by));
}

export function rotate(m: Affine, radians: number, center?: Vec2): Affine {
  return center ? multiply(m, rotation(radians, center)) : multiply(m, rotation(radians));
}

export function scaleMatrix(m: Affine, by: Vec2, center?: Vec2): Affine {
  return center ? multiply(m, scale(by, center)) : multiply(m, scale(by));
}

/** Point-vector arithmetic reused by transform consumers. */
export const pointMath = { add, subtract, scale: scaleVec, multiplyComponents };
