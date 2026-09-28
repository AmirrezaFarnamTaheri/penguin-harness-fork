/**
 * A closed vocabulary for review findings, with the guidance that keeps a reviewer honest.
 *
 * Why codes at all. A finding whose category is prose can be read but not aggregated: you cannot
 * count how many of a class there were, diff them between runs, or notice that a category has
 * quietly doubled. A closed code makes findings a countable population, which is the property
 * that lets a reviewer be measured at all.
 *
 * Two devices do most of the work here, and both come from watching LLM reviewers fail in
 * predictable ways:
 *
 * - `NO_MATERIAL_ISSUE` is a real code. "Nothing found" becomes an explicit, countable outcome
 *   rather than an empty string, so a report can distinguish a reviewer that looked and found
 *   nothing from one that produced no output at all — a distinction a text report cannot make.
 * - Every metric carries ANTI-DRIFT guidance. The failure modes are well known: rewarding short
 *   files, flagging stylistic duplication as a defect, inventing a performance problem to fill
 *   the report, praising speculative architecture, judging a file by its line count. The guidance
 *   says so explicitly, because a reviewer that has not been told will do all five.
 *
 * Codes are a property of the METRIC (what kind of problem is this), while severity stays a
 * property of the FINDING (how much does this instance matter). Keeping the two apart is what
 * lets one metric produce findings of different severities without inventing categories.
 */

/** The canonical "reviewed and clean" outcome. */
export const NO_MATERIAL_ISSUE = "no_material_issue";

/** Anti-drift guidance, keyed by metric. Short enough to sit in a prompt, specific enough to act on. */
export const ANTI_DRIFT_GUIDANCE: Readonly<Record<ReviewMetric, string>> = {
  correctness:
    "Do not use length, style, or taste as evidence. A finding is correctness only when a specific input produces a specific wrong output.",
  edge_case:
    "Do not report a missing guard for an input the caller cannot construct. Name the input.",
  regression_risk:
    "Do not report risk that is already covered by a test in the change set; the test is the evidence against it.",
  security:
    "Do not report a theoretical issue with no reachable path. Trace the value from a source you can name.",
  performance:
    "Require evidence; do not invent bottlenecks. A finding needs a measured or provable cost, not a plausible one.",
  duplication:
    "Do not enforce syntactic DRY or couple merely similar code. Two blocks that change together belong together; two that do not, do not.",
  forced_reuse:
    "The counter-case: reuse that couples concepts which should stay separate. Deduplication is not automatically an improvement.",
  complexity:
    "Do not reward small files by default and do not reward long ones either. Judge the control flow, not the count.",
  observability:
    "Do not require a log line for something that cannot fail silently. Name the failure mode you expect to be invisible.",
  scalability: "Judged only when the context makes it relevant; say what makes it relevant here.",
  compatibility:
    "Judged only when a public shape changes. An internal signature is not a compatibility concern.",
  architecture:
    "Do not reward speculative architecture. A layer justified by a second caller is a layer; one justified by foresight is not.",
  maintainability:
    "Do not file a finding whose only remedy is 'add a comment' or 'make it more idiomatic'.",
  correctness_of_tests:
    "Do not report a missing assertion when the code under test cannot take the wrong branch.",
  [NO_MATERIAL_ISSUE]:
    "Say this explicitly when a metric found nothing. An empty answer and a clean answer are different facts, and only one of them is a result.",
};

/** The metrics a finding can be about. Closed, so a report can aggregate over them. */
export const REVIEW_METRICS = [
  "correctness",
  "edge_case",
  "regression_risk",
  "security",
  "performance",
  "duplication",
  "forced_reuse",
  "complexity",
  "observability",
  "scalability",
  "compatibility",
  "architecture",
  "maintainability",
  "correctness_of_tests",
  NO_MATERIAL_ISSUE,
] as const;

export type ReviewMetric = (typeof REVIEW_METRICS)[number];

/**
 * How much a finding of this metric should count when ranking. A security finding outweighs a
 * maintainability one regardless of how many of the latter are found, so the weight is a property
 * of the metric and the ordering happens once, at the end.
 */
export const METRIC_PRIORITY: Readonly<Record<ReviewMetric, number>> = {
  security: 3,
  correctness: 3,
  regression_risk: 3,
  correctness_of_tests: 2,
  edge_case: 2,
  forced_reuse: 2,
  compatibility: 2,
  performance: 2,
  architecture: 2,
  complexity: 1,
  duplication: 1,
  maintainability: 1,
  observability: 1,
  scalability: 1,
  [NO_MATERIAL_ISSUE]: 0,
};

/** Metrics only judged when the change actually makes them relevant. */
export const CONDITIONAL_METRICS: ReadonlySet<ReviewMetric> = new Set([
  "scalability",
  "compatibility",
  "architecture",
  "performance",
]);

/**
 * Metric for each existing rule id, so a rule set gains a countable dimension without every
 * preset being rewritten. A single table rather than a field per rule: the mapping is reviewable
 * in one place, and a rule that is missing from it is visibly missing rather than silently
 * uncoded.
 */
export const RULE_METRICS: Readonly<Record<string, ReviewMetric>> = {
  // Security preset.
  "sec-hardcoded-secret": "security",
  "sec-eval-exec": "security",
  "sec-sql-injection": "security",
  "sec-xss-innerhtml": "security",
  "sec-path-traversal": "security",
  "sec-permissive-cors": "security",
  // Code-quality preset.
  "q-swallowed-exception": "correctness",
  "q-broad-catch": "maintainability",
  "q-magic-number": "maintainability",
  "q-todo-fixme": "maintainability",
  "q-deep-nesting": "complexity",
  "q-debug-logging": "maintainability",
  // Architecture preset.
  "a-long-method": "complexity",
  "a-god-object": "architecture",
  "a-dead-code-suspect": "maintainability",
  "a-shotgun-surgery": "duplication",
};

/** The metric for a rule id, or `undefined` when a rule has not been classified yet. */
export function metricForRule(ruleId: string): ReviewMetric | undefined {
  return RULE_METRICS[ruleId];
}

/** The rank contribution of a rule id, or 0 when unclassified. */
export function priorityForRule(ruleId: string): number {
  const metric = RULE_METRICS[ruleId];
  return metric === undefined ? 0 : (METRIC_PRIORITY[metric] ?? 0);
}
