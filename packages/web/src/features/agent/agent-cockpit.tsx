import { useState } from "react";
import { Modal } from "../../components/ui/modal.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";

export interface AgentCockpitProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}

interface MockTurnSummary {
  turnId: string;
  terminalSeq: number;
  status: "queued" | "running" | "completed" | "interrupted" | "failed";
  durationMs: number;
  outcome?: string;
  streamRecords: number;
}

interface MockMailboxEntry {
  agentName: string;
  queueDepth: number;
  pendingReplies: number;
  leaseState: "acquired" | "idle" | "expired";
  leaseRemainingSec?: number;
}

interface MockCompactionAnchor {
  anchorId: string;
  phase: "turn-start" | "in-loop" | "agent-session";
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens: number;
  foldedCount: number;
  durationMs: number;
  timestamp: string;
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

export function AgentCockpit({ open, onClose, sessionId = "default-session" }: AgentCockpitProps) {
  const [tab, setTab] = useState<"ledger" | "mailbox" | "loop" | "compaction" | "swarm">("ledger");

  // State: Turn Ledger
  const [activeTurn] = useState<string>("turn-7a8f9c2d");
  const [turnStatus] = useState<"running" | "completed" | "queued">("running");
  const [turnSummaries] = useState<MockTurnSummary[]>([
    {
      turnId: "turn-7a8f9c2d",
      terminalSeq: 42,
      status: "running",
      durationMs: 3420,
      outcome: "Investigating upstream archives and compiling TypeScript declarations",
      streamRecords: 18,
    },
    {
      turnId: "turn-6c1e4b9a",
      terminalSeq: 24,
      status: "completed",
      durationMs: 8940,
      outcome: "Loop detector and turn ledger test suite verified 15/15 passed",
      streamRecords: 35,
    },
    {
      turnId: "turn-5b2d8f1e",
      terminalSeq: 12,
      status: "completed",
      durationMs: 4120,
      outcome: "Mounted REST gateway endpoints for quota and pricing catalog",
      streamRecords: 22,
    },
  ]);

  // State: Mailbox
  const [mailboxes] = useState<MockMailboxEntry[]>([
    { agentName: "orchestrator", queueDepth: 0, pendingReplies: 0, leaseState: "idle" },
    {
      agentName: "coder",
      queueDepth: 1,
      pendingReplies: 1,
      leaseState: "acquired",
      leaseRemainingSec: 24,
    },
    { agentName: "reviewer", queueDepth: 0, pendingReplies: 0, leaseState: "idle" },
    {
      agentName: "researcher",
      queueDepth: 2,
      pendingReplies: 0,
      leaseState: "acquired",
      leaseRemainingSec: 18,
    },
  ]);

  const [toAgent, setToAgent] = useState("coder");
  const [messageText, setMessageText] = useState("");
  const [dispatchedCount, setDispatchedCount] = useState(0);

  // State: Loop & Circuit Breaker
  const [consecutiveErrors] = useState(0);
  const [timeSinceLastProgress] = useState(4.2);
  const [currentFile] = useState("packages/core/src/agent/turn-ledger.ts");
  const [recentTools] = useState([
    "view_file",
    "write_to_file",
    "run_command",
    "replace_file_content",
  ]);
  const [progressPhase] = useState("Cluster 3 Batch 3 Porting");
  const [filesCompleted] = useState(28);
  const [totalFiles] = useState(40);

  // State: Compaction Anchors
  const [anchors, setAnchors] = useState<MockCompactionAnchor[]>([
    {
      anchorId: "anchor-c81e9f",
      phase: "turn-start",
      trigger: "auto",
      preTokens: 78500,
      postTokens: 24300,
      foldedCount: 14,
      durationMs: 450,
      timestamp: "2 mins ago",
    },
    {
      anchorId: "anchor-a24b7d",
      phase: "in-loop",
      trigger: "manual",
      preTokens: 64200,
      postTokens: 19800,
      foldedCount: 10,
      durationMs: 380,
      timestamp: "18 mins ago",
    },
  ]);

  // State: Swarm & Handoff Topology (from agent-teams-ai GraphDataPort & aif-handoff)
  const [swarmNodes] = useState<SwarmAgentNode[]>([
    {
      id: "orchestrator",
      role: "orchestrator",
      status: "active",
      tasksCompleted: 14,
      currentTask: "Dispatching batch extraction and verification",
    },
    {
      id: "coder",
      role: "coder",
      status: "active",
      tasksCompleted: 28,
      currentTask: "Implementing gateway routes and UI controls",
      handoffTarget: "reviewer",
    },
    {
      id: "reviewer",
      role: "reviewer",
      status: "idle",
      tasksCompleted: 27,
      currentTask: "Waiting for pull request diff audit",
    },
    {
      id: "researcher",
      role: "researcher",
      status: "idle",
      tasksCompleted: 19,
      currentTask: "Analyzing upstream source trees",
    },
    {
      id: "tester",
      role: "tester",
      status: "idle",
      tasksCompleted: 22,
      currentTask: "Standing by for Vitest run",
    },
  ]);

  const [swarmEdges] = useState<SwarmEdge[]>([
    { from: "orchestrator", to: "coder", kind: "directive", activeCount: 2 },
    { from: "coder", to: "reviewer", kind: "handoff", activeCount: 1 },
    { from: "reviewer", to: "orchestrator", kind: "review_gate", activeCount: 1 },
    { from: "orchestrator", to: "researcher", kind: "directive", activeCount: 0 },
    { from: "coder", to: "tester", kind: "handoff", activeCount: 0 },
  ]);

  const handleManualCompact = () => {
    const newAnchor: MockCompactionAnchor = {
      anchorId: `anchor-${Math.random().toString(16).slice(2, 8)}`,
      phase: "agent-session",
      trigger: "manual",
      preTokens: 42000,
      postTokens: 14800,
      foldedCount: 6,
      durationMs: 290,
      timestamp: "Just now",
    };
    setAnchors([newAnchor, ...anchors]);
  };

  const handleSendMessage = () => {
    if (!messageText.trim()) return;
    setDispatchedCount((c) => c + 1);
    setMessageText("");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agent War Room & Autonomous Cockpit"
      widthClass="sm:max-w-3xl"
    >
      <div className="flex flex-col gap-4">
        {/* Navigation Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-800 gap-2">
          <button
            type="button"
            onClick={() => setTab("ledger")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
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
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
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
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "loop"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Loop & Circuit Breaker
          </button>
          <button
            type="button"
            onClick={() => setTab("compaction")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "compaction"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Context Anchors ({anchors.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("swarm")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "swarm"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Swarm Topology ({swarmNodes.length})
          </button>
        </div>

        {/* Tab 1: Turn Ledger */}
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
                  Status: {turnStatus.toUpperCase()}
                </span>
                <span className="text-xs text-gray-400 font-mono">Session: {sessionId}</span>
              </div>
            </div>

            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mt-1">
              Terminal Turn History & Checkpoint Log
            </div>
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
                  <option value="coder">To: coder</option>
                  <option value="reviewer">To: reviewer</option>
                  <option value="researcher">To: researcher</option>
                  <option value="orchestrator">To: orchestrator</option>
                </select>
                <Input
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder="Enter directive or subagent instruction..."
                  className="flex-1"
                />
                <Button size="sm" onClick={handleSendMessage} disabled={!messageText.trim()}>
                  Send
                </Button>
              </div>
              {dispatchedCount > 0 && (
                <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  ✓ {dispatchedCount} directives dispatched to inter-agent FIFO mailbox queue.
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
                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                  Consecutive Errors
                </div>
                <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                  {consecutiveErrors} / 10
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">Healthy threshold</div>
              </div>
              <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
                <div className="text-[11px] text-gray-500 dark:text-gray-400">Forward Progress</div>
                <div className="text-xl font-bold text-cyan-600 dark:text-cyan-400 mt-1">
                  {timeSinceLastProgress}s ago
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">Stall limit: 300s</div>
              </div>
              <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
                <div className="text-[11px] text-gray-500 dark:text-gray-400">Circuit Breaker</div>
                <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
                  CLOSED
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">Zero cycle loops detected</div>
              </div>
            </div>

            <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex flex-col gap-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-700 dark:text-gray-300">
                  Phase: {progressPhase}
                </span>
                <span className="font-mono text-cyan-600 dark:text-cyan-400 font-bold">
                  {filesCompleted} / {totalFiles} ({Math.round((filesCompleted / totalFiles) * 100)}
                  %)
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-cyan-500 h-full rounded-full transition-all duration-300"
                  style={{ width: `${(filesCompleted / totalFiles) * 100}%` }}
                />
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center justify-between mt-1">
                <span>
                  Active File:{" "}
                  <code className="font-mono text-gray-700 dark:text-gray-300">{currentFile}</code>
                </span>
                <span>Est. remaining: ~4 mins</span>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Recent Tool Call Sequence (Rolling 20-call buffer)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {recentTools.map((t, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 font-mono text-xs text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700"
                  >
                    #{idx + 1} {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Compaction Anchors */}
        {tab === "compaction" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-600 dark:text-gray-400">
                Dynamic Context Pruning folds earlier conversation turns into structured memory
                anchors.
              </div>
              <Button size="sm" variant="secondary" onClick={handleManualCompact}>
                Compact History Now
              </Button>
            </div>

            <div className="flex flex-col gap-2.5 max-h-72 overflow-y-auto pr-1">
              {anchors.map((anc) => {
                const savingsPct = Math.round(
                  ((anc.preTokens - anc.postTokens) / anc.preTokens) * 100,
                );
                return (
                  <div
                    key={anc.anchorId}
                    className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-gray-800 dark:text-gray-200">
                          {anc.anchorId}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          -{savingsPct}% tokens saved
                        </span>
                      </div>
                      <span className="text-[11px] text-gray-400 font-mono">
                        {anc.timestamp} • {anc.durationMs}ms
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                      <span>
                        Pre:{" "}
                        <strong className="text-gray-700 dark:text-gray-300">
                          {anc.preTokens.toLocaleString()}
                        </strong>{" "}
                        tok
                      </span>
                      <span>
                        Post:{" "}
                        <strong className="text-gray-700 dark:text-gray-300">
                          {anc.postTokens.toLocaleString()}
                        </strong>{" "}
                        tok
                      </span>
                      <span>
                        Folded:{" "}
                        <strong className="text-gray-700 dark:text-gray-300">
                          {anc.foldedCount}
                        </strong>{" "}
                        turns
                      </span>
                      <span>
                        Phase: <code className="text-cyan-600 dark:text-cyan-400">{anc.phase}</code>
                      </span>
                      <span>
                        Trigger:{" "}
                        <code className="text-gray-600 dark:text-gray-400">{anc.trigger}</code>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tab 5: Swarm Topology */}
        {tab === "swarm" && (
          <div className="flex flex-col gap-4">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Autonomous Agent Swarm Network (GraphDataPort physics & AIF handoff routing):
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
                    <span className="font-semibold text-cyan-600 dark:text-cyan-400">
                      {edge.to}
                    </span>
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
    </Modal>
  );
}
