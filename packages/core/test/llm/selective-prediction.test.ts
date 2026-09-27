import { describe, it, expect } from "vitest";
import {
  areaUnderRiskCoverage,
  describeSelective,
  expectedCalibrationError,
  riskCoverageCurve,
  selectThreshold,
  type ScoredDecision,
} from "../../src/llm/selective-prediction.js";

const d = (id: string, confidence: number, correct: boolean): ScoredDecision => ({
  id,
  confidence,
  correct,
});

describe("risk-coverage curve", () => {
  it("measures the error rate of the kept prefix instead of assuming the confidence", () => {
    const curve = riskCoverageCurve([d("a", 0.9, true), d("b", 0.8, true), d("c", 0.7, false)]);
    expect(curve.order.map((x) => x.id)).toEqual(["a", "b", "c"]);
    // Compared with tolerance: the last term is 1 - 2/3, which is not bit-identical to 1/3.
    expect(curve.risk[0]).toBe(0);
    expect(curve.risk[1]).toBe(0);
    expect(curve.risk[2]).toBeCloseTo(1 / 3, 12);
    expect(curve.coverage).toEqual([1 / 3, 2 / 3, 1]);
  });

  it("ranks deterministically, so a threshold means the same set tomorrow", () => {
    // Equal confidences must not swap: otherwise the threshold computed today describes a
    // different set of items than the one that produced it.
    const first = riskCoverageCurve([d("x", 0.5, true), d("y", 0.5, false)]);
    const second = riskCoverageCurve([d("y", 0.5, false), d("x", 0.5, true)]);
    expect(first.order.map((o) => o.id)).toEqual(second.order.map((o) => o.id));
  });
});

describe("selective threshold", () => {
  it("answers the largest prefix that meets the error budget", () => {
    const decisions = [
      d("a", 0.95, true),
      d("b", 0.9, true),
      d("c", 0.85, true),
      d("d", 0.6, false),
      d("e", 0.5, false),
    ];
    const verdict = selectThreshold(decisions, { errorBudget: 0.1 });
    // The top three are all correct (0% error); including d would make it 25%.
    expect(verdict.coverage).toBeCloseTo(0.6, 6);
    expect(verdict.errorRate).toBe(0);
    expect(verdict.threshold).toBe(0.85);
    expect(verdict.overBudget).toBe(false);
  });

  it("answers nothing rather than a set that fails the budget, and says so", () => {
    const verdict = selectThreshold([d("a", 0.2, false), d("b", 0.1, false)], {
      errorBudget: 0.05,
    });
    expect(verdict.overBudget).toBe(true);
    // The single most confident item is still answered rather than abstaining from everything —
    // abstaining from everything is indistinguishable from a broken system.
    expect(verdict.coverage).toBeCloseTo(0.5, 6);
    expect(verdict.total).toBe(2);
  });

  it("counts items the model itself does not believe, separately from the budget", () => {
    const verdict = selectThreshold([d("a", 0.95, true), d("b", 0.2, false)], {
      errorBudget: 0.5,
      confidenceFloor: 0.5,
    });
    expect(verdict.unknown).toBe(1);
  });

  it("handles an empty input without inventing a threshold", () => {
    const verdict = selectThreshold([], { errorBudget: 0.1 });
    expect(verdict.total).toBe(0);
    expect(verdict.threshold).toBe(0);
    expect(verdict.coverage).toBe(0);
    expect(describeSelective([], { errorBudget: 0.1 })).toBeNull();
  });

  it("groups the answered set by id so a caller can say which items it owns", () => {
    const verdict = selectThreshold(
      [d("tool_read", 0.9, true), d("tool_read", 0.85, true), d("tool_write", 0.6, false)],
      { errorBudget: 0.1 },
    );
    expect(verdict.perLabel.get("tool_read")).toEqual({ answered: 2, correct: 2 });
    expect(verdict.perLabel.get("tool_write")).toBeUndefined();
  });

  it("degrades honestly: a worse model earns less coverage, never a laxer promise", () => {
    const good = [d("a", 0.99, true), d("b", 0.98, true), d("c", 0.97, false), d("d", 0.96, false)];
    const bad = [d("a", 0.99, false), d("b", 0.98, false), d("c", 0.97, true), d("d", 0.96, true)];
    const goodVerdict = selectThreshold(good, { errorBudget: 0.1 });
    const badVerdict = selectThreshold(bad, { errorBudget: 0.1 });
    expect(goodVerdict.coverage).toBeGreaterThan(badVerdict.coverage);
  });
});

describe("calibration metrics", () => {
  it("reports near-zero error for a perfectly calibrated set", () => {
    // Each bucket holds items whose confidence equals their accuracy, so no term contributes.
    const calibrated = [d("a", 1, true), d("b", 1, true), d("c", 0, false), d("d", 0, false)];
    expect(expectedCalibrationError(calibrated)).toBeCloseTo(0, 6);
  });

  it("reports maximal error for a confidently wrong set", () => {
    const overconfident = [d("a", 1, false), d("b", 1, false)];
    expect(expectedCalibrationError(overconfident)).toBeCloseTo(1, 6);
  });

  it("gives a better AURC to a model that is right more often", () => {
    const strong = riskCoverageCurve([d("a", 0.9, true), d("b", 0.8, true), d("c", 0.4, false)]);
    const weak = riskCoverageCurve([d("a", 0.9, false), d("b", 0.8, false), d("c", 0.4, true)]);
    expect(areaUnderRiskCoverage(strong)).toBeLessThan(areaUnderRiskCoverage(weak));
  });
});

describe("describeSelective", () => {
  it("states the guarantee in the form a person can read", () => {
    const result = describeSelective(
      [d("a", 0.95, true), d("b", 0.9, true), d("c", 0.85, true), d("d", 0.6, false)],
      { errorBudget: 0.1 },
    );
    expect(result).not.toBeNull();
    expect(result?.summary).toContain("75%");
    expect(result?.summary).toContain("10% error");
  });

  it("says plainly when the data cannot support the promise", () => {
    const result = describeSelective([d("a", 0.5, false)], { errorBudget: 0.05 });
    expect(result?.summary).toContain("No confidence threshold meets");
  });
});
