import { describe, expect, it } from "vitest";

import {
  type CursorPoint,
  cubicBezier,
  easeDeceleration,
  estimateTravelDurationMs,
  planControlPoints,
  planCursorPath,
  seededRandom,
  stepDurationMs,
} from "../../src/browser/cursor-simulator.js";

describe("cursor simulator", () => {
  describe("seededRandom", () => {
    it("is deterministic for a given seed", () => {
      const a = seededRandom(42);
      const b = seededRandom(42);
      expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    });

    it("produces values within the unit interval", () => {
      const random = seededRandom(7);
      const values = Array.from({ length: 100 }, () => random());
      expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    });

    it("differs between seeds", () => {
      const a = seededRandom(1);
      const b = seededRandom(2);
      expect([a(), a()]).not.toEqual([b(), b()]);
    });
  });

  describe("cubicBezier", () => {
    it("returns the start point at t=0 and the end point at t=1", () => {
      const p0: CursorPoint = { x: 0, y: 0 };
      const p3: CursorPoint = { x: 100, y: 50 };
      const start = cubicBezier(p0, { x: 30, y: 10 }, { x: 70, y: 40 }, p3, 0);
      const end = cubicBezier(p0, { x: 30, y: 10 }, { x: 70, y: 40 }, p3, 1);
      expect(start).toEqual(p0);
      expect(end).toEqual(p3);
    });

    it("is linear when all control points are collinear", () => {
      const p0: CursorPoint = { x: 0, y: 0 };
      const p3: CursorPoint = { x: 100, y: 0 };
      const mid = cubicBezier(p0, { x: 25, y: 0 }, { x: 75, y: 0 }, p3, 0.5);
      expect(mid).toEqual({ x: 50, y: 0 });
    });
  });

  describe("easeDeceleration", () => {
    it("is clamped to [0, 1]", () => {
      expect(easeDeceleration(-1)).toBe(0);
      expect(easeDeceleration(0)).toBe(0);
      expect(easeDeceleration(1)).toBe(1);
      expect(easeDeceleration(2)).toBe(1);
    });

    it("decelerates: the second half of the journey covers less distance than the first", () => {
      const firstHalf = easeDeceleration(0.5);
      const secondHalf = easeDeceleration(1) - easeDeceleration(0.5);
      expect(secondHalf).toBeLessThan(firstHalf);
    });
  });

  describe("planControlPoints", () => {
    it("returns the endpoints for a zero-length move", () => {
      const point: CursorPoint = { x: 10, y: 10 };
      const { c1, c2 } = planControlPoints(point, point);
      expect(c1).toEqual(point);
      expect(c2).toEqual(point);
    });

    it("places control points off the straight line", () => {
      const from: CursorPoint = { x: 0, y: 0 };
      const to: CursorPoint = { x: 100, y: 0 };
      const { c1, c2 } = planControlPoints(from, to, { curvature: 0.5 }, seededRandom(3));
      // A bowed arc must leave the x-axis.
      expect(Math.abs(c1.y)).toBeGreaterThan(0);
      expect(Math.abs(c2.y)).toBeGreaterThan(0);
      // And stay within a sane bounding box of the move.
      for (const point of [c1, c2]) {
        expect(point.x).toBeGreaterThanOrEqual(-50);
        expect(point.x).toBeLessThanOrEqual(150);
      }
    });
  });

  describe("planCursorPath", () => {
    it("is reproducible for the same seed", () => {
      const from: CursorPoint = { x: 0, y: 0 };
      const to: CursorPoint = { x: 400, y: 300 };
      expect(planCursorPath(from, to, { seed: 11 })).toEqual(
        planCursorPath(from, to, { seed: 11 }),
      );
    });

    it("differs between seeds", () => {
      const from: CursorPoint = { x: 0, y: 0 };
      const to: CursorPoint = { x: 400, y: 300 };
      expect(planCursorPath(from, to, { seed: 11 })).not.toEqual(
        planCursorPath(from, to, { seed: 12 }),
      );
    });

    it("emits a monotonically increasing progress that ends at 1", () => {
      const steps = planCursorPath({ x: 0, y: 0 }, { x: 500, y: 100 }, { seed: 5 });
      expect(steps.length).toBeGreaterThan(1);
      for (let index = 1; index < steps.length; index++) {
        expect(steps[index]!.progress).toBeGreaterThanOrEqual(steps[index - 1]!.progress);
      }
      expect(steps[steps.length - 1]!.progress).toBe(1);
    });

    it("ends within arrival jitter of the target", () => {
      const to: CursorPoint = { x: 500, y: 100 };
      const steps = planCursorPath({ x: 0, y: 0 }, to, { seed: 5, arrivalJitterPx: 4 });
      const last = steps[steps.length - 1]!.point;
      expect(Math.abs(last.x - to.x)).toBeLessThanOrEqual(4);
      expect(Math.abs(last.y - to.y)).toBeLessThanOrEqual(4);
    });

    it("honours minSamples for a near-zero move", () => {
      const steps = planCursorPath({ x: 1, y: 1 }, { x: 1, y: 1 }, { seed: 1, minSamples: 3 });
      expect(steps).toHaveLength(3);
    });

    it("clusters samples toward the target under deceleration", () => {
      const steps = planCursorPath({ x: 0, y: 0 }, { x: 1000, y: 0 }, { seed: 9, minStepPx: 5 });
      const positions = steps.map((step) => step.point.x);
      const midIndex = Math.floor(positions.length / 2);
      // Deceleration means more samples sit in the second half of the distance.
      const secondHalfCount = positions.filter((x) => x > 500).length;
      expect(secondHalfCount).toBeGreaterThan(midIndex);
    });
  });

  describe("stepDurationMs", () => {
    it("spends longer on the decelerating tail than mid-path", () => {
      const tail = stepDurationMs(0.95, 1000);
      const mid = stepDurationMs(0.5, 1000);
      expect(tail).toBeGreaterThan(mid);
    });

    it("never exceeds the total duration", () => {
      expect(stepDurationMs(1, 500)).toBeLessThanOrEqual(500);
    });
  });

  describe("estimateTravelDurationMs", () => {
    it("returns zero for a zero-length move", () => {
      expect(estimateTravelDurationMs({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
    });

    it("floors short hops at a reaction time and caps long traverses", () => {
      expect(estimateTravelDurationMs({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeGreaterThanOrEqual(120);
      expect(estimateTravelDurationMs({ x: 0, y: 0 }, { x: 50_000, y: 0 })).toBeLessThanOrEqual(
        1_200,
      );
    });
  });
});
