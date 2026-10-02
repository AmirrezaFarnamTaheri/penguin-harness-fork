/**
 * The cockpit stream's client half: reconnect decorrelation and the "am I behind?" state
 * machine. Both are pure functions precisely so they can be asserted here — the web package's
 * vitest runs in a node environment with no DOM, and a resume that only worked when nothing
 * had dropped would be a resume that never works.
 */
import { describe, expect, it } from "vitest";
import {
  applyStreamMessage,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  reconnectDelayMs,
  type StreamProgress,
} from "../src/features/agent/use-cockpit-telemetry.js";

const START: StreamProgress = { streamState: "connecting", missedEvents: 0, cursor: null };

describe("reconnect backoff decorrelates a fleet that dropped together", () => {
  it("gives two clients the same attempt different delays", () => {
    // The bug being fixed: a fixed 5s interval meant every client in a fleet that dropped at
    // the same instant reconnected at the same instant. Two clients at the same attempt must
    // not be handed the same delay.
    const a = reconnectDelayMs(0, 0x1234_5678);
    const b = reconnectDelayMs(0, 0x9abc_def0);
    expect(a).not.toBe(b);
  });

  it("spreads a whole fleet across the window rather than clustering it", () => {
    // Not just "a != b": a herd that all drew from a 10ms band is still a herd. Fifty
    // clients on the same attempt must be spread across most of the first window.
    const delays: number[] = [];
    for (let i = 0; i < 50; i += 1) delays.push(reconnectDelayMs(0, (i * 0x9e37_79b9) >>> 0));
    const distinct = new Set(delays).size;
    expect(distinct).toBeGreaterThan(40);
    const spread = Math.max(...delays) - Math.min(...delays);
    expect(spread).toBeGreaterThan(RECONNECT_BASE_MS * 0.9);
    // And draws from zero, which is what actually decorrelates: a symmetric band around the
    // delay would still centre every client on the same instant.
    expect(Math.min(...delays)).toBeLessThan(RECONNECT_BASE_MS * 0.1);
  });

  it("grows the WINDOW with the attempt and never exceeds the ceiling", () => {
    // The ceiling is what grows; an individual sample is not monotonic, and must not be.
    // Full jitter deliberately lets a later attempt draw a shorter delay than an earlier
    // one — otherwise every client would be sorted by attempt, and the fleet would move
    // through the schedule in lockstep waves.
    const ceilingFor = (attempt: number) =>
      Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
    let sawOutOfOrderSample = false;
    let previous = 0;
    for (const attempt of [0, 1, 2, 3, 4, 5]) {
      const delays = Array.from({ length: 60 }, (_, i) =>
        reconnectDelayMs(attempt, (i * 2654435761) >>> 0),
      );
      expect(Math.max(...delays)).toBeLessThanOrEqual(ceilingFor(attempt));
      if (attempt > 0) {
        // The whole fleet at a later attempt is pushed later than the first attempt was.
        expect(Math.max(...delays)).toBeGreaterThan(Math.max(previous, 1) - 1);
        if (Math.min(...delays) < previous) sawOutOfOrderSample = true;
      }
      previous = Math.max(...delays);
    }
    expect(sawOutOfOrderSample).toBe(true);
    // A client that is genuinely down must stop hammering: the long-attempt window is at the
    // ceiling, not back at the base.
    expect(reconnectDelayMs(16, 42)).toBeGreaterThanOrEqual(RECONNECT_CAP_MS / 2);
    for (const attempt of [10, 16, 64, 1_000]) {
      expect(reconnectDelayMs(attempt, 42)).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    }
  });

  it("is reproducible for a given (attempt, salt)", () => {
    // Determinism per client: a flaky reconnect is impossible to debug if the same client
    // picks a different delay on every render of the same outage.
    for (const attempt of [0, 3, 7]) {
      expect(reconnectDelayMs(attempt, 0xabcd_ef01)).toBe(reconnectDelayMs(attempt, 0xabcd_ef01));
    }
  });

  it("survives a negative or absurd attempt count without going negative or infinite", () => {
    for (const attempt of [-1, -100, Number.MAX_SAFE_INTEGER, Number.NaN]) {
      const delay = reconnectDelayMs(attempt, 7);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    }
  });
});

