/**
 * Selective prediction: turning a stream of confidences into a stated guarantee.
 *
 * The problem. Every "the model was only 70% sure, so do not act" threshold in a system is a
 * number someone picked. A raw confidence is not a probability of being right — models are
 * systematically overconfident, and how badly depends on the model, the prompt, and the task.
 * So a threshold of 0.8 is not "80% likely correct", it is "0.8 on an uncalibrated scale", and
 * two deployments that both use 0.8 can have very different error rates. That is a number in a
 * settings page, not a guarantee.
 *
 * The method, and what it buys. Sort the scored items by confidence, highest first. The
 * empirical risk of the kept prefix is `1 - cumsum(correct) / n`, which is a *measured* error
 * rate over the items actually answered rather than an assumed one. Walk down the ranking until
 * the measured risk would cross the error budget, and you have a coverage figure you can
 * promise: "I answer the top 62% of items with at most 5% error, and abstain on the rest." That
 * is a property of the data, and it degrades honestly: as the model gets worse, coverage falls.
 *
 * What this is NOT. Abstention here is a *reporting* decision — "answer this, or say you don't
 * know, and let the caller decide". It is never an authorization decision. Routing to a caller
 * that then runs a privileged action is fine; routing straight into one is the failure mode this
 * whole project refuses elsewhere, and nothing in this file can cause it.
 */

/** One scored decision: a confidence in [0,1] and whether it turned out right. */
export interface ScoredDecision {
  readonly confidence: number;
  readonly correct: boolean;
  /** Stable identity, so a caller can say WHICH items were answered. */
  readonly id: string;
}

export interface SelectiveOptions {
  /** The error rate the caller is willing to promise on what it does answer. */
  readonly errorBudget: number;
  /** Never return a threshold that keeps fewer than this many items. */
  readonly minAccepted?: number;
  /** Items whose confidence is below this floor are counted as unknown, never answered. */
  readonly confidenceFloor?: number;
}

export interface SelectiveVerdict {
  /** Confidence at or above which an item is answered. 0 when nothing qualifies. */
  readonly threshold: number;
  /** How many items the threshold answers. */
  readonly coverage: number;
  /** How many items exist in total. */
  readonly total: number;
  /** Measured error rate within the answered set. */
  readonly errorRate: number;
  /** Items at or below the confidence floor: the model says it does not know. */
  readonly unknown: number;
  /** True when the ranking could not meet the error budget and had to answer anyway. */
  readonly overBudget: boolean;
  /** Per-label accuracy of the answered set, for the labels that occurred. */
  readonly perLabel: ReadonlyMap<string, { answered: number; correct: number }>;
}

const DEFAULT_MIN_ACCEPTED = 1;
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Risk-coverage curve as parallel arrays, highest confidence first. Sorted with the label's own
 * confidence as the tiebreak so the ranking is DETERMINISTIC: two items with the same confidence
 * must not swap places between runs, or a threshold computed today would not describe the same
 * items tomorrow.
 */
export interface RiskCoverageCurve {
  readonly order: ReadonlyArray<ScoredDecision>;
  /** Indexed by rank: running error rate of the prefix of that length. */
  readonly risk: readonly number[];
  /** Indexed by rank: the coverage (fraction) of the prefix. */
  readonly coverage: readonly number[];
  /** Indexed by rank: the threshold that would select exactly that prefix. */
  readonly thresholds: readonly number[];
}

export function riskCoverageCurve(decisions: readonly ScoredDecision[]): RiskCoverageCurve {
  const order = [...decisions].sort(
    (a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1),
  );
  const risk: number[] = [];
  const coverage: number[] = [];
  const thresholds: number[] = [];
  let correct = 0;
  order.forEach((decision, index) => {
    if (decision.correct) correct += 1;
    const kept = index + 1;
    risk.push(1 - correct / kept);
    coverage.push(kept / order.length);
    // The threshold that selects this prefix is the LOWEST confidence in it: answering one item
    // fewer must not be needed to get here, and answering the whole prefix requires every member.
    thresholds.push(decision.confidence);
  });
  return { order, risk, coverage, thresholds };
}

/**
 * The largest prefix whose measured error rate stays within the budget.
 *
 * The scan runs from the FULL ranking downwards and stops at the first prefix that fits, so the
 * result is the largest satisfying prefix rather than the first one encountered. It is written
 * as a scan over `risk` because the risk of a prefix is not monotonic in general, and a rule
 * that assumed it was would silently answer less than it could.
 */
