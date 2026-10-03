/**
 * Shared UI clock (F2) — one timer for every relative-time label in the app.
 *
 * The problem this replaces: each `LiveDuration` (and the header's elapsed chip, and the key
 * cooldown countdown) ran its own `setInterval(…, 1000)`. A transcript with twenty visible running
 * cards therefore had twenty timers, all waking on their own schedule; none of them noticed the
 * tab going to sleep, so a tab restored after ten minutes repainted its labels one second later
 * with whatever `Date.now()` said then — and nothing reconciled the labels that were still showing
 * stale text in the meantime.
 *
 * The semantics this module fixes:
 *
 *   - **Wall clock, not elapsed accumulation.** Subscribers receive `now()` (epoch milliseconds,
 *     `Date.now()` semantics). Durations are computed as `now - sinceMs` by the consumer, so a
 *     clock jump or a change of timezone cannot accumulate error: a timezone change does not move
 *     epoch milliseconds at all, and {@link elapsedSince} clamps a negative difference to zero
 *     instead of painting "-3s".
 *   - **One timer, several cadences.** The clock runs a single interval at the smallest cadence any
 *     live subscriber asked for; each subscriber is notified only when its own cadence has
 *     elapsed. A 60 s label and a 1 s label share one timer.
 *   - **Visibility wakeup.** On `visibilitychange` → visible, every subscriber is notified
 *     immediately, so labels converge the instant the tab is restored rather than at the next
 *     boundary. While hidden the timer keeps running (browsers throttle it themselves; second-
 *     guessing that is how a "shared clock" ends up silently stopped).
 *   - **Last-subscriber cleanup.** The timer is cleared when the last subscriber leaves; a
 *     subscribe/unsubscribe cycle repeated any number of times leaves zero timers behind.
 *
 * Everything the clock touches is injectable (clock source, timer functions, the document), which
 * is what makes the lifecycle claims in `test/ui-clock.test.ts` deterministic — the web package's
 * test environment has no DOM by policy.
 */

/** The smallest cadence a subscriber may ask for; a shorter request is raised to this. */
export const MIN_CLOCK_CADENCE_MS = 250;

export interface UiClockSubscriptionOptions {
  /** How often this subscriber wants to be notified. Default 1000 ms; raised to the minimum. */
  intervalMs?: number;
}

export interface UiClock {
  /** Current wall-clock time (injected in tests). */
  now(): number;
  /**
   * Registers a listener and returns its unsubscribe function. The listener is called once
   * immediately (so a first render is never stale) and then on its cadence.
   */
  subscribe(listener: (now: number) => void, options?: UiClockSubscriptionOptions): () => void;
  /** `now - sinceMs`, clamped at zero: a clock jump must not produce a negative duration. */
  elapsedSince(sinceMs: number): number;
  /** Live subscriber count. */
  subscriberCount(): number;
  /** Active timer count (0 or 1) — the leak assertion. */
  activeTimerCount(): number;
  /** Stops every timer and drops subscribers; for unmount of the app shell and tests. */
  dispose(): void;
}

/**
 * The slice of `Document` the clock needs. Narrower than `Pick<Document, …>` on purpose so a test
 * harness without a DOM can supply it (the web suite is node-environment by policy).
 */
export interface UiClockDocument {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface UiClockDeps {
  /** Clock source; defaults to `Date.now` (wall clock, epoch ms). */
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Document whose visibility change wakes the clock; absent = no visibility handling. */
  documentRef?: UiClockDocument | null;
}

interface Subscriber {
  listener: (now: number) => void;
  cadenceMs: number;
  /** Wall-clock time this subscriber was notified last; drives per-subscriber cadence gating. */
  lastNotifiedAtMs: number;
}

export function createUiClock(deps: UiClockDeps = {}): UiClock {
  const now = deps.now ?? (() => Date.now());
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((handle) => clearInterval(handle as never));
  const documentRef = deps.documentRef ?? null;

  const subscribers = new Map<symbol, Subscriber>();
  let timer: unknown = null;
  /** Cadence the running timer was started with; a new subscriber may need a faster one. */
  let timerCadenceMs = 0;

  const notify = (subscriber: Subscriber, atMs: number): void => {
    subscriber.lastNotifiedAtMs = atMs;
    subscriber.listener(atMs);
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
      timerCadenceMs = 0;
    }
  };

