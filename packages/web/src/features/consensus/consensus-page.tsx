import { useState } from "react";
import { useProject } from "../../state/project";
import { Segmented } from "../../components/ui/segmented";
import { QuorumBoard } from "./quorum-board";
import { MailboxBureau } from "./mailbox-bureau";
import { HandoffTimeline } from "./handoff-timeline";

export interface ConsensusPageProps {
  embedded?: boolean;
}

export function ConsensusPage({ embedded = false }: ConsensusPageProps) {
  const { currentProject } = useProject();
  const [tab, setTab] = useState<"quorum" | "mailbox" | "handoff">("quorum");

  return (
    <div
      className={`flex flex-col h-full gap-4 ${
        embedded ? "p-2" : "p-6"
      } bg-gray-950 text-gray-100 font-sans select-none overflow-y-auto`}
    >
      {/* Header & Telemetry Cards */}
      <div className="flex flex-col gap-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2 font-mono">
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
              Multi-Agent Quorum Consensus & Mailbox Bureau
            </h1>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              Decentralized peer endorsement voting, anti-cascade evidence grounding, and message lease bureau for{" "}
              {currentProject?.name ?? "Penguin"}
            </p>
          </div>

          <div className="w-72">
            <Segmented
              cols={3}
              options={[
                { value: "quorum", label: "Quorum" },
                { value: "mailbox", label: "Mailbox" },
                { value: "handoff", label: "Handoffs" },
              ]}
              value={tab}
              onChange={(v) => setTab(v as "quorum" | "mailbox" | "handoff")}
            />
          </div>
        </div>

        {/* Telemetry Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Settled Topics</span>
            <span className="text-base font-bold text-emerald-400 tabular-nums">2 settled</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Active Debates</span>
            <span className="text-base font-bold text-amber-400 tabular-nums">2 debating</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Mailbox Leases</span>
            <span className="text-base font-bold text-cyan-400 tabular-nums">3 active</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Handoff Success</span>
            <span className="text-base font-bold text-indigo-400 tabular-nums">100%</span>
          </div>
        </div>
      </div>

      {/* Main Workspace Body */}
      <div className="flex-1 min-h-0">
        {tab === "quorum" && <QuorumBoard />}
        {tab === "mailbox" && <MailboxBureau />}
        {tab === "handoff" && <HandoffTimeline />}
      </div>
    </div>
  );
}