export function selectThreshold(
  decisions: readonly ScoredDecision[],
  options: SelectiveOptions,
): SelectiveVerdict {
  const minAccepted = options.minAccepted ?? DEFAULT_MIN_ACCEPTED;
  const floor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const total = decisions.length;
  const unknown = decisions.filter((decision) => decision.confidence < floor).length;
  const perLabel = new Map<string, { answered: number; correct: number }>();
  if (total === 0) {
    return {
      threshold: 0,
      coverage: 0,
      total: 0,
      errorRate: 0,
      unknown: 0,
      overBudget: false,
      perLabel,
    };
  }

  const curve = riskCoverageCurve(decisions);
  let chosen = 0;
  for (let index = curve.risk.length - 1; index >= 0; index -= 1) {
    if (curve.risk[index]! <= options.errorBudget) {
      chosen = index + 1;
      break;
    }
  }

  // Nothing fits the budget. Answer the best item anyway and say so, rather than answering
  // nothing and hiding the fact that the data cannot support the promise at all.
  const overBudget = chosen === 0;
  if (overBudget) chosen = Math.min(minAccepted, total);

  const answered = curve.order.slice(0, chosen);
  for (const decision of answered) {
    const entry = perLabel.get(decision.id) ?? { answered: 0, correct: 0 };
    entry.answered += 1;
    if (decision.correct) entry.correct += 1;
    perLabel.set(decision.id, entry);
  }

  const wrong = answered.filter((decision) => !decision.correct).length;
  return {
    threshold: chosen === 0 ? 0 : curve.thresholds[chosen - 1]!,
    coverage: answered.length / total,
    total,
    errorRate: answered.length === 0 ? 0 : wrong / answered.length,
    unknown,
    overBudget,
    perLabel,
  };
}

/**
 * Area under the risk–coverage curve, lower is better. Reported alongside coverage because a
 * coverage figure alone flatters a model that answers only the one item it was certain about:
 * 100% coverage at 100% error has a smaller AURC than it deserves to look.
 */
export function areaUnderRiskCoverage(curve: RiskCoverageCurve): number {
  let area = 0;
  // ∫ risk(c) dc from c=0 to c=1, trapezoid rule. Two things this loop got wrong the first time,
  // both of which made it report the same number for a model that is always right and one that
  // is always wrong: it integrated the COVERAGE instead of the risk, and it took the interval
  // width as `previous - current`, which is NEGATIVE because coverage grows with rank — so a
  // better model came out with a larger area.
  let previousRisk = 0; // The empty prefix's risk, at coverage 0.
  for (let index = 0; index < curve.coverage.length; index += 1) {
    const risk = curve.risk[index]!;
    const coverage = curve.coverage[index]!;
    const previousCoverage = index === 0 ? 0 : curve.coverage[index - 1]!;
    area += ((previousRisk + risk) / 2) * (coverage - previousCoverage);
    previousRisk = risk;
  }
  return area;
}

/**
 * Expected calibration error, in binned form. Non-linear in the per-item scores, so it must be
 * recomputed from them rather than averaged from pre-computed per-item confidences — averaging a
 * ratio of sums is not the ratio of the sums.
 */
export function expectedCalibrationError(decisions: readonly ScoredDecision[], bins = 10): number {
  if (decisions.length === 0) return 0;
  const width = 1 / Math.max(1, bins);
  const buckets = new Map<number, { total: number; correct: number; confidence: number }>();
  for (const decision of decisions) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(decision.confidence / width)));
    const bucket = buckets.get(index) ?? { total: 0, correct: 0, confidence: 0 };
    bucket.total += 1;
    bucket.confidence += decision.confidence;
    if (decision.correct) bucket.correct += 1;
    buckets.set(index, bucket);
  }
  let error = 0;
  for (const bucket of buckets.values()) {
    const meanConfidence = bucket.confidence / bucket.total;
    const accuracy = bucket.correct / bucket.total;
    error += (bucket.total / decisions.length) * Math.abs(accuracy - meanConfidence);
  }
  return error;
}

/**
 * The headline number, in the form a caller can put in front of a person: "answer the top X%
 * with at most Y% error". Returns null when there is nothing to measure, rather than a
 * confident-looking zero.
 */
export function describeSelective(
  decisions: readonly ScoredDecision[],
  options: SelectiveOptions,
): { summary: string; verdict: SelectiveVerdict } | null {
  const verdict = selectThreshold(decisions, options);
  if (verdict.total === 0) return null;
  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const summary = verdict.overBudget
    ? `No confidence threshold meets a ${pct(options.errorBudget)} error budget; the single most confident item is answered anyway.`
    : `Answering the top ${pct(verdict.coverage)} of items carries at most ${pct(options.errorBudget)} error (measured ${pct(verdict.errorRate)}). ${verdict.unknown} item${verdict.unknown === 1 ? "" : "s"} are below the confidence floor.`;
  return { summary, verdict };
}
