import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KanbanTask,
  KanbanTaskPriority,
  KanbanTaskState,
  TriageDraft,
} from "@prismshadow/penguin-core/browser";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Modal } from "../../components/ui/modal";
import { toastSuccess } from "../../components/ui/toast";
import { KanbanBoardView } from "./kanban-board";
import { WorkTool, WorkHeader, WorkError, fieldClass, mutedClass } from "./work-tool-ui";

export function KanbanPage() {
  useDocumentTitle(S.nav.kanban);
  const { currentProject } = useProject();
  return currentProject ? (
    <KanbanWorkspace key={currentProject.projectId} projectId={currentProject.projectId} />
  ) : (
    <WorkTool>
      <p>Select a project to view its tasks.</p>
    </WorkTool>
  );
}
export function KanbanWorkspace({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [drafts, setDrafts] = useState<TriageDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftError, setDraftError] = useState("");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<KanbanTaskPriority>("normal");
  const [assignee, setAssignee] = useState("");
  const [tags, setTags] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    setLoading(true);
    setError("");
    setDraftError("");
    const [taskResult, draftResult] = await Promise.allSettled([
      api.listKanbanTasks(projectId),
      api.listTriageDrafts(projectId),
    ]);
    if (ticket !== generation.current) return;
    if (taskResult.status === "fulfilled") setTasks(taskResult.value.tasks);
    else setError(message(taskResult.reason));
    if (draftResult.status === "fulfilled") setDrafts(draftResult.value.drafts);
    else setDraftError(`Triage inbox: ${message(draftResult.reason)}`);
    setLoading(false);
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  async function update(id: string, state?: KanbanTaskState, owner?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Assignment is not a worker lease claim. Use the ordinary task update route.
      const response = await api.updateKanbanTask(
        projectId,
        id,
        state ? { state } : { assignee: owner },
      );
      if (!response?.task)
        throw new Error("The server did not confirm the task update. Refresh before trying again.");
      setTasks((prev) => prev.map((t) => (t.id === id ? response.task : t)));
      toastSuccess("Task updated");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function launch(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.launchTriageDraft(projectId, id);
      await load();
      toastSuccess("Draft added to the board");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.createKanbanTask(projectId, {
        title: title.trim(),
        description: description.trim(),
        priority,
        assignee: assignee.trim() || undefined,
        labels: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      if (!response?.task)
        throw new Error("The server did not confirm the new task. Refresh before trying again.");
      setTasks((prev) => [response.task, ...prev]);
      setOpen(false);
      setTitle("");
      setDescription("");
      setPriority("normal");
      setAssignee("");
      setTags("");
      toastSuccess("Task created");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkTool>
      <WorkHeader
        title="Task board"
        description="Prioritize work, assign ownership, and move tasks through review. Drafts wait in the triage inbox until you add them."
      >
        <Button className="min-h-10" disabled={busy || loading} onClick={() => void load()}>
          Refresh
        </Button>
        <Button className="min-h-10" variant="primary" onClick={() => setOpen(true)}>
          New task
        </Button>
      </WorkHeader>
      {!open && <WorkError error={error} />}
      <WorkError error={draftError} />
      {loading && (
        <p role="status" className={mutedClass}>
          Loading task board…
        </p>
      )}
      <KanbanBoardView
        tasks={tasks}
        drafts={drafts}
        busy={busy || loading}
        error={error}
        onUpdateTaskState={(id, state) => void update(id, state)}
        onClaimTask={(id, owner) => void update(id, undefined, owner)}
        onLaunchDraft={(id) => void launch(id)}
      />
      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="New task"
      >
        <form className="space-y-4 text-sm" onSubmit={create}>
          <WorkError error={error} />
          <label className="block">
            Title
            <input
              required
              maxLength={300}
              className={`${fieldClass} mt-1`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block">
            Description
            <textarea
              rows={4}
              className={`${fieldClass} mt-1`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              Priority
              <select
                className={`${fieldClass} mt-1`}
                value={priority}
                onChange={(e) => {
                  const value = e.target.value;
                  if (
                    value === "low" ||
                    value === "normal" ||
                    value === "high" ||
                    value === "urgent"
                  )
                    setPriority(value);
                }}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label>
              Assignee
              <input
                className={`${fieldClass} mt-1`}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
            </label>
          </div>
          <label className="block">
            Labels (comma separated)
            <input
              className={`${fieldClass} mt-1`}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
              {busy ? "Creating…" : "Create task"}
            </Button>
          </div>
        </form>
      </Modal>
    </WorkTool>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "Request failed. Please try again.";
}
