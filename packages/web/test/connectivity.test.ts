/**
 * F17.1 unit cases: the connectivity state machine and its bounded monitor.
 *
 * The web package's vitest environment is node with no DOM (by policy), so everything here is the
 * injected-dependency surface: a fake clock, fake timers and fake probes. That is also what makes
 * the "no false offline banner" and "bounded retry" claims checkable without a browser.
 */
import { describe, expect, it } from "vitest";
import {
  FAILURE_THRESHOLD,
  RECOVERY_NOTICE_MS,
  clearRecoveredNotice,
  createConnectivityMonitor,
  initialConnectivityState,
  reduceConnectivity,
} from "../src/lib/connectivity.js";
import type { ConnectivityEvent, ConnectivityState } from "../src/lib/connectivity.js";

function apply(events: ConnectivityEvent[], from = initialConnectivityState(0)): ConnectivityState {
  return events.reduce((state, event) => reduceConnectivity(state, event), from);
}

describe("connectivity posture (F17.1)", () => {
  it("does not call a single failed request offline", () => {
    const state = apply([
      { type: "probe-started", atMs: 0 },
      { type: "probe-failed", atMs: 10 },
    ]);
    // One failure is "reconnecting": the model knows about it, the user is not told anything false.
    expect(state.posture).toBe("reconnecting");
    expect(state.banner).toBe("none");
    expect(state.writesBlocked).toBe(false);
    expect(state.cachedContentReadable).toBe(true);
  });

  it(`states the server is unreachable only after ${FAILURE_THRESHOLD} consecutive failures`, () => {
    const state = apply([
      { type: "probe-failed", atMs: 10 },
      { type: "probe-failed", atMs: 1010 },
    ]);
    expect(state.posture).toBe("server-unreachable");
    expect(state.banner).toBe("server-unreachable");
    expect(state.writesBlocked).toBe(true);
    // Cached content is a separate fact, and stays true — that IS the honest part of the copy.
    expect(state.cachedContentReadable).toBe(true);
  });

  it("resets the failure run on success, so an intermittent server never reaches the banner", () => {
    const state = apply([
      { type: "probe-failed", atMs: 10 },
      { type: "probe-succeeded", atMs: 20 },
      { type: "probe-failed", atMs: 30 },
    ]);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.banner).toBe("none");
  });

  it("believes the browser's offline report immediately, and blocks writes while cached content stays readable", () => {
    const state = apply([{ type: "browser-offline", atMs: 5 }]);
    expect(state.posture).toBe("browser-offline");
    expect(state.banner).toBe("browser-offline");
    expect(state.writesBlocked).toBe(true);
    expect(state.cachedContentReadable).toBe(true);
  });

  it("does not clear the banner on a browser-online event alone", () => {
    const down = apply([
      { type: "probe-failed", atMs: 1 },
      { type: "probe-failed", atMs: 2 },
    ]);
    expect(down.banner).toBe("server-unreachable");
    // The browser says the link is back. That is not evidence about the server — which is still
    // known unreachable — so the banner stays and writes stay blocked.
    const online = reduceConnectivity(down, { type: "browser-online", atMs: 3 });
    expect(online.banner).toBe("server-unreachable");
    expect(online.writesBlocked).toBe(true);
    // Only a real probe success clears it, and then it shows the brief recovered notice.
    const recovered = reduceConnectivity(online, { type: "probe-succeeded", atMs: 4 });
    expect(recovered.posture).toBe("online");
    expect(recovered.banner).toBe("recovered");
    expect(recovered.writesBlocked).toBe(false);
  });

  it("shows the reconnecting banner when the link returns but the server is unverified", () => {
    const offline = reduceConnectivity(initialConnectivityState(0), {
      type: "browser-offline",
      atMs: 1,
    });
    // While the device is offline, a failed probe is the link's doing, not the server's.
    const stillOffline = reduceConnectivity(offline, { type: "probe-failed", atMs: 2 });
    expect(stillOffline.posture).toBe("browser-offline");
    expect(stillOffline.consecutiveFailures).toBe(0);
    expect(stillOffline.banner).toBe("browser-offline");
    // Link back: "reconnecting" until a probe proves the server is reachable.
    const back = reduceConnectivity(stillOffline, { type: "browser-online", atMs: 3 });
    expect(back.posture).toBe("reconnecting");
    expect(back.banner).toBe("reconnecting");
    expect(back.writesBlocked).toBe(true);
    const verified = reduceConnectivity(back, { type: "probe-succeeded", atMs: 4 });
    expect(verified.banner).toBe("recovered");
    expect(verified.writesBlocked).toBe(false);
  });

  it("keeps the browser-offline posture while the device is offline, whatever the server probe says", () => {
    const offline = reduceConnectivity(initialConnectivityState(0), {
      type: "browser-offline",
      atMs: 1,
    });
    const failed = reduceConnectivity(offline, { type: "probe-failed", atMs: 2 });
    // The server may be perfectly reachable; the link is the problem, and the copy must say so.
    expect(failed.banner).toBe("browser-offline");
    expect(failed.posture).toBe("browser-offline");
    expect(failed.writesBlocked).toBe(true);
  });

  it("clears the recovered notice back to no banner", () => {
    const recovered = apply([
      { type: "probe-failed", atMs: 1 },
      { type: "probe-failed", atMs: 2 },
      { type: "probe-succeeded", atMs: 3 },
    ]);
    expect(recovered.banner).toBe("recovered");
    expect(clearRecoveredNotice(recovered, 4).banner).toBe("none");
  });
});

