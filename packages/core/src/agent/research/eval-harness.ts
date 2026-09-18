/**
 * Research evaluation harness.
 *
 * Observation and scoring for a deep-research loop, ported from the eval platforms in
 * this track: rating types and step-builder prompts from the Kiln eval framework, and
 * the dataset / evaluator / report split from pydantic-evals. What is kept from both
 * is the discipline that an evaluation is *data* — a dataset of cases, a set of
 * evaluators that score an output, and a report that aggregates the scores — so a
 * change to the research loop can be judged rather than eyeballed.
 *
 * No model access is required: the default evaluators are deterministic, and an
 * LLM-as-judge seam is provided for cases where a rubric needs interpretation.
 */

import type { Claim } from "./claim-extractor.js";
import { aggregateSpecificity } from "./claim-extractor.js";
import type { CitationReport } from "./citation-network.js";
import type { VerificationSummary } from "./evidence-verifier.js";

export type RatingType = "five-star" | "pass-fail" | "pass-fail-critical";

export type RatingOutcome = 1 | 2 | 3 | 4 | 5 | "pass" | "fail" | "critical";

export interface EvalCase {
  readonly id: string;
  readonly question: string;
  /** Fixture inputs the loop is run against (sources, expected markers). */
  readonly fixtures: EvalFixtures;
  /** Expected properties of a correct answer. */
  readonly expectations: CaseExpectations;
}

export interface EvalFixtures {
  readonly sources: ReadonlyArray<{ id: string; title: string; text: string }>;
  readonly queries?: readonly string[];
}

export interface CaseExpectations {
  /** Minimum sources a synthesis must cover. */
  readonly minSources?: number;
  /** Claims that must appear as supported. */
  readonly requiredClaims?: readonly string[];
  /** Terms a synthesis must contain. */
  readonly requiredTerms?: readonly string[];
  /** Terms a synthesis must not contain (hallucination probes). */
  readonly forbiddenTerms?: readonly string[];
  readonly ratingType?: RatingType;
}

export interface EvalResult {
  readonly caseId: string;
  readonly outcome: RatingOutcome;
  readonly numericScore: number;
  readonly evaluatorResults: ReadonlyArray<EvaluatorResult>;
  readonly durationNs: number;
  readonly notes: string[];
}

export interface EvaluatorResult {
  readonly name: string;
  readonly passed: boolean;
  readonly score: number;
  readonly detail?: string;
}

export interface EvalReport {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly critical: number;
  readonly passRate: number;
  readonly meanScore: number;
  readonly p50Score: number;
  readonly p95LatencyNs: number;
  readonly perEvaluator: ReadonlyMap<string, { passed: number; total: number; rate: number }>;
  readonly regressions: string[];
  readonly summary: string;
}

/** Human-readable description of the allowed values for a rating type. */
export function scoreScaleInstruction(ratingType: RatingType): string {
  switch (ratingType) {
    case "five-star":
      return "an integer from 1 to 5, where 1 is the worst and 5 is the best";
    case "pass-fail":
      return '"pass" or "fail"';
    case "pass-fail-critical":
      return '"pass", "fail", or "critical" (critical = a very severe failure)';
  }
}

/**
 * An evaluator scores one aspect of a research output. Deterministic by default; the
 * judge seam exists for rubric-style evaluation that needs interpretation.
 */
export interface ResearchOutputEvaluator {
  readonly name: string;
  evaluate(context: EvaluationContext): EvaluatorResult;
}

export interface EvaluationContext {
  readonly question: string;
  readonly synthesis: string;
  readonly claims: readonly Claim[];
  readonly citationReport: CitationReport;
  readonly verification: VerificationSummary;
  readonly expectations: CaseExpectations;
  /** Time the research loop took to produce this output. */
  readonly elapsedNs: number;
}

/**
 * An LLM-as-judge seam. The harness never calls a model directly; a caller supplies
 * this so a rubric can be applied where a deterministic check is too brittle.
 */
export interface JudgeSeam {
  judge(prompt: string): Promise<RatingOutcome> | RatingOutcome;
}

/** Builds the numbered evaluation steps a rubric judge is asked to walk through. */
export function buildEvalSteps(expectations: CaseExpectations): string[] {
  const steps: string[] = [
    "Does the synthesis answer the research question, using only the provided sources?",
  ];
  if (expectations.minSources) {
    steps.push(`Does it cover at least ${expectations.minSources} sources?`);
  }
  if (expectations.requiredClaims?.length) {
    steps.push(
      `Are the following claims supported by the synthesis and verified against source text: ${expectations.requiredClaims.join("; ")}?`,
    );
  }
  if (expectations.forbiddenTerms?.length) {
    steps.push(`Does it avoid asserting any of: ${expectations.forbiddenTerms.join("; ")}?`);
  }
  steps.push(
    `Considering the above, rate the output as ${scoreScaleInstruction(expectations.ratingType ?? "pass-fail")}.`,
  );
  return steps;
}

