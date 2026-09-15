/**
 * First-Class Multi-Agent Kanban Workspace.
 *
 * Provides live task tracking, triage queue management, priority sorting,
 * assignee delegation, and multi-agent workflow handoffs.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import type {
  KanbanTask,
  KanbanTaskState,
  KanbanTaskPriority,
  TriageDraft,
} from "@prismshadow/penguin-core/browser";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Modal } from "../../components/ui/modal";
import { toastSuccess, toastError } from "../../components/ui/toast";
import { KanbanBoardView } from "./kanban-board";

export function KanbanPage() {
  useDocumentTitle(S.nav.kanban ?? "Task Board");
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;

  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [drafts, setDrafts] = useState<TriageDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // New task form state
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<KanbanTaskPriority>("normal");
  const [newAssignee, setNewAssignee] = useState("");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      setLoading(true);
      const [tasksRes, draftsRes] = await Promise.all([
        api.listKanbanTasks(projectId),
        api.listTriageDrafts(projectId).catch(() => ({ drafts: [] })),
      ]);
      if (tasksRes && Array.isArray(tasksRes.tasks)) {
        setTasks(tasksRes.tasks);
      }
      if (draftsRes && Array.isArray(draftsRes.drafts)) {
        setDrafts(draftsRes.drafts);
      } else {
        setDrafts([]);
      }
    } catch (err) {
      console.error("Failed to load kanban tasks:", err);
      toastError("Failed to fetch kanban tasks");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleUpdateTaskState = async (taskId: string, state: KanbanTaskState) => {
    if (!projectId) return;
    const prev = [...tasks];
    setTasks((curr) =>
      curr.map((t) => (t.id === taskId ? { ...t, state, updatedAt: Date.now() } : t)),
    );
    try {
      await api.updateKanbanTask(projectId, taskId, { state });
      toastSuccess(`Task moved to ${state.replace("_", " ")}`);
    } catch (err) {
      setTasks(prev);
      console.error("Failed to update task state:", err);
      toastError("Failed to update task state");
    }
  };

  const handleClaimTask = async (taskId: string, assignee: string) => {
    if (!projectId) return;
    try {
      await api.claimKanbanTask(projectId, taskId, assignee);
      setTasks((curr) =>
        curr.map((t) => (t.id === taskId ? { ...t, assignee, updatedAt: Date.now() } : t)),
      );
      toastSuccess(`Task assigned to ${assignee}`);
    } catch (err) {
      console.error("Failed to claim task:", err);
      toastError("Failed to claim task");
    }
  };

  const handleLaunchDraft = async (draftId: string) => {
    if (!projectId) return;
    try {
      await api.launchTriageDraft(projectId, draftId);
      toastSuccess("Triage draft launched successfully");
      void loadData();
    } catch (err) {
      console.error("Failed to launch draft:", err);
      toastError("Failed to launch triage draft");
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newTitle.trim()) return;
    try {
      setCreating(true);
      const created = await api.createKanbanTask(projectId, {
        title: newTitle.trim(),
        description: newDescription.trim(),
        priority: newPriority,
        assignee: newAssignee.trim() || undefined,
        labels: newTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      if (created && created.task) {
        setTasks((curr) => [created.task, ...curr]);
      } else {
        void loadData();
      }
      toastSuccess("Task created");
      setCreateModalOpen(false);
      setNewTitle("");
      setNewDescription("");
      setNewAssignee("");
      setNewTags("");
      setNewPriority("normal");
    } catch (err) {
      console.error("Failed to create task:", err);
      toastError("Failed to create task");
    } finally {
      setCreating(false);
    }
  };

  const stats = useMemo(() => {
    const total = tasks.length;
    const inProgress = tasks.filter((t) => t.state === "in_progress").length;
    const review = tasks.filter((t) => t.state === "review").length;
    const done = tasks.filter((t) => t.state === "done").length;
    const urgent = tasks.filter((t) => t.priority === "urgent" && t.state !== "done").length;
    return { total, inProgress, review, done, urgent };
  }, [tasks]);

  return (
    <div className="flex h-full w-full flex-col bg-gray-50 dark:bg-gray-950">
      {/* Top Cockpit Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-6 py-3 backdrop-blur-xs dark:border-gray-800 dark:bg-gray-900/80">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Multi-Agent Task Kanban
              </h1>
              <Badge tone="brand">{currentProject?.name ?? "Project"}</Badge>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Autonomous task coordination, triage inbox, and agent workflow handoffs
            </p>
          </div>

          <div className="hidden items-center gap-2 pl-4 md:flex">
            <span className="flex items-center gap-1.5 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300 font-mono">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              {stats.inProgress} Active
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300 font-mono">
              <span className="h-2 w-2 rounded-full bg-purple-500" />
              {stats.review} Review
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300 font-mono">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {stats.done} Done
            </span>
            {stats.urgent > 0 && (
              <span className="flex items-center gap-1.5 rounded-md bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300 font-mono animate-pulse">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                {stats.urgent} Urgent
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => void loadData()}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateModalOpen(true)}>
            + New Task
          </Button>
        </div>
      </header>

      {/* Main Board View */}
      <div className="flex-1 overflow-hidden">
        {loading && tasks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            Loading Kanban Board...
          </div>
        ) : (
          <KanbanBoardView
            tasks={tasks}
            drafts={drafts}
            onUpdateTaskState={handleUpdateTaskState}
            onClaimTask={handleClaimTask}
            onLaunchDraft={handleLaunchDraft}
          />
        )}
      </div>

      {/* Create Task Modal */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create Kanban Task"
      >
        <form onSubmit={handleCreateTask} className="space-y-4 p-4 text-xs">
          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Task Title *
            </label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g., Audit AST parser for incremental cache"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Description
            </label>
            <textarea
              rows={3}
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Describe requirements or context..."
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Priority
              </label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as KanbanTaskPriority)}
                className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Assignee (Agent / User)
              </label>
              <input
                type="text"
                value={newAssignee}
                onChange={(e) => setNewAssignee(e.target.value)}
                placeholder="e.g. backend-developer"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 font-mono"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Tags (comma separated)
            </label>
            <input
              type="text"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              placeholder="frontend, performance, api"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCreateModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={creating}>
              {creating ? "Creating..." : "Create Task"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
