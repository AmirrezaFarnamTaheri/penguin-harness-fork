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
    <div className="flex flex-col gap-4 py-4 border-b border-gray-200 dark:border-gray-800 text-sm ">
      <div className="flex flex-wrap items-center justify-between pb-3 border-b border-gray-200 dark:border-gray-800">
        <div>
          <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100 flex flex-wrap items-center gap-2">
            <span>Worktrees (local demo)</span>
            <span className="text-sm px-2 py-2 rounded bg-indigo-500/10 text-gray-900 dark:text-gray-100 border border-indigo-500/20">
              .lanes/
            </span>
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
            Sample lanes only. Creating or pruning a lane here does not change Git or the
            filesystem.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={handlePrune}>
            Prune stale demo lanes
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSpawnOpen(true)}>
            Add demo lane
          </Button>
        </div>
      </div>

      {/* Lanes Grid */}
      <div className="flex flex-col divide-y divide-gray-200 dark:divide-gray-800">
        {lanes.map((lane) => (
          <div
            key={lane.id}
            className="py-3 border-b border-gray-200 dark:border-gray-800 flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center justify-between">
              <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                {lane.id}
              </span>
              <span
                className={`text-sm px-1.5 py-0.2 rounded  font-semibold ${
                  lane.status === "isolated"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                    : lane.status === "dirty"
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
                      : "bg-white dark:bg-gray-950 text-gray-600 dark:text-gray-400"
                }`}
              >
                {lane.status}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between text-sm text-gray-600 dark:text-gray-400">
              <span className="truncate pr-1 text-gray-900 dark:text-gray-100">{lane.branch}</span>
              <CopyButton text={lane.branch} label="Copy branch" />
            </div>

            <div className="flex flex-wrap items-center justify-between text-sm text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-gray-800 pt-1.5 mt-0.5">
              <span>Agent: {lane.agentId}</span>
              <span className="tabular-nums">SHA: {lane.headSha}</span>
            </div>

            {lane.dirtyFilesCount > 0 && (
              <div className="text-sm text-amber-700 dark:text-amber-400 font-semibold">
                {lane.dirtyFilesCount} uncommitted dirty files in lane
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Spawn Modal */}
      <Modal
        open={spawnOpen}
        title="Add demo worktree"
        onClose={() => setSpawnOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSpawnOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={handleSpawn}>
              Add demo lane
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 text-sm text-gray-900 dark:text-gray-100">
          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
              Lane Branch Name <RequiredMark />
            </label>
            <Input
              aria-label="New branch"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="e.g. lanes/experiment-ast-rewrite"
              size="sm"
            />
          </div>

          <div>
            <label className="block mb-1 text-gray-600 dark:text-gray-400 font-medium">
              Assigned Subagent
            </label>
            <Input
              aria-label="New agent"
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
