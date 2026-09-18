import { useState, useEffect } from "react";
import type { MailboxSummary, MailboxMessage } from "./consensus-types";
import type { LiveMailboxEntry } from "../agent/use-cockpit-telemetry.js";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Modal } from "../../components/ui/modal";
import { RequiredMark } from "../../components/ui/field";

/**
 * When the cockpit supplies live mailbox entries, they replace the demo
 * queues: the cards render the SwarmCoordinator's real queue depths and
 * leases (folded from the cockpit WS snapshot). This view is read-only in
 * live mode; the local demo composer is not exposed alongside live queues.
 */
export function MailboxBureau({ entries }: { entries?: LiveMailboxEntry[] }) {
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>(() => [
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
  const displayedEntries: LiveMailboxEntry[] =
    entries ??
    mailboxes.map((mailbox) => ({
      agentName: mailbox.agentName,
      queueDepth: mailbox.queueDepth,
      pendingReplies: mailbox.pendingReplyCount,
      leaseState: mailbox.lease
        ? mailbox.lease.expiresAt > Date.now()
          ? "acquired"
          : "expired"
        : "idle",
      leaseRemainingSec: mailbox.lease
        ? Math.max(0, Math.round((mailbox.lease.expiresAt - Date.now()) / 1000))
        : undefined,
    }));

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

  // Live lease countdown tick (paused in live mode: the feed refreshes itself).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (entries !== undefined) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [entries]);

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

  const isLive = entries !== undefined;

  return (
    <div className="flex flex-col gap-4 text-sm ">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between pb-3 border-b border-gray-200 dark:border-gray-800">
        <div>
          <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">
            {isLive ? "Messages (live)" : "Messages (local demo)"}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
            {isLive
              ? "Queues and leases from the project's running swarm."
              : "Sample queues and leases. Messages created here stay in this page."}
          </p>
        </div>

        {!isLive && (
          <Button size="sm" variant="primary" onClick={() => setDispatchOpen(true)}>
            Compose demo message
          </Button>
        )}
      </div>

      {/* Mailbox Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {displayedEntries.map((mb) => {
          const leaseActive = mb.leaseState === "acquired";
          const remainingSec = mb.leaseRemainingSec;

          return (
            <div
              key={mb.agentName}
              className="p-3 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center justify-between">
                <span className="font-semibold text-gray-900 dark:text-gray-100 break-words">
                  {mb.agentName}
                </span>
                <span
                  className={`text-sm px-1.5 py-0.2 rounded  font-semibold ${
                    leaseActive
                      ? "bg-cyan-500/15 text-gray-900 dark:text-gray-100 border border-cyan-500/30"
                      : "bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {leaseActive ? "LEASE HELD" : mb.leaseState === "expired" ? "EXPIRED" : "IDLE"}
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between text-sm text-gray-600 dark:text-gray-400">
                <span>Queue Depth:</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                  {mb.queueDepth} pending
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between">
                <span>Pending replies:</span>
                <span className="tabular-nums">{mb.pendingReplies}</span>
              </div>

              {leaseActive && (
                <div className="flex flex-wrap items-center justify-between text-sm text-gray-900 dark:text-gray-100 bg-cyan-950/20 p-1.5 rounded border border-cyan-900/30">
                  <span>Lease TTL:</span>
                  <span className="font-semibold tabular-nums">
                    {remainingSec === undefined ? "Unknown" : `${remainingSec}s remaining`}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Messages Queue Stream (demo mode only: live queues carry no message feed here) */}
      {!isLive && (
        <div className="flex flex-col gap-2 p-3 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Recent messages ({messages.length})
          </div>
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
            {messages.map((m) => (
              <div
                key={m.id}
                className="p-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                  <span className="font-semibold text-gray-900 dark:text-gray-100">
                    {m.fromAgent}
                  </span>
                  <span className="text-gray-600 dark:text-gray-400">→</span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100">
                    {m.toAgent}
                  </span>
                  <span className="text-sm px-1.5 py-0.2 rounded bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400">
                    {m.eventType}
                  </span>
                  <span className="text-sm text-gray-600 dark:text-gray-400 break-words">
                    {JSON.stringify(m.payload)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <span
                    className={`text-sm px-1.5 py-0.2 rounded font-semibold  ${
                      m.priority === "high"
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30"
                        : "bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400"
                    }`}
                  >
                    {m.priority}
                  </span>
                  <span className="text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {Math.round((Date.now() - m.createdAt) / 1000)}s ago
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dispatch Modal (demo mode only) */}
      {!isLive && (
        <Modal
          open={dispatchOpen}
          title="Compose demo message"
          onClose={() => setDispatchOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDispatchOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={handleDispatchMessage}>
                Add demo message
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-3 text-sm text-gray-900 dark:text-gray-100">
            <div className="grid grid-cols-1 sm:grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
                  From Agent
                </label>
                <Input
                  aria-label="From agent"
                  value={fromAgent}
                  onChange={(e) => setFromAgent(e.target.value)}
                  size="sm"
                />
              </div>
              <div>
                <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
                  To Agent
                </label>
                <Input
                  aria-label="To agent"
                  value={toAgent}
                  onChange={(e) => setToAgent(e.target.value)}
                  size="sm"
                />
              </div>
            </div>

            <div>
              <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
                Event Type <RequiredMark />
              </label>
              <Input
                aria-label="Event type"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                placeholder="e.g. directive:refactor_code"
                size="sm"
              />
            </div>

            <div>
              <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
                JSON Payload
              </label>
              <textarea
                aria-label="Payload text"
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                rows={3}
                className="w-full bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded p-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
