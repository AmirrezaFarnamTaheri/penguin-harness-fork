import { useId } from "react";
import { cockpitCopy } from "./cockpit-copy";
import {
  LOOP_EVENT_LIMIT,
  type CockpitTelemetryState,
  type LiveLoopEvent,
} from "./use-cockpit-telemetry";

export function LoopEventFeed({
  events,
  transport,
  locale,
}: {
  events: LiveLoopEvent[];
  transport: CockpitTelemetryState["transport"];
  locale: "en" | "zh";
}) {
  const id = useId();
  const c = cockpitCopy(locale);
  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-scope`}
      className="min-w-0 space-y-3"
    >
      <h3 id={`${id}-title`} className="text-base font-semibold">
        {c.loopEvents}
      </h3>
      <p id={`${id}-scope`} className="text-sm leading-6 text-gray-600 dark:text-gray-400">
        {c.loopScope.replace("{limit}", String(LOOP_EVENT_LIMIT))}
      </p>
      <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
        {transport === "ws"
          ? c.loopLive
          : transport === "connecting"
            ? c.loopConnecting
            : c.loopPaused}
      </p>
      <div
        role="log"
        aria-label={c.loopEvents}
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        {events.length === 0 ? (
          <p className="text-sm leading-6 text-gray-600 dark:text-gray-400">{c.noLoopEvents}</p>
        ) : (
          <ol className="divide-y divide-gray-200 dark:divide-gray-800">
            {events.map((event) => (
              <li key={event.id} className="space-y-2 py-4">
                <p className="whitespace-pre-wrap break-words text-sm font-medium leading-6 text-amber-800 dark:text-amber-300">
                  {event.message}
                </p>
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
                  <div className="min-w-0">
                    <dt className="inline">{c.loopAgent}: </dt>
                    <dd className="inline break-all">{event.agentId ?? c.unknown}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="inline">{c.loopTask}: </dt>
                    <dd className="inline break-all font-mono">{event.taskId}</dd>
                  </div>
                </dl>
                <time
                  dateTime={new Date(event.timestamp).toISOString()}
                  className="block text-sm text-gray-600 dark:text-gray-400"
                >
                  {new Date(event.timestamp).toLocaleString(locale)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
