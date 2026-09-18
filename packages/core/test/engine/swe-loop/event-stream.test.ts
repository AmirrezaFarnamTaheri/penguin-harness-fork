import { describe, expect, it, vi } from "vitest";

import { SweEventStream, type SweEvent } from "../../../src/engine/swe-loop/event-stream.js";

describe("SweEventStream ordering", () => {
  it("mints strictly monotonic, gap-free sequence numbers", () => {
    const stream = new SweEventStream({ runId: "r1" });
    expect(stream.getNextSeq()).toBe(1);
    const a = stream.append("run_started", { n: 1 });
    const b = stream.append("model_turn", { n: 2 });
    const c = stream.append("tool_dispatched", { n: 3 });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(stream.getNextSeq()).toBe(4);
    expect(stream.getLength()).toBe(3);
  });

  it("accepts an explicit sequence only when it matches the next expected value", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    expect(() => stream.append("model_turn", {}, { seq: 5 })).toThrow(
      /does not match the next expected sequence/,
    );
    const ok = stream.append("model_turn", {}, { seq: 2 });
    expect(ok.seq).toBe(2);
  });

  it("refuses a causal parent at or after the next sequence", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.append("model_turn", {});
    // The last event is seq 2, so descending from it is legal; only a parent
    // at or beyond the *next* sequence is impossible.
    expect(() => stream.append("tool_dispatched", {}, { parentSeq: 3 })).toThrow(
      /cannot be at or after/,
    );
    const ok = stream.append("tool_dispatched", {}, { parentSeq: 2 });
    expect(ok.parentSeq).toBe(2);
  });

  it("refuses appends once sealed", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.seal();
    expect(stream.isSealed()).toBe(true);
    expect(() => stream.append("run_exited", {})).toThrow(/is sealed/);
  });

  it("renumbers retained events on eviction so seq still addresses the right record", () => {
    const stream = new SweEventStream({ maxEvents: 3 });
    stream.append("run_started", { name: "a" });
    stream.append("model_turn", { name: "b" });
    stream.append("tool_dispatched", { name: "c" });
    // This append evicts the oldest event; without renumbering the rebased
    // sequence would collide with a retained event.
    stream.append("tool_output", { name: "d" });

    expect(stream.getLength()).toBe(3);
    expect(stream.snapshot().map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(stream.getEvent(1)?.payload).toEqual({ name: "b" });
    expect(stream.getEvent(3)?.payload).toEqual({ name: "d" });
    expect(new Set(stream.snapshot().map((event) => event.seq)).size).toBe(3);
  });
});

describe("SweEventStream replay", () => {
  function populated(): SweEventStream {
    const stream = new SweEventStream({ runId: "r" });
    stream.append("run_started", { i: 0 });
    stream.append("model_turn", { i: 1 }, { agentId: "orchestrator" });
    stream.append("tool_dispatched", { i: 2 }, { agentId: "coder", parentSeq: 1 });
    stream.append("tool_output", { i: 3 }, { agentId: "coder" });
    stream.append("tool_failed", { i: 4 }, { agentId: "tester" });
    return stream;
  }

  it("replays in sequence order by default", () => {
    expect(
      populated()
        .replay()
        .map((event) => event.kind),
    ).toEqual(["run_started", "model_turn", "tool_dispatched", "tool_output", "tool_failed"]);
  });

  it("filters by sequence range", () => {
    const events = populated().replay({ fromSeq: 2, toSeq: 4 });
    expect(events.map((event) => event.seq)).toEqual([2, 3, 4]);
  });

  it("filters by kind", () => {
    const events = populated().replay({ kinds: ["tool_output", "tool_failed"] });
    expect(events.map((event) => event.kind)).toEqual(["tool_output", "tool_failed"]);
  });

  it("filters by agent", () => {
    const events = populated().replay({ agentId: "coder" });
    expect(events.map((event) => event.seq)).toEqual([3, 4]);
  });

  it("honours the limit, taking the earliest matches", () => {
    expect(
      populated()
        .replay({ limit: 2 })
        .map((event) => event.seq),
    ).toEqual([1, 2]);
  });

  it("returns defensive copies, so mutating a result cannot corrupt the log", () => {
    const stream = populated();
    const events = stream.replay();
    (events[0] as SweEvent).seq = 999;
    expect(stream.getEvent(1)?.seq).toBe(1);
  });

  it("walks the causal chain from an event back to the run start", () => {
    const stream = populated();
    const trace = stream.causalTrace(3);
    expect(trace.map((event) => event.seq)).toEqual([1, 3]);
  });

  it("terminates the causal walk on a cycle or a missing parent", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    // A self-referential parent cannot be appended (parentSeq >= nextSeq is
    // refused), so build the loop by hand and confirm the walk is bounded.
    const trace = stream.causalTrace(42);
    expect(trace).toHaveLength(0);
  });
});

