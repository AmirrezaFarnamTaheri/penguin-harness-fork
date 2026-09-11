import { useMemo } from "react";
import type { SpendFlowReport } from "@prismshadow/penguin-core";
import { Badge } from "../../components/ui/badge";

export interface SpendFlowCardProps {
  report: SpendFlowReport;
  className?: string;
}

export function SpendFlowCard({ report, className = "" }: SpendFlowCardProps) {
  const maxModelCost = useMemo(() => {
    return Math.max(1, ...report.models.map((m) => m.cost));
  }, [report.models]);

  const maxProjectCost = useMemo(() => {
    return Math.max(1, ...report.projects.map((p) => p.cost));
  }, [report.projects]);

  return (
    <div className={`p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-xs space-y-4 text-xs ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
              Spend Flow & Cost Attribution
            </h3>
            <Badge tone="brand">
              ${report.totalCostUsd.toFixed(2)} USD
            </Badge>
          </div>
          <p className="text-gray-500 dark:text-gray-400 text-[11px] mt-0.5">
            Active Period: {report.period.label}
          </p>
        </div>
      </div>

      {/* Grid: Models & Projects */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Models Column */}
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
            Top Models
          </div>
          <div className="space-y-2">
            {report.models.map((node) => {
              const pct = Math.round((node.cost / (report.totalCostUsd || 1)) * 100);
              const barWidth = Math.min(100, Math.round((node.cost / maxModelCost) * 100));
              return (
                <div key={node.id} className="space-y-1">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="font-mono text-gray-700 dark:text-gray-300 truncate max-w-[140px]" title={node.label}>
                      {node.label}
                    </span>
                    <span className="text-gray-500 font-mono">
                      ${node.cost.toFixed(4)} ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-full rounded-full transition-all duration-300"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Projects Column */}
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
            Top Workspaces / Projects
          </div>
          <div className="space-y-2">
            {report.projects.map((node) => {
              const pct = Math.round((node.cost / (report.totalCostUsd || 1)) * 100);
              const barWidth = Math.min(100, Math.round((node.cost / maxProjectCost) * 100));
              return (
                <div key={node.id} className="space-y-1">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="font-mono text-gray-700 dark:text-gray-300 truncate max-w-[140px]" title={node.label}>
                      {node.label}
                    </span>
                    <span className="text-gray-500 font-mono">
                      ${node.cost.toFixed(4)} ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Attribution Links */}
      {report.links.length > 0 && (
        <div className="pt-2 border-t border-gray-100 dark:border-gray-800 space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
            Attribution Matrix ({report.links.length} routes)
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1 font-mono text-[11px]">
            {report.links.map((link, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between py-1 px-2 rounded-sm bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-indigo-600 dark:text-indigo-400">{link.model}</span>
                  <span className="text-gray-400">→</span>
                  <span className="text-emerald-600 dark:text-emerald-400">{link.project}</span>
                </div>
                <span className="font-semibold text-gray-700 dark:text-gray-300 shrink-0">
                  ${link.cost.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
