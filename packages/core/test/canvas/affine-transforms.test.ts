import { describe, expect, it } from "vitest";
import {
  addTranslate,
  affine,
  decompose,
  determinant,
  equals,
  IDENTITY,
  inverse,
  isAffine,
  isIdentity,
  isMirrored,
  isTranslationOnly,
  multiply,
  multiplyChain,
  parseMatrixString,
  pointMath,
  rotation,
  scale,
  scaleMatrix,
  skew,
  toMatrixString,
  transformIn,
  transformPoint,
  transformRect,
  transformVector,
  translate,
  translation,
  translationNeg,
} from "../../src/canvas/affine-transforms";
import { makeRect, pointsToRect, vec } from "../../src/canvas/vector-primitives";

describe("affine transforms", () => {
  it("constructs and identifies matrices", () => {
    expect(IDENTITY).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(affine(1, 2, 3, 4, 5, 6)).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expect(isAffine({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(true);
    expect(isAffine({ a: 1 })).toBe(false);
    expect(isIdentity(IDENTITY)).toBe(true);
    expect(isIdentity(translation(5, 5))).toBe(false);
  });

  it("multiplies so the right operand applies first", () => {
    // translate(10,0) then rotate(90deg): a point at (1,0) first rotates to (0,1), then shifts to (10,1).
    const m = multiply(translation(10, 0), rotation(Math.PI / 2));
    const p = transformPoint(m, vec(1, 0));
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(1);
    // null operands behave as the identity.
    expect(multiply(null, IDENTITY)).toEqual(IDENTITY);
    expect(multiply(IDENTITY, null)).toEqual(IDENTITY);
  });

  it("chains matrices left to right", () => {
    const chained = multiplyChain(translation(1, 2), translation(3, 4), translation(5, 6));
    expect(transformPoint(chained, vec(0, 0))).toEqual({ x: 9, y: 12 });
  });

  it("combines translations faster than multiplying", () => {
    expect(addTranslate(translation(1, 2), translation(3, 4))).toEqual(translation(4, 6));
  });

  it("detects pure translations", () => {
    expect(isTranslationOnly(translation(5, 5))).toBe(true);
    expect(isTranslationOnly(rotation(0.1))).toBe(false);
    expect(isTranslationOnly(scale(vec(2, 2)))).toBe(false);
  });

  it("computes the determinant and detects mirroring", () => {
    expect(determinant(IDENTITY)).toBe(1);
    expect(determinant(scale(vec(2, 3)))).toBe(6);
    expect(determinant(scale(vec(-1, 1)))).toBe(-1);
    expect(isMirrored(scale(vec(-1, 1)))).toBe(true);
    expect(isMirrored(scale(vec(2, 2)))).toBe(false);
  });

  it("inverts and round-trips", () => {
    const m = multiplyChain(translation(3, 7), rotation(0.4), scale(vec(2, 0.5)));
    const inv = inverse(m);
    expect(inv).not.toBeNull();
    const roundTrip = multiply(m, inv!);
    expect(equals(roundTrip, IDENTITY)).toBe(true);
    expect(inverse(scale(vec(0, 0)))).toBeNull();
  });

  it("scales and rotates about a center", () => {
    const aboutOrigin = rotation(Math.PI / 2);
    const rotated = transformPoint(aboutOrigin, vec(1, 0));
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(1);
    // Rotating about (1,0) keeps that point fixed.
    const aboutPoint = rotation(Math.PI / 2, vec(1, 0));
    const fixed = transformPoint(aboutPoint, vec(1, 0));
    expect(fixed.x).toBeCloseTo(1);
    expect(fixed.y).toBeCloseTo(0);
    // Scaling about a center keeps the center fixed.
    const scaled = scale(vec(2, 2), vec(10, 10));
    expect(transformPoint(scaled, vec(10, 10))).toEqual({ x: 10, y: 10 });
    expect(transformPoint(scaled, vec(11, 10))).toEqual({ x: 12, y: 10 });
  });

  it("skews and re-expresses in a local frame", () => {
    const s = skew(0.5, 0);
    const sheared = transformPoint(s, vec(1, 1));
    expect(sheared.x).toBeCloseTo(1 + Math.tan(0.5));
    expect(sheared.y).toBeCloseTo(1);
    const local = transformIn(rotation(Math.PI / 4), vec(5, 5));
    const anchored = transformPoint(local, vec(5, 5));
    expect(anchored.x).toBeCloseTo(5);
    expect(anchored.y).toBeCloseTo(5);
  });

  it("transforms points, vectors and rects", () => {
    const m = multiplyChain(translation(10, 20), rotation(Math.PI / 2));
    const p = transformPoint(m, vec(1, 0));
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(21);
    // A direction ignores translation.
    const v = transformVector(m, vec(1, 0));
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
    expect(p.x).not.toBeCloseTo(v.x);
    const r = transformRect(m, makeRect(0, 0, 2, 4));
    expect(r.x1).toBeCloseTo(6);
    expect(r.y1).toBeCloseTo(20);
    expect(r.x2).toBeCloseTo(10);
    expect(r.y2).toBeCloseTo(22);
  });

  it("decomposes into translate, rotate, scale and skew", () => {
    const m = multiplyChain(translation(3, 7), rotation(0.4), scale(vec(2, 0.5)));
    const parts = decompose(m);
    expect(parts.translate).toEqual({ x: 3, y: 7 });
    expect(parts.rotate).toBeCloseTo(0.4);
    expect(parts.scale.x).toBeCloseTo(2);
    expect(parts.scale.y).toBeCloseTo(0.5);
  });

  it("parses and emits matrix strings", () => {
    const m = affine(1.5, 0, 0, 2, 10, -5);
    expect(toMatrixString(m)).toBe("matrix(1.5,0,0,2,10,-5)");
    expect(parseMatrixString("matrix(1.5,0,0,2,10,-5)")).toEqual(m);
    expect(parseMatrixString("scale(2)")).toBeNull();
    expect(parseMatrixString("matrix(1,0,0)")).toBeNull();
  });

  it("exposes point math helpers", () => {
    expect(pointMath.add(vec(1, 1), vec(2, 2))).toEqual({ x: 3, y: 3 });
    expect(pointMath.subtract(vec(5, 5), vec(2, 2))).toEqual({ x: 3, y: 3 });
    expect(pointMath.scale(vec(3, 3), 2)).toEqual({ x: 6, y: 6 });
    expect(pointMath.multiplyComponents(vec(3, 4), vec(2, 5))).toEqual({ x: 6, y: 20 });
  });

  it("applies fluent transforms", () => {
    // translate ∘ scale: scale runs first, so (1,1) -> (2,2) -> (3,3).
    const m = scaleMatrix(translate(IDENTITY, vec(1, 1)), vec(2, 2));
    const p = transformPoint(m, vec(1, 1));
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(3);
    // Translating after scaling composes the other way around.
    const reversed = translate(scaleMatrix(IDENTITY, vec(2, 2)), vec(1, 1));
    const q = transformPoint(reversed, vec(1, 1));
    expect(q.x).toBeCloseTo(4);
    expect(q.y).toBeCloseTo(4);
  });

  it("negates translations", () => {
    expect(translationNeg(vec(3, 4))).toEqual(translation(-3, -4));
  });

  it("treats pointsToRect output as a rect source", () => {
    expect(pointsToRect([vec(0, 0), vec(2, 2)]).width).toBe(2);
  });
});