describe("stream progress: a resumed connection reconciles, and a lossy one says so", () => {
  it("is live and current after a clean resume, with nothing missed", () => {
    const progress = applyStreamMessage(START, { type: "cockpit_resume", cursor: 42, missed: 0 });
    expect(progress).toEqual({ streamState: "live", missedEvents: 0, cursor: 42 });
  });

  it("is live and current after a snapshot, which IS server truth", () => {
    const progress = applyStreamMessage(START, { type: "cockpit_init", seq: 7 });
    expect(progress).toEqual({ streamState: "live", missedEvents: 0, cursor: 7 });
  });

  it("says it is BEHIND when the server could not replay back to its cursor", () => {
    const connected = applyStreamMessage(START, { type: "cockpit_init", seq: 10 });
    const gapped = applyStreamMessage(connected, {
      type: "cockpit_stream_gap",
      missed: 900,
      cursor: 910,
    });
    // The failure this prevents: a transport badge reading "connected" over a feed that is
    // missing a stretch, looking exactly like a healthy one.
    expect(gapped.streamState).toBe("behind");
    expect(gapped.missedEvents).toBe(900);
    // The gap message reports the new cursor under `cursor` (it is a control message, not a
    // sequenced event). Adopting it is what stops the next reconnect from asking for the
    // same unreachable window and gapping again forever.
    expect(gapped.cursor).toBe(910);
    // The real server sends a snapshot immediately after the gap. It repairs the tree,
    // but cannot restore the missing delta-built history or clear the warning.
    const snapshot = applyStreamMessage(gapped, { type: "cockpit_init", seq: 910 });
    expect(snapshot).toEqual({ streamState: "behind", missedEvents: 900, cursor: 910 });
    const resumed = applyStreamMessage(gapped, { type: "cockpit_resume", cursor: 1200 });
    expect(resumed.streamState).toBe("live");
    expect(resumed.cursor).toBe(1200);
  });

  it("treats cockpit_caught_up as a cursor advance, never as a way out of behind", () => {
    // The server sends `cockpit_caught_up` only on the contiguous path — its presence is the
    // proof the delta feeds have no hole. So the marker must move the cursor to the
    // convergence point AND must not clear `behind`: a socket that saw a gap is still holey,
    // and letting the marker un-warn it would rebuild the exact false "connected" badge the
    // gap signal exists to prevent. On a healthy connection it is simply consistent with the
    // snapshot that preceded it.
    const live = applyStreamMessage(START, { type: "cockpit_init", seq: 7 });
    const marker = applyStreamMessage(live, { type: "cockpit_caught_up", cursor: 7 });
    expect(marker).toEqual({ streamState: "live", missedEvents: 0, cursor: 7 });

    const gapped = applyStreamMessage(live, { type: "cockpit_stream_gap", missed: 3, cursor: 10 });
    const after = applyStreamMessage(
      applyStreamMessage(gapped, { type: "cockpit_init", seq: 10 }),
      { type: "cockpit_caught_up", cursor: 10 },
    );
    expect(after.streamState).toBe("behind");
    expect(after.missedEvents).toBe(3);
    expect(after.cursor).toBe(10);
  });

  it("keeps saying it is behind when later deltas arrive", () => {
    // The lost stretch cannot be un-lost by events that happened after it. A delta must
    // advance the cursor without clearing the flag.
    let progress = applyStreamMessage(START, { type: "cockpit_init", seq: 10 });
    progress = applyStreamMessage(progress, { type: "cockpit_stream_gap", missed: 5, seq: 11 });
    progress = applyStreamMessage(progress, { type: "swarm_event", seq: 12 });
    progress = applyStreamMessage(progress, { type: "swarm_event", seq: 13 });
    expect(progress.streamState).toBe("behind");
    expect(progress.cursor).toBe(13);
  });

  it("distinguishes 'missed an unknown number' from 'missed nothing'", () => {
    // null is a different claim from 0, and a UI that renders both as "0" is lying.
    const unknown = applyStreamMessage(START, { type: "cockpit_stream_gap", missed: null });
    expect(unknown.missedEvents).toBeNull();
    expect(unknown.streamState).toBe("behind");
    const none = applyStreamMessage(START, { type: "cockpit_resume", missed: 0 });
    expect(none.missedEvents).toBe(0);
  });

  it("advances the cursor on a delta without claiming completeness", () => {
    const start = applyStreamMessage(START, { type: "cockpit_init", seq: 3 });
    const delta = applyStreamMessage(start, { type: "key_fleet_update", seq: 4 });
    expect(delta.cursor).toBe(4);
    expect(delta.streamState).toBe("live");
    expect(delta.missedEvents).toBe(0);
  });

  it("marks a non-contiguous live delta behind and preserves the last repairable cursor", () => {
    const start = applyStreamMessage(START, { type: "cockpit_init", seq: 100 });
    expect(applyStreamMessage(start, { type: "swarm_event", seq: 102 })).toEqual({
      streamState: "behind",
      missedEvents: 1,
      cursor: 100,
    });
  });

  it("ignores a malformed or missing sequence rather than moving the cursor to garbage", () => {
    const start = applyStreamMessage(START, { type: "cockpit_init", seq: 5 });
    for (const seq of [undefined, null, "9", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(applyStreamMessage(start, { type: "swarm_event", seq }).cursor, String(seq)).toBe(5);
    }
    // And a message that is not an object at all is survivable, not a thrown reducer.
    expect(applyStreamMessage(start, null).cursor).toBe(5);
    expect(applyStreamMessage(start, "nonsense").cursor).toBe(5);
  });

  it("returns the same object when nothing changed, so the caller can skip a render", () => {
    const start = applyStreamMessage(START, { type: "cockpit_init", seq: 5 });
    expect(applyStreamMessage(start, { type: "unknown_new_type" })).toBe(start);
  });
});
