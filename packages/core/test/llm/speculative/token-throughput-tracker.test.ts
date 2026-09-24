import { describe, it, expect } from "vitest";
import {
  TokenThroughputTracker,
  hrtimeToNs,
  predictedSpeedup,
  type RoundMetrics,
} from "../../../src/llm/speculative/token-throughput-tracker.js";

function round(streamId: string, partial: Partial<RoundMetrics>): RoundMetrics {
  return {
    streamId,
    proposed: 4,
    accepted: 3,
    bonus: 1,
    committed: 4,
    discarded: 1,
    durationNs: 1_000_000,
    priority: 0,
    ...partial,
  };
}

describe("TokenThroughputTracker", () => {
  it("counts tokens by phase: proposed, accepted, bonus, committed, discarded", () => {
    const tracker = new TokenThroughputTracker();
    tracker.recordAll([round("a", {}), round("b", {})]);
    const report = tracker.report();
    expect(report.proposed).toBe(8);
    expect(report.accepted).toBe(6);
    expect(report.bonus).toBe(2);
    expect(report.committed).toBe(8);
    expect(report.discarded).toBe(2);
    expect(report.rounds).toBe(2);
  });

  it("computes the aggregate acceptance rate", () => {
    const tracker = new TokenThroughputTracker();
    tracker.recordAll([
      round("a", { proposed: 4, accepted: 1 }),
      round("b", { proposed: 4, accepted: 3 }),
    ]);
    expect(tracker.report().acceptanceRate).toBeCloseTo(0.5, 6);
  });

  it("keeps per-priority accept buckets summing exactly to the total", () => {
    const tracker = new TokenThroughputTracker();
    tracker.recordAll([
      round("a", { priority: 0, accepted: 3 }),
      round("b", { priority: 1, accepted: 2 }),
      round("c", { priority: 1, accepted: 1 }),
    ]);
    const report = tracker.report();
    expect(report.acceptedByPriority.get(0)).toBe(3);
    expect(report.acceptedByPriority.get(1)).toBe(3);
    const integrity = tracker.priorityBucketIntegrity();
    expect(integrity.balanced).toBe(true);
    expect(integrity.actual).toBe(integrity.expected);
  });

  it("reports mean accepted tokens per round", () => {
    const tracker = new TokenThroughputTracker();
    tracker.recordAll([round("a", { accepted: 4 }), round("b", { accepted: 2 })]);
    expect(tracker.report().meanAcceptedPerRound).toBe(3);
  });

  it("smooths the acceptance rate with an EMA and seeds from the first round", () => {
    const tracker = new TokenThroughputTracker({ emaAlpha: 0.5 });
    tracker.record(round("a", { proposed: 4, accepted: 4 }));
    expect(tracker.report().emaAcceptanceRate).toBeCloseTo(1, 6);
    tracker.record(round("b", { proposed: 4, accepted: 0 }));
    expect(tracker.report().emaAcceptanceRate).toBeCloseTo(0.5, 6);
  });

  it("computes committed tokens per second of verification time", () => {
    const tracker = new TokenThroughputTracker();
    tracker.recordAll([round("a", { committed: 4, durationNs: 1_000_000_000 })]);
    expect(tracker.report().tokensPerSecond).toBeCloseTo(4, 6);
  });

  it("reports p95 verification latency across rounds", () => {
    const tracker = new TokenThroughputTracker();
    tracker.recordAll(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms, index) =>
        round(`s${index}`, { durationNs: ms * 1_000_000 }),
      ),
    );
    const report = tracker.report();
    expect(report.meanVerifyLatencyNs).toBeCloseTo(5.5e6, -6);
    expect(report.p95VerifyLatencyNs).toBeGreaterThanOrEqual(report.meanVerifyLatencyNs);
  });

  it("flags rounds that breach the verification latency budget", () => {
    const tracker = new TokenThroughputTracker({ verifyLatencyBudgetNs: 1_000_000 });
    tracker.record(round("a", { durationNs: 2_000_000 }));
    expect(tracker.report().withinLatencyBudget).toBe(false);
    tracker.reset();
    tracker.record(round("a", { durationNs: 500_000 }));
    expect(tracker.report().withinLatencyBudget).toBe(true);
  });

  it("models speedup as accepted tokens against target+draft forwards", () => {
    const tracker = new TokenThroughputTracker({ draftCostWeight: 0 });
    // Perfect acceptance, gamma 4: 5 tokens per 1 target forward.
    expect(tracker.speedup(1, 4)).toBeCloseTo(5, 6);
    // Zero acceptance: only the bonus token, speedup 1.
    expect(tracker.speedup(0, 4)).toBe(1);
  });

  it("reduces speedup as draft cost rises", () => {
    const cheap = new TokenThroughputTracker({ draftCostWeight: 0.1 }).speedup(0.8, 4);
    const expensive = new TokenThroughputTracker({ draftCostWeight: 0.9 }).speedup(0.8, 4);
    expect(cheap).toBeGreaterThan(expensive);
  });

  it("reports speedup at the window the recorded rounds actually ran", () => {
    // report() models speedup from the acceptance rate, and the model's γ is the window the
    // rounds used — not a hardcoded 4. A tracker fed γ=8 rounds used to report the γ=4 figure
    // regardless, so a deployment running any other window read a speedup that was not its
    // own, in either direction.
    const wide = new TokenThroughputTracker({ draftCostWeight: 0.35 });
    wide.recordAll([
      round("a", { proposed: 8, accepted: 8 }),
      round("b", { proposed: 8, accepted: 8 }),
    ]);
    const wideReport = wide.report();
    expect(wideReport.acceptanceRate).toBe(1);
    // γ=8 at draftCostWeight 0.35: (1 + 8) / (1 + 8·0.35) ≈ 2.368. The γ=4 figure (≈2.083) is
    // what report() produced from a hardcoded window.
    expect(wideReport.speedup).toBeCloseTo(wide.speedup(1, 8), 9);
    expect(wideReport.speedup).not.toBeCloseTo(wide.speedup(1, 4), 9);

    // Rounds at the default window still report their own figure, at their own rate.
    const narrow = new TokenThroughputTracker({ draftCostWeight: 0.35 });
    narrow.recordAll([round("a", {})]);
    const narrowReport = narrow.report();
    expect(narrowReport.speedup).toBeCloseTo(narrow.speedup(narrowReport.acceptanceRate, 4), 9);
  });

  it("resets all counters", () => {
    const tracker = new TokenThroughputTracker();
    tracker.record(round("a", {}));
    tracker.reset();
    expect(tracker.report().rounds).toBe(0);
    expect(tracker.report().proposed).toBe(0);
  });

  it("predicts whether speculation is worth it at a given acceptance rate", () => {
    expect(predictedSpeedup(0.9, 4, 0.35)).toBeGreaterThan(1);
    expect(predictedSpeedup(0.1, 8, 0.9)).toBeLessThanOrEqual(1);
    expect(predictedSpeedup(0, 4, 0.35)).toBe(1);
  });

  it("converts hrtime tuples to nanoseconds", () => {
    expect(hrtimeToNs([1, 500_000_000])).toBe(1_500_000_000);
  });
});
