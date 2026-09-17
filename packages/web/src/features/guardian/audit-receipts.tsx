import { useEffect, useState } from "react";
import type { AuditReceiptsResponse } from "@prismshadow/penguin-server/api";
import { apiFetch } from "../../api/client";
import { Button } from "../../components/ui/button";
import { S } from "../../lib/strings";
import { SignalChainGraph } from "../cockpit/signal-chain-graph";

export function AuditReceipts({ projectId }: { projectId: string }) {
  // Remount on project change so old project data never flashes in the new scope.
  return <ProjectAuditReceipts key={projectId} projectId={projectId} />;
}

function ProjectAuditReceipts({ projectId }: { projectId: string }) {
  const copy = S.guardian.audit;
  const [result, setResult] = useState<AuditReceiptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setError(null);
    void apiFetch<AuditReceiptsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/audit/receipts`,
    ).then(
      (response) => {
        if (!cancelled) {
          setResult(response);
          setLoading(false);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : S.guardian.audit.error);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, revision]);

  return (
    <div className="min-w-0 space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
      <SignalChainGraph
        chronology={{
          title: copy.title,
          empty: loading || error ? "" : copy.empty,
          eventHashLabel: copy.eventHash,
        }}
        chain={{
          chainId: projectId,
          nodes: (result?.receipts ?? []).map((receipt, index) => ({
            id: `${receipt.payloadHash}-${index}`,
            type: receipt.type,
            label: `${copy[receipt.type]} · ${receipt.agentId} / ${receipt.sessionId}`,
            timestamp: receipt.timestamp,
            eventHash: receipt.eventHash,
          })),
        }}
      />
      <p className="text-gray-600 dark:text-gray-400">{copy.description}</p>
      <p className="text-xs text-gray-600 dark:text-gray-400">{copy.scope}</p>
      {loading && <p role="status">{copy.loading}</p>}
      {error && (
        <p role="alert">
          {copy.error} {error}
        </p>
      )}
      {result?.truncated && <p role="status">{copy.truncated}</p>}
      <Button disabled={loading} onClick={() => setRevision((value) => value + 1)}>
        {copy.refresh}
      </Button>
    </div>
  );
}
