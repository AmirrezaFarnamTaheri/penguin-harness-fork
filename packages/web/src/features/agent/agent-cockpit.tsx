import { useState } from "react";
import { Modal } from "../../components/ui/modal.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { BrainIcon, KeyRoundIcon, FlameIcon, HistoryIcon } from "../../components/ui/icons.js";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { useProject } from "../../state/project";
import { TopologyPage } from "../topology/topology-page";
import { GuardianPage } from "../guardian/guardian-page";
import { ConsensusPage } from "../consensus/consensus-page";
import { ContextBreakdownPage } from "../context/context-breakdown-page";
import { MemoryPage } from "../memory/memory-page";
import { ModelsKeyFleetPage } from "../models/models-key-fleet-page";
import { TraceFlamegraphPage } from "../traces/trace-flamegraph-page";
import { SnapshotsPage } from "../snapshots/snapshots-page";
import {
  useCockpitTelemetry,
  type LiveTurnSummary,
  type LiveMailboxEntry,
} from "./use-cockpit-telemetry.js";

export interface AgentCockpitProps {
  open?: boolean;
  onClose?: () => void;
  sessionId?: string;
  embedded?: boolean;
}

export interface SwarmAgentNode {
  id: string;
  role: "orchestrator" | "coder" | "reviewer" | "researcher" | "tester";
  status: "idle" | "active" | "waiting_approval" | "handoff";
  tasksCompleted: number;
  currentTask?: string;
  handoffTarget?: string;
}

export interface SwarmEdge {
  from: string;
  to: string;
  kind: "directive" | "handoff" | "review_gate";
  activeCount: number;
}

