import { useEffect, useRef, useState, useCallback } from "react";
import type { SpendFlowReport } from "@prismshadow/penguin-core/browser";
import * as api from "../../api/endpoints";
import { SpendFlowCard } from "./spend-flow-card";
import { Button } from "../../components/ui/button";
import { WorkError, mutedClass } from "../kanban/work-tool-ui";
export interface SpendFlowPanelProps {
  projectId: string;
}
export function SpendFlowPanel({ projectId }: SpendFlowPanelProps) {
  return <SpendFlowWorkspace key={projectId} projectId={projectId} />;
}
function SpendFlowWorkspace({ projectId }: SpendFlowPanelProps) {
  const [report, setReport] = useState<SpendFlowReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    if (!projectId) {
      setReport(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await api.computeGatewaySpendFlow(projectId, { limit: 50 });
      if (ticket === generation.current) setReport(response?.report ?? null);
    } catch (err) {
      if (ticket === generation.current)
        setError(err instanceof Error ? err.message : "Could not load costs. Try refreshing.");
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return (
    <section className="h-full overflow-y-auto p-4 space-y-4 text-sm" aria-label="Project costs">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Project costs</h2>
          <p className={mutedClass}>Cost attribution for up to 50 recent sessions.</p>
        </div>
        <Button className="min-h-10" disabled={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </header>
      <WorkError error={error} />
      {loading && (
        <p role="status" className={mutedClass}>
          Loading costs…
        </p>
      )}
      {report ? (
        <SpendFlowCard report={report} />
      ) : (
        !loading &&
        !error && (
          <p className={mutedClass}>
            {projectId
              ? "No recorded costs for this project yet."
              : "Select a project to view costs."}
          </p>
        )
      )}
    </section>
  );
}
