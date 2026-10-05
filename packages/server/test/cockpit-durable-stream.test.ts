/**
 * The cockpit stream across a restart, as executable assertions.
 *
 * The in-memory replay window (cockpit-resume.test.ts) answers "a client dropped"; this suite
 * answers the harder one E4 names: the PROCESS dropped. Survival is claimed only where it is
 * proven — a durable file that a new log adopts with the same generation and cursor, a torn
 * tail from a crash that is discarded rather than guessed at, a bounded append-only file, a
 * failure that never stops the live stream, and a `caught_up` marker that appears at the
 * convergence point and nowhere else.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  COCKPIT_EVENT_LOG_CAP,
  COCKPIT_EVENT_LOG_COMPACT_AT_BYTES,
  COCKPIT_EVENT_LOG_FILE,
  COCKPIT_EVENT_LOG_MAX_BYTES,
  CockpitEventLog,
  nodeCockpitEventLogDisk,
  type CockpitEventLogDisk,
} from "../src/cockpit/event-log.js";
import {
  COCKPIT_BACKPRESSURE_CLOSE_CODE,
  attachCockpitWebSocket,
  getOrCreateProjectRuntime,
  resetCockpitRuntimesForTesting,
  safeSend,
} from "../src/cockpit/ws.js";

const tmpDirs: string[] = [];
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-durable-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetCockpitRuntimesForTesting();
});

/**
 * A disk that goes down on demand, so the failure path is exercised rather than described.
 * Both writes fail — a disk that refuses one but accepts the other would let the log repair
 * itself through the second path, which is a recovery, not the outage under test here.
 */
function failingDisk(failure: () => Error | null, base = nodeCockpitEventLogDisk) {
  const guard = (): void => {
    const error = failure();
    if (error) throw error;
  };
  return {
    read: base.read,
    replace: (file: string, text: string): void => {
      guard();
      base.replace(file, text);
    },
    append: (file: string, text: string): void => {
      guard();
      base.append(file, text);
    },
  } satisfies CockpitEventLogDisk;
}

