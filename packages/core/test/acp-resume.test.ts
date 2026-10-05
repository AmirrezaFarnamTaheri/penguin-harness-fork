import { describe, expect, it } from "vitest";
import { AcpConnection } from "../src/kernel/acp.js";
import {
  ACP_ACK_EVERY_RECORDS,
  ACP_ACK_INTERVAL_MS,
  ACP_RECONNECT_BASE_MS,
  ACP_RECONNECT_MAX_MS,
  ACP_REPLAY_MAX_BYTES,
  AcpReplayLog,
  AcpResumeConsumer,
  acpReconnectDelayMs,
  acpResumeBanner,
  type AcpResumePlan,
  type AcpStreamCursor,
} from "../src/kernel/acp-resume.js";

const cursor = (seq: number, streamId = "s1"): AcpStreamCursor => ({ streamId, seq });

/** Appends `count` lines and returns the log, for the common "fill then resume" shape. */
function filledLog(
  count: number,
  options: { streamId?: string; maxRecords?: number; maxBytes?: number } = {},
): AcpReplayLog {
  const log = new AcpReplayLog({ streamId: options.streamId ?? "s1", ...options });
  for (let seq = 1; seq <= count; seq++) log.append(`line ${seq}`, 1);
  return log;
}

const seqs = (plan: AcpResumePlan): number[] =>
  plan.kind === "replay" ? plan.records.map((record) => record.cursor.seq) : [];

