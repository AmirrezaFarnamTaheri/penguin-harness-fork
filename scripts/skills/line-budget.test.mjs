import test from "node:test";
import assert from "node:assert/strict";
import {
  compareLineBudget,
  MAX_SKILL_LINES,
  parseNameStatus,
  physicalLineCount,
} from "./line-budget.mjs";

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

test("reads rename and copy baselines from the base path", () => {
  const output = [
    "M",
    ".agents/skills/edited/SKILL.md",
    "R100",
    ".agents/skills/old-name/SKILL.md",
    ".agents/skills/new-name/SKILL.md",
    "C075",
    ".agents/skills/source/SKILL.md",
    ".agents/skills/copy/SKILL.md",
    "A",
    ".agents/skills/added/SKILL.md",
    "",
  ].join("\0");
  assert.deepEqual(parseNameStatus(output), [
    {
      status: "M",
      file: ".agents/skills/edited/SKILL.md",
      baselineFile: ".agents/skills/edited/SKILL.md",
    },
    {
      status: "R100",
      file: ".agents/skills/new-name/SKILL.md",
      baselineFile: ".agents/skills/old-name/SKILL.md",
    },
    {
      status: "C075",
      file: ".agents/skills/copy/SKILL.md",
      baselineFile: ".agents/skills/source/SKILL.md",
    },
    {
      status: "A",
      file: ".agents/skills/added/SKILL.md",
      baselineFile: ".agents/skills/added/SKILL.md",
    },
  ]);
  assert.throws(() => parseNameStatus("R100\0.agents/skills/only-old/SKILL.md\0"), /Malformed/);
});
