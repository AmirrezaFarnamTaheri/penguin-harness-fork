/**
 * Task Watchdog & Stall Monitor Indicator.
 *
 * Displays live heartbeat pulses, step counts against runaway caps, elapsed duration
 * against stage budgets, and provides emergency abort and intervention controls.
 *
 * Synthesized from aif-handoff taskWatchdog, CCB watchdog, and cockpit-tools presentation.
 */
import { Badge, type BadgeTone } from "../../components/ui/badge";

export interface TaskWatchdogIndicatorProps {
  currentStep: number;
  maxSteps: number;
  elapsedMs: number;
  totalTimeoutMs: number;
  state: "healthy" | "warning" | "stalled" | "timed_out" | "max_steps_exceeded" | "aborted";
  lastAction?: string;
  onAbort?: () => void;
  onIntervene?: () => void;
}

export function TaskWatchdogIndicator({
  currentStep,
  maxSteps,
  elapsedMs,
  totalTimeoutMs,
  state,
  lastAction,
  onAbort,
  onIntervene,
}: TaskWatchdogIndicatorProps) {
  const stepPercent = Math.min(100, Math.round((currentStep / maxSteps) * 100));
  const timePercent = Math.min(100, Math.round((elapsedMs / totalTimeoutMs) * 100));

  const formatDuration = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const getTone = (): BadgeTone => {
    switch (state) {
      case "healthy":
        return "green";
      case "warning":
        return "yellow";
      case "stalled":
      case "timed_out":
      case "max_steps_exceeded":
      case "aborted":
        return "red";
      default:
        return "gray";
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-xs dark:border-gray-800 dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              state === "healthy"
                ? "animate-pulse bg-emerald-500"
                : state === "warning"
                  ? "bg-amber-500"
                  : "bg-red-500"
            }`}
          />
          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
            Task Watchdog
          </span>
          <Badge tone={getTone()}>{state.replace(/_/g, " ")}</Badge>
        </div>

        <div className="flex items-center gap-1.5">
          {onIntervene && state !== "aborted" && (
            <button
              type="button"
              onClick={onIntervene}
              className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Steer
            </button>
          )}
          {onAbort && state !== "aborted" && (
            <button
              type="button"
              onClick={onAbort}
              className="rounded bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-900/60"
            >
              Abort
            </button>
          )}
        </div>
      </div>

      {/* Progress Bars */}
      <div className="grid grid-cols-2 gap-3 text-[11px]">
        {/* Steps */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-gray-500 dark:text-gray-400">
            <span>Steps</span>
            <span>
              {currentStep} / {maxSteps}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div
              className={`h-full transition-all duration-300 ${
                stepPercent > 80 ? "bg-red-500" : "bg-blue-500"
              }`}
              style={{ width: `${stepPercent}%` }}
            />
          </div>
        </div>

        {/* Time */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-gray-500 dark:text-gray-400">
            <span>Time</span>
            <span>
              {formatDuration(elapsedMs)} / {formatDuration(totalTimeoutMs)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div
              className={`h-full transition-all duration-300 ${
                timePercent > 80 ? "bg-red-500" : "bg-emerald-500"
              }`}
              style={{ width: `${timePercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Last Action Footer */}
      {lastAction && (
        <div className="truncate border-t border-gray-100 pt-1.5 text-[10px] text-gray-400 dark:border-gray-800/60 dark:text-gray-500">
          Last action:{" "}
          <span className="font-mono text-gray-600 dark:text-gray-300">{lastAction}</span>
        </div>
      )}
    </div>
  );
}
