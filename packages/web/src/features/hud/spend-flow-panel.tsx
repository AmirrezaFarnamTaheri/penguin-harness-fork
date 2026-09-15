/**
 * Spend Flow & Cost Attribution Dock Panel.
 *
 * Fetches and displays multi-project and multi-model LLM gateway cost attribution.
 */
import { useEffect, useState, useCallback } from "react";
import type { SpendFlowReport } from "@prismshadow/penguin-core/browser";
import * as api from "../../api/endpoints";
import { SpendFlowCard } from "./spend-flow-card";
import { Button } from "../../components/ui/button";
import { SkeletonList } from "../../components/ui/skeleton";

export interface SpendFlowPanelProps {
  projectId: string;
}

export function SpendFlowPanel({ projectId }: SpendFlowPanelProps) {
  const [report, setReport] = useState<SpendFlowReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.computeGatewaySpendFlow(projectId, { limit: 50 });
      if (res && res.report) {
        setReport(res.report);
      } else {
        setReport(null);
      }
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "Failed to load spend telemetry");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  if (loading && !report) {
    return (
      <div className="p-4 space-y-3">
        <div className="flex justify-between items-center pb-2">
          <div className="h-4 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
        </div>
        <SkeletonList rows={3} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      <div className="flex justify-between items-center px-1">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Gateway Telemetry
        </span>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void loadReport()}>
          <span className={`mr-1 ${loading ? "animate-spin" : ""}`}>↺</span> Refresh
        </Button>
      </div>
      {error && (
        <div className="p-2 text-xs rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {report ? (
        <SpendFlowCard report={report} />
      ) : (
        !loading && (
          <div className="p-4 text-center text-xs text-gray-500 rounded border border-dashed border-gray-200 dark:border-gray-800">
            No spend telemetry available for this project yet.
          </div>
        )
      )}
    </div>
  );
}
