import React, { useState } from "react";
import type { KanbanTask, KanbanTaskState, KanbanTaskPriority, TriageDraft } from "@prismshadow/penguin-core";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";

export interface KanbanBoardViewProps {
  tasks: KanbanTask[];
  drafts?: TriageDraft[];
  onUpdateTaskState: (taskId: string, state: KanbanTaskState) => void;
  onClaimTask?: (taskId: string, assignee: string) => void;
  onLaunchDraft?: (draftId: string) => void;
  onClose?: () => void;
}

const COLUMNS: Array<{ key: KanbanTaskState; title: string; color: string }> = [
  { key: "backlog", title: "Backlog", color: "border-gray-300 dark:border-gray-700" },
  { key: "triage", title: "Triage", color: "border-amber-400 dark:border-amber-600" },
  { key: "in_progress", title: "In Progress", color: "border-blue-400 dark:border-blue-600" },
  { key: "review", title: "Review", color: "border-purple-400 dark:border-purple-600" },
  { key: "done", title: "Done", color: "border-emerald-400 dark:border-emerald-600" },
];

const PRIORITY_BADGES: Record<KanbanTaskPriority, { label: string; class: string }> = {
  urgent: { label: "Urgent", class: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300" },
  high: { label: "High", class: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" },
  normal: { label: "Normal", class: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" },
  low: { label: "Low", class: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
};

export function KanbanBoardView({
  tasks,
  drafts = [],
  onUpdateTaskState,
  onClaimTask,
  onLaunchDraft,
  onClose,
}: KanbanBoardViewProps) {
  const [selectedTask, setSelectedTask] = useState<KanbanTask | null>(null);
  const [filterAssignee, setFilterAssignee] = useState<string>("");

  const filteredTasks = tasks.filter((t) => {
    if (!filterAssignee) return true;
    return t.assignee?.toLowerCase().includes(filterAssignee.toLowerCase());
  });

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans">
      {/* Top Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-md bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold leading-none">Multi-Agent Kanban & Pipeline</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {tasks.length} total tasks · {tasks.filter((t) => t.state === "in_progress").length} active
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <input
            type="text"
            placeholder="Filter assignee..."
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            className="px-2.5 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>

      {/* Triage Drafts Notification Bar */}
      {drafts.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/60 px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
            <span className="font-semibold">{drafts.length} Triage Draft(s) Ready:</span>
            <span>{drafts[0]?.title}</span>
            <span className="text-amber-600 dark:text-amber-400">({drafts[0]?.suggestedTasks.length} subtasks)</span>
          </div>
          {onLaunchDraft && drafts[0] && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => onLaunchDraft(drafts[0]!.id)}
              className="text-xs py-0.5 px-2"
            >
              Launch Pipeline
            </Button>
          )}
        </div>
      )}

      {/* Columns Board */}
      <div className="flex-1 p-6 overflow-x-auto">
        <div className="grid grid-cols-5 gap-4 h-full min-w-[1000px]">
          {COLUMNS.map((col) => {
            const colTasks = filteredTasks.filter((t) => t.state === col.key);
            return (
              <div
                key={col.key}
                className="flex flex-col rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-100/60 dark:bg-gray-900/40 p-3 h-full"
              >
                {/* Column Header */}
                <div className={`flex items-center justify-between pb-2 mb-2 border-b-2 ${col.color}`}>
                  <span className="text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                    {col.title}
                  </span>
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                    {colTasks.length}
                  </span>
                </div>

                {/* Task Cards */}
                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                  {colTasks.map((task) => {
                    const pri = PRIORITY_BADGES[task.priority] ?? PRIORITY_BADGES.normal;
                    return (
                      <div
                        key={task.id}
                        onClick={() => setSelectedTask(task)}
                        className={`group relative rounded-lg border bg-white dark:bg-gray-900 p-3 shadow-2xs hover:shadow-md transition-all cursor-pointer ${
                          selectedTask?.id === task.id
                            ? "border-blue-500 ring-1 ring-blue-500"
                            : "border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1.5 mb-1.5">
                          <span className="text-xs font-semibold leading-snug line-clamp-2">
                            {task.title}
                          </span>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-sm shrink-0 ${pri.class}`}>
                            {pri.label}
                          </span>
                        </div>

                        {task.description && (
                          <p className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2 mb-2">
                            {task.description}
                          </p>
                        )}

                        <div className="flex items-center justify-between pt-1 border-t border-gray-100 dark:border-gray-800 text-[10px] text-gray-500 dark:text-gray-400">
                          <div className="flex items-center gap-1.5">
                            {task.assignee ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 font-mono">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                {task.assignee}
                              </span>
                            ) : (
                              <span className="text-gray-400 italic">Unassigned</span>
                            )}
                          </div>

                          {task.dependencies.length > 0 && (
                            <span className="font-mono" title={`${task.dependencies.length} blocking dependencies`}>
                              🔗 {task.dependencies.length}
                            </span>
                          )}
                        </div>

                        {/* Quick state shift buttons on hover */}
                        <div className="absolute top-2 right-2 hidden group-hover:flex items-center gap-1 bg-white/90 dark:bg-gray-900/90 rounded-md p-0.5 shadow-sm border border-gray-200 dark:border-gray-700">
                          {col.key !== "done" && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const nextState: KanbanTaskState =
                                  col.key === "backlog"
                                    ? "triage"
                                    : col.key === "triage"
                                      ? "in_progress"
                                      : col.key === "in_progress"
                                        ? "review"
                                        : "done";
                                onUpdateTaskState(task.id, nextState);
                              }}
                              className="px-1.5 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700"
                              title="Advance state"
                            >
                              →
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
