import { useState } from "react";
import type { HandoffStepItem } from "./consensus-types";
import { Button } from "../../components/ui/button";

export function HandoffTimeline() {
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

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl border border-gray-800 bg-gray-950 font-mono text-xs select-none">
      <div className="flex items-center justify-between pb-3 border-b border-gray-800">
        <div>
          <h3 className="font-bold text-sm text-gray-100">
            Autonomous Handoff Pipeline & Topology
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Sequential task delegation chain across swarm agents with automated quality and review
            gates.
          </p>
        </div>

        <Button size="sm" variant="secondary" onClick={handleRunSimulation} disabled={simulating}>
          {simulating ? "Advancing..." : "Simulate Next Stage"}
        </Button>
      </div>

      {/* Stepper Timeline */}
      <div className="flex flex-col gap-3">
        {steps.map((step, idx) => (
          <div
            key={step.id}
            className={`relative p-3 rounded-lg border transition-all flex items-start justify-between gap-4 ${
              step.status === "completed"
                ? "bg-gray-900/40 border-gray-800"
                : step.status === "in_progress"
                  ? "bg-cyan-950/20 border-cyan-500/40 ring-1 ring-cyan-500/30"
                  : "bg-gray-950/40 border-gray-900 opacity-60"
            }`}
          >
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 ${
                  step.status === "completed"
                    ? "bg-emerald-500 text-black"
                    : step.status === "in_progress"
                      ? "bg-cyan-500 text-black animate-pulse"
                      : "bg-gray-800 text-gray-500"
                }`}
              >
                {step.status === "completed" ? "✓" : idx + 1}
              </div>

              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-200">{step.fromAgent}</span>
                  <span className="text-gray-500">→</span>
                  <span className="font-bold text-cyan-400">{step.toAgent}</span>
                  <span className="text-gray-500 text-[10px] tabular-nums">[{step.timestamp}]</span>
                </div>
                <div className="text-[11px] text-gray-300 font-medium">{step.reason}</div>
                <div className="text-[10px] text-gray-500 truncate">{step.payloadSummary}</div>
              </div>
            </div>

            <div className="flex flex-col items-end gap-1 shrink-0">
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded uppercase font-bold ${
                  step.status === "completed"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : step.status === "in_progress"
                      ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                      : "bg-gray-800 text-gray-500"
                }`}
              >
                {step.status}
              </span>
              {step.durationMs > 0 && (
                <span className="text-[10px] text-gray-500 tabular-nums">{step.durationMs}ms</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