describe("CockpitEventLog durability", () => {
  it("a new log adopts the same generation, cursor and tail from the durable file", () => {
    const file = path.join(tempRoot(), "proj", COCKPIT_EVENT_LOG_FILE);
    const first = new CockpitEventLog({ file });
    expect(first.publish('{"type":"a"}')).toBe(1);
    expect(first.publish('{"type":"b"}')).toBe(2);
    expect(first.publish('{"type":"c"}')).toBe(3);
    expect(first.durableCursor).toBe(3);

    // "Restart": a brand-new instance reading the same file, no shared memory.
    const second = new CockpitEventLog({ file });
    expect(second.generation).toBe(first.generation);
    expect(second.cursor).toBe(3);
    expect(second.durableCursor).toBe(3);
    expect(second.since(1)).toMatchObject({ gap: false, missed: 2, cursor: 3 });
    expect(second.since(1).entries.map((entry) => entry.seq)).toEqual([2, 3]);

    // And the stream continues where it stopped, in the same generation.
    expect(second.publish('{"type":"d"}')).toBe(4);
    const third = new CockpitEventLog({ file });
    expect(third.generation).toBe(first.generation);
    expect(third.cursor).toBe(4);
  });

  it("discards a torn tail left by a crash instead of resurrecting or guessing it", () => {
    const dir = tempRoot();
    const file = path.join(dir, "proj", COCKPIT_EVENT_LOG_FILE);
    const log = new CockpitEventLog({ file });
    for (const body of ["a", "b", "c"]) log.publish(`{"type":"${body}"}`);

    // Simulate a crash mid-append: the last line is cut short.
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, raw.slice(0, raw.length - 6));

    const restarted = new CockpitEventLog({ file });
    expect(restarted.cursor).toBe(2);
    expect(restarted.durableCursor).toBe(2);
    // The torn envelope is gone, and a client that had it is told it is ahead of this stream
    // (a gap), rather than being handed a partial replay that pretends to be continuous.
    expect(restarted.since(2)).toMatchObject({ gap: false, missed: 0 });
    expect(restarted.since(3)).toMatchObject({ gap: true, entries: [] });
    // The next publish repairs the file: it becomes the complete third record.
    expect(restarted.publish('{"type":"d"}')).toBe(3);
    expect(new CockpitEventLog({ file }).cursor).toBe(3);
  });

  it("does not adopt a foreign or older-format file, and replaces it on the next publish", () => {
    const dir = tempRoot();
    const file = path.join(dir, "proj", COCKPIT_EVENT_LOG_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "cockpit_stream_header", version: 0, generation: "old" })}\n${JSON.stringify({ seq: 1, payload: "stale" })}\n`,
    );

    const log = new CockpitEventLog({ file });
    expect(log.cursor).toBe(0);
    expect(log.generation).not.toBe("old");
    expect(log.since(0)).toMatchObject({ gap: false, missed: 0 });
    log.publish('{"type":"fresh"}');
    const reloaded = new CockpitEventLog({ file });
    expect(reloaded.cursor).toBe(1);
    expect(reloaded.since(0).entries.map((entry) => entry.payload)).toEqual(['{"type":"fresh"}']);
  });

  it("keeps the durable file bounded by compacting it atomically", () => {
    const file = path.join(tempRoot(), "proj", COCKPIT_EVENT_LOG_FILE);
    const log = new CockpitEventLog({ file });
    const total = 16_000;
    let smallest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < total; index += 1) {
      log.publish(JSON.stringify({ type: "tick", index, pad: "x".repeat(200) }));
      smallest = Math.min(smallest, fs.statSync(file).size);
    }
    const size = fs.statSync(file).size;
    // Two halves of the bound. The file never grows past the compaction threshold (plus the
    // one envelope that crosses it), and at least one compaction shrank it back into the
    // retained-window budget — a rewrite that only bounded nothing would pass the first check.
    expect(size).toBeLessThanOrEqual(COCKPIT_EVENT_LOG_COMPACT_AT_BYTES + 4 * 1024);
    expect(smallest).toBeLessThanOrEqual(COCKPIT_EVENT_LOG_MAX_BYTES + 4 * 1024);
    // Compaction preserved the stream: the tail is intact and the cursor is continuous.
    const reloaded = new CockpitEventLog({ file });
    expect(reloaded.cursor).toBe(total);
    expect(reloaded.since(total - 3).entries.map((entry) => entry.seq)).toEqual([
      total - 2,
      total - 1,
      total,
    ]);
    expect(reloaded.durableCursor).toBe(total);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("repairs a torn tail in place so the repaired file reads back contiguously", () => {
    const file = path.join(tempRoot(), "proj", COCKPIT_EVENT_LOG_FILE);
    const log = new CockpitEventLog({ file });
    for (const body of ["a", "b", "c"]) log.publish(`{"type":"${body}"}`);
    // Truncate mid-record, then confirm the repair is what a *second* restart reads, not just
    // what this instance believes: the next publish must rewrite, never append onto the stump.
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, raw.slice(0, raw.length - 6));
    const restarted = new CockpitEventLog({ file });
    restarted.publish('{"type":"d"}');
    const after = fs.readFileSync(file, "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(() =>
      after
        .split("\n")
        .slice(0, -1)
        .forEach((l) => JSON.parse(l)),
    ).not.toThrow();
    expect(new CockpitEventLog({ file }).cursor).toBe(3);
  });

  it("creates the durable file owner-only", () => {
    const file = path.join(tempRoot(), "proj", COCKPIT_EVENT_LOG_FILE);
    new CockpitEventLog({ file }).publish('{"type":"secret-ish"}');
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("never lets a persistence failure stop the live stream, and reports bursts", () => {
    const file = path.join(tempRoot(), "proj", COCKPIT_EVENT_LOG_FILE);
    let failure: Error | null = null;
    const errors: Error[] = [];
    const log = new CockpitEventLog({
      file,
      disk: failingDisk(() => failure),
      onPersistError: (error) => errors.push(error),
    });

    expect(log.publish('{"type":"one"}')).toBe(1);
    expect(log.durableCursor).toBe(1);

    failure = new Error("ENOSPC");
    expect(log.publish('{"type":"two"}')).toBe(2);
    expect(log.publish('{"type":"three"}')).toBe(3);
    // The stream is intact in memory, the durability acknowledgement is not advanced, and the
    // burst is reported once rather than per envelope.
    expect(log.cursor).toBe(3);
    expect(log.since(1).entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(log.durableCursor).toBe(1);
    expect(errors).toHaveLength(1);

    // Recovery is also a transition: the next failure is reported again.
    failure = null;
    expect(log.publish('{"type":"four"}')).toBe(4);
    expect(log.durableCursor).toBe(4);
    failure = new Error("EIO");
    log.publish('{"type":"five"}');
    expect(errors).toHaveLength(2);
    expect(log.persistenceErrors).toBe(3);
    // A restart sees a contiguous prefix of what this process published, never a hole: the
    // envelope written right after the outage repaired the file wholesale (that is why the
    // cursor is 4 and not 1), and the second outage left the repaired file untouched.
    expect(new CockpitEventLog({ file }).cursor).toBe(4);
  });

  it("bounds restored state by the caps, keeping the newest tail", () => {
    const file = path.join(tempRoot(), "proj", COCKPIT_EVENT_LOG_FILE);
    const log = new CockpitEventLog({ file });
    for (let index = 0; index < COCKPIT_EVENT_LOG_CAP + 100; index += 1) log.publish(`e${index}`);

    const restarted = new CockpitEventLog({ file });
    expect(restarted.cursor).toBe(COCKPIT_EVENT_LOG_CAP + 100);
    expect(restarted.size).toBe(COCKPIT_EVENT_LOG_CAP);
    // A cursor inside the window still replays; one below it is told about the gap.
    expect(restarted.since(COCKPIT_EVENT_LOG_CAP).gap).toBe(false);
    expect(restarted.since(1).gap).toBe(true);
  });
});

describe("safeSend: an undeliverable frame is never a silent skip", () => {
  const client = (readyState: number, bufferedAmount: number) => {
    const send = vi.fn();
    const close = vi.fn();
    return { ws: { readyState, bufferedAmount, send, close } as unknown as WebSocket, send, close };
  };

  it("delivers when the socket is open and inside the backpressure guard", () => {
    const { ws, send, close } = client(WebSocket.OPEN, 0);
    expect(safeSend(ws, "frame")).toBe(true);
    expect(send).toHaveBeenCalledWith("frame");
    expect(close).not.toHaveBeenCalled();
  });

  it("closes a backed-up client instead of skipping the frame it cannot receive", () => {
    const { ws, send, close } = client(WebSocket.OPEN, 64 * 1024);
    expect(safeSend(ws, "frame")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(COCKPIT_BACKPRESSURE_CLOSE_CODE, expect.any(String));
  });

  it("reports a closed socket without pretending it was sent", () => {
    const { ws, send, close } = client(WebSocket.CLOSED, 0);
    expect(safeSend(ws, "frame")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("cockpit stream across a process restart", () => {
  let server: Server;
  let port: number;
  let root: string;

  const open = new Set<WebSocket>();

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
        // Not a frame this suite models; ignored rather than failing the run.
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

  /**
   * Records one broadcast exactly as the transport does — `publishStamped`, so the retained
   * payload carries the `seq` a client orders by (a bare `publish` would store a payload no
   * client could order). Used only while no client is attached: this is the history an outage
   * or a restart has to survive, not a delivery path.
   */
  const record = (
    runtime: { eventLog: { publishStamped: (make: (seq: number) => string) => { seq: number } } },
    event: Record<string, unknown>,
  ): number => runtime.eventLog.publishStamped((seq) => JSON.stringify({ ...event, seq })).seq;

  const waitFor = async (
    predicate: () => boolean,
    what: string,
    timeoutMs = 10_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const url = (project: string, query = ""): string =>
    `ws://127.0.0.1:${port}/ws/cockpit?project=${project}${query}`;

  async function withServer(): Promise<void> {
    root = tempRoot();
    server = createServer();
    attachCockpitWebSocket(server, { root });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async function closeServer(): Promise<void> {
    for (const ws of open) ws.terminate();
    open.clear();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it("resumes a cursor from before the restart, in the same generation, then says caught_up", async () => {
    await withServer();
    const project = "proj-restart";
    try {
      const runtime = await getOrCreateProjectRuntime(project, { root });
      record(runtime, { type: "before", n: 1 });
      record(runtime, { type: "before", n: 2 });
      const cursor = runtime.eventLog.cursor;
      const generation = runtime.eventLog.generation;

      const first = collect(url(project));
      await waitFor(
        () => first.messages.some((m) => m.type === "cockpit_caught_up"),
        "caught_up on a clean connect",
      );
      const firstTypes = first.messages.map((m) => m.type);
      expect(firstTypes.indexOf("cockpit_init")).toBeLessThan(
        firstTypes.indexOf("cockpit_caught_up"),
      );
      first.stop();
      await first.closed;

      // Events while no client is attached, then the process "restarts": every in-memory
      // runtime is dropped, and the next connection builds a new one from the data root.
      record(runtime, { type: "during", n: 3 });
      record(runtime, { type: "during", n: 4 });
      resetCockpitRuntimesForTesting();

      expect(fs.existsSync(path.join(root, project, COCKPIT_EVENT_LOG_FILE))).toBe(true);

      const resumed = collect(url(project, `&since=${cursor}&generation=${generation}`));
      await waitFor(
        () => resumed.messages.some((m) => m.type === "cockpit_caught_up"),
        "caught_up after the restart",
      );

      const types = resumed.messages.map((m) => m.type);
      const resume = resumed.messages.find((m) => m.type === "cockpit_resume");
      // The generation survived the restart, so this is a resume rather than a forced resync.
      expect(resume, JSON.stringify(types)).toBeDefined();
      expect(resume!.generation).toBe(generation);
      expect(resume!.replayed).toBeGreaterThanOrEqual(2);
      // Ordering: replayed deltas, then the resume ack, then the snapshot, then the marker.
      expect(types.indexOf("cockpit_resume")).toBeLessThan(types.indexOf("cockpit_init"));
      expect(types.lastIndexOf("cockpit_caught_up")).toBeGreaterThan(types.indexOf("cockpit_init"));
      // The snapshot also carries a `seq` (the convergence point), so exclude control frames
      // and keep the replayed envelopes themselves.
      const replayed = resumed.messages.filter(
        (m) => typeof m.seq === "number" && (m.seq as number) > cursor && m.type !== "cockpit_init",
      );
      // Exactly the two envelopes the client missed, each once, in order: a double-apply would
      // show up here as a repeated seq and a hole as a missing one.
      expect(replayed.map((m) => m.seq)).toEqual([cursor + 1, cursor + 2]);
      expect(resumed.messages.some((m) => m.type === "cockpit_stream_gap")).toBe(false);

      // Fresh tail from the convergence point: the runtime the restart created continues the
      // stream where the file left off, and a real broadcast (the transport's own publish path,
      // reached by running a simulated task) lands on the resumed client as the very next
      // sequence number — not re-sent, not skipped. This is the "no double-apply" assertion, at
      // the seam where a resumed snapshot and a live broadcast could disagree.
      const marker = resumed.messages.find((m) => m.type === "cockpit_caught_up")!;
      const convergedAt = marker.cursor as number;
      const restartedRuntime = await getOrCreateProjectRuntime(project, { root });
      expect(restartedRuntime.eventLog.cursor).toBe(convergedAt);
      await restartedRuntime.coordinator.runTask({
        id: "after-restart",
        goal: "warm",
        maxRounds: 1,
        simulate: true,
      });
      await waitFor(
        () =>
          resumed.messages.some(
            (m) => typeof m.seq === "number" && (m.seq as number) > convergedAt,
          ),
        "the first live delta after the marker",
      );
      const live = resumed.messages.filter(
        (m) =>
          typeof m.seq === "number" && (m.seq as number) > convergedAt && m.type !== "cockpit_init",
      );
      expect(live.length).toBeGreaterThan(0);
      expect(live.map((m) => m.seq)).toEqual(live.map((_, index) => convergedAt + 1 + index));
      resumed.stop();
    } finally {
      await closeServer();
    }
  });

  it("refuses a cursor from another protocol instead of guessing a position", async () => {
    await withServer();
    const project = "proj-foreign-cursor";
    try {
      const runtime = await getOrCreateProjectRuntime(project, { root });
      record(runtime, { type: "one", n: 1 });

      // An ACP cursor is `{streamId, seq}`; the cockpit's is a bare integer plus a generation.
      // Handing the cockpit an ACP cursor must not be read as a position — `parseSince` admits
      // only a safe non-negative integer, so the connection is a first connect (fresh snapshot
      // plus the marker), never a resume from a number the cursor never meant.
      const acpCursor = encodeURIComponent(JSON.stringify({ streamId: "acp-stream-1", seq: 4 }));
      const client = collect(url(project, `&since=${acpCursor}&generation=acp-stream-1`));
      await waitFor(
        () => client.messages.some((m) => m.type === "cockpit_caught_up"),
        "caught_up for a foreign cursor",
      );
      expect(client.messages.some((m) => m.type === "cockpit_resume")).toBe(false);
      expect(client.messages.some((m) => m.type === "cockpit_stream_gap")).toBe(false);
      client.stop();
    } finally {
      await closeServer();
    }
  });

  it("a gap never claims caught_up, whichever way the cursor is unavailable", async () => {
    await withServer();
    const project = "proj-gap";
    try {
      const runtime = await getOrCreateProjectRuntime(project, { root });
      for (let index = 0; index < COCKPIT_EVENT_LOG_CAP + 20; index += 1) {
        record(runtime, { type: "noise", index });
      }

      const outsideWindow = collect(
        url(project, `&since=1&generation=${runtime.eventLog.generation}`),
      );
      await waitFor(() => outsideWindow.messages.some((m) => m.type === "cockpit_init"), "init");
      const windowGap = outsideWindow.messages.find((m) => m.type === "cockpit_stream_gap")!;
      expect(windowGap).toMatchObject({
        reason: "outside_replay_window",
        cursor: runtime.eventLog.cursor,
      });
      expect(outsideWindow.messages.some((m) => m.type === "cockpit_caught_up")).toBe(false);
      outsideWindow.stop();

      // Gap recovery: the client reconnects from the cursor the gap message handed it, and the
      // server answers with a resume — not another gap. Without this the "you are behind"
      // signal would be a dead end rather than the first half of a recovery.
      const recovered = collect(
        url(project, `&since=${windowGap.cursor}&generation=${runtime.eventLog.generation}`),
      );
      await waitFor(
        () => recovered.messages.some((m) => m.type === "cockpit_caught_up"),
        "caught_up after recovering from the gap cursor",
      );
      const recoveredResume = recovered.messages.find((m) => m.type === "cockpit_resume")!;
      expect(recoveredResume).toMatchObject({ missed: 0, replayed: 0 });
      expect(recovered.messages.some((m) => m.type === "cockpit_stream_gap")).toBe(false);
      recovered.stop();

      const foreignGeneration = collect(url(project, "&since=1&generation=previous-process"));
      await waitFor(
        () => foreignGeneration.messages.some((m) => m.type === "cockpit_init"),
        "init after generation mismatch",
      );
      const gap = foreignGeneration.messages.find((m) => m.type === "cockpit_stream_gap");
      expect(gap).toMatchObject({ reason: "stream_generation_changed", missed: null });
      expect(foreignGeneration.messages.some((m) => m.type === "cockpit_caught_up")).toBe(false);
      foreignGeneration.stop();

      // A first-time client (no cursor) is current by construction, so it does get the marker.
      const firstTimer = collect(url(project));
      await waitFor(
        () => firstTimer.messages.some((m) => m.type === "cockpit_caught_up"),
        "caught_up for a first-time client",
      );
      expect(firstTimer.messages.some((m) => m.type === "cockpit_stream_gap")).toBe(false);
      firstTimer.stop();
    } finally {
      await closeServer();
    }
  });
});
