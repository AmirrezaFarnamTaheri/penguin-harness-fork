import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETENTION,
  fitsBudget,
  MAX_DISPOSABLE_KEEP_PROBABILITY,
  planRetention,
  retentionAction,
  type RetentionCandidate,
} from "../../src/agent/tool-result-retention.js";

function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    id: "call_1",
    callText: "bash: ls -la /repo",
    resultHead: "total 4\ndrwxr-xr-x  .",
    resultChars: 40_000,
    keepCall: 0.9,
    keepResult: 0.2,
    ...overrides,
  };
}

describe("retention tiers", () => {
  it("keeps everything when the result is needed verbatim", () => {
    expect(retentionAction(candidate({ keepResult: 0.9 }), DEFAULT_RETENTION)).toBe("keep");
  });

  it("keeps the call and drops the result — the tier a message folder cannot express", () => {
    // The model still needs to know the call happened and with what arguments; the output is
    // re-observable by running it again.
    expect(retentionAction(candidate({ keepCall: 0.9, keepResult: 0.1 }), DEFAULT_RETENTION)).toBe(
      "drop_result",
    );
  });

  it("drops the call entirely only when neither half matters", () => {
    expect(
      retentionAction(candidate({ keepCall: 0.05, keepResult: 0.05 }), DEFAULT_RETENTION),
    ).toBe("drop_call");
  });

  it("never drops a pinned candidate, whatever the scores say", () => {
    // A pending approval or an error the model must read is not a scoring question.
    expect(
      retentionAction(candidate({ pinned: true, keepCall: 0, keepResult: 0 }), DEFAULT_RETENTION),
    ).toBe("keep");
  });

  it("lets the model add retention but never remove the last of it", () => {
    // Above the disposable floor, a call survives even when the threshold is not met: a scorer
    // that is confidently wrong about one item cannot talk the compactor out of keeping it.
    const barely = candidate({ keepCall: MAX_DISPOSABLE_KEEP_PROBABILITY + 0.01, keepResult: 0 });
    expect(retentionAction(barely, DEFAULT_RETENTION)).toBe("drop_result");
    const disposable = candidate({ keepCall: MAX_DISPOSABLE_KEEP_PROBABILITY, keepResult: 0 });
    expect(retentionAction(disposable, DEFAULT_RETENTION)).toBe("drop_call");
  });
});

describe("retention plan", () => {
  it("prices each decision and totals what survives", () => {
    const plan = planRetention([
      candidate({ id: "keep", keepResult: 0.9 }),
      candidate({ id: "middle", keepCall: 0.9, keepResult: 0.1 }),
      candidate({ id: "gone", keepCall: 0, keepResult: 0 }),
    ]);
    expect(plan.decisions.map((d) => d.action)).toEqual(["keep", "drop_result", "drop_call"]);
    expect(plan.droppedResults).toBe(1);
    expect(plan.droppedCalls).toBe(1);
    // The middle tier costs the call plus a BOUNDED head plus the note, not the whole result.
    const middle = plan.decisions[1]!;
    expect(middle.charsKept).toBeLessThan(candidate().resultChars);
    expect(middle.charsKept).toBeGreaterThan(0);
    expect(plan.charsRequired).toBe(plan.decisions.reduce((sum, d) => sum + d.charsKept, 0));
  });

  it("never lets a budget be met by shrinking a kept item", () => {
    const plan = planRetention([candidate({ keepResult: 0.9, resultChars: 40_000 })]);
    const tight = fitsBudget(plan, 100);
    expect(tight.fits).toBe(false);
    // The plan is reported as not fitting, with the shortfall: the caller's job is to compact
    // something else or decline, not to cut the kept item.
    expect(tight.overBy).toBeGreaterThan(0);
  });

  it("reports a plan that fits without a shortfall", () => {
    const plan = planRetention([candidate({ id: "gone", keepCall: 0, keepResult: 0 })]);
    const roomy = fitsBudget(plan, 1000);
    expect(roomy.fits).toBe(true);
    expect(roomy.overBy).toBe(0);
  });
});