export function AgentCockpit({
  open,
  onClose,
  sessionId = "default-session",
  embedded = false,
}: AgentCockpitProps) {
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? "default";

  const [tab, setTab] = useState<
    | "topology"
    | "guardian"
    | "consensus"
    | "context"
    | "memory"
    | "keys"
    | "flamegraph"
    | "snapshots"
    | "ledger"
    | "mailbox"
    | "loop"
    | "swarm"
  >("topology");

  const telemetry = useCockpitTelemetry(projectId, sessionId);
  const [swarmPrompt, setSwarmPrompt] = useState("");

  // Live Turn Ledger summaries
  const activeTurn = telemetry.activeTaskId ?? "Idle";
  const turnSummaries = telemetry.turnSummaries;

  // Live Mailbox entries: fallback to idle agent entries if none received yet
  const mailboxes: LiveMailboxEntry[] =
    telemetry.mailboxEntries.length > 0
      ? telemetry.mailboxEntries
      : telemetry.swarmAgents.map((a) => ({
          agentName: a.id,
          queueDepth: 0,
          pendingReplies: 0,
          leaseState: "idle" as const,
        }));

  const [toAgent, setToAgent] = useState("coder");
  const [messageText, setMessageText] = useState("");
  const [dispatchedCount, setDispatchedCount] = useState(0);

  // State: Swarm & Handoff Topology (from live telemetry)
  const swarmNodes = telemetry.swarmAgents;
  const swarmEdges = telemetry.swarmEdges;

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    const ok = await telemetry.dispatchDirective(toAgent, messageText.trim());
    if (ok) {
      setDispatchedCount((c) => c + 1);
      setMessageText("");
    }
  };

  const bodyContent = (
    <div className="flex flex-col gap-4">
      {/* Live WebSocket Connection Status Banner */}
      <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-xs">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              telemetry.transport === "ws"
                ? "bg-emerald-500 animate-pulse"
                : telemetry.transport === "http"
                  ? "bg-cyan-500"
                  : "bg-amber-500"
            }`}
          />
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {telemetry.transport === "ws"
              ? "Live WebSocket Stream Active (/api/cockpit/stream)"
              : telemetry.transport === "http"
                ? "Connected via HTTP Telemetry Polling"
                : "Offline Mode (Reconnecting...)"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {telemetry.activeTaskId && (
            <div className="flex items-center gap-1.5 text-cyan-600 dark:text-cyan-400 font-mono text-[11px]">
              <span className="text-gray-400">Task:</span>
              <span className="font-semibold">{telemetry.activeTaskId}</span>
            </div>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void telemetry.refresh()}
            className="text-[11px] h-6 px-2"
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Live Telemetry Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => setTab("memory")}
          className="flex flex-col text-left p-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:border-cyan-500/50 dark:hover:border-cyan-500/50 transition-all group shadow-sm"
        >
          <div className="flex items-center justify-between w-full mb-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 group-hover:text-cyan-600 dark:group-hover:text-cyan-400">
              Memory Vault
            </span>
            <BrainIcon size={16} className="text-purple-500" />
          </div>
          <div className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Active Project Memory
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 font-mono">
            {telemetry.connected ? "● Project Scope Active" : "○ Offline"}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setTab("keys")}
          className="flex flex-col text-left p-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:border-cyan-500/50 dark:hover:border-cyan-500/50 transition-all group shadow-sm"
        >
          <div className="flex items-center justify-between w-full mb-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 group-hover:text-cyan-600 dark:group-hover:text-cyan-400">
              Model Key Fleet
            </span>
            <KeyRoundIcon size={16} className="text-amber-500" />
          </div>
          <div className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {telemetry.keyFleet.healthy
              ? "Healthy"
              : telemetry.keyFleet.activeCount === 0
                ? "No Keys"
                : "Degraded"}{" "}
            <span className="text-xs font-normal text-gray-400">
              ({telemetry.keyFleet.activeCount} Active)
            </span>
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 font-mono">
            {telemetry.keyFleet.providers.filter((p) => p.status === "cooldown").length > 0
              ? `● ${telemetry.keyFleet.providers.filter((p) => p.status === "cooldown").length} in Cooldown`
              : "● All Keys Ready"}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setTab("flamegraph")}
          className="flex flex-col text-left p-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:border-cyan-500/50 dark:hover:border-cyan-500/50 transition-all group shadow-sm"
        >
          <div className="flex items-center justify-between w-full mb-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 group-hover:text-cyan-600 dark:group-hover:text-cyan-400">
              Trace Flamegraph
            </span>
            <FlameIcon size={16} className="text-orange-500" />
          </div>
          <div className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Causal Performance
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 font-mono">
            {telemetry.transport === "ws"
              ? "● Streaming via WebSocket"
              : telemetry.transport === "http"
                ? "○ Polling via HTTP"
                : "○ Offline"}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setTab("snapshots")}
          className="flex flex-col text-left p-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:border-cyan-500/50 dark:hover:border-cyan-500/50 transition-all group shadow-sm"
        >
          <div className="flex items-center justify-between w-full mb-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 group-hover:text-cyan-600 dark:group-hover:text-cyan-400">
              Snapshot Rewind
            </span>
            <HistoryIcon size={16} className="text-blue-500" />
          </div>
          <div className="text-sm font-bold text-gray-900 dark:text-gray-100">
            Workspace Snapshots
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 font-mono">
            Project Checkpoints
          </div>
        </button>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-800 gap-1 overflow-x-auto">
        <button
          type="button"
          onClick={() => setTab("topology")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "topology"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Code Topology
        </button>
        <button
          type="button"
          onClick={() => setTab("guardian")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "guardian"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Shell Guardian
        </button>
        <button
          type="button"
          onClick={() => setTab("consensus")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "consensus"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Quorum Consensus
        </button>
        <button
          type="button"
          onClick={() => setTab("context")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "context"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Context Breakdown
        </button>
        <button
          type="button"
          onClick={() => setTab("memory")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "memory"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Memory Vault
        </button>
        <button
          type="button"
          onClick={() => setTab("keys")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "keys"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Model Key Fleet
        </button>
        <button
          type="button"
          onClick={() => setTab("flamegraph")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "flamegraph"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Trace Flamegraph
        </button>
        <button
          type="button"
          onClick={() => setTab("snapshots")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "snapshots"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Snapshot Rewind
        </button>
        <button
          type="button"
          onClick={() => setTab("ledger")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "ledger"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Turn Ledger ({turnSummaries.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("mailbox")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "mailbox"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Mailbox Bureau ({mailboxes.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("loop")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "loop"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Loop Breaker
        </button>
        <button
          type="button"
          onClick={() => setTab("swarm")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
            tab === "swarm"
              ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Swarm ({swarmNodes.length})
        </button>
      </div>

      {/* Tab: Code Topology */}
      {tab === "topology" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <TopologyPage embedded />
        </div>
      )}

      {/* Tab: Shell Guardian */}
      {tab === "guardian" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <GuardianPage embedded />
        </div>
      )}

      {/* Tab: Quorum Consensus */}
      {tab === "consensus" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <ConsensusPage embedded />
        </div>
      )}

      {/* Tab: Context Breakdown */}
      {tab === "context" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <ContextBreakdownPage embedded sessionId={sessionId} />
        </div>
      )}

      {/* Tab: Memory Vault */}
      {tab === "memory" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <MemoryPage embedded />
        </div>
      )}

      {/* Tab: Model Key Fleet */}
      {tab === "keys" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <ModelsKeyFleetPage embedded />
        </div>
      )}

      {/* Tab: Trace Flamegraph */}
      {tab === "flamegraph" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <TraceFlamegraphPage embedded />
        </div>
      )}

      {/* Tab: Snapshot Rewind */}
      {tab === "snapshots" && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden min-h-[560px]">
          <SnapshotsPage embedded />
        </div>
      )}

      {/* Tab: Turn Ledger */}
      {tab === "ledger" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400">Active Turn:</span>
              <span className="ml-2 font-mono text-xs font-semibold text-cyan-600 dark:text-cyan-400">
                {activeTurn}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
                Status: {telemetry.activeTaskId ? "RUNNING" : "IDLE"}
              </span>
              <span className="text-xs text-gray-400 font-mono">Session: {sessionId}</span>
            </div>
          </div>

          <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-1">
            Terminal Turn History & Checkpoint Log
          </div>
          {turnSummaries.length === 0 ? (
            <div className="p-8 text-center rounded-lg border border-dashed border-gray-300 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-950/40 text-gray-500 text-xs flex flex-col items-center gap-1.5">
              <span className="font-semibold text-gray-700 dark:text-gray-300">
                No turn checkpoints recorded yet
              </span>
              <span className="text-[11px] text-gray-400">
                Execute a command or launch an autonomous swarm task to generate turn ledger
                replays.
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
              {turnSummaries.map((turn) => (
                <div
                  key={turn.turnId}
                  className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-gray-800 dark:text-gray-200">
                        {turn.turnId}
                      </span>
                      <span
                        className={`px-2 py-0.2 rounded text-[10px] font-medium ${
                          turn.status === "completed"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                            : turn.status === "running"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                              : "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20"
                        }`}
                      >
                        {turn.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-400">
                      Seq #{turn.terminalSeq} • {turn.durationMs}ms • {turn.streamRecords} chunks
                    </div>
                  </div>
                  {turn.outcome && (
                    <div className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                      {turn.outcome}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Mailbox Bureau */}
      {tab === "mailbox" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            {mailboxes.map((mb) => (
              <div
                key={mb.agentName}
                className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-gray-800 dark:text-gray-200 uppercase tracking-wide">
                    {mb.agentName}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      mb.leaseState === "acquired"
                        ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-500"
                    }`}
                  >
                    Lease: {mb.leaseState}
                    {mb.leaseRemainingSec ? ` (${mb.leaseRemainingSec}s)` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                  <span>
                    Queue Depth:{" "}
                    <strong className="text-gray-700 dark:text-gray-200">{mb.queueDepth}</strong>
                  </span>
                  <span>
                    Replies:{" "}
                    <strong className="text-gray-700 dark:text-gray-200">
                      {mb.pendingReplies}
                    </strong>
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Inter-Agent Dispatch Tester */}
          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 flex flex-col gap-2.5">
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Dispatch Inter-Agent Directive
            </div>
            <div className="flex gap-2">
              <select
                value={toAgent}
                onChange={(e) => setToAgent(e.target.value)}
                className="text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2.5 py-1.5 text-gray-800 dark:text-gray-200"
              >
                {telemetry.swarmAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    To: {a.id} ({a.role})
                  </option>
                ))}
              </select>
              <Input
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Enter directive or subagent instruction..."
                className="flex-1"
              />
              <Button size="sm" onClick={handleSendMessage} disabled={!messageText.trim()}>
                Send Directive
              </Button>
            </div>
            {dispatchedCount > 0 && (
              <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                ✓ {dispatchedCount} live directive(s) queued into destination Mailbox.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Loop & Circuit Breaker */}
      {tab === "loop" && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
              <div className="text-[11px] text-gray-500 dark:text-gray-400">Failed Turns</div>
              <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                {turnSummaries.filter((t) => t.status === "failed").length} / 10
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">Circuit breaker limit: 10</div>
            </div>
            <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
              <div className="text-[11px] text-gray-500 dark:text-gray-400">Telemetry Activity</div>
              <div className="text-xl font-bold text-cyan-600 dark:text-cyan-400 mt-1">
                {telemetry.lastEventTime
                  ? `${Math.max(0, Math.round((Date.now() - telemetry.lastEventTime) / 1000))}s ago`
                  : "Standby"}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {telemetry.transport.toUpperCase()} stream
              </div>
            </div>
            <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
              <div className="text-[11px] text-gray-500 dark:text-gray-400">Circuit Breaker</div>
              <div
                className={`text-xl font-bold mt-1 ${
                  turnSummaries.filter((t) => t.status === "failed").length >= 10
                    ? "text-red-500"
                    : "text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {turnSummaries.filter((t) => t.status === "failed").length >= 10
                  ? "TRIPPED"
                  : "CLOSED"}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {turnSummaries.filter((t) => t.status === "failed").length >= 10
                  ? "Execution halted on errors"
                  : "Normal operation"}
              </div>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex flex-col gap-2">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">
                Active Goal:{" "}
                {telemetry.activeTaskId
                  ? telemetry.activeTaskId
                  : "System Idle (Awaiting Dispatch)"}
              </span>
              <span className="font-mono text-cyan-600 dark:text-cyan-400 font-bold">
                {telemetry.activeTaskId || telemetry.isDispatching ? "EXECUTING" : "STANDBY"}
              </span>
            </div>
            {telemetry.activeTaskId ? (
              <div className="w-full bg-gray-200 dark:bg-gray-700 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-cyan-500 h-full rounded-full animate-pulse"
                  style={{ width: "100%" }}
                />
              </div>
            ) : null}
            <div className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center justify-between mt-1">
              <span>
                Task ID:{" "}
                <code className="font-mono text-gray-700 dark:text-gray-300">
                  {telemetry.activeTaskId ?? "None"}
                </code>
              </span>
              <span>{turnSummaries.length} turn checkpoint(s) recorded</span>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Recent Turn Checkpoint History
            </div>
            {turnSummaries.length === 0 ? (
              <div className="p-4 text-center rounded-lg border border-dashed border-gray-300 dark:border-gray-800 bg-white dark:bg-gray-950 text-gray-400 text-xs font-mono">
                No recent turn checkpoints recorded. Tasks dispatched to the swarm will log
                execution turns here.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {turnSummaries.slice(-15).map((t, idx) => (
                  <span
                    key={t.turnId || idx}
                    className={`px-2 py-1 rounded font-mono text-xs border ${
                      t.status === "completed"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                        : t.status === "failed"
                          ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700"
                    }`}
                  >
                    #{idx + 1} {t.turnId} ({t.durationMs}ms)
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 5: Swarm Topology */}
      {tab === "swarm" && (
        <div className="flex flex-col gap-4">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Autonomous Agent Swarm Network (GraphDataPort physics & AIF handoff routing):
          </div>

          {/* Autonomous Swarm Dispatch Bar */}
          <div className="p-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 dark:bg-cyan-950/20 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-cyan-700 dark:text-cyan-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-500 animate-ping" />
                Autonomous Multi-Agent Task Dispatcher
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 font-mono">
                {telemetry.transport.toUpperCase()} STREAM
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                size="sm"
                value={swarmPrompt}
                onChange={(e) => setSwarmPrompt(e.target.value)}
                placeholder="Enter high-level objective (e.g., 'Refactor database pool and run tests')..."
                className="flex-1 bg-white dark:bg-gray-950"
                disabled={telemetry.isDispatching}
              />
              <Button
                size="sm"
                onClick={() => {
                  if (swarmPrompt.trim()) {
                    void telemetry.triggerTask(swarmPrompt.trim());
                    setSwarmPrompt("");
                  }
                }}
                disabled={telemetry.isDispatching || !swarmPrompt.trim()}
              >
                {telemetry.isDispatching ? "Swarm Running..." : "Launch Swarm"}
              </Button>
            </div>
          </div>

          {/* Swarm Agent Nodes Grid */}
          <div className="grid grid-cols-2 gap-3">
            {swarmNodes.map((node) => (
              <div
                key={node.id}
                className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-gray-800 dark:text-gray-200 uppercase tracking-wide">
                      {node.id}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                      {node.role}
                    </span>
                  </div>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      node.status === "active"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                        : node.status === "handoff"
                          ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
                          : node.status === "waiting_approval"
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-500"
                    }`}
                  >
                    {node.status.toUpperCase()}
                  </span>
                </div>

                {node.currentTask && (
                  <div className="text-[11px] text-gray-600 dark:text-gray-400 leading-snug">
                    {node.currentTask}
                  </div>
                )}

                <div className="flex items-center justify-between text-[11px] text-gray-400 border-t border-gray-100 dark:border-gray-800/80 pt-1.5 mt-0.5">
                  <span>
                    Tasks Completed:{" "}
                    <strong className="text-gray-700 dark:text-gray-200">
                      {node.tasksCompleted}
                    </strong>
                  </span>
                  {node.handoffTarget && (
                    <span className="text-cyan-600 dark:text-cyan-400 font-mono">
                      → Handoff to: {node.handoffTarget}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Active Handoff & Edge Channels */}
          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex flex-col gap-2">
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Active Coordination Channels ({swarmEdges.length})
            </div>
            <div className="flex flex-wrap gap-2">
              {swarmEdges.map((edge, idx) => (
                <div
                  key={idx}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-xs font-mono"
                >
                  <span className="font-semibold text-gray-700 dark:text-gray-300">
                    {edge.from}
                  </span>
                  <span className="text-gray-400">→</span>
                  <span className="font-semibold text-cyan-600 dark:text-cyan-400">{edge.to}</span>
                  <span className="text-[10px] px-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
                    {edge.kind}
                  </span>
                  {edge.activeCount > 0 && (
                    <span className="text-[10px] px-1 rounded-full bg-cyan-500 text-white font-bold">
                      {edge.activeCount}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (embedded || open === undefined) {
    return (
      <div className="h-full overflow-y-auto p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl">
        <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Agent War Room & Autonomous Cockpit
          </h2>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
        <div className="mt-3">{bodyContent}</div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose ?? (() => {})}
      title="Agent War Room & Autonomous Cockpit"
      widthClass="sm:max-w-5xl"
    >
      {bodyContent}
    </Modal>
  );
}

export function CockpitPage() {
  useDocumentTitle(S.nav.cockpit ?? "Agent Cockpit");
  return (
    <div className="h-full p-4 overflow-y-auto">
      <AgentCockpit embedded={true} />
    </div>
  );
}
