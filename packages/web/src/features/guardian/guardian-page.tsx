import { useProject } from "../../state/project";
import { LiveCommandSandbox } from "./live-command-sandbox";
import { RulePolicyEditor } from "./rule-policy-editor";
import { WorktreeLanesCard } from "./worktree-lanes-card";

export interface GuardianPageProps {
  embedded?: boolean;
}

export function GuardianPage({ embedded = false }: GuardianPageProps) {
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? "default-project";

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
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Shell Guardian & Safe Execution Cockpit
            </h1>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              Blast radius analyzer, regex command firewall, and isolated Git worktree lanes for{" "}
              {currentProject?.name ?? "Penguin"}
            </p>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
              SANDBOX BARRIER: ACTIVE
            </span>
          </div>
        </div>

        {/* Telemetry Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Enforcement Level</span>
            <span className="text-base font-bold text-emerald-400">RESTRICTED</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Critical Guard Rules</span>
            <span className="text-base font-bold text-rose-400 tabular-nums">18 rules</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Worktree Lanes</span>
            <span className="text-base font-bold text-indigo-400 tabular-nums">3 active</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Destructive Aborts</span>
            <span className="text-base font-bold text-cyan-400 tabular-nums">14 blocked</span>
          </div>
        </div>
      </div>

      {/* Main Sections */}
      <div className="flex flex-col gap-4">
        <LiveCommandSandbox />
        <RulePolicyEditor projectId={projectId} />
        <WorktreeLanesCard projectId={projectId} />
      </div>
    </div>
  );
}
