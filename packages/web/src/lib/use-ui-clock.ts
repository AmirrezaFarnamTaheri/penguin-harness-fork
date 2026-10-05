/**
 * React binding for the shared clock (F2.2/F2.3).
 *
 * `intervalMs` is the consumer's cadence — 1000 for a live duration, 60_000 for a minute-grained
 * label — and several components asking for different cadences still share one timer (see
 * `ui-clock.ts`). The returned value is wall-clock epoch ms; consumers compute durations from it so
 * that a clock jump, a timezone change or a tab that slept cannot produce a negative or drifting
 * elapsed value.
 *
 * `resetKey` re-anchors the value (see `UseUiClockOptions`), and
 * `enabled: false` unsubscribes entirely: a view that only ticks while something is running (the
 * header's elapsed chip) must not keep a timer alive when it is idle. Re-enabling subscribes again,
 * and the clock's immediate first notification is what re-anchors the value at that moment.
 */
import { useEffect, useState } from "react";
import { sharedUiClock } from "./ui-clock";

export interface UseUiClockOptions {
  enabled?: boolean;
  /**
   * Re-subscribes when this value changes, and a fresh subscription re-reads the clock
   * immediately. Pass the identity of the thing being timed (an attempt id, a request id) when the
   * label belongs to a new event: without it, the first paint after the change would render against
   * the previous event's last tick, which is the stale-anchor bug the migration removed.
   */
  resetKey?: unknown;
}

export function useUiClock(intervalMs = 1000, options: UseUiClockOptions = {}): number {
  const { enabled = true, resetKey } = options;
  const clock = sharedUiClock();
  const [nowMs, setNowMs] = useState(() => clock.now());
  useEffect(() => {
    if (!enabled) return;
    // Subscribing is safe to repeat (cadence change, remount, re-enable): the clock is shared, and
    // the returned unsubscribe is the last-subscriber cleanup when this was the only consumer.
    return clock.subscribe(setNowMs, { intervalMs });
  }, [clock, enabled, intervalMs, resetKey]);
  return nowMs;
}
