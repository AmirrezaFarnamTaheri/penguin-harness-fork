/**
 * The cockpit stream's resume, as executable assertions.
 *
 * The property under test is the one the old transport could not satisfy: a client that drops
 * reconnects and ends up reconciled to server truth, or says out loud that it could not be.
 * There is no third outcome in which it looks current and is not — that was the actual bug,
 * because the loop-alert and handoff feeds are built only from deltas and the REST snapshot
 * that a reconnect refetches contains no event history at all.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  attachCockpitWebSocket,
  getOrCreateProjectRuntime,
  resetCockpitRuntimesForTesting,
} from "../src/cockpit/ws.js";
import {
  COCKPIT_EVENT_LOG_CAP,
  COCKPIT_EVENT_LOG_MAX_BYTES,
  CockpitEventLog,
} from "../src/cockpit/event-log.js";

describe("CockpitEventLog: a bounded, monotonic cursor", () => {
  it("numbers envelopes monotonically from 1, with 0 meaning 'nothing yet'", () => {
    const log = new CockpitEventLog();
    expect(log.cursor).toBe(0);
    expect(log.publish("a")).toBe(1);
    expect(log.publish("b")).toBe(2);
    expect(log.cursor).toBe(2);
  });

  it("changes generation when the log is reset", () => {
    const log = new CockpitEventLog();
    const first = log.generation;
    log.reset();
    expect(log.generation).not.toBe(first);
  });

  it("replays exactly what a client between cursors missed, in order", () => {
    const log = new CockpitEventLog();
    for (const body of ["a", "b", "c", "d"]) log.publish(body);
    const replay = log.since(2);
    expect(replay.gap).toBe(false);
    expect(replay.missed).toBe(2);
    expect(replay.cursor).toBe(4);
    expect(replay.entries.map((e) => e.payload)).toEqual(["c", "d"]);
  });

  it("retains the exact stamped envelope that live subscribers receive", () => {
    const log = new CockpitEventLog();
    const entry = log.publishStamped((seq) => JSON.stringify({ type: "event", seq }));
    expect(entry.seq).toBe(1);
    expect(JSON.parse(entry.payload)).toEqual({ type: "event", seq: 1 });
    expect(log.since(0).entries).toEqual([entry]);
  });

  it("reports nothing missed for a client that is current", () => {
    const log = new CockpitEventLog();
    log.publish("a");
    const replay = log.since(1);
    expect(replay).toMatchObject({ gap: false, missed: 0, entries: [] });
  });

  it("bounds the entry count and evicts the oldest", () => {
    const log = new CockpitEventLog();
    for (let i = 0; i < COCKPIT_EVENT_LOG_CAP + 50; i += 1) log.publish(`e${i}`);
    expect(log.size).toBe(COCKPIT_EVENT_LOG_CAP);
    // The evicted prefix is exactly what a cursor pointing into it can no longer be served.
    const replay = log.since(1);
    expect(replay.gap).toBe(true);
    expect(replay.entries).toEqual([]);
    // ...while a cursor inside the window still is.
    expect(log.since(COCKPIT_EVENT_LOG_CAP + 40).gap).toBe(false);
  });

  it("bounds retained bytes, not just entry count", () => {
    // The count bound alone is not a memory bound: 512 large envelopes is a very different
    // number of bytes than 512 small ones, and this project emits both.
    const log = new CockpitEventLog();
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 20; i += 1) log.publish(big);
    expect(log.retainedBytes).toBeLessThanOrEqual(COCKPIT_EVENT_LOG_MAX_BYTES);
    expect(log.size).toBeLessThan(20);
  });

  it("measures UTF-8 storage bytes when payloads contain multibyte characters", () => {
    const log = new CockpitEventLog();
    const payload = "😀".repeat(40_000);
    log.publish(payload);
    log.publish(payload);
    log.publish(payload);
    log.publish(payload);
    expect(log.retainedBytes).toBeLessThanOrEqual(COCKPIT_EVENT_LOG_MAX_BYTES);
    expect(log.retainedBytes).toBeGreaterThan(log.retainedChars);
    expect(log.size).toBe(3);
  });

  it("refuses to retain an envelope larger than the whole budget", () => {
    // Keeping it would evict everything else and still overflow, so it is published (the
    // caller always broadcasts) but not retained. A client needing it is told it fell out.
    const log = new CockpitEventLog();
    log.publish("small");
    log.publish("y".repeat(COCKPIT_EVENT_LOG_MAX_BYTES + 1));
    expect(log.size).toBe(1);
    expect(log.since(1).entries).toEqual([]);
  });

  it("treats a garbage or foreign cursor as a gap rather than clamping it", () => {
    const log = new CockpitEventLog();
    for (const body of ["a", "b", "c"]) log.publish(body);
    for (const bogus of [undefined, null, "2", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const replay = log.since(bogus);
      expect(replay.gap, String(bogus)).toBe(true);
      expect(replay.entries, String(bogus)).toEqual([]);
    }
  });

  it("reports a gap for a client whose cursor is ahead of this server", () => {
    // A restarted server has a new log generation. Its lower cursor cannot prove that
    // the client has seen the events in this generation.
    const log = new CockpitEventLog();
    log.publish("a");
    expect(log.since(9999)).toMatchObject({ gap: true, missed: null, entries: [] });
  });
});

describe("cockpit stream: a reconnecting client resumes instead of restarting blind", () => {
  let server: Server;
  let port: number;
  const project = "proj-resume";

  /**
   * Every client socket this test opened. They must all be closed before `server.close`
   * can complete: an upgraded socket is no longer an HTTP connection, so
   * `server.closeAllConnections()` does not reach it and the afterAll hook would hang.
   */
  const open = new Set<WebSocket>();

  /** Collects every message a client receives until `stop()` is called. */
  function collect(url: string): {
    messages: Array<Record<string, unknown>>;
    closed: Promise<void>;
    stop: () => void;
  } {
    const messages: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(url);
    open.add(ws);
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        // A frame this test does not model; ignored rather than failing the run.
      }
    });
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    return {
      messages,
      closed,
      stop: () => {
        open.delete(ws);
        ws.close();
      },
    };
  }

  const waitFor = async (
    predicate: () => boolean,
    what: string,
    timeoutMs = 5_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    server = createServer();
    attachCockpitWebSocket(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const ws of open) ws.terminate();
    open.clear();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetCockpitRuntimesForTesting();
  });

  beforeEach(async () => {
    // A fresh project per test, so the event log starts at seq 1 and cursor assertions mean
    // what they say rather than depending on another test's traffic.
    resetCockpitRuntimesForTesting();
  });

  it("stamps every broadcast with a sequence number the client can resume from", async () => {
    const client = collect(`ws://127.0.0.1:${port}/ws/cockpit?project=${project}`);
    await waitFor(() => client.messages.some((m) => m.type === "cockpit_init"), "init");
    const init = client.messages.find((m) => m.type === "cockpit_init")!;
    expect(typeof init.seq).toBe("number");

    client.messages.length = 0;
    client.stop();
    await client.closed;

    const runtime = await getOrCreateProjectRuntime(project);
    // Publish through the same path the coordinator uses, by running a simulated task.
    const runner = collect(`ws://127.0.0.1:${port}/ws/cockpit?project=${project}`);
    await waitFor(() => runner.messages.some((m) => m.type === "cockpit_init"), "runner init");
    runner.stop();
    await runner.closed;
    await runtime.coordinator.runTask({ id: "t1", goal: "warm", maxRounds: 1, simulate: true });
    await waitFor(() => runtime.eventLog.cursor > 0, "a published event");

    const resumed = collect(
      `ws://127.0.0.1:${port}/ws/cockpit?project=${project}&since=${init.seq}&generation=${init.generation}`,
    );
    await waitFor(
      () =>
        resumed.messages.some(
          (m) => m.type === "cockpit_resume" || m.type === "cockpit_stream_gap",
        ),
      "resume acknowledgement or explicit gap",
      15_000,
    );
    const response = resumed.messages.find(
      (m) => m.type === "cockpit_resume" || m.type === "cockpit_stream_gap",
    );
    expect(response?.type, JSON.stringify(response)).toBe("cockpit_resume");
    const ack = response!;
    expect(ack.missed).toBeGreaterThan(0);
    // The backlog arrives BEFORE the ack and before the fresh snapshot, so a client applies
    // missed deltas in the order they happened and then reconciles against truth.
    const types = resumed.messages.map((m) => m.type);
    expect(types.indexOf("cockpit_resume")).toBeGreaterThan(-1);
    expect(types.indexOf("cockpit_init")).toBeGreaterThan(types.indexOf("cockpit_resume") - 1);
    // Every replayed envelope carries its own original sequence number.
    const replayed = resumed.messages.filter(
      (m) => typeof m.seq === "number" && m.seq > Number(init.seq),
    );
    expect(replayed.length).toBeGreaterThan(0);
    resumed.stop();
  });

  it("answers a cursor outside the bounded window with a gap and a fresh snapshot", async () => {
    const runtime = await getOrCreateProjectRuntime(project);
    // Fill the log past its cap without a client attached: these are published but broadcast
    // to nobody, which is exactly the situation a long-idle project is in.
    for (let i = 0; i < COCKPIT_EVENT_LOG_CAP + 20; i += 1) {
      runtime.eventLog.publish(JSON.stringify({ type: "noise", i }));
    }

    const client = collect(
      `ws://127.0.0.1:${port}/ws/cockpit?project=${project}&since=1&generation=${runtime.eventLog.generation}`,
    );
    await waitFor(() => client.messages.some((m) => m.type === "cockpit_init"), "init");
    const gap = client.messages.find((m) => m.type === "cockpit_stream_gap");
    expect(gap).toBeDefined();
    expect(gap!.reason).toBe("outside_replay_window");
    // The gap is announced, and a full snapshot follows it, so the client's tree is current
    // even though its delta-built feeds are known to have a hole.
    const order = client.messages.map((m) => m.type);
    expect(order.indexOf("cockpit_init")).toBeGreaterThan(order.indexOf("cockpit_stream_gap"));
    // And no partial replay masquerades as a complete one.
    expect(client.messages.some((m) => m.type === "cockpit_resume")).toBe(false);
    client.stop();
  });

  it("reports a gap when a cursor belongs to a previous stream generation", async () => {
    const runtime = await getOrCreateProjectRuntime(project);
    runtime.eventLog.publish(JSON.stringify({ type: "before_restart" }));
    const client = collect(
      `ws://127.0.0.1:${port}/ws/cockpit?project=${project}&since=1&generation=previous-process`,
    );
    await waitFor(() => client.messages.some((m) => m.type === "cockpit_init"), "init");
    const gap = client.messages.find((m) => m.type === "cockpit_stream_gap");
    expect(gap).toMatchObject({
      reason: "stream_generation_changed",
      missed: null,
      generation: runtime.eventLog.generation,
    });
    expect(client.messages.some((m) => m.type === "cockpit_resume")).toBe(false);
    client.stop();
  });

  it("never replays an unbounded history to a first-time client", async () => {
    const runtime = await getOrCreateProjectRuntime(project);
    const retained = COCKPIT_EVENT_LOG_CAP + 20;
    for (let i = 0; i < retained; i += 1) runtime.eventLog.publish(`noise-${i}`);
    const cursorBeforeConnect = runtime.eventLog.cursor;

    const client = collect(`ws://127.0.0.1:${port}/ws/cockpit?project=${project}`);
    await waitFor(() => client.messages.some((m) => m.type === "cockpit_init"), "init");
    // No `since` means "show me the state", not "replay the log". A first connection gets the
    // snapshot first and is told the current cursor to resume from next time. (The graph
    // watcher may add topology deltas after it, so the assertion is that the client got the
    // snapshot and NOT the retained backlog — not that it received exactly one frame.)
    const init = client.messages[0]!;
    expect(init.type).toBe("cockpit_init");
    // The stamp is the cursor as of the snapshot, so it is at least everything published
    // before the connection and at most what the log has reached since.
    expect(init.seq).toBeGreaterThanOrEqual(cursorBeforeConnect);
    expect(init.seq).toBeLessThanOrEqual(runtime.eventLog.cursor);
    expect(client.messages.length).toBeLessThan(retained);
    expect(client.messages.some((m) => m.type === "cockpit_resume")).toBe(false);
    expect(client.messages.some((m) => m.type === "cockpit_stream_gap")).toBe(false);
    client.stop();
  });
});