/** A deterministic clock + timer queue: no wall-clock waits anywhere in these tests. */
function harness() {
  let clock = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clearTimeoutFn: (handle: unknown) => {
      timers.delete(handle as number);
    },
    /**
     * Advances the clock, interleaving timer fires with promise settlements: a probe that settles
     * schedules the next attempt, so a fake clock that moves straight to the target would skip
     * attempts that a real clock would have run.
     */
    async advance(ms: number) {
      const target = clock + ms;
      const settle = async () => {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      };
      for (let guard = 0; guard < 500; guard += 1) {
        await settle();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [handle, timer] = due[0]!;
        timers.delete(handle);
        clock = Math.max(clock, timer.at);
        timer.fn();
      }
      clock = target;
      await settle();
    },
    pending: () => timers.size,
  };
}

describe("bounded health probe (F17.1)", () => {
  it("treats a probe that never settles as a failure once its timeout elapses", async () => {
    const h = harness();
    const states: ConnectivityState[] = [];
    // A probe that resolves only when aborted — i.e. never, on its own.
    const monitor = createConnectivityMonitor({
      probe: (signal) =>
        new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false))),
      onSnapshot: (state) => states.push(state),
      now: h.now,
      setTimeoutFn: h.setTimeoutFn,
      clearTimeoutFn: h.clearTimeoutFn,
      probeTimeoutMs: 2500,
      maxAutoAttempts: 3,
      backoffMs: () => 100,
    });
    monitor.start();
    expect(monitor.isProbing()).toBe(true);
    await h.advance(2600); // first timeout + backoff + second attempt timeout… enough for one
    // The timeout is evidence: the attempt failed rather than hanging forever.
    expect(states.at(-1)!.consecutiveFailures).toBeGreaterThanOrEqual(1);
    monitor.stop();
    expect(monitor.isProbing()).toBe(false);
  });

  it("caps automatic attempts and leaves recovery to the online event or a manual retry", async () => {
    const h = harness();
    const monitor = createConnectivityMonitor({
      probe: async () => false,
      onSnapshot: () => {},
      now: h.now,
      setTimeoutFn: h.setTimeoutFn,
      clearTimeoutFn: h.clearTimeoutFn,
      maxAutoAttempts: 3,
      backoffMs: () => 10,
      healthyProbeIntervalMs: 60_000,
    });
    monitor.start();
    await h.advance(1000);
    // 3 attempts, then no timer is left to fire: the monitor is waiting for a real signal.
    expect(h.pending()).toBe(0);
    expect(monitor.snapshot().posture).toBe("server-unreachable");
    expect(monitor.snapshot().autoRetriesExhausted).toBe(true);
    monitor.stop();
  });

  it("rate-limits manual retries and lets one succeed afterwards", async () => {
    const h = harness();
    let healthy = false;
    const monitor = createConnectivityMonitor({
      probe: async () => healthy,
      onSnapshot: () => {},
      now: h.now,
      setTimeoutFn: h.setTimeoutFn,
      clearTimeoutFn: h.clearTimeoutFn,
      maxAutoAttempts: 2,
      backoffMs: () => 10,
      minManualRetryIntervalMs: 1000,
    });
    monitor.start();
    await h.advance(100);
    expect(monitor.snapshot().posture).toBe("server-unreachable");

    // First manual retry inside the spacing window is refused, with the reason attached.
    expect(monitor.retry()).toBe(false);
    expect(monitor.snapshot().retry.reason).toBe("rate-limited");

    healthy = true;
    await h.advance(1500);
    expect(monitor.retry()).toBe(true);
    await h.advance(0);
    expect(monitor.snapshot().posture).toBe("online");
    expect(monitor.snapshot().banner).toBe("recovered");
    // The notice clears itself without another event.
    await h.advance(RECOVERY_NOTICE_MS + 1);
    expect(monitor.snapshot().banner).toBe("none");
    monitor.stop();
  });

  it("cancels in flight on stop and ignores the late result", async () => {
    const h = harness();
    const states: ConnectivityState[] = [];
    // A holder object, not a `let`: control-flow analysis cannot see an assignment made from
    // inside the probe callback and would narrow the variable to `never`.
    const probeControl: { resolve: ((ok: boolean) => void) | null } = { resolve: null };
    const monitor = createConnectivityMonitor({
      probe: () => new Promise<boolean>((resolve) => (probeControl.resolve = resolve)),
      onSnapshot: (state) => states.push(state),
      now: h.now,
      setTimeoutFn: h.setTimeoutFn,
      clearTimeoutFn: h.clearTimeoutFn,
    });
    monitor.start();
    const before = states.length;
    monitor.stop();
    expect(monitor.isProbing()).toBe(false);
    probeControl.resolve?.(true);
    await Promise.resolve();
    await Promise.resolve();
    // No snapshot after stop: an unmounted app must not be told about a probe it cancelled.
    expect(states.length).toBe(before);
    expect(h.pending()).toBe(0);
  });

  it("keeps probing on a healthy schedule so a later outage is noticed without a failed request", async () => {
    const h = harness();
    let healthy = true;
    const monitor = createConnectivityMonitor({
      probe: async () => healthy,
      onSnapshot: () => {},
      now: h.now,
      setTimeoutFn: h.setTimeoutFn,
      clearTimeoutFn: h.clearTimeoutFn,
      healthyProbeIntervalMs: 1000,
      maxAutoAttempts: 5,
      // A long backoff so exactly one automatic attempt falls inside each advance window below;
      // the point is which failures are visible to the user when, not how fast retries run.
      backoffMs: () => 5000,
    });
    monitor.start();
    await h.advance(0);
    expect(monitor.snapshot().posture).toBe("online");
    healthy = false;
    // Healthy probe at +1000 sees the outage (1 failure: still online, no banner yet)…
    await h.advance(1100);
    expect(monitor.snapshot().posture).toBe("reconnecting");
    expect(monitor.snapshot().banner).toBe("none");
    // …and the next one crosses the threshold.
    await h.advance(5100);
    expect(monitor.snapshot().posture).toBe("server-unreachable");
    monitor.stop();
  });
});
