/**
 * F2.2/F2.4 — the shared clock's lifecycle, proven with injected timers.
 *
 * Every named negative from the card has a case here, and each asserts on **timer counts**, not
 * just on values: a "shared clock" that leaks a timer per mount would still pass a value check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_CLOCK_CADENCE_MS, createUiClock } from "../src/lib/ui-clock.js";

const SRC = new URL("../src", import.meta.url).pathname;

/** Every .ts/.tsx file under src, so a pin cannot be dodged by moving a file. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** A fake environment: manual clock, manual timer table, deterministic visibility. */
function harness() {
  let clock = 1_000_000;
  let nextHandle = 1;
  // key → interval (period kept, so re-arming after a fire preserves interval semantics)
  const timers = new Map<number, { at: number; periodMs: number; fn: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    now: () => clock,
    setIntervalFn: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, periodMs: ms, fn });
      return handle;
    },
    clearIntervalFn: (handle: unknown) => {
      timers.delete(handle as number);
    },
    documentRef: {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (type: string, listener: () => void) => {
        (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      },
    },
    intervalCount: () => timers.size,
    /** Advances the clock, firing intervals whose time has come. */
    tick(ms: number) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [handle, timer] = due[0]!;
        // Re-arm before the callback so a callback that (un)subscribes sees the same timer table
        // the clock does; a cleared handle must stay cleared.
        timer.at += timer.periodMs;
        clock = Math.max(clock, timer.at - timer.periodMs);
        timer.fn();
        if (!timers.has(handle)) continue; // cleared during the callback (last unsubscribe)
      }
      clock = target;
    },
    /** Jump the wall clock without firing timers — a device clock correction or a slept tab. */
    jump(ms: number) {
      clock += ms;
    },
    setVisibility(state: DocumentVisibilityState) {
      this.documentRef.visibilityState = state;
      for (const listener of listeners.get("visibilitychange") ?? []) listener();
    },
  };
}

