import { describe, expect, it } from "vitest";
import {
  bendCurveDeltas,
  cubicBounds,
  cubicClosestT,
  cubicCurvature,
  cubicIsLine,
  cubicLength,
  cubicParameterAtLengthFraction,
  cubicSecondDerivative,
  cubicTangent,
  evalCubic,
  flattenCubic,
  intersectSegments,
  mirrorHandle,
  nearestPointOnCubic,
  nearestPointOnSegment,
  polylineLength,
  segmentAsCubic,
  splitCubicAt,
} from "../../src/canvas/bezier-curves";
import type { Cubic } from "../../src/canvas/bezier-curves";
import { vec } from "../../src/canvas/vector-primitives";

const line: Cubic = {
  p0: vec(0, 0),
  cp1: vec(0, 0),
  cp2: vec(10, 0),
  p3: vec(10, 0),
};

/** A quarter-circle-ish arc used for curvature and length checks. */
const arc: Cubic = {
  p0: vec(0, 0),
  cp1: vec(0, 50),
  cp2: vec(50, 100),
  p3: vec(100, 100),
};

describe("bezier curves", () => {
  it("evaluates the endpoints and midpoint exactly", () => {
    expect(evalCubic(line, 0)).toEqual({ x: 0, y: 0 });
    expect(evalCubic(line, 1)).toEqual({ x: 10, y: 0 });
    const mid = evalCubic(line, 0.5);
    expect(mid.x).toBeCloseTo(5);
    expect(mid.y).toBeCloseTo(0);
  });

  it("follows the Bernstein basis", () => {
    // A cubic with handles at (1/3, 0) and (2/3, 0) is the straight line itself.
    const straight: Cubic = {
      p0: vec(0, 0),
      cp1: vec(1 / 3, 0),
      cp2: vec(2 / 3, 0),
      p3: vec(1, 0),
    };
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(evalCubic(straight, t).x).toBeCloseTo(t);
      expect(evalCubic(straight, t).y).toBeCloseTo(0);
    }
  });

  it("computes the tangent and curvature", () => {
    // B'(0.5) = 3(1-t)^2(cp1-p0) + 6(1-t)t(cp2-cp1) + 3t^2(p3-cp2) = 0 + 15 + 0.
    const tan = cubicTangent(line, 0.5);
    expect(tan.x).toBeCloseTo(15);
    expect(tan.y).toBeCloseTo(0);
    // A straight line has zero curvature everywhere.
    expect(cubicCurvature(line, 0.5)).toBeCloseTo(0);
    expect(cubicSecondDerivative(line, 0.5)).toEqual({ x: 0, y: 0 });
    // A curved control polygon has non-zero curvature in the middle. The sign
    // encodes turn direction, so the magnitude is what to assert on.
    expect(Math.abs(cubicCurvature(arc, 0.5))).toBeGreaterThan(0);
  });

  it("detects straight cubics", () => {
    expect(cubicIsLine(line)).toBe(true);
    expect(cubicIsLine(arc)).toBe(false);
    expect(cubicIsLine({ p0: vec(0, 0), cp1: vec(0, 0), cp2: vec(0, 0), p3: vec(0, 0) })).toBe(
      true,
    );
  });

  it("splits a cubic and keeps both halves on the same curve", () => {
    const { left, right } = splitCubicAt(arc, 0.5);
    expect(evalCubic(left, 1)).toEqual(evalCubic(arc, 0.5));
    expect(evalCubic(right, 0)).toEqual(evalCubic(arc, 0.5));
    // Points on the halves match the original curve.
    for (const t of [0.1, 0.5, 0.9]) {
      expect(evalCubic(left, t).x).toBeCloseTo(evalCubic(arc, t * 0.5).x);
      expect(evalCubic(left, t).y).toBeCloseTo(evalCubic(arc, t * 0.5).y);
      expect(evalCubic(right, t).x).toBeCloseTo(evalCubic(arc, 0.5 + t * 0.5).x);
    }
  });

  it("bounds a cubic by its extrema, not only its endpoints", () => {
    // Both endpoints sit at x=0 while the curve bulges out to x=7.5 at t=0.5;
    // endpoint-only bounds would report zero width.
    const bulging: Cubic = {
      p0: vec(0, 0),
      cp1: vec(10, 0),
      cp2: vec(10, 0),
      p3: vec(0, 0),
    };
    const bounds = cubicBounds(bulging);
    expect(bounds.width).toBeCloseTo(7.5);
    expect(bounds.x1).toBeCloseTo(0);
    expect(bounds.x2).toBeCloseTo(7.5);
    // When the extrema fall outside the curve, the endpoints bound it.
    expect(cubicBounds(line).width).toBeCloseTo(10);
  });

  it("measures length", () => {
    expect(cubicLength(line)).toBeCloseTo(10);
    expect(cubicLength(line, 2)).toBeCloseTo(10);
    expect(cubicLength(arc)).toBeGreaterThan(100);
  });

  it("walks the curve by arc length", () => {
    expect(cubicParameterAtLengthFraction(line, 0)).toBe(0);
    expect(cubicParameterAtLengthFraction(line, 1)).toBe(1);
    const half = cubicParameterAtLengthFraction(line, 0.5);
    expect(half).toBeCloseTo(0.5);
    // A degenerate curve falls back to the midpoint rather than dividing by zero.
    const point: Cubic = { p0: vec(5, 5), cp1: vec(5, 5), cp2: vec(5, 5), p3: vec(5, 5) };
    expect(cubicParameterAtLengthFraction(point, 0.5)).toBe(0.5);
  });

  it("finds the nearest point on a cubic", () => {
    const near = nearestPointOnCubic(arc, vec(0, 0), 32);
    expect(near.t).toBeCloseTo(0, 1);
    expect(near.distance).toBeCloseTo(0, 6);
    const far = nearestPointOnCubic(arc, vec(500, 500), 32);
    expect(far.distance).toBeCloseTo(Math.hypot(500 - 100, 500 - 100), 0);
  });

  it("finds the nearest point on a segment", () => {
    const on = nearestPointOnSegment(vec(5, 0), vec(0, 0), vec(10, 0));
    expect(on.t).toBeCloseTo(0.5);
    expect(on.point).toEqual({ x: 5, y: 0 });
    expect(on.distance).toBeCloseTo(0);
    const clamped = nearestPointOnSegment(vec(20, 0), vec(0, 0), vec(10, 0));
    expect(clamped.t).toBe(1);
    expect(clamped.distance).toBeCloseTo(10);
    const degenerate = nearestPointOnSegment(vec(5, 0), vec(0, 0), vec(0, 0));
    expect(degenerate.t).toBe(0);
  });

  it("bisects to the closest parameter", () => {
    const t = cubicClosestT(arc, vec(100, 100));
    expect(t).toBeCloseTo(1, 2);
  });

  it("computes the handle deltas that move a point on the curve", () => {
    const deltas = bendCurveDeltas(arc, 0.5, vec(60, 60));
    const moved: Cubic = {
      p0: arc.p0,
      cp1: { x: arc.cp1.x + deltas.cp1.x, y: arc.cp1.y + deltas.cp1.y },
      cp2: { x: arc.cp2.x + deltas.cp2.x, y: arc.cp2.y + deltas.cp2.y },
      p3: arc.p3,
    };
    const arrived = evalCubic(moved, 0.5);
    expect(arrived.x).toBeCloseTo(60);
    expect(arrived.y).toBeCloseTo(60);
    // At t=0 both barycenter weights are zero, so the denominator vanishes
    // and the deltas are exactly zero rather than NaN.
    const zero = bendCurveDeltas(point(), 0, vec(10, 10));
    expect(zero.cp1).toEqual({ x: 0, y: 0 });
    expect(zero.cp2).toEqual({ x: 0, y: 0 });
  });

  it("mirrors a handle through its anchor", () => {
    expect(mirrorHandle(vec(5, 5), vec(7, 5))).toEqual({ x: 3, y: 5 });
    expect(mirrorHandle(vec(0, 0), vec(1, 1))).toEqual({ x: -1, y: -1 });
  });

  it("intersects segments", () => {
    const hit = intersectSegments(vec(0, 0), vec(10, 10), vec(0, 10), vec(10, 0));
    expect(hit).not.toBeNull();
    expect(hit!.t1).toBeCloseTo(0.5);
    expect(hit!.point.x).toBeCloseTo(5);
    const miss = intersectSegments(vec(0, 0), vec(1, 1), vec(5, 5), vec(6, 6));
    expect(miss).toBeNull();
    const parallel = intersectSegments(vec(0, 0), vec(10, 0), vec(0, 5), vec(10, 5));
    expect(parallel).toBeNull();
  });

  it("flattens adaptively", () => {
    const flat = flattenCubic(line, 0.5);
    expect(flat.length).toBe(1);
    const curved = flattenCubic(arc, 0.5, 8);
    expect(curved.length).toBeGreaterThan(1);
    expect(polylineLength(curved)).toBeGreaterThan(100);
  });

  it("represents a straight segment as a degenerate cubic", () => {
    const c = segmentAsCubic(vec(0, 0), vec(3, 4));
    expect(evalCubic(c, 0)).toEqual({ x: 0, y: 0 });
    expect(evalCubic(c, 1)).toEqual({ x: 3, y: 4 });
    expect(cubicLength(c)).toBeCloseTo(5);
  });
});

function point(): Cubic {
  return { p0: vec(2, 2), cp1: vec(2, 2), cp2: vec(2, 2), p3: vec(2, 2) };
}
