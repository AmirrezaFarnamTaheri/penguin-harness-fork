import { useState, useEffect } from "react";
import type { MailboxSummary, MailboxMessage } from "./consensus-types";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { RequiredMark } from "../../components/ui/field";

export function MailboxBureau() {
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([
    {
      agentName: "agent-orchestrator",
      queueDepth: 1,
      pendingReplyCount: 0,
      lease: {
        agentName: "agent-orchestrator",
        inboundEventId: "ev-849",
        leaseToken: "tok-91a",
        leaseState: "acquired",
        acquiredAt: Date.now() - 5000,
        expiresAt: Date.now() + 25000,
      },
      lastActivityAt: Date.now() - 2000,
    },
    {
      agentName: "agent-coder-1",
      queueDepth: 3,
      pendingReplyCount: 1,
      lease: {
        agentName: "agent-coder-1",
        inboundEventId: "ev-850",
        leaseToken: "tok-32c",
        leaseState: "acquired",
        acquiredAt: Date.now() - 12000,
        expiresAt: Date.now() + 18000,
      },
      lastActivityAt: Date.now() - 4000,
    },
    {
      agentName: "agent-reviewer",
      queueDepth: 0,
      pendingReplyCount: 0,
      lease: null,
      lastActivityAt: Date.now() - 60000,
    },
    {
      agentName: "agent-tester-1",
      queueDepth: 2,
      pendingReplyCount: 0,
      lease: {
        agentName: "agent-tester-1",
        inboundEventId: "ev-851",
        leaseToken: "tok-77b",
        leaseState: "acquired",
        acquiredAt: Date.now() - 1000,
        expiresAt: Date.now() + 29000,
      },
      lastActivityAt: Date.now() - 1000,
    },
  ]);

  const [messages, setMessages] = useState<MailboxMessage[]>([
    {
      id: "msg-101",
      fromAgent: "agent-orchestrator",
      toAgent: "agent-coder-1",
      eventType: "directive:implement_feature",
      payload: { feature: "CodeGraph SVG canvas", targetBranch: "lanes/subagent-refactor-ast" },
      priority: "high",
      createdAt: Date.now() - 15000,
      attempts: 1,
    },
    {
      id: "msg-102",
      fromAgent: "agent-coder-1",
      toAgent: "agent-reviewer",
      eventType: "review:handoff_request",
      payload: { pullRequest: "PR #42 - Add shell guardian", diffStats: "+280 -12" },
      priority: "normal",
      createdAt: Date.now() - 32000,
      attempts: 1,
    },
    {
      id: "msg-103",
      fromAgent: "agent-reviewer",
      toAgent: "agent-tester-1",
      eventType: "test:vitest_run",
      payload: { testScope: "packages/web/test", runMode: "isolated" },
      priority: "high",
      createdAt: Date.now() - 45000,
      attempts: 1,
    },
  ]);

  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [fromAgent, setFromAgent] = useState("agent-orchestrator");
  const [toAgent, setToAgent] = useState("agent-coder-1");
  const [eventType, setEventType] = useState("directive:sync_state");
  const [payloadText, setPayloadText] = useState('{"action": "recheck_topology"}');

  // Live lease countdown tick
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleDispatchMessage = () => {
    let parsedPayload: unknown = {};
    try {
      parsedPayload = JSON.parse(payloadText);
    } catch {
      parsedPayload = { text: payloadText };
    }

    const newMsg: MailboxMessage = {
      id: `msg-${Math.random().toString(16).slice(2, 6)}`,
      fromAgent,
      toAgent,
      eventType,
      payload: parsedPayload,
      priority: "normal",
      createdAt: Date.now(),
      attempts: 0,
    };

    setMessages([newMsg, ...messages]);
    setMailboxes((prev) =>
      prev.map((mb) => {
        if (mb.agentName === toAgent) {
          return { ...mb, queueDepth: mb.queueDepth + 1, lastActivityAt: Date.now() };
        }
        return mb;
      }),
    );
    setDispatchOpen(false);
  };

  return (
    <div className="flex flex-col gap-4 font-mono text-xs select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-3 border-b border-gray-800">
        <div>
          <h3 className="font-bold text-sm text-gray-100">Inter-Agent Mailbox Bureau</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Distributed message queues, lease acquisition timeouts, and event brokers across swarm agents.
          </p>
        </div>

        <Button size="sm" variant="primary" onClick={() => setDispatchOpen(true)}>
          + Dispatch Agent Event
        </Button>
      </div>

      {/* Mailbox Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {mailboxes.map((mb) => {
          const leaseActive = mb.lease && mb.lease.expiresAt > Date.now();
          const remainingSec = mb.lease ? Math.max(0, Math.round((mb.lease.expiresAt - Date.now()) / 1000)) : 0;

          return (
            <div
              key={mb.agentName}
              className="p-3 rounded-xl border border-gray-800 bg-gray-950 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-gray-200 truncate">{mb.agentName}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded uppercase font-semibold ${
                    leaseActive
                      ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30"
                      : "bg-gray-800 text-gray-500"
                  }`}
                >
                  {leaseActive ? "LEASE HELD" : "IDLE"}
                </span>
              </div>

              <div className="flex items-center justify-between text-[11px] text-gray-400">
                <span>Queue Depth:</span>
                <span className="font-semibold text-gray-100 tabular-nums">{mb.queueDepth} pending</span>
              </div>

              {leaseActive && (
                <div className="flex items-center justify-between text-[10px] text-cyan-400 bg-cyan-950/20 p-1.5 rounded border border-cyan-900/30">
                  <span>Lease TTL:</span>
                  <span className="font-bold tabular-nums">{remainingSec}s remaining</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Messages Queue Stream */}
      <div className="flex flex-col gap-2 p-3 rounded-xl border border-gray-800 bg-gray-950">
        <div className="text-xs font-bold text-gray-200">Recent Inter-Agent Dispatches ({messages.length})</div>
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {messages.map((m) => (
            <div
              key={m.id}
              className="p-2 rounded-lg bg-gray-900/60 border border-gray-800 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="font-bold text-cyan-400">{m.fromAgent}</span>
                <span className="text-gray-500">→</span>
                <span className="font-bold text-indigo-300">{m.toAgent}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-gray-800 text-gray-400">
                  {m.eventType}
                </span>
                <span className="text-[11px] text-gray-400 truncate">
                  {JSON.stringify(m.payload)}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded font-bold uppercase ${
                    m.priority === "high"
                      ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                      : "bg-gray-800 text-gray-400"
                  }`}
                >
                  {m.priority}
                </span>
                <span className="text-[10px] text-gray-500 tabular-nums">
                  {Math.round((Date.now() - m.createdAt) / 1000)}s ago
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Dispatch Modal */}
      <Modal
        open={dispatchOpen}
        title="Dispatch Peer-to-Peer Agent Event"
        onClose={() => setDispatchOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDispatchOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleDispatchMessage}>
              Dispatch Event
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 font-mono text-xs text-gray-300">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block mb-1 text-gray-400 font-medium">From Agent</label>
              <Input
                value={fromAgent}
                onChange={(e) => setFromAgent(e.target.value)}
                size="sm"
              />
            </div>
            <div>
              <label className="block mb-1 text-gray-400 font-medium">To Agent</label>
              <Input
                value={toAgent}
                onChange={(e) => setToAgent(e.target.value)}
                size="sm"
              />
            </div>
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">
              Event Type <RequiredMark />
            </label>
            <Input
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="e.g. directive:refactor_code"
              size="sm"
            />
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">JSON Payload</label>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              rows={3}
              className="w-full bg-gray-900 border border-gray-800 rounded p-2 text-xs text-gray-200 font-mono focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
