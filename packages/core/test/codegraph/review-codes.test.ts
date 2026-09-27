import { describe, it, expect } from "vitest";
import {
  ANTI_DRIFT_GUIDANCE,
  CONDITIONAL_METRICS,
  METRIC_PRIORITY,
  metricForRule,
  NO_MATERIAL_ISSUE,
  priorityForRule,
  REVIEW_METRICS,
  RULE_METRICS,
  type ReviewMetric,
} from "../../src/codegraph/review-codes.js";
import {
  ARCHITECTURE_PRESET,
  CODE_QUALITY_PRESET,
  SECURITY_PRESET,
} from "../../src/codegraph/review-presets.js";

const ALL_PRESETS = [...SECURITY_PRESET, ...CODE_QUALITY_PRESET, ...ARCHITECTURE_PRESET];

describe("review finding vocabulary", () => {
  it("classifies every rule that ships, so no finding is uncoded", () => {
    // The point of a closed vocabulary is that it is closed. A rule with no metric is a finding
    // that cannot be counted, and the gap is invisible in a report.
    const uncoded = ALL_PRESETS.map((rule) => rule.id).filter(
      (id) => metricForRule(id) === undefined,
    );
    expect(uncoded).toEqual([]);
  });

  it("carries no rule id the presets do not define", () => {
    // The other direction: a mapping that names a rule nobody has is a typo that reads as coverage.
    const ids = new Set(ALL_PRESETS.map((rule) => rule.id));
    const stale = Object.keys(RULE_METRICS).filter((id) => !ids.has(id));
    expect(stale).toEqual([]);
  });

  it("treats 'reviewed and clean' as a countable outcome rather than an empty string", () => {
    expect(REVIEW_METRICS).toContain(NO_MATERIAL_ISSUE);
    expect(METRIC_PRIORITY[NO_MATERIAL_ISSUE]).toBe(0);
  });

  it("weighs a security finding above a maintainability one", () => {
    expect(METRIC_PRIORITY.security).toBeGreaterThan(METRIC_PRIORITY.maintainability);
    expect(priorityForRule("sec-sql-injection")).toBeGreaterThan(priorityForRule("q-magic-number"));
    expect(priorityForRule("does-not-exist")).toBe(0);
  });

  it("gives every metric anti-drift guidance that names a concrete failure", () => {
    for (const metric of REVIEW_METRICS) {
      const guidance = ANTI_DRIFT_GUIDANCE[metric];
      expect(guidance, `no guidance for ${metric}`).toBeTypeOf("string");
      expect(guidance.length).toBeGreaterThan(20);
    }
  });

  it("marks the metrics that are only judged when relevant", () => {
    expect(CONDITIONAL_METRICS.has("architecture")).toBe(true);
    expect(CONDITIONAL_METRICS.has("security")).toBe(false);
  });

  it("has a priority for every metric it defines", () => {
    for (const metric of REVIEW_METRICS) {
      expect(METRIC_PRIORITY[metric as ReviewMetric], `no priority for ${metric}`).toBeTypeOf(
        "number",
      );
    }
  });
});
