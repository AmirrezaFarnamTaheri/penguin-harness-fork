import test from "node:test";
import assert from "node:assert/strict";
import { compareLineBudget, MAX_SKILL_LINES, physicalLineCount } from "./line-budget.mjs";

test("counts physical lines independent of newline style and final newline", () => {
  assert.equal(physicalLineCount("one\ntwo\n"), 2);
  assert.equal(physicalLineCount("one\r\ntwo"), 2);
  assert.equal(physicalLineCount(""), 0);
});

test("rejects a new over-limit skill but permits exactly the limit", () => {
  assert.equal(compareLineBudget(MAX_SKILL_LINES, 0).status, "within-budget");
  assert.equal(compareLineBudget(MAX_SKILL_LINES + 1, 0).status, "new-violation");
});

test("reports existing over-limit skills and rejects any further growth", () => {
  assert.equal(compareLineBudget(100, 100).status, "grandfathered");
  assert.equal(compareLineBudget(90, 100).status, "grandfathered");
  assert.equal(compareLineBudget(101, 100).status, "regression");
});

test("rejects invalid baseline counters", () => {
  assert.throws(() => compareLineBudget(1.5, 0), RangeError);
});
