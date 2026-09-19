import { describe, expect, it } from "vitest";
import { TurnLedger } from "../src/agent/turn-ledger.js";

describe("TurnLedger", () => {
  it("manages a complete turn lifecycle and allocates monotonic sequences", () => {
    const ledger = new TurnLedger("sess-1");
    const turnId = ledger.begin("sub-1", "epoch-1");

    expect(ledger.getActiveTurnId()).toBe(turnId);
    expect(ledger.getStatus()).toBe("queued");

    const e1 = ledger.append("turn_status", "starting", "running");
    expect(e1.seq).toBe(1);
    expect(e1.status).toBe("running");

    const e2 = ledger.append("text", "thinking...");
    expect(e2.seq).toBe(2);

    const e3 = ledger.append("turn_done", "task finished successfully", "completed");
    expect(e3.seq).toBe(3);
    expect(e3.status).toBe("completed");

    expect(ledger.getActiveTurnId()).toBeNull(); // Terminal turn is not active
    expect(ledger.getLatestSequence()).toBe(3);

    const summaries = ledger.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.turnId).toBe(turnId);
    expect(summaries[0]!.status).toBe("completed");
    expect(summaries[0]!.outcome).toBe("task finished successfully");
  });

  it("prevents beginning a second turn while the first is non-terminal", () => {
    const ledger = new TurnLedger("sess-2");
    ledger.begin();
    ledger.append("turn_status", "work", "running");

    expect(() => ledger.begin()).toThrow(/still active/);
  });

  it("handles paged replay and boundary resets", () => {
    const ledger = new TurnLedger("sess-3", { maxReplayPageSize: 2 });
    ledger.begin();
    ledger.append("turn_status", null, "running");
    ledger.append("text", "delta 1");
    ledger.append("text", "delta 2");
    ledger.append("turn_done", null, "completed");

    const page1 = ledger.replay(0);
    expect(page1.events.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextAfterSeq).toBe(2);

    const page2 = ledger.replay(page1.nextAfterSeq);
    expect(page2.events.length).toBe(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextAfterSeq).toBe(4);

    // Replaying with sequence beyond latest triggers resetRequired
    const pageReset = ledger.replay(999);
    expect(pageReset.resetRequired).toBe(true);
  });

  it("tracks pending projections and projection acknowledgements", () => {
    const ledger = new TurnLedger("sess-4");
    const turn1 = ledger.begin();
    ledger.append("turn_status", null, "running");
    ledger.append("turn_done", null, "completed");

    expect(ledger.pendingProjections().length).toBe(1);
    expect(ledger.pendingProjections()[0]!.turnId).toBe(turn1);

    ledger.acknowledgeProjection(turn1);
    expect(ledger.pendingProjections().length).toBe(0);
  });

  it("safely compacts event records after projection acknowledgement", () => {
    const ledger = new TurnLedger("sess-5");
    const turn1 = ledger.begin();
    ledger.append("turn_status", null, "running");
    ledger.append("text", "long streaming output that can be purged");
    const done = ledger.append("turn_done", null, "completed");

    // Acknowledge projection first
    ledger.acknowledgeProjection(turn1);

    // Compact up through terminal sequence
    ledger.compact(done.seq);

    const replay = ledger.replay(0);
    expect(replay.events.length).toBe(0); // Raw records purged
    expect(ledger.getSummaries().length).toBe(1); // Summary retained
    expect(ledger.metrics.compactions).toBe(1);
  });

  it("keeps unacknowledged turns replayable past the record bound, and compacts them once acked", () => {
    const ledger = new TurnLedger("sess-bounded", { maxRecords: 5, maxSummaries: 2 });

    for (let i = 1; i <= 4; i++) {
      ledger.begin();
      ledger.append("turn_status", null, "running");
      ledger.append("text", `step ${i}`);
      ledger.append("turn_done", `finished ${i}`, "completed");
    }

    // 4 turns * 3 events = 12 events, maxRecords is 5 — but no projection has acknowledged any
    // turn yet. Evicting the oldest records here would orphan those turns from
    // `pendingProjections` (it rebuilds from `records`) and stall the projection watermark at
    // the gap, so the ledger keeps the overflow rather than lose replay data.
    expect(ledger.replay(0).events.length).toBe(12);
    expect(ledger.pendingProjections().length).toBe(4);

    // 4 completed turns, but maxSummaries is 2
    const summaries = ledger.getSummaries();
    expect(summaries.length).toBe(2);
    expect(summaries[0]!.outcome).toBe("finished 3");
    expect(summaries[1]!.outcome).toBe("finished 4");
  });

  it("compacts acknowledged turns to satisfy the record bound", () => {
    const ledger = new TurnLedger("sess-bounded-ack", { maxRecords: 5 });

    for (let i = 1; i <= 4; i++) {
      const turnId = ledger.begin();
      ledger.append("turn_status", null, "running");
      ledger.append("text", `step ${i}`);
      ledger.append("turn_done", `finished ${i}`, "completed");
      // The projection keeps pace, so compaction to the watermark is always safe.
      ledger.acknowledgeProjection(turnId);
    }

    // Every turn is acknowledged: compaction drains the records to the projection watermark.
    expect(ledger.replay(0).events.length).toBeLessThanOrEqual(5);
    expect(ledger.pendingProjections().length).toBe(0);
  });

  it("stalls the projection watermark at an unacknowledged turn and keeps it replayable", () => {
    const ledger = new TurnLedger("sess-watermark", { maxRecords: 6 });

    const makeTurn = () => {
      const turnId = ledger.begin();
      ledger.append("turn_status", null, "running");
      ledger.append("text", "work");
      ledger.append("turn_done", null, "completed");
      return turnId;
    };

    const t1 = makeTurn();
    const t2 = makeTurn();
    const t3 = makeTurn();

    // Acks arrive out of order: t1 and t3 are acknowledged while t2 lags. The watermark must
    // not skip the gap, and t2's events must survive the bound — otherwise the projection can
    // never catch up and the ledger grows past maxRecords anyway.
    ledger.acknowledgeProjection(t1);
    ledger.acknowledgeProjection(t3);

    expect(ledger.pendingProjections().map((p) => p.turnId)).toEqual([t2]);
    expect(ledger.replay(0).events.filter((e) => e.turnId === t2).length).toBe(3);
  });
});
