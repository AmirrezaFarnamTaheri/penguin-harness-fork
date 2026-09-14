import { useState } from "react";
import type {
  HudSpeedMetrics,
  HudPromptCacheMetrics,
  HudVcsMetrics,
  HudActiveTask,
} from "@prismshadow/penguin-core";

export interface HudStatuslineProps {
  tokensUsed?: number;
  contextWindow?: number;
  speed?: HudSpeedMetrics;
  promptCache?: HudPromptCacheMetrics;
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
  tokensUsed = 0,
  contextWindow = 200000,
  speed,
  promptCache,
  vcs,
  costUsd = 0,
  costSavingsUsd = 0,
  activeTasks = [],
  onOpenGateway,
  onOpenCockpit,
  onOpenKanban,
  onOpenContext,
}: HudStatuslineProps) {
  const [expanded, setExpanded] = useState(false);

  const capacityPct =
    contextWindow > 0 ? Math.min(100, Math.round((tokensUsed / contextWindow) * 100)) : 0;

  const isCacheActive = promptCache && promptCache.state === "active";
  const isCacheWarning = promptCache && promptCache.state === "warning";

  return (
    <div className="w-full border-t border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm px-3 py-1 text-[11px] text-gray-600 dark:text-gray-400 flex items-center justify-between gap-3 select-none">
      {/* Left side: Context meter & Speed */}
      <div className="flex items-center gap-2.5 overflow-hidden">
        {/* Context Capacity Meter */}
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
          onClick={() => {
            if (onOpenContext) {
              onOpenContext();
            } else {
              setExpanded(!expanded);
            }
          }}
          title={`Context Window: ${(tokensUsed / 1000).toFixed(1)}k / ${(contextWindow / 1000).toFixed(0)}k tokens (${capacityPct}%) - Click to open Context Breakdown`}
        >
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {(tokensUsed / 1000).toFixed(1)}k
          </span>
          <span className="text-gray-400">/</span>
          <span className="text-gray-400">{(contextWindow / 1000).toFixed(0)}k</span>
          <div className="w-12 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden ml-0.5">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                capacityPct > 85 ? "bg-rose-500" : capacityPct > 65 ? "bg-amber-400" : "bg-cyan-500"
              }`}
              style={{ width: `${Math.max(4, capacityPct)}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-400 font-mono">({capacityPct}%)</span>
        </div>

        {/* Live Generation Speed */}
        {speed && speed.tokensPerSecond > 0 && (
          <div className="flex items-center gap-1 text-cyan-600 dark:text-cyan-400 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
            <span>{speed.tokensPerSecond} tok/s</span>
          </div>
        )}

        {/* Prompt Cache TTL Indicator */}
        {promptCache && promptCache.state !== "none" && (
          <div
            className={`flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-mono ${
              isCacheActive
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                : isCacheWarning
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-400 border border-gray-200 dark:border-gray-700"
            }`}
            title={`Prompt Cache: ${promptCache.remainingSeconds}s TTL remaining`}
          >
            <span>Cache</span>
            {promptCache.remainingSeconds > 0 && <span>{promptCache.remainingSeconds}s</span>}
          </div>
        )}
      </div>

      {/* Right side: Tasks, VCS, Cost, Gateway button */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Active background tasks */}
        {activeTasks.length > 0 && (
          <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-mono text-[10px]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
            <span>
              [{activeTasks[0]!.toolName} ({Math.round(activeTasks[0]!.durationMs / 1000)}s)]
            </span>
          </div>
        )}

        {/* VCS Status */}
        {vcs && (
          <div className="flex items-center gap-1 text-gray-500 dark:text-gray-400 font-mono text-[10px]">
            <span className="opacity-70">git:</span>
            <span className="text-gray-700 dark:text-gray-300 font-semibold">
              {vcs.branch ?? "main"}
            </span>
            {!vcs.isClean && (
              <span className="text-amber-500 font-bold">
                {vcs.dirtyFilesCount > 0 ? `*${vcs.dirtyFilesCount}` : ""}
              </span>
            )}
          </div>
        )}

        {/* Agent Cockpit Button */}
        {onOpenCockpit && (
          <button
            type="button"
            onClick={onOpenCockpit}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors"
            title="Open Agent War Room & Autonomous Cockpit"
          >
            <span>Cockpit</span>
          </button>
        )}

        {/* Kanban Pipeline Button */}
        {onOpenKanban && (
          <button
            type="button"
            onClick={onOpenKanban}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors"
            title="Open Multi-Agent Kanban & Pipeline"
          >
            <span>Kanban</span>
          </button>
        )}

        {/* Cost & Savings */}
        <div
          className="cursor-pointer hover:text-cyan-600 dark:hover:text-cyan-400 font-mono text-[10px] transition-colors"
          onClick={onOpenGateway}
          title={`Session Cost: $${costUsd.toFixed(4)} (Saved $${costSavingsUsd.toFixed(4)} via prompt caching)`}
        >
          <span>${costUsd > 0 ? costUsd.toFixed(4) : "0.00"}</span>
          {costSavingsUsd > 0 && (
            <span className="text-emerald-500 dark:text-emerald-400 ml-1 font-semibold">
              (-${costSavingsUsd.toFixed(3)})
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