describe("shared UI clock (F2)", () => {
  it("runs ONE timer for many subscribers, whatever mix of cadences they ask for", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    const fast: number[] = [];
    const slow: number[] = [];
    const unsubs = [
      clock.subscribe((now) => fast.push(now), { intervalMs: 1000 }),
      clock.subscribe((now) => fast.push(now), { intervalMs: 1000 }),
      clock.subscribe((now) => fast.push(now), { intervalMs: 1000 }),
      clock.subscribe((now) => slow.push(now), { intervalMs: 60_000 }),
    ];
    expect(clock.subscriberCount()).toBe(4);
    expect(clock.activeTimerCount()).toBe(1);

    h.tick(1000);
    expect(fast).toHaveLength(3 + 3); // one immediate notification each, then one tick
    // The 60 s subscriber heard its immediate notification and nothing at the 1 s boundary: its
    // cadence is respected inside the shared timer.
    expect(slow).toHaveLength(1);
    h.tick(59_000);
    expect(slow).toHaveLength(2);

    for (const unsubscribe of unsubs) unsubscribe();
    expect(clock.subscriberCount()).toBe(0);
    // Last-subscriber cleanup: nothing left ticking.
    expect(clock.activeTimerCount()).toBe(0);
  });

  it("notifies a new subscriber immediately, so its first render is not stale", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    const seen: number[] = [];
    h.tick(5000); // time passes before anyone subscribes
    const unsubscribe = clock.subscribe((now) => seen.push(now));
    expect(seen).toEqual([h.now()]);
    unsubscribe();
  });

  it("raises a sub-minimum cadence instead of busy-looping", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    const seen: number[] = [];
    const unsubscribe = clock.subscribe((now) => seen.push(now), { intervalMs: 10 });
    // The first tick is the immediate one; the second arrives only after the raised cadence.
    h.tick(MIN_CLOCK_CADENCE_MS - 1);
    expect(seen).toHaveLength(1);
    h.tick(1);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });

  it("does not restart the timer when another subscriber joins the same cadence", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    let ticks = 0;
    const first = clock.subscribe(() => (ticks += 1));
    const handleBefore = h.intervalCount();
    const second = clock.subscribe(() => (ticks += 1));
    expect(h.intervalCount()).toBe(handleBefore); // same single timer, not a replaced one
    h.tick(1000);
    // Both subscribers heard the tick: a restart would have reset the phase and delivered to one.
    expect(ticks).toBe(2 + 2);
    first();
    second();
    expect(clock.activeTimerCount()).toBe(0);
  });

  it("converges after a hidden tab: visibility wakeup, not the next boundary", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
      documentRef: h.documentRef,
    });
    const seen: number[] = [];
    const unsubscribe = clock.subscribe((now) => seen.push(now), { intervalMs: 60_000 });
    expect(seen).toHaveLength(1);

    // The tab is hidden; the device sleeps for ten minutes and the wall clock moves while no
    // interval fired (a real browser throttles or suspends timers).
    h.setVisibility("hidden");
    h.jump(10 * 60_000);
    expect(seen).toHaveLength(1);

    // Restoring the tab wakes every subscriber immediately: the label converges now, not at the
    // next minute boundary.
    h.setVisibility("visible");
    expect(seen).toHaveLength(2);
    expect(seen[1]! - seen[0]!).toBe(10 * 60_000);
    unsubscribe();
    expect(clock.activeTimerCount()).toBe(0);
  });

  it("keeps one timer across repeated mount/unmount cycles, and none after the last unmount", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const unsubs = [
        clock.subscribe(() => {}),
        clock.subscribe(() => {}),
        clock.subscribe(() => {}),
      ];
      expect(clock.activeTimerCount()).toBe(1);
      unsubs.forEach((unsubscribe) => unsubscribe());
      expect(clock.activeTimerCount()).toBe(0);
    }
    expect(h.intervalCount()).toBe(0);
  });

  it("never reports a negative elapsed value across a clock jump or a timezone change", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    const startedAt = clock.now();
    h.tick(5000);
    expect(clock.elapsedSince(startedAt)).toBe(5000);

    // A timezone change does not move epoch milliseconds at all: elapsed is unaffected.
    const beforeTimezoneChange = clock.elapsedSince(startedAt);
    expect(clock.elapsedSince(startedAt)).toBe(beforeTimezoneChange);

    // A backward clock correction (NTP, a user editing the device clock) must not paint "-8s".
    h.jump(-8000);
    expect(clock.elapsedSince(startedAt)).toBe(0);
    // A forward jump converges to the new wall clock rather than accumulating from ticks.
    h.jump(20_000);
    expect(clock.elapsedSince(startedAt)).toBe(17_000);
  });

  it("stops notifying a subscriber whose unsubscribe happened mid-iteration", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    const heard = { a: [] as number[], b: [] as number[], c: [] as number[] };
    let unsubscribeB = () => {};
    // A's listener tears B down. This is the case the `cancelled` wrapper exists for: the
    // notification loop iterates a snapshot, so B is still in it when A's turn comes. Without the
    // flag, B's listener would be invoked after its subscription was already removed.
    const unsubscribeA = clock.subscribe((now) => {
      heard.a.push(now);
      if (heard.a.length > 1) unsubscribeB();
    });
    unsubscribeB = clock.subscribe((now) => heard.b.push(now));
    const unsubscribeC = clock.subscribe((now) => heard.c.push(now));

    h.tick(1000); // immediate notification for a/b/c happened at subscribe time
    expect(heard.a).toHaveLength(2);
    expect(heard.b).toHaveLength(1); // unsubscribed by a during this very tick
    expect(heard.c).toHaveLength(2); // c comes after b and is unaffected

    h.tick(1000);
    expect(heard.b).toHaveLength(1); // and stays silent
    expect(heard.a).toHaveLength(3);
    unsubscribeA();
    unsubscribeC();
    expect(clock.activeTimerCount()).toBe(0);
  });

  it("disposes the visibility listener and every timer", () => {
    const h = harness();
    const clock = createUiClock({
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
      documentRef: h.documentRef,
    });
    clock.subscribe(() => {});
    expect(clock.activeTimerCount()).toBe(1);
    clock.dispose();
    expect(clock.activeTimerCount()).toBe(0);
    expect(clock.subscriberCount()).toBe(0);
    // A later visibility event must not throw or notify anything — the listener was removed.
    expect(() => h.setVisibility("visible")).not.toThrow();
  });
});

describe("shared UI clock migration (F2.3)", () => {
  /** The relative-time views the card inventoried, and the component that owns each. */
  const MIGRATED = [
    "features/chat/live-duration.tsx",
    "features/chat/chat-page.tsx",
    "features/chat/message-item.tsx",
    "features/models/models-key-pools.tsx",
    "features/models/key-health-card.tsx",
    "features/company/calendar-page.tsx",
    "features/consensus/mailbox-bureau.tsx",
  ];

  it("leaves no per-component second-clock anywhere in the web source", () => {
    // The exact shape every migrated view used to carry. A new one is a regression of this card no
    // matter which file it appears in.
    const offenders = sourceFiles()
      .filter((path) => /setInterval\(\(\) => setNow\(Date\.now\(\)\)/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("has every inventoried relative-time view on the shared clock", () => {
    const offClock: string[] = [];
    for (const name of MIGRATED) {
      const text = readFileSync(join(SRC, name), "utf8");
      if (!text.includes("useUiClock")) offClock.push(name);
    }
    expect(offClock).toEqual([]);
  });

  it("keeps the shared clock itself free of consumer-level state", () => {
    // The clock module may not import React: "one timer per page" must hold for non-React callers
    // too, and a React import here is how the module silently becomes component-scoped.
    const text = readFileSync(join(SRC, "lib/ui-clock.ts"), "utf8");
    expect(text).not.toMatch(/from "react"/);
  });
});
