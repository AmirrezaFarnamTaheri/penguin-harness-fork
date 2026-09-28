/**
 * One vocabulary for what happened, with MISSING and FAILED kept apart.
 *
 * The distinction is the whole point. "We don't know" and "we know, and it is bad" are different
 * states with different next actions — one asks for more evidence, the other asks for a fix —
 * and collapsing them is the most common defect in agent outcome reporting. A run that reports
 * "3 failures" when two of them were never attempted has told the reader to go and fix
 * something that does not exist yet.
 *
 * A closed enumeration rather than free text, for the same reason the review presets carry
 * stable codes: findings that can be counted, diffed between runs, and aggregated across a
 * project are worth having; prose that has to be parsed is not.
 */
export const OUTCOME_CODES = [
  // Evidence we expected and did not get.
  "missing_evidence",
  "missing_required_command",
  "missing_requirement",
  "missing_probe_evidence",
  "missing_artifact_evaluation",
  // Evidence we got, and it failed. Each pairs with the MISSING_ above it.
  "development_failed",
  "development_stopped",
  "development_not_started",
  "required_command_failed",
  "requirement_failed",
  "probe_evidence_failed",
  "artifact_evaluation_failed",
  // Budget: a limit was reached, which is neither success nor a defect in the work.
  "wall_budget_exceeded",
  "file_budget_exceeded",
  // Evidence was obtained but is too weak to conclude from.
  "low_evidence_support",
  "low_reproducibility",
  "high_residual_risk",
  "low_shipping_value",
  // Uncertainty about the judgement rather than about the evidence.
  "low_confidence",
  "close_result",
  "objectively_dominated",
] as const;

export type OutcomeCode = (typeof OUTCOME_CODES)[number];

/** The MISSING_/FAILED_ pair for one concern, so a report can say both without inventing names. */
const PAIRS: ReadonlyArray<readonly [OutcomeCode, OutcomeCode]> = [
  ["missing_evidence", "development_failed"],
  ["missing_required_command", "required_command_failed"],
  ["missing_requirement", "requirement_failed"],
  ["missing_probe_evidence", "probe_evidence_failed"],
  ["missing_artifact_evaluation", "artifact_evaluation_failed"],
];

/** True for the "we do not know" half of the vocabulary. */
export function isUnknown(code: OutcomeCode): boolean {
  return code.startsWith("missing_");
}

/** True for the "we know and it is bad" half. */
export function isFailure(code: OutcomeCode): boolean {
  return (
    code.startsWith("development_") ||
    code === "required_command_failed" ||
    code === "requirement_failed" ||
    code === "probe_evidence_failed" ||
    code === "artifact_evaluation_failed"
  );
}

/** True for a limit that was reached rather than a defect in the work. */
export function isBudget(code: OutcomeCode): boolean {
  return code === "wall_budget_exceeded" || code === "file_budget_exceeded";
}

/** The counterpart of a code, for a report that must state both halves explicitly. */
export function counterpart(code: OutcomeCode): OutcomeCode | null {
  for (const [missing, failed] of PAIRS) {
    if (code === missing) return failed;
    if (code === failed) return missing;
  }
  return null;
}

export interface OutcomeTally {
  readonly total: number;
  /** Never obtained — the reader's next action is to obtain them. */
  readonly missing: number;
  /** Obtained and failed — the reader's next action is to fix them. */
  readonly failed: number;
  /** Reached a limit; not a defect in the work. */
  readonly budget: number;
  /** Counts per code, in the vocabulary's own order, so a report is stable between runs. */
  readonly byCode: ReadonlyMap<OutcomeCode, number>;
}

/**
 * Tallies a set of codes. The distinction is preserved in the totals rather than collapsed: a
 * caller that only reads `total` has still thrown away the information, and that is their call
 * to make, but it is not the default.
 */
export function tallyOutcomes(codes: readonly OutcomeCode[]): OutcomeTally {
  const byCode = new Map<OutcomeCode, number>();
  let missing = 0;
  let failed = 0;
  let budget = 0;
  for (const code of codes) {
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
    if (isUnknown(code)) missing += 1;
    else if (isBudget(code)) budget += 1;
    else if (isFailure(code)) failed += 1;
  }
  // Ordered by the vocabulary, not by insertion: two reports of the same outcomes compare equal.
  const ordered = new Map<OutcomeCode, number>();
  for (const code of OUTCOME_CODES) {
    const count = byCode.get(code);
    if (count !== undefined) ordered.set(code, count);
  }
  return { total: codes.length, missing, failed, budget, byCode: ordered };
}
