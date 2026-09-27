import { describe, it, expect } from "vitest";
import {
  auditEvalRun,
  buildEvalRunManifest,
  hashValue,
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
    const audit = auditEvalRun({ manifest: m, rows: ROWS, dataset: DATASET, scorer: SCORER });
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("names each drifted input separately rather than reporting that something changed", () => {
    const m = manifest();
    const audit = auditEvalRun({
      manifest: m,
      rows: [...ROWS, { caseId: "c3", outcome: "pass", numericScore: 1 }],
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
    const audit = auditEvalRun({ manifest: m, rows: crashed });
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
    const audit = auditEvalRun({ manifest: m, rows: duped });
    expect(audit.problems.join(" ")).toContain("duplicate case id: c1");
  });

  it("catches a recorded score the raw response no longer reproduces", () => {
    const m = manifest();
    const audit = auditEvalRun({
      manifest: m,
      rows: ROWS,
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
    const audit = auditEvalRun({ manifest: m, rows: moved });
    expect(audit.problems.join(" ")).toContain("scored rows changed");
  });

  it("reads the repository revision from git rather than trusting the caller", () => {
    // cwd defaults to the process root, which in this repository IS a git checkout, so the
    // manifest pins a real 40-hex id. A caller-supplied label could be anything.
    const m = manifest();
    expect(m.repoCommit === null || /^[0-9a-f]{40}$/.test(m.repoCommit)).toBe(true);
  });
});
