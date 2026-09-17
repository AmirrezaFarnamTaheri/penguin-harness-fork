import { useState } from "react";
import type {
  HudSpeedMetrics,
  HudVcsMetrics,
  HudActiveTask,
} from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { CacheWarmBadge } from "../cockpit/cache-warm-badge";
import type { CacheUsage } from "../cockpit/cache-warm-badge";

export interface HudStatuslineProps {
  /** Latest main request context occupancy, never cumulative session usage. */
  tokensUsed?: number;
  /** Successful compaction invalidates occupancy until the next main request reports. */
  contextStale?: boolean;
  contextWindow?: number;
  speed?: HudSpeedMetrics;
  /** Current task's measured cached/uncached input buckets, updated by token_usage. */
  promptCache?: CacheUsage;
  vcs?: HudVcsMetrics;
  costUsd?: number;
  costSavingsUsd?: number;
  activeTasks?: HudActiveTask[];
  onOpenGateway?: () => void;
  onOpenCockpit?: () => void;
  onOpenKanban?: () => void;
  onOpenContext?: () => void;
}
export function HudStatusline({
  tokensUsed,
  contextStale = false,
  contextWindow,
  speed,
  promptCache,
  vcs,
  costUsd,
  costSavingsUsd,
  activeTasks = [],
  onOpenGateway,
  onOpenCockpit,
  onOpenKanban,
  onOpenContext,
}: HudStatuslineProps) {
  const [expanded, setExpanded] = useState(false);
  const validContext =
    !contextStale &&
    tokensUsed !== undefined &&
    Number.isFinite(tokensUsed) &&
    tokensUsed >= 0 &&
    contextWindow !== undefined &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0;
  const percentage = validContext ? Math.round((tokensUsed / contextWindow) * 100) : null;
  const context = percentage === null ? "Context unavailable" : `Context ${percentage}%`;
  const cost =
    costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0
      ? `Cost $${costUsd.toFixed(4)}`
      : "Cost unavailable";
  return (
    <section
      aria-label="Session status"
      className="border-t border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {onOpenContext ? (
            <Button className="min-h-10" variant="ghost" onClick={onOpenContext}>
              {context}
            </Button>
          ) : (
            <span>{context}</span>
          )}
          {onOpenGateway ? (
            <Button className="min-h-10" variant="ghost" onClick={onOpenGateway}>
              {cost}
            </Button>
          ) : (
            <span>{cost}</span>
          )}
          <CacheWarmBadge usage={promptCache} />
          {speed?.isStreaming &&
            Number.isFinite(speed.tokensPerSecond) &&
            speed.tokensPerSecond > 0 && (
              <span className="text-xs tabular-nums">
                {speed.tokensPerSecond.toFixed(1)} tokens/s
              </span>
            )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onOpenCockpit && (
            <Button className="min-h-10" variant="ghost" onClick={onOpenCockpit}>
              Agent workspace
            </Button>
          )}
          {onOpenKanban && (
            <Button className="min-h-10" variant="ghost" onClick={onOpenKanban}>
              Task board
            </Button>
          )}
          <Button
            className="min-h-10"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide details" : "Session details"}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-800">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-gray-500">Context tokens</dt>
              <dd className="tabular-nums">
                {validContext
                  ? `${tokensUsed.toLocaleString()} / ${contextWindow.toLocaleString()}`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Prompt cache</dt>
              <dd>
                Current task input reuse is shown above. Provider cache lifetime is not reported.
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Cache savings</dt>
              <dd>
                {costSavingsUsd !== undefined && Number.isFinite(costSavingsUsd)
                  ? `$${costSavingsUsd.toFixed(4)}`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Repository</dt>
              <dd className="break-all">
                {vcs
                  ? `${vcs.branch ?? "Branch not reported"} · ${vcs.isClean ? "Clean" : `${vcs.dirtyFilesCount} changed files`}`
                  : "Not reported"}
              </dd>
            </div>
          </dl>
          {activeTasks.length > 0 && (
            <div>
              <h3 className="font-medium">Active tools ({activeTasks.length})</h3>
              <ul className="mt-1 max-h-40 overflow-y-auto">
                {activeTasks.map((task) => (
                  <li key={task.id} className="flex flex-wrap justify-between gap-2 py-1">
                    <span className="break-all">{task.toolName}</span>
                    <span className="tabular-nums">{Math.round(task.durationMs / 1000)}s</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
