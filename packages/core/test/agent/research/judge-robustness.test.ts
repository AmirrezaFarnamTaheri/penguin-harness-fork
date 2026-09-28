import { describe, it, expect } from "vitest";
import {
  assessJudgeRobustness,
  type JudgeVariant,
  type RobustnessInput,
} from "../../../src/agent/research/judge-robustness.js";

function answer(
  id: string,
  variant: JudgeVariant,
  choice: string,
  correctChoice: string | null = "a",
  confidence = 0.9,
): RobustnessInput {
  return { id, variant, answer: { choice, confidence }, correctChoice };
}

describe("judge robustness", () => {
  it("reports a judge that ignores wording as fully robust", () => {
    const input: RobustnessInput[] = ["x", "y", "z"].flatMap((id) =>
      (["original", "reworded-light", "options-reversed"] as JudgeVariant[]).map((variant) =>
        answer(id, variant, "a"),
      ),
    );
    const verdict = assessJudgeRobustness(input);
    expect(verdict.flipRate).toBe(0);
    expect(verdict.robustness).toBe(1);
    expect(verdict.flipped).toEqual([]);
    expect(verdict.summary).toContain("kept the same answer");
  });

  it("catches a judge that follows the phrasing rather than the content", () => {
    // Every item is answered correctly, but the reworded variant picks a different option — the
    // signature of a lookup table, which a single run cannot reveal.
    const input: RobustnessInput[] = ["x", "y", "z"].flatMap((id) => [
      answer(id, "original", "a"),
      answer(id, "reworded-light", "b"),
    ]);
    const verdict = assessJudgeRobustness(input);
    expect(verdict.flipRate).toBe(1);
    expect(verdict.robustness).toBe(0);
    expect(verdict.flipped).toEqual(["x", "y", "z"]);
  });

  it("does not count an item that is consistently wrong as a flip", () => {
    // Same wrong answer every time is NOT robustness: it is a different defect, and the flip
    // rate is the wrong instrument for it. What matters here is that the metric does not
    // inflate the appearance of robustness by treating stability as correctness.
    const input: RobustnessInput[] = ["x", "y"].flatMap((id) => [
      answer(id, "original", "b"),
      answer(id, "reworded-light", "b"),
    ]);
    const verdict = assessJudgeRobustness(input);
    expect(verdict.flipRate).toBe(0);
    // ...and the accuracy report is where the wrongness shows up.
    expect(verdict.variants[0]?.accuracy).toBe(0);
  });

  it("reports accuracy and calibration per variant, because neither predicts the other", () => {
    const input: RobustnessInput[] = [
      answer("x", "original", "a", "a", 0.95),
      answer("y", "original", "b", "a", 0.95),
      answer("x", "reworded-light", "a", "a", 0.4),
      answer("y", "reworded-light", "a", "a", 0.4),
    ];
    const verdict = assessJudgeRobustness(input, { samples: 200 });
    const original = verdict.variants.find((v) => v.variant === "original");
    const reworded = verdict.variants.find((v) => v.variant === "reworded-light");
    expect(original?.accuracy).toBe(0.5);
    expect(reworded?.accuracy).toBe(1);
    // The MORE accurate variant is the LESS calibrated one: right every time while claiming
    // only 0.4. Calibration error and accuracy are independent, so a report that shows one and
    // calls it the other is misleading — this pair of numbers is why both are reported.
    expect(reworded?.calibrationError).toBeGreaterThan(original?.calibrationError ?? 0);
  });

  it("is deterministic: the same input gives the same bootstrap every run", () => {
    const input: RobustnessInput[] = Array.from({ length: 20 }, (_, index) => [
      answer(`i${index}`, "original", index % 3 === 0 ? "a" : "b"),
      answer(`i${index}`, "reworded-light", "a"),
    ]).flat();
    const first = assessJudgeRobustness(input, { samples: 500 });
    const second = assessJudgeRobustness(input, { samples: 500 });
    expect(first.pairedConfidence).toBe(second.pairedConfidence);
    expect(first.flipRate).toBe(second.flipRate);
  });

  it("reports zero rather than a confident number when there is nothing to compare", () => {
    const verdict = assessJudgeRobustness([]);
    expect(verdict.flipRate).toBe(0);
    expect(verdict.robustness).toBe(1);
    expect(verdict.variants).toEqual([]);
    expect(verdict.pairedConfidence).toBe(1);
  });

  it("ignores unscored items rather than counting them as flips", () => {
    const input: RobustnessInput[] = [
      answer("x", "original", "a", null),
      answer("x", "reworded-light", "b", null),
    ];
    const verdict = assessJudgeRobustness(input);
    // A disagreement with no ground truth is not a measured flip; accuracy is null for it.
    expect(verdict.variants[0]?.accuracy).toBeNull();
  });
});
