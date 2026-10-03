/**
 * Live duration (inline display on running thinking/tool cards): ticks every second, showing
 * whole seconds only — decimals appear only on the settled value once the item finishes. sinceMs
 * comes from the server-side message timestamp and may drift from the local clock; negative
 * values are shown as 0; a pulsing ellipsis is shown when missing.
 * `offsetMs` is the already-settled duration of a prior segment (e.g. a tool call's argument
 * generation phase), added on top of the live segment as it ticks.
 *
 * The tick comes from the shared UI clock (F2): every live duration on screen shares one timer, and
 * a tab restored from sleep repaints these labels on the visibility wakeup instead of waiting for
 * the next second.
 */
import { useUiClock } from "../../lib/use-ui-clock";
import { humanizeDurationLive } from "../../lib/format";

export function LiveDuration({ sinceMs, offsetMs = 0 }: { sinceMs?: number; offsetMs?: number }) {
  const now = useUiClock(1000);
  if (sinceMs === undefined) return <span className="animate-pulse">…</span>;
  return <>{humanizeDurationLive(Math.max(0, offsetMs) + Math.max(0, now - sinceMs))}</>;
}
