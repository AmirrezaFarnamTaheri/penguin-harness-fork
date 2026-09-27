import { describe, it, expect } from "vitest";
import {
  counterpart,
  isBudget,
  isFailure,
  isUnknown,
  OUTCOME_CODES,
  tallyOutcomes,
  type OutcomeCode,
} from "../../../src/agent/research/outcome-codes.js";

describe("outcome codes", () => {
  it(`keeps "we do not know" apart from "we know and it is bad"`, () => {
    // The distinction the whole vocabulary exists for: these two have different next actions,
    // and a report that merges them sends the reader to fix something that does not exist.
    expect(isUnknown("missing_evidence")).toBe(true);
    expect(isUnknown("development_failed")).toBe(false);
    expect(isFailure("development_failed")).toBe(true);
    expect(isFailure("missing_evidence")).toBe(false);
  });

  it("does not call a budget a failure", () => {
    expect(isBudget("wall_budget_exceeded")).toBe(true);
    expect(isFailure("wall_budget_exceeded")).toBe(false);
    expect(isUnknown("wall_budget_exceeded")).toBe(false);
  });

  it("names the counterpart of every paired code", () => {
    for (const code of OUTCOME_CODES) {
      const other = counterpart(code);
      if (other === null) continue;
      expect(counterpart(other)).toBe(code);
      expect(isUnknown(code)).not.toBe(isUnknown(other));
    }
  });

  it("has a counterpart for every MISSING_ code and no unpaired unknown", () => {
    for (const code of OUTCOME_CODES) {
      if (isUnknown(code)) expect(counterpart(code)).not.toBeNull();
    }
  });

  it("tallies the two halves separately", () => {
    const tally = tallyOutcomes([
      "missing_evidence",
      "missing_requirement",
      "development_failed",
      "wall_budget_exceeded",
    ] as OutcomeCode[]);
    expect(tally.total).toBe(4);
    expect(tally.missing).toBe(2);
    expect(tally.failed).toBe(1);
    expect(tally.budget).toBe(1);
    expect(tally.byCode.get("missing_evidence")).toBe(1);
  });

  it("orders its counts by the vocabulary, so two reports of the same outcomes compare equal", () => {
    const codes = ["development_failed", "missing_evidence"] as OutcomeCode[];
    const forwards = tallyOutcomes(codes);
    const backwards = tallyOutcomes([...codes].reverse() as OutcomeCode[]);
    expect([...forwards.byCode.keys()]).toEqual([...backwards.byCode.keys()]);
    // missing_evidence precedes development_failed in the vocabulary, whatever order they arrived.
    expect([...forwards.byCode.keys()][0]).toBe("missing_evidence");
  });

  it("handles an empty tally without inventing a code", () => {
    const tally = tallyOutcomes([]);
    expect(tally.total).toBe(0);
    expect(tally.byCode.size).toBe(0);
  });
});