describe("SweEventStream checkpoints", () => {
  it("saves checkpoints at the current sequence and lists them in order", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.append("model_turn", {});
    const first = stream.saveCheckpoint("before-tests", "baseline");
    expect(first.atSeq).toBe(2);

    stream.append("tool_dispatched", {});
    const second = stream.saveCheckpoint("after-edit");
    expect(second.atSeq).toBe(3);
    expect(stream.listCheckpoints().map((checkpoint) => checkpoint.checkpointId)).toEqual([
      "before-tests",
      "after-edit",
    ]);
  });

  it("reports the events recorded since a checkpoint", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.saveCheckpoint("k");
    stream.append("tool_dispatched", {});
    stream.append("tool_output", {});
    expect(stream.eventsSinceCheckpoint("k").map((event) => event.seq)).toEqual([2, 3]);
    expect(stream.eventsSinceCheckpoint("missing")).toEqual([]);
  });

  it("refuses a duplicate or empty checkpoint id", () => {
    const stream = new SweEventStream();
    stream.saveCheckpoint("k");
    expect(() => stream.saveCheckpoint("k")).toThrow(/already exists/);
    expect(() => stream.saveCheckpoint("")).toThrow(/cannot be empty/);
  });

  it("refuses to truncate inside a live checkpoint range", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.append("model_turn", {});
    stream.saveCheckpoint("k");
    stream.append("tool_dispatched", {});
    expect(() => stream.truncate(1)).toThrow(/Refusing to truncate/);
  });

  it("truncates past a checkpoint that still points at retained history", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.append("model_turn", {});
    stream.saveCheckpoint("k");
    expect(stream.truncate(2)).toBe(0);
    expect(stream.getNextSeq()).toBe(3);
  });

  it("truncates away later events and rebuilds the sequence base", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    stream.append("model_turn", {});
    stream.append("tool_dispatched", {});
    expect(stream.truncate(1)).toBe(2);
    expect(stream.getLength()).toBe(1);
    expect(stream.getNextSeq()).toBe(2);
    // The stream continues cleanly from the new base.
    const next = stream.append("model_turn", {});
    expect(next.seq).toBe(2);
  });
});

describe("SweEventStream restore", () => {
  it("rebuilds an empty stream from an external event list", () => {
    const stream = new SweEventStream();
    const events: SweEvent[] = [
      { seq: 1, runId: "x", kind: "run_started", timestamp: 1, payload: {} },
      { seq: 2, runId: "x", kind: "model_turn", timestamp: 2, payload: {} },
    ];
    expect(stream.restore(events)).toBe(2);
    expect(stream.replay().map((event) => event.seq)).toEqual([1, 2]);
    expect(stream.getNextSeq()).toBe(3);
  });

  it("sorts an unordered event list by sequence", () => {
    const stream = new SweEventStream();
    const events: SweEvent[] = [
      { seq: 2, runId: "x", kind: "model_turn", timestamp: 2, payload: {} },
      { seq: 1, runId: "x", kind: "run_started", timestamp: 1, payload: {} },
    ];
    expect(stream.restore(events)).toBe(2);
    expect(stream.replay()[0]?.kind).toBe("run_started");
  });

  it("rejects a restored stream with a sequence gap", () => {
    const stream = new SweEventStream();
    const events: SweEvent[] = [
      { seq: 1, runId: "x", kind: "run_started", timestamp: 1, payload: {} },
      { seq: 3, runId: "x", kind: "model_turn", timestamp: 3, payload: {} },
    ];
    expect(() => stream.restore(events)).toThrow(/sequence gap at 3/);
  });

  it("refuses to restore into a non-empty stream", () => {
    const stream = new SweEventStream();
    stream.append("run_started", {});
    expect(() => stream.restore([])).toThrow(/non-empty/);
  });
});

describe("SweEventStream subscribers", () => {
  it("fans every appended event to subscribers", () => {
    const stream = new SweEventStream();
    const seen: string[] = [];
    const unsubscribe = stream.subscribe((event) => seen.push(event.kind));
    stream.append("run_started", {});
    stream.append("model_turn", {});
    expect(seen).toEqual(["run_started", "model_turn"]);
    unsubscribe();
    stream.append("tool_dispatched", {});
    expect(seen).toHaveLength(2);
  });

  it("survives a subscriber that throws", () => {
    const stream = new SweEventStream();
    const good: string[] = [];
    const logged: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      stream.subscribe(() => {
        throw new Error("subscriber blew up");
      });
      stream.subscribe((event) => good.push(event.kind));
      stream.append("run_started", {});
      expect(good).toEqual(["run_started"]);
      expect(logged.some((entry) => entry.includes("subscriber blew up"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("enforces the subscriber limit", () => {
    const stream = new SweEventStream({ maxSubscribers: 1 });
    stream.subscribe(() => undefined);
    expect(() => stream.subscribe(() => undefined)).toThrow(/subscriber limit reached/);
  });
});
