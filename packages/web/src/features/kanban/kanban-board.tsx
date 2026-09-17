import { useState } from "react";
import type { KanbanTask, KanbanTaskState, TriageDraft } from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { Modal } from "../../components/ui/modal";
import { fieldClass, mutedClass, panelClass, WorkError } from "./work-tool-ui";

export interface KanbanBoardViewProps {
  tasks: KanbanTask[];
  drafts?: TriageDraft[];
  onUpdateTaskState: (taskId: string, state: KanbanTaskState) => void;
  onClaimTask?: (taskId: string, assignee: string) => void;
  onLaunchDraft?: (draftId: string) => void;
  onClose?: () => void;
  busy?: boolean;
  error?: string;
}
const columns: Array<{ key: KanbanTaskState; title: string }> = [
  { key: "backlog", title: "Backlog" },
  { key: "triage", title: "Triage" },
  { key: "in_progress", title: "In progress" },
  { key: "review", title: "Review" },
  { key: "done", title: "Done" },
  { key: "failed", title: "Failed" },
  { key: "archived", title: "Archived" },
];
const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
export function KanbanBoardView({
  tasks,
  drafts = [],
  onUpdateTaskState,
  onClaimTask,
  onLaunchDraft,
  onClose,
  busy = false,
  error,
}: KanbanBoardViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [state, setState] = useState("all");
  const selected = tasks.find((t) => t.id === selectedId);
  const filtered = tasks
    .filter(
      (t) =>
        (!owner || t.assignee?.toLowerCase().includes(owner.toLowerCase())) &&
        (!query ||
          `${t.title} ${t.description} ${taskLabels(t).join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort((a, b) => rank[a.priority] - rank[b.priority] || b.createdAt - a.createdAt);
  return (
    <div className="min-w-0 space-y-5 text-sm text-gray-900 dark:text-gray-100">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-52">
          Search tasks
          <input
            className={`${fieldClass} mt-1`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title, description, or label"
          />
        </label>
        <label className="min-w-0 flex-1 basis-40">
          Assignee
          <input
            className={`${fieldClass} mt-1`}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="All assignees"
          />
        </label>
        <label className="min-w-0 flex-1 basis-40">
          Show status
          <select
            className={`${fieldClass} mt-1`}
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="all">All statuses</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        {onClose && (
          <Button className="min-h-10" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
      {drafts.length > 0 && (
        <details className={panelClass} open>
          <summary className="cursor-pointer font-semibold">Triage inbox ({drafts.length})</summary>
          <p className={mutedClass}>Review drafts before adding them to the task board.</p>
          <ul className="mt-3 max-h-80 overflow-auto divide-y divide-gray-200 dark:divide-gray-800">
            {drafts.map((draft) => (
              <li key={draft.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <h3 className="font-medium break-words">{draft.title}</h3>
                  <p className={mutedClass}>{draft.suggestedTasks.length} suggested tasks</p>
                </div>
                {onLaunchDraft && (
                  <Button
                    className="min-h-10"
                    disabled={busy}
                    onClick={() => onLaunchDraft(draft.id)}
                  >
                    Add draft to board
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className={mutedClass}>
        {filtered.length} of {tasks.length} tasks · Highest priority first
      </p>
      <div
        className={`grid min-w-0 gap-4 ${state === "all" ? "md:grid-cols-2 2xl:grid-cols-5" : ""}`}
      >
        {columns
          .filter((c) => state === "all" || c.key === state)
          .map((col) => {
            const items = filtered.filter((t) => t.state === col.key);
            return (
              <section
                key={col.key}
                aria-label={col.title}
                className="min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-gray-900"
              >
                <h2 className="mb-3 flex items-center justify-between font-semibold">
                  {col.title}
                  <span className="text-sm font-normal text-gray-500">{items.length}</span>
                </h2>
                <div className="max-h-[38rem] space-y-3 overflow-y-auto">
                  {items.map((task) => (
                    <article className={`${panelClass} space-y-3`} key={task.id}>
                      <button
                        className="min-h-10 w-full text-left font-semibold break-words hover:underline"
                        onClick={() => {
                          setSelectedId(task.id);
                          setAssignee(task.assignee ?? "");
                        }}
                      >
                        {task.title}
                      </button>
                      <p className="line-clamp-3 text-gray-600 dark:text-gray-400">
                        {task.description}
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
                        <span
                          className={
                            task.priority === "urgent"
                              ? "text-red-700 dark:text-red-300"
                              : "capitalize"
                          }
                        >
                          {task.priority}
                        </span>
                        <span className="break-all">{task.assignee || "Unassigned"}</span>
                        {task.dependencies.length > 0 && (
                          <span>{task.dependencies.length} dependencies</span>
                        )}
                      </div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400">
                        Move task
                        <select
                          aria-label={`Status for ${task.title}`}
                          className={`${fieldClass} mt-1`}
                          value={task.state}
                          disabled={busy}
                          onChange={(e) => {
                            const next = columns.find((c) => c.key === e.target.value);
                            if (next) onUpdateTaskState(task.id, next.key);
                          }}
                        >
                          {columns.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    </article>
                  ))}
                  {!items.length && (
                    <p className={`${mutedClass} py-4`}>
                      {tasks.length ? "No matching tasks in this status." : "No tasks yet."}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
      </div>
      <Modal
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.title ?? "Task details"}
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <WorkError error={error} />
            <p className="whitespace-pre-wrap break-words leading-6">
              {selected.description || "No description."}
            </p>
            <dl className="space-y-2">
              <dt className={mutedClass}>Task ID</dt>
              <dd className="font-mono break-all">{selected.id}</dd>
              <dt className={mutedClass}>Labels</dt>
              <dd>{taskLabels(selected).join(", ") || "None"}</dd>
              <dt className={mutedClass}>Dependencies</dt>
              <dd>
                {selected.dependencies
                  .map((id) => tasks.find((t) => t.id === id)?.title ?? id)
                  .join(", ") || "None"}
              </dd>
            </dl>
            {onClaimTask && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (assignee.trim()) onClaimTask(selected.id, assignee.trim());
                }}
                className="space-y-3"
              >
                <label className="block">
                  Assign to agent or user
                  <input
                    className={`${fieldClass} mt-1`}
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    required
                  />
                </label>
                <Button type="submit" className="min-h-10" disabled={busy || !assignee.trim()}>
                  Assign task
                </Button>
              </form>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

export function taskLabels(task: KanbanTask): string[] {
  const labels = task.metadata?.labels;
  return Array.isArray(labels)
    ? labels.filter((label): label is string => typeof label === "string")
    : [];
}
