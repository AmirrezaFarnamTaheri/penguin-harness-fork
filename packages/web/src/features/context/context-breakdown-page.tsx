import { useEffect, useState, useCallback, useMemo } from "react";
import type { SessionContextResponse } from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import { ContextAllocationBar } from "./context-allocation-bar";
import { TopConsumersCard } from "./top-consumers-card";
import { CompactionAnchorsCard } from "./compaction-anchors-card";
import { Button } from "../../components/ui/button";
import { toastSuccess, toastError } from "../../components/ui/toast";

export interface ContextBreakdownPageProps {
  sessionId?: string;
  embedded?: boolean;
}

export function ContextBreakdownPage({
  sessionId: explicitSessionId,
  embedded = false,
}: ContextBreakdownPageProps) {
  const { currentProject } = useProject();
  const { sessions } = useSessions();

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    explicitSessionId && explicitSessionId !== "current-session" ? explicitSessionId : null,
  );
  const [data, setData] = useState<SessionContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);

  // Synchronize initial session selection from available project sessions
  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      const first = sessions[0];
      if (first) {
        setSelectedSessionId(first.sessionId);
      }
    }
  }, [sessions, selectedSessionId]);

  // If explicit sessionId prop changes and is valid, update selection
  useEffect(() => {
    if (explicitSessionId && explicitSessionId !== "current-session") {
      setSelectedSessionId(explicitSessionId);
    }
  }, [explicitSessionId]);

  const activeSessionId = selectedSessionId;

  const loadContext = useCallback(async () => {
    if (!activeSessionId) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSessionContext(activeSessionId);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session context telemetry");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const handleManualCompact = async () => {
    if (!activeSessionId) return;
    setCompacting(true);
    try {
      await api.postCompact(activeSessionId);
      toastSuccess("Context compaction requested. Scheduled pruning task on session.");
      await loadContext();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Failed to execute context compaction");
    } finally {
      setCompacting(false);
    }
  };

  const totalTokens = useMemo(() => {
    if (!data) return 0;
    return (
      data.systemPrompt +
      data.toolDefs +
      data.userMessages +
      data.assistantMessages +
      data.toolRequests +
      data.toolResults
    );
  }, [data]);

  return (
    <div
      className={`flex flex-col h-full gap-4 ${
        embedded ? "p-2" : "p-6"
      } bg-gray-950 text-gray-100 font-sans select-none overflow-y-auto`}
    >
      {/* Top Header & Telemetry Cards */}
      <div className="flex flex-col gap-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2 font-mono">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              Context Token Breakdown & Compaction Cockpit
            </h1>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              Deep token attribution across 6 partitions, tool traffic consumers, and compaction
              anchors for {currentProject?.name ?? "Penguin"}
            </p>
          </div>

          {/* Session Selector & Status */}
          <div className="flex items-center gap-3 font-mono text-xs">
            {sessions.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-400 text-[11px]">Session:</span>
                <select
                  value={activeSessionId ?? ""}
                  onChange={(e) => setSelectedSessionId(e.target.value)}
                  className="rounded-md border border-gray-800 bg-gray-900 px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                >
                  {sessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.title
                        ? `${s.title.slice(0, 28)} (${s.sessionId.slice(0, 6)})`
                        : s.sessionId}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <span className="px-2 py-1 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-semibold">
              WINDOW: 200,000 TOKENS
            </span>
          </div>
        </div>

        {/* Telemetry Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Active Occupancy</span>
            <span className="text-base font-bold text-gray-100 tabular-nums">
              {data ? `${totalTokens.toLocaleString()} tok` : "—"}
            </span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Window Capacity</span>
            <span className="text-base font-bold text-cyan-400 tabular-nums">
              {data ? `${Math.min(100, Math.round((totalTokens / 200000) * 100))}%` : "—"}
            </span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Compaction Threshold</span>
            <span className="text-base font-bold text-rose-400 tabular-nums">
              {data?.compactionThreshold
                ? `${(data.compactionThreshold / 1000).toFixed(0)}k tok`
                : "—"}
            </span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Status</span>
            <span className="text-base font-bold text-emerald-400 tabular-nums">
              {loading ? "Loading..." : data ? (data.contextClosed ? "Closed" : "Active") : "Idle"}
            </span>
          </div>
        </div>
      </div>

      {/* Main Breakdown Content */}
      {loading && !data ? (
        <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-gray-800 bg-gray-900/40 text-center font-mono text-xs">
          <span className="text-cyan-400 animate-pulse">
            Loading context breakdown telemetry...
          </span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-red-900/50 bg-red-950/20 text-center font-mono text-xs">
          <span className="text-red-400 font-semibold mb-2">{error}</span>
          <p className="text-gray-400 mb-4 max-w-md text-[11px]">
            Unable to retrieve context occupancy for session &apos;{activeSessionId}&apos;. The
            session may have expired, or no telemetry has been recorded yet.
          </p>
          <Button variant="secondary" size="sm" onClick={() => void loadContext()}>
            Retry Telemetry Fetch
          </Button>
        </div>
      ) : !activeSessionId ? (
        <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-dashed border-gray-800 bg-gray-900/40 text-center font-mono text-xs">
          <span className="text-gray-400 font-semibold mb-1">No active conversation session</span>
          <p className="text-gray-500 max-w-md text-[11px]">
            Please select an active session from the menu above or start a conversation in Chat to
            inspect token partition allocation and trigger compaction.
          </p>
        </div>
      ) : data ? (
        <div className="flex flex-col gap-4">
          <ContextAllocationBar data={data} contextWindow={200000} />
          <TopConsumersCard tools={data.topTools} files={data.topFiles} />
          <CompactionAnchorsCard
            onManualCompact={handleManualCompact}
            compacting={compacting || loading}
          />
        </div>
      ) : null}
    </div>
  );
}