/** Coverage evaluator: required terms present, forbidden terms absent. */
export class CoverageEvaluator implements ResearchOutputEvaluator {
  readonly name = "coverage";

  evaluate(context: EvaluationContext): EvaluatorResult {
    const synthesis = context.synthesis.toLowerCase();
    const missing = (context.expectations.requiredTerms ?? []).filter(
      (term) => !synthesis.includes(term.toLowerCase()),
    );
    const leaked = (context.expectations.forbiddenTerms ?? []).filter((term) =>
      synthesis.includes(term.toLowerCase()),
    );

    const total =
      (context.expectations.requiredTerms ?? []).length +
      (context.expectations.forbiddenTerms ?? []).length;
    const correct = total - missing.length - leaked.length;
    return {
      name: this.name,
      passed: missing.length === 0 && leaked.length === 0,
      score: total > 0 ? correct / total : 1,
      detail: [
        missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
        leaked.length > 0 ? `forbidden present: ${leaked.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  }
}

/** Citation-hallucination evaluator: the QoS target is zero unresolved markers. */
export class CitationHallucinationEvaluator implements ResearchOutputEvaluator {
  readonly name = "citation-hallucination";

  evaluate(context: EvaluationContext): EvaluatorResult {
    const unresolved = context.citationReport.unresolvedMarkers.length;
    return {
      name: this.name,
      passed: unresolved === 0,
      score: 1 - context.citationReport.hallucinationRate,
      detail:
        unresolved === 0
          ? "all citation markers resolve to fetched sources"
          : `${unresolved} unresolved markers: ${context.citationReport.unresolvedMarkers
              .slice(0, 5)
              .map((marker) => marker.marker)
              .join(", ")}`,
    };
  }
}

/** Verification evaluator: agreement rate of claim verification against sources. */
export class VerificationAccuracyEvaluator implements ResearchOutputEvaluator {
  readonly name = "verification-accuracy";

  constructor(private readonly target = 0.992) {}

  evaluate(context: EvaluationContext): EvaluatorResult {
    const rate = context.verification.agreementRate;
    return {
      name: this.name,
      passed: rate >= this.target,
      score: rate,
      detail: `${context.verification.supported} supported, ${context.verification.contradicted} contradicted, ${context.verification.unsupported} unsupported, ${context.verification.unverifiable} unverifiable (target ${this.target})`,
    };
  }
}

/** Latency evaluator: enforces the plan's wall-clock budget for a synthesis. */
export class LatencyEvaluator implements ResearchOutputEvaluator {
  readonly name = "latency";
  constructor(private readonly budgetNs = 12_000_000_000) {}

  evaluate(context: EvaluationContext): EvaluatorResult {
    return {
      name: this.name,
      passed: context.elapsedNs <= this.budgetNs,
      score: Math.min(1, this.budgetNs / Math.max(1, context.elapsedNs)),
      detail: `${(context.elapsedNs / 1e9).toFixed(3)}s against a ${(this.budgetNs / 1e9).toFixed(1)}s budget`,
    };
  }
}

/** Specificity evaluator: a synthesis of vague claims scores low even if it is accurate. */
export class SpecificityEvaluator implements ResearchOutputEvaluator {
  readonly name = "specificity";
  constructor(private readonly minMean = 0.35) {}

  evaluate(context: EvaluationContext): EvaluatorResult {
    const aggregate = aggregateSpecificity(context.claims);
    return {
      name: this.name,
      passed: aggregate.mean >= this.minMean,
      score: aggregate.mean,
      detail: `mean specificity ${aggregate.mean.toFixed(3)} over ${context.claims.length} claims`,
    };
  }
}

/**
 * The harness. Runs deterministic evaluators per case, converts the results to the
 * case's rating type, and reports pass rates plus a regression list against a stored
 * baseline.
 */
export class ResearchEvalHarness {
  private readonly evaluators: ResearchOutputEvaluator[];
  private readonly judge?: JudgeSeam;
  private baseline: ReadonlyMap<string, number> = new Map();

  constructor(options: { evaluators?: ResearchOutputEvaluator[]; judge?: JudgeSeam } = {}) {
    this.evaluators = options.evaluators ?? [
      new CoverageEvaluator(),
      new CitationHallucinationEvaluator(),
      new VerificationAccuracyEvaluator(),
      new LatencyEvaluator(),
      new SpecificityEvaluator(),
    ];
    this.judge = options.judge;
  }

  /** Sets the baseline scores a run is compared against for regression detection. */
  setBaseline(scores: ReadonlyMap<string, number>): void {
    this.baseline = new Map(scores);
  }

  /** Evaluates one case against a research output. */
  async evaluateCase(caseEntry: EvalCase, context: EvaluationContext): Promise<EvalResult> {
    const started = nowNs();
    const results = this.evaluators.map((evaluator) => evaluator.evaluate(context));
    const notes: string[] = [];

    const deterministic =
      results.reduce((sum, result) => sum + result.score, 0) / Math.max(1, results.length);
    let outcome: RatingOutcome = results.every((result) => result.passed) ? "pass" : "fail";
    let numeric = deterministic;

    if (this.judge) {
      const prompt = buildJudgePrompt(caseEntry, context, results);
      outcome = await this.judge.judge(prompt);
      numeric = ratingToScore(outcome, deterministic);
    }

    for (const result of results) {
      if (!result.passed && result.detail) notes.push(`${result.name}: ${result.detail}`);
    }

    return {
      caseId: caseEntry.id,
      outcome,
      numericScore: numeric,
      evaluatorResults: results,
      durationNs: nowNs() - started,
      notes,
    };
  }

  /** Evaluates a batch of cases and produces the aggregate report. */
  async evaluateBatch(
    cases: ReadonlyArray<{ case: EvalCase; context: EvaluationContext }>,
  ): Promise<EvalReport> {
    const results = await Promise.all(
      cases.map((entry) => this.evaluateCase(entry.case, entry.context)),
    );
    return this.summarise(results);
  }

  private summarise(results: readonly EvalResult[]): EvalReport {
    const total = results.length;
    const outcomes = new Map<RatingOutcome, number>();
    const perEvaluator = new Map<string, { passed: number; total: number; rate: number }>();

    for (const result of results) {
      outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
      for (const evaluatorResult of result.evaluatorResults) {
        const bucket = perEvaluator.get(evaluatorResult.name) ?? { passed: 0, total: 0, rate: 0 };
        bucket.passed += evaluatorResult.passed ? 1 : 0;
        bucket.total += 1;
        bucket.rate = bucket.passed / bucket.total;
        perEvaluator.set(evaluatorResult.name, bucket);
      }
    }

    const passed =
      (outcomes.get("pass") ?? 0) +
      (outcomes.get(3) ?? 0) +
      (outcomes.get(4) ?? 0) +
      (outcomes.get(5) ?? 0);
    const failed = (outcomes.get("fail") ?? 0) + (outcomes.get(1) ?? 0) + (outcomes.get(2) ?? 0);
    const critical = outcomes.get("critical") ?? 0;

    const scores = results.map((result) => result.numericScore).sort((a, b) => a - b);
    const latencies = results.map((result) => result.durationNs).sort((a, b) => a - b);

    const regressions: string[] = [];
    for (const result of results) {
      const previous = this.baseline.get(result.caseId);
      if (previous !== undefined && result.numericScore < previous) {
        regressions.push(
          `${result.caseId}: ${previous.toFixed(3)} → ${result.numericScore.toFixed(3)}`,
        );
      }
    }

    return {
      cases: total,
      passed,
      failed,
      critical,
      passRate: total > 0 ? passed / total : 0,
      meanScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      p50Score: scores.length > 0 ? (scores[Math.floor(scores.length / 2)] ?? 0) : 0,
      p95LatencyNs:
        latencies.length > 0
          ? (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0)
          : 0,
      perEvaluator,
      regressions,
      summary: this.render(total, passed, failed, critical, perEvaluator),
    };
  }

  private render(
    total: number,
    passed: number,
    failed: number,
    critical: number,
    perEvaluator: ReadonlyMap<string, { passed: number; total: number; rate: number }>,
  ): string {
    const lines = [
      `Eval report: ${total} cases — ${passed} passed, ${failed} failed, ${critical} critical.`,
      "",
      "Per evaluator:",
    ];
    for (const [name, bucket] of perEvaluator) {
      lines.push(
        `  ${name}: ${bucket.passed}/${bucket.total} (${(bucket.rate * 100).toFixed(1)}%)`,
      );
    }
    return lines.join("\n");
  }
}

function buildJudgePrompt(
  caseEntry: EvalCase,
  context: EvaluationContext,
  results: readonly EvaluatorResult[],
): string {
  const steps = buildEvalSteps(caseEntry.expectations);
  const lines = [
    `You are an evaluator. Rate the research output on the following steps:`,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Deterministic evaluator findings:",
    ...results.map(
      (result) =>
        `- ${result.name}: ${result.passed ? "pass" : "fail"} (${result.score.toFixed(2)})`,
    ),
    "",
    "Synthesis under evaluation:",
    context.synthesis.slice(0, 4_000),
  ];
  return lines.join("\n");
}

function ratingToScore(outcome: RatingOutcome, fallback: number): number {
  switch (outcome) {
    case 1:
      return 0.2;
    case 2:
      return 0.4;
    case 3:
      return 0.6;
    case 4:
      return 0.8;
    case 5:
      return 1;
    case "pass":
      return 1;
    case "fail":
      return 0;
    case "critical":
      return 0;
  }
  return fallback;
}

function nowNs(): number {
  if (typeof process !== "undefined" && typeof process.hrtime?.bigint === "function") {
    return Number(process.hrtime.bigint());
  }
  return Date.now() * 1e6;
}
