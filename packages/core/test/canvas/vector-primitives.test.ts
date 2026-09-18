import { describe, expect, it } from "vitest";
import {
  add,
  angle,
  angleBetween,
  almostEqual,
  clamp01,
  cross,
  distance,
  distanceSquared,
  dot,
  emptyRect,
  expandRect,
  intersectRects,
  isVec2,
  joinRects,
  length,
  lengthSquared,
  lerp,
  makeRect,
  negate,
  normalize,
  pointAtAngle,
  pointsToRect,
  rectCorners,
  rectFromCorners,
  rectsOverlap,
  rectsOverlapOrTouch,
  rectContainsPoint,
  scale,
  subtract,
  vec,
  vecEquals,
  vecZero,
} from "../../src/canvas/vector-primitives";
import type { Rect, Vec2 } from "../../src/canvas/vector-primitives";

describe("vector primitives", () => {
  it("constructs and identifies points", () => {
    expect(vec(3, 4)).toEqual({ x: 3, y: 4 });
    expect(vecZero()).toEqual({ x: 0, y: 0 });
    expect(isVec2({ x: 1, y: 2 })).toBe(true);
    expect(isVec2({ x: 1 })).toBe(false);
    expect(isVec2(null)).toBe(false);
  });

  it("adds, subtracts, scales and negates", () => {
    expect(add(vec(1, 2), vec(3, 4))).toEqual({ x: 4, y: 6 });
    expect(subtract(vec(5, 7), vec(2, 1))).toEqual({ x: 3, y: 6 });
    expect(scale(vec(2, -3), 2)).toEqual({ x: 4, y: -6 });
    expect(negate(vec(2, -3))).toEqual({ x: -2, y: 3 });
  });

  it("computes dot, cross, length and distance", () => {
    expect(dot(vec(1, 0), vec(0, 1))).toBe(0);
    expect(dot(vec(2, 3), vec(4, 5))).toBe(23);
    expect(cross(vec(1, 0), vec(0, 1))).toBe(1);
    expect(cross(vec(0, 1), vec(1, 0))).toBe(-1);
    expect(length(vec(3, 4))).toBe(5);
    expect(lengthSquared(vec(3, 4))).toBe(25);
    expect(distance(vec(0, 0), vec(3, 4))).toBe(5);
    expect(distanceSquared(vec(0, 0), vec(3, 4))).toBe(25);
  });

  it("normalises and measures angles in screen space", () => {
    expect(normalize(vec(0, 0))).toEqual({ x: 0, y: 0 });
    expect(normalize(vec(5, 0))).toEqual({ x: 1, y: 0 });
    // +y is down, so a downward vector has a positive angle.
    expect(angle(vec(1, 0))).toBeCloseTo(0);
    expect(angle(vec(0, 1))).toBeCloseTo(Math.PI / 2);
    expect(angleBetween(vec(1, 0), vec(0, 1))).toBeCloseTo(Math.PI / 2);
    expect(angleBetween(vec(1, 0), vec(0, -1))).toBeCloseTo(-Math.PI / 2);
  });

  it("lerps and clamps", () => {
    expect(lerp(vec(0, 0), vec(10, 20), 0.5)).toEqual({ x: 5, y: 10 });
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it("travels along an angle", () => {
    const p = pointAtAngle(vec(0, 0), 0, 5);
    expect(p.x).toBeCloseTo(5);
    expect(p.y).toBeCloseTo(0);
  });

  it("compares points with epsilon", () => {
    expect(vecEquals(vec(1, 2), vec(1, 2))).toBe(true);
    expect(vecEquals(vec(1, 2), vec(1 + 1e-12, 2))).toBe(true);
    expect(vecEquals(vec(1, 2), vec(1.1, 2))).toBe(false);
    expect(almostEqual(1, 1 + 1e-12)).toBe(true);
  });
});

describe("rectangles", () => {
  it("creates rects with a minimum side length", () => {
    const r = makeRect(10, 20, 100, 50);
    expect(r).toMatchObject({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 70,
    });
    const zero = makeRect(0, 0, 0, 0);
    expect(zero.width).toBeGreaterThan(0);
    expect(emptyRect.width).toBeGreaterThan(0);
  });

  it("builds a rect from a point cloud", () => {
    const r = pointsToRect([vec(5, 1), vec(-3, 4), vec(0, 0), vec(2, 9)]);
    expect(r).toMatchObject({ x: -3, y: 0, x2: 5, y2: 9 });
    expect(pointsToRect([]).width).toBeGreaterThan(0);
  });

  it("builds a rect from either corner ordering", () => {
    expect(rectFromCorners(vec(0, 0), vec(4, 6))).toMatchObject({
      x: 0,
      y: 0,
      width: 4,
      height: 6,
    });
    expect(rectFromCorners(vec(4, 6), vec(0, 0))).toMatchObject({
      x: 0,
      y: 0,
      width: 4,
      height: 6,
    });
  });

  it("joins and intersects", () => {
    const a = makeRect(0, 0, 10, 10);
    const b = makeRect(5, 5, 10, 10);
    expect(joinRects(a, b)).toMatchObject({ x1: 0, y1: 0, x2: 15, y2: 15 });
    expect(intersectRects(a, b)).toMatchObject({ x: 5, y: 5, width: 5, height: 5 });
    expect(rectsOverlap(a, b)).toBe(true);
    expect(rectsOverlap(makeRect(0, 0, 1, 1), makeRect(100, 100, 1, 1))).toBe(false);
    // Touching edges count as overlapping for culling purposes.
    expect(rectsOverlapOrTouch(makeRect(0, 0, 10, 10), makeRect(10, 0, 10, 10))).toBe(true);
    expect(rectsOverlap(makeRect(0, 0, 10, 10), makeRect(10, 0, 10, 10))).toBe(false);
  });

  it("contains points and rects", () => {
    const outer = makeRect(0, 0, 100, 100);
    expect(rectContainsPoint(outer, vec(50, 50))).toBe(true);
    expect(rectContainsPoint(outer, vec(150, 50))).toBe(false);
    expect(rectContainsPoint(outer, vec(0, 0))).toBe(true);
    expect(rectContainsPoint(outer, vec(150, 50))).toBe(false);
  });

  it("expands and translates", () => {
    expect(expandRect(makeRect(10, 10, 20, 20), 5)).toMatchObject({ x1: 5, y1: 5, x2: 35, y2: 35 });
  });

  it("reports corners", () => {
    const corners = rectCorners(makeRect(0, 0, 10, 10)) as [Vec2, Vec2, Vec2, Vec2];
    expect(corners).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it("treats the rect type as structural", () => {
    const r: Rect = makeRect(1, 2, 3, 4);
    expect(r.x + r.width).toBe(r.x2);
  });
});
