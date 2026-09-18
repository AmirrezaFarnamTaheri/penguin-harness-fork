import { describe, it, expect } from "vitest";
import {
  BatchRollbackCoordinator,
  SpeculativeRollback,
} from "../../../src/llm/speculative/speculative-rollback.js";

describe("SpeculativeRollback", () => {
  it("commits verified tokens and never shortens the committed prefix", () => {
    const stream = new SpeculativeRollback();
    stream.appendCommitted([1, 2, 3]);
    stream.stagePending([10, 11, 12]);

    expect(stream.length).toBe(6);
    expect(stream.committedLength).toBe(3);
    expect(stream.pendingLength).toBe(3);

    stream.commit(2);
    expect(stream.committed()).toEqual([1, 2, 3, 10, 11]);
    expect(stream.length).toBe(6);
  });

  it("discards the speculative suffix from the rejection point on", () => {
    const stream = new SpeculativeRollback();
    stream.appendCommitted([1, 2, 3]);
    stream.stagePending([10, 11, 12, 13]);

    const record = stream.rollback(1);
    expect(record).not.toBeNull();
    expect(record!.rolledBackTo).toBe(4);
    expect(record!.discardedTokens).toBe(3);
    expect(record!.releasedCacheSlots).toBe(3);
    expect(record!.reason).toBe("rejection");

    expect(stream.committed()).toEqual([1, 2, 3]);
    expect(stream.sequence()).toEqual([1, 2, 3, 10]);
  });

  it("never rolls back into the verified prefix", () => {
    const stream = new SpeculativeRollback();
    stream.appendCommitted([1, 2, 3]);
    stream.stagePending([10, 11]);
    // A rejection reported before the prefix is clamped to the prefix boundary.
    const record = stream.rollback(0);
    expect(record!.rolledBackTo).toBe(3);
    expect(stream.committed()).toEqual([1, 2, 3]);
  });

  it("returns null when there is nothing to discard", () => {
    const stream = new SpeculativeRollback();
    stream.appendCommitted([1, 2]);
    expect(stream.rollback(5)).toBeNull();
    expect(stream.rollbackAll()).toBeNull();
  });

  it("bumps the epoch on truncation so stale checkpoints are detectable", () => {
    const stream = new SpeculativeRollback();
    stream.appendCommitted([1]);
    const before = stream.snapshot();
    expect(stream.validateSnapshot(before)).toBe(true);

    stream.stagePending([5, 6]);
    stream.rollback(0);
    expect(stream.validateSnapshot(before)).toBe(false);
    expect(stream.currentEpoch).toBe(1);
  });

  it("releases every reserved cache slot by the time it finishes", () => {
    const stream = new SpeculativeRollback();
    stream.stagePending([1, 2, 3]);
    stream.commit(1);
    stream.rollbackAll();
    const balance = stream.cacheBalance();
    expect(balance.leaked).toBe(0);
    expect(balance.releasedTotal).toBe(2);
  });

  it("cancels the stream and rewinds the pending suffix", () => {
    const stream = new SpeculativeRollback();
    stream.appendCommitted([1]);
    stream.stagePending([2, 3]);
    stream.cancel();
    expect(stream.isCancelled).toBe(true);
    expect(stream.committed()).toEqual([1]);
  });

  it("refuses to stage pending tokens once cancelled", () => {
    const stream = new SpeculativeRollback();
    stream.cancel();
    expect(() => stream.stagePending([1])).toThrow();
  });

  it("records the full truncation history", () => {
    const stream = new SpeculativeRollback();
    stream.stagePending([1, 2, 3]);
    stream.rollback(1, "rejection");
    stream.stagePending([4]);
    stream.rollback(0, "budget-exceeded");
    const history = stream.truncationHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.reason).toBe("rejection");
    expect(history[1]!.reason).toBe("budget-exceeded");
  });
});

describe("BatchRollbackCoordinator", () => {
  it("applies per-stream acceptance lengths without cross-stream interference", () => {
    const coordinator = new BatchRollbackCoordinator();
    const a = coordinator.register("a");
    const b = coordinator.register("b");
    a.appendCommitted([1]);
    b.appendCommitted([2]);
    a.stagePending([10, 11, 12]);
    b.stagePending([20, 21, 22]);

    const accounting = coordinator.applyRound([
      { streamId: "a", acceptedLength: 3, firstRejection: 3, allAccepted: true, bonusToken: 99 },
      {
        streamId: "b",
        acceptedLength: 1,
        firstRejection: 1,
        allAccepted: false,
        committedTokens: [77],
      },
    ]);

    expect(coordinator.get("a")!.committed()).toEqual([1, 10, 11, 12, 99]);
    expect(coordinator.get("b")!.committed()).toEqual([2, 20, 77]);
    expect(accounting.committedTotal).toBe(4 + 2);
    expect(accounting.discardedTotal).toBe(2);
    expect(accounting.rolledBackStreams).toBe(1);
  });

  it("balances per-priority cache accounting across the batch", () => {
    const coordinator = new BatchRollbackCoordinator();
    coordinator.register("x").stagePending([1, 2, 3]);
    coordinator.register("y").stagePending([4]);
    coordinator.applyRound([
      { streamId: "x", acceptedLength: 1, firstRejection: 1, allAccepted: false },
      { streamId: "y", acceptedLength: 1, firstRejection: 1, allAccepted: false },
    ]);
    const report = coordinator.leakReport();
    expect(report.clean).toBe(true);
    expect(report.leaked).toBe(0);
  });

  it("skips unknown streams rather than failing the batch", () => {
    const coordinator = new BatchRollbackCoordinator();
    const accounting = coordinator.applyRound([
      { streamId: "ghost", acceptedLength: 1, firstRejection: 1, allAccepted: false },
    ]);
    expect(accounting.committedTotal).toBe(0);
  });
});
