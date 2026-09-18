import { describe, it, expect } from "vitest";
import {
  ResearchEvalHarness,
  buildEvalSteps,
  scoreScaleInstruction,
  CoverageEvaluator,
  CitationHallucinationEvaluator,
  VerificationAccuracyEvaluator,
  LatencyEvaluator,
  SpecificityEvaluator,
  type EvalCase,
  type EvaluationContext,
  type RatingOutcome,
} from "../../../src/agent/research/eval-harness.js";
import { CitationNetwork } from "../../../src/agent/research/citation-network.js";
import type { Claim } from "../../../src/agent/research/claim-extractor.js";
import type { VerificationSummary } from "../../../src/agent/research/evidence-verifier.js";

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "claim_0",
    kind: "quantitative",
    text: "The photonic tensor core improves throughput by 31.4%.",
    quantities: [],
    citations: ["[1]"],
    informationContent: 46,
    specificity: 0.72,
    ...overrides,
  };
}

function emptyVerification(overrides: Partial<VerificationSummary> = {}): VerificationSummary {
  return {
    total: 2,
    supported: 2,
    contradicted: 0,
    unsupported: 0,
    unverifiable: 0,
    agreementRate: 1,
    meanCoverage: 0.9,
    meanLatencyNs: 1000,
    unresolvedCitations: 0,
    ...overrides,
  };
}

/**
 * A context whose every default evaluator passes: terms covered, citation marker
 * resolved, verification at 100% agreement, inside the latency budget, claims specific.
 */
function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const network = new CitationNetwork();
  network.addPaper({
    id: "p1",
    title: "Photonic Tensor Cores",
    marker: "[1]",
    text: "improves throughput by 31.4%",
  });
  return {
    question: "Do photonic tensor cores outperform electronic baselines?",
    synthesis:
      "The photonic tensor core improves throughput by 31.4% [1]. It consumes 0.41 nanojoules per operation [2].",
    claims: [claim()],
    citationReport: network.report([{ citations: ["[1]"], text: "supported claim" }]),
    verification: emptyVerification(),
    expectations: {
      requiredTerms: ["photonic", "throughput"],
      forbiddenTerms: ["perpetual motion", "zero energy"],
    },
    elapsedNs: 1_000_000_000,
    ...overrides,
  };
}

function unresolvedReport(): ReturnType<CitationNetwork["report"]> {
  return new CitationNetwork().report([{ citations: ["[1]"], text: "unsupported claim" }]);
}

function caseEntry(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case_a",
    question: "Do photonic tensor cores outperform electronic baselines?",
    fixtures: {
      sources: [{ id: "p1", title: "Photonic Tensor Cores", text: "improves throughput by 31.4%" }],
    },
    expectations: {
      minSources: 1,
      requiredTerms: ["photonic", "throughput"],
      forbiddenTerms: ["perpetual motion"],
      ratingType: "five-star",
    },
    ...overrides,
  };
}

describe("scoreScaleInstruction", () => {
  it("describes the allowed values for each rating type", () => {
    expect(scoreScaleInstruction("five-star")).toContain("1 to 5");
    expect(scoreScaleInstruction("pass-fail")).toContain('"pass" or "fail"');
    expect(scoreScaleInstruction("pass-fail-critical")).toContain("critical");
  });
});

describe("buildEvalSteps", () => {
  it("includes only the steps the expectations call for", () => {
    const steps = buildEvalSteps(caseEntry().expectations);
    expect(steps[0]).toContain("answer the research question");
    expect(steps).toEqual(expect.arrayContaining([expect.stringContaining("at least 1 sources")]));
    expect(steps[steps.length - 1]).toContain("1 to 5");
  });

  it("omits optional steps when no expectations are given", () => {
    const steps = buildEvalSteps({});
    expect(steps).toHaveLength(2);
    expect(steps[1]).toContain('"pass" or "fail"');
  });
});

