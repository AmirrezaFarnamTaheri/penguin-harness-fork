import { describe, it, expect } from "vitest";
import {
  auditEvalRun,
  buildEvalRunManifest,
  hashValue,
  type AuditInput,
  type EvalRunManifest,
} from "../../../src/agent/research/eval-manifest.js";

const COMMIT = "a".repeat(40);
const DATASET = { cases: ["c1", "c2"], fixtures: { q: "x" } };
const SCORER = { version: 1, gates: ["coverage", "citations"] };
const ROWS = [
  { caseId: "c1", outcome: "pass", numericScore: 0.9 },
  { caseId: "c2", outcome: "fail", numericScore: 0.4 },
];

function manifest(overrides: Partial<Parameters<typeof buildEvalRunManifest>[0]> = {}) {
  return buildEvalRunManifest({
    dataset: DATASET,
    scorer: SCORER,
    rows: ROWS,
    modelRevision: COMMIT,
    reporting: "pass-fail",
    ...overrides,
  });
}

function auditRun(m: EvalRunManifest, rows = ROWS, overrides: Partial<AuditInput> = {}) {
  return auditEvalRun({
    manifest: m,
    rows,
    dataset: DATASET,
    scorer: SCORER,
    modelRevision: m.modelRevision,
    reporting: m.reporting,
    cwd: process.cwd(),
    reparse: (row) => ({ outcome: row.outcome, numericScore: row.numericScore }),
    ...overrides,
  });
}

describe("eval run manifest", () => {
  it("hashes equal values equally regardless of key order", () => {
    expect(hashValue({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(
      hashValue({ b: [2, { c: 3, d: 4 }], a: 1 }),
    );
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("refuses a floating model tag, which is the one drift it could not detect later", () => {
    expect(() => manifest({ modelRevision: "gpt-4o" })).toThrow(/commit id/);
    expect(() => manifest({ modelRevision: "main" })).toThrow(/commit id/);
    expect(() => manifest({ modelRevision: "A".repeat(40) })).toThrow(/commit id/);
    expect(manifest().modelRevision).toBe(COMMIT);
  });

  it("certifies a run whose every input is unchanged", () => {
    const m = manifest();
    const audit = auditRun(m);
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("names each drifted input separately rather than reporting that something changed", () => {
    const m = manifest();
    const audit = auditRun(m, [...ROWS, { caseId: "c3", outcome: "pass", numericScore: 1 }], {
      dataset: { cases: ["c1", "c2", "c3"] },
      scorer: { version: 2, gates: ["coverage"] },
    });
    expect(audit.ok).toBe(false);
    // All three, and each says WHICH input moved.
    expect(audit.problems.some((p) => p.includes("row count"))).toBe(true);
    expect(audit.problems.some((p) => p.includes("dataset changed"))).toBe(true);
    expect(audit.problems.some((p) => p.includes("scorer changed"))).toBe(true);
  });

  it("gives no partial credit to a case that errored", () => {
    const crashed = [{ ...ROWS[0]!, error: "evaluator threw" }, ROWS[1]!];
    const m = buildEvalRunManifest({
      dataset: DATASET,
      scorer: SCORER,
      rows: crashed,
      modelRevision: COMMIT,
      reporting: "pass-fail",
    });
    const audit = auditRun(m, crashed);
    expect(audit.ok).toBe(false);
    expect(audit.problems.join(" ")).toContain("c1 did not complete");
  });

  it("catches a duplicate case id", () => {
    const duped = [ROWS[0]!, ROWS[0]!];
    const m = buildEvalRunManifest({
      dataset: DATASET,
      scorer: SCORER,
      rows: duped,
      modelRevision: COMMIT,
      reporting: "pass-fail",
    });
    const audit = auditRun(m, duped);
    expect(audit.problems.join(" ")).toContain("duplicate case id: c1");
  });

  it("catches a recorded score the raw response no longer reproduces", () => {
    const m = manifest();
    const audit = auditRun(m, ROWS, {
      // The scorer was edited so that c2 now passes, but the recorded output was never
      // regenerated. c1 is unchanged, so the mismatch is c2's alone.
      reparse: (row) => (row.caseId === "c2" ? { outcome: "pass", numericScore: 0.95 } : null),
    });
    expect(audit.ok).toBe(false);
    const replay = audit.problems.find((p) => p.includes("does not re-derive"));
    expect(replay).toContain("c2");
    expect(replay).not.toContain("c1");
  });

  it("catches a score that moved under an unchanged case id", () => {
    const m = manifest();
    const moved = [{ ...ROWS[0]!, numericScore: 0.95 }, ROWS[1]!];
    const audit = auditRun(m, moved);
    expect(audit.problems.join(" ")).toContain("scored rows changed");
  });

  it("requires the current model, reporting mode, and a successful reparse of every row", () => {
    const m = manifest();
    const audit = auditRun(m, ROWS, {
      modelRevision: "b".repeat(40),
      reporting: "five-star",
      reparse: () => null,
    });
    expect(audit.problems.join(" ")).toContain("model revision changed");
    expect(audit.problems.join(" ")).toContain("reporting mode changed");
    expect(
      audit.problems.filter((problem) => problem.includes("could not be re-derived")),
    ).toHaveLength(2);
  });

  it("compares the repository revision being audited with the current checkout", () => {
    const m = { ...manifest(), repoCommit: "b".repeat(40) };
    const audit = auditRun(m);
    expect(audit.problems.join(" ")).toContain("repository revision changed");
  });

  it("reads the repository revision from git rather than trusting the caller", () => {
    // cwd defaults to the process root, which in this repository IS a git checkout, so the
    // manifest pins a real 40-hex id. A caller-supplied label could be anything.
    const m = manifest();
    expect(m.repoCommit === null || /^[0-9a-f]{40}$/.test(m.repoCommit)).toBe(true);
  });
});
