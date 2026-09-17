import { S } from "../../lib/strings";
import { useState } from "react";
import type { HandoffStepItem } from "./consensus-types";
import type { LiveHandoffEvent } from "../agent/use-cockpit-telemetry.js";
import { Button } from "../../components/ui/button";

export function HandoffTimeline({ handoffs }: { handoffs?: LiveHandoffEvent[] }) {
  const [steps, setSteps] = useState<HandoffStepItem[]>([
    {
      id: "step-1",
      fromAgent: "user",
      toAgent: "agent-orchestrator",
      reason: "User prompted multi-agent frontend overhaul",
      payloadSummary: "Scope: CodeGraph, Shell Guardian, Quorum Consensus, Context Breakdown",
      status: "completed",
      durationMs: 450,
      timestamp: "10:14:02",
    },
    {
      id: "step-2",
      fromAgent: "agent-orchestrator",
      toAgent: "agent-coder-1",
      reason: "Directive: Implement Phase 1 CodeGraph & AST Topology Navigator",
      payloadSummary: "Target: packages/web/src/features/topology/",
      status: "completed",
      durationMs: 1840,
      timestamp: "10:14:05",
    },
    {
      id: "step-3",
      fromAgent: "agent-coder-1",
      toAgent: "agent-reviewer",
      reason: "Review Gate: Verify Shell Guardian & Safe Execution Cockpit",
      payloadSummary: "Target: packages/web/src/features/guardian/",
      status: "completed",
      durationMs: 920,
      timestamp: "10:14:09",
    },
    {
      id: "step-4",
      fromAgent: "agent-reviewer",
      toAgent: "agent-tester-1",
      reason: "Verification Gate: Run typecheck and full vitest regression test suite",
      payloadSummary: "Command: pnpm --filter @prismshadow/penguin-web test --run",
      status: "in_progress",
      durationMs: 2310,
      timestamp: "10:14:12",
    },
    {
      id: "step-5",
      fromAgent: "agent-tester-1",
      toAgent: "user",
      reason: "Handoff Result: Verified production-grade cockpit modules ready",
      payloadSummary: "Final statusline binding and router integration",
      status: "pending",
      durationMs: 0,
      timestamp: "—",
    },
  ]);

  const [simulating, setSimulating] = useState(false);

  const handleRunSimulation = () => {
    setSimulating(true);
    setTimeout(() => {
      setSteps((prev) =>
        prev.map((s, idx) => {
          if (idx === 3) return { ...s, status: "completed" };
          if (idx === 4)
            return { ...s, status: "in_progress", durationMs: 1200, timestamp: "10:14:15" };
          return s;
        }),
      );
      setSimulating(false);
    }, 1200);
  };

  const isLive = handoffs !== undefined;

  return (
    <div className="flex flex-col gap-4 py-4 border-b border-gray-200 dark:border-gray-800 text-sm ">
      <div className="flex flex-wrap items-center justify-between pb-3 border-b border-gray-200 dark:border-gray-800">
        <div>
          <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">
            {isLive ? S.consensus.timeline.liveTitle : S.consensus.timeline.demoTitle}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
            {isLive ? S.consensus.timeline.liveDescription : S.consensus.timeline.demoDescription}
          </p>
        </div>

        {!isLive && (
          <Button size="sm" variant="secondary" onClick={handleRunSimulation} disabled={simulating}>
            {simulating ? S.consensus.timeline.advancing : S.consensus.timeline.simulate}
          </Button>
        )}
      </div>

      {/* Live feed (from the existing cockpit swarm event stream) */}
      {isLive && (
        <div className="flex flex-col gap-3">
          {handoffs.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">{S.consensus.timeline.empty}</p>
          )}
          {handoffs.map((event) => (
            <div
              key={event.messageId}
              className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900 dark:text-gray-100">{event.from}</span>
                <span className="text-gray-600 dark:text-gray-400">→</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100">{event.to}</span>
                <span className="text-sm px-1.5 py-0.2 rounded font-semibold bg-cyan-500/15 text-gray-900 dark:text-gray-100 border border-cyan-500/30">
                  {event.source === "task_started"
                    ? S.consensus.timeline.started
                    : S.consensus.timeline.dispatched}
                </span>
                <span className="text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                  [{new Date(event.timestamp).toLocaleTimeString()}]
                </span>
              </div>
              {event.source === "task_started" && (
                <div className="text-sm text-gray-600 dark:text-gray-400 break-words">
                  <div>
                    {S.consensus.timeline.task} {event.taskId}
                  </div>
                  <div>{S.consensus.timeline.planned}</div>
                </div>
              )}
              {event.content && (
                <div className="text-sm text-gray-900 dark:text-gray-100 font-medium break-words">
                  {event.content}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Stepper Timeline */}
      {!isLive && (
        <div className="flex flex-col gap-3">
          {steps.map((step, idx) => (
            <div
              key={step.id}
              className={`relative p-3 rounded-lg border transition-all flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${
                step.status === "completed"
                  ? "bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800"
                  : step.status === "in_progress"
                    ? "bg-cyan-950/20 border-cyan-500/40 ring-1 ring-cyan-500/30"
                    : "bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800 opacity-60"
              }`}
            >
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div
                  className={`w-6 h-6 rounded-full flex flex-wrap items-center justify-center font-semibold text-sm shrink-0 mt-0.5 ${
                    step.status === "completed"
                      ? "bg-emerald-500 text-black"
                      : step.status === "in_progress"
                        ? "bg-cyan-500 text-black "
                        : "bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {step.status === "completed" ? "✓" : idx + 1}
                </div>

                <div className="flex flex-col gap-1 min-w-0 flex-1 break-words">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {step.fromAgent}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">→</span>
                    <span className="font-semibold text-gray-900 dark:text-gray-100">
                      {step.toAgent}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400 text-sm tabular-nums">
                      [{step.timestamp}]
                    </span>
                  </div>
                  <div className="text-sm text-gray-900 dark:text-gray-100 font-medium">
                    {step.reason}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 break-words">
                    {step.payloadSummary}
                  </div>
                </div>
              </div>

              <div className="flex flex-row items-center gap-2 shrink-0 sm:flex-col sm:items-end">
                <span
                  className={`text-sm px-1.5 py-0.2 rounded  font-semibold ${
                    step.status === "completed"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                      : step.status === "in_progress"
                        ? "bg-cyan-500/15 text-gray-900 dark:text-gray-100 border border-cyan-500/30"
                        : "bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {S.consensus.timeline[step.status]}
                </span>
                {step.durationMs > 0 && (
                  <span className="text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {S.consensus.timeline.duration.replace("{ms}", String(step.durationMs))}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