describe("CoverageEvaluator", () => {
  it("passes when required terms are present and forbidden ones absent", () => {
    const result = new CoverageEvaluator().evaluate(context());
    expect(result.name).toBe("coverage");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("reports missing required terms", () => {
    const result = new CoverageEvaluator().evaluate(
      context({
        synthesis: "The photonic core improves throughput.",
        expectations: { requiredTerms: ["photonic", "fidelity"] },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBeCloseTo(0.5);
    expect(result.detail).toContain("missing: fidelity");
  });

  it("reports forbidden terms that leaked into the synthesis", () => {
    const result = new CoverageEvaluator().evaluate(
      context({
        synthesis: "photonic throughput perpetual motion",
        expectations: { forbiddenTerms: ["perpetual motion"] },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("forbidden present: perpetual motion");
  });

  it("scores a full pass when no terms are constrained", () => {
    const result = new CoverageEvaluator().evaluate(context({ expectations: {} }));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });
});

describe("CitationHallucinationEvaluator", () => {
  it("passes at zero unresolved markers", () => {
    const result = new CitationHallucinationEvaluator().evaluate(context());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.detail).toContain("all citation markers resolve");
  });

  it("fails and names the unresolved marker", () => {
    const result = new CitationHallucinationEvaluator().evaluate(
      context({ citationReport: unresolvedReport() }),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("[1]");
  });
});

describe("VerificationAccuracyEvaluator", () => {
  it("passes at or above the 99.2% target", () => {
    expect(new VerificationAccuracyEvaluator().evaluate(context()).passed).toBe(true);
  });

  it("fails below the target and reports the breakdown", () => {
    const result = new VerificationAccuracyEvaluator().evaluate(
      context({
        verification: emptyVerification({ supported: 1, unsupported: 1, agreementRate: 0.5 }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBeCloseTo(0.5);
    expect(result.detail).toContain("target 0.992");
  });

  it("honours a custom target", () => {
    const evaluator = new VerificationAccuracyEvaluator(0.4);
    expect(
      evaluator.evaluate(context({ verification: emptyVerification({ agreementRate: 0.5 }) }))
        .passed,
    ).toBe(true);
  });
});

describe("LatencyEvaluator", () => {
  it("passes within the wall-clock budget", () => {
    expect(new LatencyEvaluator().evaluate(context({ elapsedNs: 1_000_000_000 })).passed).toBe(
      true,
    );
  });

  it("fails over the budget and reports seconds", () => {
    const result = new LatencyEvaluator(1_000_000_000).evaluate(
      context({ elapsedNs: 2_000_000_000 }),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("2.000s");
  });
});

describe("SpecificityEvaluator", () => {
  it("passes when mean specificity clears the floor", () => {
    expect(new SpecificityEvaluator().evaluate(context()).passed).toBe(true);
  });

  it("fails on vague claims even when nothing else is wrong", () => {
    const result = new SpecificityEvaluator().evaluate(
      context({ claims: [claim({ specificity: 0.1, informationContent: 2 })] }),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("mean specificity");
  });
});

describe("ResearchEvalHarness", () => {
  it("passes a case that satisfies every default evaluator", async () => {
    const harness = new ResearchEvalHarness();
    const result = await harness.evaluateCase(caseEntry(), context());

    expect(result.caseId).toBe("case_a");
    expect(result.outcome).toBe("pass");
    // The numeric score is the mean of the evaluator scores, so a passing case is not
    // necessarily exactly 1 — specificity contributes its own sub-1 figure.
    expect(result.numericScore).toBeCloseTo((1 + 1 + 1 + 1 + 0.72) / 5, 5);
    expect(result.evaluatorResults).toHaveLength(5);
    expect(result.evaluatorResults.every((entry) => entry.passed)).toBe(true);
    expect(result.notes).toHaveLength(0);
    expect(result.durationNs).toBeGreaterThanOrEqual(0);
  });

  it("fails a case and collects failure notes", async () => {
    const harness = new ResearchEvalHarness();
    const result = await harness.evaluateCase(
      caseEntry(),
      context({
        verification: emptyVerification({ supported: 0, unsupported: 2, agreementRate: 0.5 }),
      }),
    );

    expect(result.outcome).toBe("fail");
    expect(result.numericScore).toBeLessThan(1);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.some((note) => note.startsWith("verification-accuracy:"))).toBe(true);
  });

  it("aggregates a batch into pass rates and per-evaluator tallies", async () => {
    const harness = new ResearchEvalHarness();
    const report = await harness.evaluateBatch([
      { case: caseEntry(), context: context() },
      { case: caseEntry({ id: "case_b" }), context: context({ synthesis: "photonic" }) },
      { case: caseEntry({ id: "case_c" }), context: context({ elapsedNs: 20_000_000_000 }) },
    ]);

    expect(report.cases).toBe(3);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.passRate).toBeCloseTo(1 / 3);
    expect(report.meanScore).toBeGreaterThan(0);
    expect(report.perEvaluator.get("coverage")!.total).toBe(3);
    expect(report.perEvaluator.get("coverage")!.passed).toBe(2);
    expect(report.p95LatencyNs).toBeGreaterThan(0);
    expect(report.summary).toContain("Eval report");
  });

  it("detects regressions against a stored baseline", async () => {
    const harness = new ResearchEvalHarness();
    harness.setBaseline(new Map<string, number>([["case_a", 1]]));

    const report = await harness.evaluateBatch([
      { case: caseEntry(), context: context({ synthesis: "photonic" }) },
    ]);

    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0]).toMatch(/^case_a: 1\.000 → 0\.\d+$/);
  });

  it("reports no regression when a score holds or improves", async () => {
    const harness = new ResearchEvalHarness();
    harness.setBaseline(new Map([["case_a", 0.5]]));
    const report = await harness.evaluateBatch([{ case: caseEntry(), context: context() }]);
    expect(report.regressions).toHaveLength(0);
  });

  it("delegates the outcome to a judge seam and maps it to a score", async () => {
    const outcomes: RatingOutcome[] = [];
    const harness = new ResearchEvalHarness({
      judge: {
        judge: (prompt: string) => {
          outcomes.push("pass");
          expect(prompt).toContain("You are an evaluator");
          expect(prompt).toContain("1. Does the synthesis answer");
          return "pass";
        },
      },
    });
    const result = await harness.evaluateCase(caseEntry(), context());
    expect(outcomes).toEqual(["pass"]);
    expect(result.outcome).toBe("pass");
    expect(result.numericScore).toBe(1);
  });

  it("maps a starred judge rating onto the numeric scale", async () => {
    const harness = new ResearchEvalHarness({ judge: { judge: () => 4 } });
    const result = await harness.evaluateCase(caseEntry(), context());
    expect(result.outcome).toBe(4);
    expect(result.numericScore).toBeCloseTo(0.8);
  });

  it("runs a custom evaluator set", async () => {
    const harness = new ResearchEvalHarness({ evaluators: [new CoverageEvaluator()] });
    const result = await harness.evaluateCase(caseEntry(), context());
    expect(result.evaluatorResults).toHaveLength(1);
    expect(result.evaluatorResults[0]!.name).toBe("coverage");
  });
});
