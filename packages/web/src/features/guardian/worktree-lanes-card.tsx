import { useState } from "react";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import { Modal } from "../../components/ui/modal";
import { Input } from "../../components/ui/input";
import { RequiredMark } from "../../components/ui/field";
import type { WorktreeLaneInfo } from "./guardian-types";

export interface WorktreeLanesCardProps {
  projectId: string;
}

export function WorktreeLanesCard({ projectId: _projectId }: WorktreeLanesCardProps) {
  const [lanes, setLanes] = useState<WorktreeLaneInfo[]>([
    {
      id: "lane-subagent-refactor",
      branch: "lanes/subagent-refactor-ast",
      headSha: "a9f4c21",
      agentId: "agent-coder-1",
      status: "isolated",
      createdAgo: "12m ago",
      dirtyFilesCount: 0,
    },
    {
      id: "lane-qa-vitest",
      branch: "lanes/qa-vitest-runner",
      headSha: "8b17e39",
      agentId: "agent-tester-1",
      status: "dirty",
      createdAgo: "34m ago",
      dirtyFilesCount: 2,
    },
    {
      id: "lane-db-migration",
      branch: "lanes/db-migration-pg",
      headSha: "e2c3104",
      agentId: "agent-architect",
      status: "isolated",
      createdAgo: "2h ago",
      dirtyFilesCount: 0,
    },
  ]);

  const [spawnOpen, setSpawnOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [newAgent, setNewAgent] = useState("agent-coder-1");

  const handlePrune = () => {
    setLanes((prev) => prev.filter((l) => l.status !== "stale"));
  };

  const handleSpawn = () => {
    if (!newBranch.trim()) return;
    const newLane: WorktreeLaneInfo = {
      id: `lane-${Math.random().toString(16).slice(2, 8)}`,
      branch: newBranch.trim(),
      headSha: "head-" + Math.random().toString(16).slice(2, 6),
      agentId: newAgent,
      status: "isolated",
      createdAgo: "Just now",
      dirtyFilesCount: 0,
    };
    setLanes([newLane, ...lanes]);
    setSpawnOpen(false);
    setNewBranch("");
  };

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl border border-gray-800 bg-gray-950 font-mono text-xs select-none">
      <div className="flex items-center justify-between pb-3 border-b border-gray-800">
        <div>
          <h3 className="font-bold text-sm text-gray-100 flex items-center gap-2">
            <span>Git Worktree Isolated Lanes</span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              .lanes/
            </span>
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Physical working directory sandboxes preventing parallel subagents from clobbering uncommitted work.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={handlePrune}>
            Prune Stale
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSpawnOpen(true)}>
            + Spawn Lane
          </Button>
        </div>
      </div>

      {/* Lanes Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {lanes.map((lane) => (
          <div
            key={lane.id}
            className="p-3 rounded-lg border border-gray-800 bg-gray-900/50 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-200 truncate">{lane.id}</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded uppercase font-semibold ${
                  lane.status === "isolated"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : lane.status === "dirty"
                      ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      : "bg-gray-800 text-gray-400"
                }`}
              >
                {lane.status}
              </span>
            </div>

            <div className="flex items-center justify-between text-[11px] text-gray-400">
              <span className="truncate pr-1 text-cyan-400">{lane.branch}</span>
              <CopyButton text={lane.branch} label="Copy branch" />
            </div>

            <div className="flex items-center justify-between text-[10px] text-gray-500 border-t border-gray-800 pt-1.5 mt-0.5">
              <span>Agent: {lane.agentId}</span>
              <span className="tabular-nums">SHA: {lane.headSha}</span>
            </div>

            {lane.dirtyFilesCount > 0 && (
              <div className="text-[10px] text-amber-400 font-semibold">
                {lane.dirtyFilesCount} uncommitted dirty files in lane
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Spawn Modal */}
      <Modal
        open={spawnOpen}
        title="Spawn Isolated Git Worktree Lane"
        onClose={() => setSpawnOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSpawnOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleSpawn}>
              Spawn Worktree
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 font-mono text-xs text-gray-300">
          <div>
            <label className="block mb-1 text-gray-400 font-medium">
              Lane Branch Name <RequiredMark />
            </label>
            <Input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="e.g. lanes/experiment-ast-rewrite"
              size="sm"
            />
          </div>

          <div>
            <label className="block mb-1 text-gray-400 font-medium">Assigned Subagent</label>
            <Input
              value={newAgent}
              onChange={(e) => setNewAgent(e.target.value)}
              placeholder="e.g. agent-coder-1"
              size="sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