  const requiredCadence = (): number => {
    let cadence = Number.POSITIVE_INFINITY;
    for (const subscriber of subscribers.values())
      cadence = Math.min(cadence, subscriber.cadenceMs);
    return cadence;
  };

  const ensureTimer = (): void => {
    if (subscribers.size === 0) {
      stopTimer();
      return;
    }
    const cadence = requiredCadence();
    if (timer !== null && timerCadenceMs === cadence) return;
    // Restart only when the required cadence actually changed; a restart on every subscribe would
    // reset the interval phase and make N mounts produce N out-of-phase ticks.
    stopTimer();
    timerCadenceMs = cadence;
    timer = setIntervalFn(() => {
      const atMs = now();
      for (const subscriber of [...subscribers.values()]) {
        if (atMs - subscriber.lastNotifiedAtMs >= subscriber.cadenceMs) notify(subscriber, atMs);
      }
    }, cadence);
  };

  /** Ticks every subscriber whose cadence has elapsed — the wakeup path, without waiting. */
  const wake = (): void => {
    const atMs = now();
    for (const subscriber of [...subscribers.values()]) {
      if (atMs - subscriber.lastNotifiedAtMs >= subscriber.cadenceMs) notify(subscriber, atMs);
    }
  };

  const onVisibilityChange = (): void => {
    if (documentRef?.visibilityState === "visible") wake();
  };

  if (documentRef) documentRef.addEventListener("visibilitychange", onVisibilityChange);

  return {
    now,
    subscribe(listener, options) {
      const cadenceMs = Math.max(MIN_CLOCK_CADENCE_MS, options?.intervalMs ?? 1000);
      const key = Symbol("ui-clock-subscriber");
      // `cancelled` is checked inside the wrapper: a listener may unsubscribe itself while being
      // notified (a component unmounting during render is exactly that case), and a notification
      // delivered after that would be work done for a subscriber that no longer exists.
      let cancelled = false;
      const subscriber: Subscriber = {
        listener: (value) => {
          if (!cancelled) listener(value);
        },
        cadenceMs,
        lastNotifiedAtMs: Number.NEGATIVE_INFINITY,
      };
      subscribers.set(key, subscriber);
      ensureTimer();
      // Deliver immediately: a subscriber that just mounted must render the current time, not the
      // one from the last tick (this is the case the old chat-page code hand-patched with setNow).
      notify(subscriber, now());
      return () => {
        cancelled = true;
        subscribers.delete(key);
        ensureTimer();
      };
    },
    elapsedSince(sinceMs) {
      return Math.max(0, now() - sinceMs);
    },
    subscriberCount: () => subscribers.size,
    activeTimerCount: () => (timer === null ? 0 : 1),
    dispose() {
      stopTimer();
      subscribers.clear();
      if (documentRef) documentRef.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

/**
 * The app-wide clock. Module-level on purpose: "one timer" is a property of the page, not of a
 * component tree, and two providers mounting (a modal, a second root) must not double the timers.
 */
let sharedClock: UiClock | null = null;

export function sharedUiClock(): UiClock {
  sharedClock ??= createUiClock({
    documentRef: typeof document === "undefined" ? null : (document as unknown as UiClockDocument),
  });
  return sharedClock;
}

/** Test seam: replaces the app clock; pass null to fall back to a fresh default instance. */
export function setSharedUiClockForTesting(clock: UiClock | null): void {
  sharedClock?.dispose();
  sharedClock = clock;
}