describe("AcpReplayLog", () => {
  // --- E3.2: a reconnect converges by replaying exactly the unseen suffix -----------
  it("replays exactly the records after the cursor, and nothing at the newest position", () => {
    const log = filledLog(5);

    const partial = log.resume(cursor(2));
    expect(partial.kind).toBe("replay");
    expect(seqs(partial)).toEqual([3, 4, 5]);
    expect(partial.kind === "replay" && partial.from).toBe(2);
    // Line content survives verbatim: a replay is what the peer would have received.
    expect(partial.kind === "replay" && partial.records[0]!.line).toBe("line 3");

    expect(seqs(log.resume(cursor(5)))).toEqual([]);
    expect(log.newestSeq).toBe(5);
    expect(log.oldestRetainedSeq).toBe(1);
  });

  it("asks for a fresh snapshot when the consumer has no cursor yet", () => {
    const plan = filledLog(3).resume(null);
    expect(plan).toMatchObject({ kind: "fresh", reason: "no-cursor", streamId: "s1" });
  });

  // --- acceptance: stale-generation / foreign cursor is never accepted ---------------
  it("refuses a cursor from another stream instead of approximating a position", () => {
    const log = filledLog(3);
    expect(log.resume(cursor(1, "other"))).toMatchObject({
      kind: "fresh",
      reason: "unknown-stream",
    });
    expect(log.acknowledge(cursor(1, "other"))).toBe(false);
    expect(log.ackedSeq).toBe(0);
  });

  it("refuses a cursor beyond anything this log produced", () => {
    const log = filledLog(3);
    expect(log.resume(cursor(4))).toMatchObject({ kind: "fresh", reason: "unknown-cursor" });
    expect(log.resume(cursor(99))).toMatchObject({ kind: "fresh", reason: "unknown-cursor" });
    // Malformed positions fail closed too.
    expect(log.resume({ streamId: "s1", seq: -1 })).toMatchObject({ kind: "fresh" });
    expect(log.resume({ streamId: "s1", seq: 1.5 })).toMatchObject({
      kind: "fresh",
      reason: "unknown-cursor",
    });
  });

  // --- acceptance: no silent loss ----------------------------------------------------
  it("answers an expired cursor with a fresh snapshot, never a suffix across a hole", () => {
    const log = filledLog(100, { maxRecords: 8 });
    expect(log.retainedRecords).toBe(8);
    expect(log.droppedRecords).toBe(92);
    expect(log.droppedBeforeSeq).toBe(92);

    const plan = log.resume(cursor(10));
    expect(plan).toMatchObject({ kind: "fresh", reason: "expired" });
    expect(plan.kind === "fresh" && plan.droppedRecords).toBe(92);

    // A cursor at the watermark still replays the retained tail.
    expect(seqs(log.resume(cursor(92)))).toEqual([93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it("drops a record larger than the byte bound immediately and counts the loss", () => {
    const log = new AcpReplayLog({ streamId: "s1", maxBytes: 32 });
    const small = log.append("x".repeat(10));
    expect(small.retained).toBe(true);
    const huge = log.append("y".repeat(100));
    expect(huge.retained).toBe(false);
    expect(log.retainedRecords).toBe(1);
    expect(log.droppedRecords).toBe(1);
    expect(log.droppedBeforeSeq).toBe(2);
    // The hole is at seq 2, so a consumer that only has seq 1 cannot be served a suffix.
    expect(log.resume(cursor(1))).toMatchObject({ kind: "fresh", reason: "expired" });
    expect(seqs(log.resume(cursor(2)))).toEqual([]);
  });

  it("keeps retention inside both bounds under sustained appends", () => {
    const log = new AcpReplayLog({ streamId: "s1", maxRecords: 32, maxBytes: 4096 });
    for (let index = 0; index < 2000; index++) log.append(`record ${index}`.padEnd(40, "."));
    expect(log.retainedRecords).toBeLessThanOrEqual(32);
    expect(log.retainedBytes).toBeLessThanOrEqual(4096);
    expect(log.retainedRecords + log.droppedRecords).toBe(2000);
    expect(log.newestSeq).toBe(2000);
  });

  // --- acknowledgements: monotonic, drop-once, reported when skipped -----------------
  it("drops acknowledged records and reports how many a stale cursor skipped", () => {
    const log = filledLog(10);
    expect(log.acknowledge(cursor(6))).toBe(true);
    expect(log.ackedSeq).toBe(6);
    expect(log.oldestRetainedSeq).toBe(7);
    expect(log.retainedRecords).toBe(4);

    const plan = log.resume(cursor(4));
    expect(seqs(plan)).toEqual([7, 8, 9, 10]);
    expect(plan.kind === "replay" && plan.skippedAcknowledged).toBe(2);
    expect(plan.kind === "replay" && plan.from).toBe(6);
  });

  it("refuses ack regressions and positions it never produced, without changing state", () => {
    const log = filledLog(10);
    expect(log.acknowledge(cursor(5))).toBe(true);
    expect(log.acknowledge(cursor(3))).toBe(false); // regression
    expect(log.acknowledge(cursor(11))).toBe(false); // future position
    expect(log.acknowledge(cursor(5, "other"))).toBe(false); // foreign stream
    expect(log.ackedSeq).toBe(5);
    expect(log.oldestRetainedSeq).toBe(6);
  });

  it("replays across a transport replacement: generation changes, seq never resets", async () => {
    // A real AcpConnection supplies the generation, so the integration is exercised rather
    // than assumed: a failed transport, then a reattach, then records from both.
    const connection = new AcpConnection(async () => {
      throw new Error("EPIPE");
    });
    await expect(connection.sendRequest("x")).rejects.toThrow("EPIPE");
    expect(connection.getStats().generation).toBe(1);

    const log = new AcpReplayLog({ streamId: "s1" });
    const first = log.append("old transport line", connection.getStats().generation);
    connection.reattachTransport(async () => undefined);
    expect(connection.getStats().generation).toBe(2);
    const second = log.append("new transport line", connection.getStats().generation);

    expect(first.cursor.seq).toBe(1);
    expect(second.cursor.seq).toBe(2);
    const plan = log.resume(cursor(1));
    expect(plan.kind === "replay" && plan.records[0]!.generation).toBe(2);
    connection.dispose();
  });
});

describe("AcpResumeConsumer", () => {
  it("suppresses duplicates and never advances the watermark across a gap", () => {
    const consumer = new AcpResumeConsumer("s1");

    expect(consumer.receive(cursor(1))).toBe("accepted");
    expect(consumer.receive(cursor(2))).toBe("accepted");
    expect(consumer.receive(cursor(2))).toBe("duplicate");
    expect(consumer.receive(cursor(1))).toBe("duplicate");
    expect(consumer.receive(cursor(1, "other"))).toBe("foreign");

    // Records 3 and 4 never arrived; 5 must not be accepted as if it were next.
    expect(consumer.receive(cursor(5))).toBe("gap");
    expect(consumer.deliveredSeq).toBe(2);
    expect(consumer.pendingRecords).toBe(2);

    // An ack therefore cannot claim processing of a record that was never received.
    expect(consumer.acknowledge()).toEqual(cursor(2));
    expect(consumer.ackedSeq).toBe(2);

    // The late record 3 is still acceptable: the gap is a hole, not a move forward.
    expect(consumer.receive(cursor(3))).toBe("accepted");
    expect(consumer.receive(cursor(4))).toBe("accepted");
  });

  it("resyncs to an authoritative position but refuses to regress or cross streams", () => {
    const consumer = new AcpResumeConsumer("s1");
    expect(consumer.receive(cursor(1))).toBe("accepted");
    expect(consumer.receive(cursor(2))).toBe("accepted");
    expect(consumer.resync(cursor(1))).toBe(false); // stale snapshot
    expect(consumer.resync(cursor(5, "other"))).toBe(false); // foreign stream
    expect(consumer.resync(cursor(5))).toBe(true);
    expect(consumer.deliveredSeq).toBe(5);
    expect(consumer.ackedSeq).toBe(5);
    expect(consumer.pendingRecords).toBe(0);
  });

  it("acknowledges on the record threshold or the interval, whichever comes first", () => {
    let now = 1_000;
    const consumer = new AcpResumeConsumer("s1", { now: () => now });

    for (let seq = 1; seq < ACP_ACK_EVERY_RECORDS; seq++) {
      consumer.receive(cursor(seq));
      expect(consumer.maybeAcknowledge(now)).toBeNull();
    }
    consumer.receive(cursor(ACP_ACK_EVERY_RECORDS));
    expect(consumer.maybeAcknowledge(now)).toEqual(cursor(ACP_ACK_EVERY_RECORDS));
    expect(consumer.maybeAcknowledge(now)).toBeNull(); // nothing new to ack

    // A quiet stream still advances on the interval.
    consumer.receive(cursor(ACP_ACK_EVERY_RECORDS + 1));
    expect(consumer.maybeAcknowledge(now + ACP_ACK_INTERVAL_MS - 1)).toBeNull();
    expect(consumer.maybeAcknowledge(now + ACP_ACK_INTERVAL_MS)).toEqual(
      cursor(ACP_ACK_EVERY_RECORDS + 1),
    );
  });
});

describe("acpResumeBanner", () => {
  it("shows a count only when a replay actually carries that many records", () => {
    const log = filledLog(3);
    const plan = log.resume(cursor(0));
    expect(acpResumeBanner(plan)).toEqual({ state: "behind", eventsBehind: 3 });
    expect(acpResumeBanner(log.resume(cursor(3)))).toEqual({ state: "live" });
  });

  it("shows resync (no fabricated count) for an unknown gap or a fresh snapshot", () => {
    const log = filledLog(3, { maxRecords: 1 });
    expect(acpResumeBanner(log.resume(cursor(1)))).toEqual({ state: "resync" });
    expect(acpResumeBanner({ kind: "gap" })).toEqual({ state: "resync" });
  });
});

describe("acpReconnectDelayMs", () => {
  it("grows to the ceiling with jitter inside the documented bounds", () => {
    expect(ACP_RECONNECT_BASE_MS).toBe(1_000);
    expect(ACP_RECONNECT_MAX_MS).toBe(30_000);
    let previous = 0;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = acpReconnectDelayMs(attempt, 7);
      expect(delay).toBeGreaterThanOrEqual(ACP_RECONNECT_BASE_MS);
      expect(delay).toBeLessThanOrEqual(ACP_RECONNECT_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(previous); // non-decreasing ladder
      previous = delay;
    }
    expect(acpReconnectDelayMs(20, 7)).toBeLessThanOrEqual(ACP_RECONNECT_MAX_MS);
  });

  it("spreads seeds and stays reproducible per seed", () => {
    expect(acpReconnectDelayMs(4, 1)).toBe(acpReconnectDelayMs(4, 1));
    const spread = new Set([1, 2, 3, 4, 5].map((seed) => acpReconnectDelayMs(4, seed)));
    expect(spread.size).toBeGreaterThan(1);
  });
});

describe("resume convergence fixtures", () => {
  it("converges across disconnects at every handshake and replay boundary", () => {
    const log = new AcpReplayLog({ streamId: "s1", maxRecords: 32 });
    const consumer = new AcpResumeConsumer("s1", { ackIntervalMs: 0 });
    const delivered: number[] = [];

    const accept = (at: AcpStreamCursor): void => {
      if (consumer.receive(at) === "accepted") delivered.push(at.seq);
    };
    const deliver = (plan: AcpResumePlan): void => {
      if (plan.kind !== "replay") return;
      for (const record of plan.records) accept(record.cursor);
    };

    // Round 0: first attach (no cursor) → fresh, so the host sends a snapshot position.
    for (let seq = 1; seq <= 5; seq++) log.append(`line ${seq}`);
    expect(log.resume(consumer.lastDelivered)).toMatchObject({
      kind: "fresh",
      reason: "no-cursor",
    });
    expect(consumer.resync(cursor(log.newestSeq))).toBe(true);

    // Round 1: disconnect mid-replay — deliver half the planned batch, reconnect, get the rest.
    for (let seq = 6; seq <= 15; seq++) log.append(`line ${seq}`);
    const firstPlan = log.resume(consumer.lastDelivered);
    expect(firstPlan.kind).toBe("replay");
    const half = firstPlan.kind === "replay" ? firstPlan.records.slice(0, 4) : [];
    for (const record of half) accept(record.cursor);
    const resumePlan = log.resume(consumer.lastDelivered);
    deliver(resumePlan);
    // The remaining records arrive exactly once, in order.
    expect(delivered).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    // Round 2: ack, then reconnect after more appends; acknowledged records are skipped.
    const ack = consumer.acknowledge();
    expect(ack).toEqual(cursor(15));
    expect(log.acknowledge(ack!)).toBe(true);
    for (let seq = 16; seq <= 20; seq++) log.append(`line ${seq}`);
    const afterAck = log.resume(consumer.lastDelivered);
    expect(afterAck.kind === "replay" && afterAck.skippedAcknowledged).toBe(0);
    deliver(afterAck);
    expect(delivered).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    // Round 3: the retention window overruns the cursor — explicit gap, then a snapshot
    // resync, and from there delivery continues without loss.
    for (let seq = 21; seq <= 200; seq++) log.append(`line ${seq}`);
    const gapPlan = log.resume(consumer.lastDelivered);
    expect(gapPlan).toMatchObject({ kind: "fresh", reason: "expired" });
    expect(acpResumeBanner(gapPlan)).toEqual({ state: "resync" });
    expect(log.droppedRecords).toBeGreaterThan(0);
    expect(consumer.resync(cursor(log.newestSeq))).toBe(true);
    for (let seq = 201; seq <= 205; seq++) log.append(`line ${seq}`);
    deliver(log.resume(consumer.lastDelivered));
    expect(delivered.slice(-5)).toEqual([201, 202, 203, 204, 205]);

    // No duplicates were ever accepted, and memory stayed inside the bound throughout.
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered).toEqual([...delivered].sort((a, b) => a - b));
    expect(log.retainedRecords).toBeLessThanOrEqual(32);
    expect(log.retainedBytes).toBeLessThanOrEqual(ACP_REPLAY_MAX_BYTES);
    expect(consumer.pendingRecords).toBeLessThanOrEqual(5);
  });

  it("re-sends unacknowledged records on purpose: duplicates are cheaper than loss", () => {
    const log = filledLog(4);
    const consumer = new AcpResumeConsumer("s1");
    const first = log.resume(cursor(0));
    if (first.kind !== "replay") throw new Error("expected replay");
    for (const record of first.records) consumer.receive(record.cursor);

    // No ack was sent, so the producer must assume the consumer may have lost them.
    const again = log.resume(cursor(0));
    expect(seqs(again)).toEqual([1, 2, 3, 4]);
    if (again.kind !== "replay") throw new Error("expected replay");
    expect(again.records.map((record) => consumer.receive(record.cursor))).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    expect(consumer.ackedSeq).toBe(0);
  });
});
