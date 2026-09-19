import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonaMask, WorkflowRunState } from "@prismshadow/penguin-core/browser";
import * as api from "../../api/endpoints";
import { apiFetchJson } from "../../api/client";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Modal } from "../../components/ui/modal";
import { PipelineStudioCanvas } from "./pipeline-studio-canvas";
import {
  WorkTool,
  WorkHeader,
  WorkError,
  fieldClass,
  panelClass,
  mutedClass,
} from "../kanban/work-tool-ui";

export function PipelinesPage() {
  useDocumentTitle(S.nav.pipelines);
  const { currentProject } = useProject();
  return currentProject ? (
    <PipelineWorkspace key={currentProject.projectId} projectId={currentProject.projectId} />
  ) : (
    <WorkTool>
      <p>Select a project to view its workflows.</p>
    </WorkTool>
  );
}

export function PipelineWorkspace({ projectId }: { projectId: string }) {
  const [pipelines, setPipelines] = useState<api.PipelineRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [personas, setPersonas] = useState<PersonaMask[]>([]);
  const [run, setRun] = useState<WorkflowRunState | null>(null);
  const [nodeId, setNodeId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [personaError, setPersonaError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [output, setOutput] = useState("{}");
  const [runContext, setRunContext] = useState("{}");
  const generation = useRef(0);
  const base = `/api/projects/${encodeURIComponent(projectId)}/pipelines`;
  const current = pipelines.find((p) => p.id === selectedId) ?? null;
  const node = current?.nodes.find((n) => n.id === nodeId);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    setLoading(true);
    setError("");
    setPersonaError("");
    const results = await Promise.allSettled([api.listPipelines(projectId), api.listPersonas()]);
    if (ticket !== generation.current) return;
    const [pipes, masks] = results;
    if (pipes.status === "fulfilled" && Array.isArray(pipes.value?.pipelines)) {
      setPipelines(pipes.value.pipelines);
      setSelectedId((prev) =>
        pipes.value.pipelines.some((p) => p.id === prev)
          ? prev
          : (pipes.value.pipelines[0]?.id ?? ""),
      );
    } else
      setError(
        pipes.status === "rejected"
          ? message(pipes.reason)
          : "The server did not return workflows.",
      );
    if (masks.status === "fulfilled" && Array.isArray(masks.value?.personas))
      setPersonas(masks.value.personas);
    else
      setPersonaError(
        masks.status === "rejected" ? message(masks.reason) : "The server did not return personas.",
      );
    setLoading(false);
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  async function startRun() {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    try {
      const context = jsonObject(runContext);
      const response = await apiFetchJson<{ run: WorkflowRunState }>(
        `${base}/${encodeURIComponent(current.id)}/runs`,
        { method: "POST", body: { context } },
      );
      if (!response?.run)
        throw new Error("The server did not return a run. Refresh before trying again.");
      setRun(response.run);
      setNodeId(response.run.currentNodeIds[0] ?? "");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function completeNode() {
    if (!run || !node || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetchJson<{ run: WorkflowRunState }>(
        `${base}/${encodeURIComponent(run.pipelineId)}/runs/${encodeURIComponent(run.runId)}/nodes/${encodeURIComponent(node.id)}/complete`,
        { method: "POST", body: { output: jsonObject(output) } },
      );
      if (!response?.run)
        throw new Error("The server did not return a run. Refresh before trying again.");
      setRun(response.run);
      setOutput("{}");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    const definition: api.PipelineRecord = {
      id: `pipe-${crypto.randomUUID()}`,
      name: name.trim(),
      description: description.trim(),
      nodes: [
        { id: "trigger", name: "Start", kind: "trigger" },
        { id: "worker", name: "Worker", kind: "agent", agentRole: "Senior Developer" },
        { id: "output", name: "Output", kind: "output" },
      ],
      edges: [
        { from: "trigger", to: "worker" },
        { from: "worker", to: "output" },
      ],
    };
    try {
      // The create route returns the definition directly, not { pipeline }.
      const saved = await apiFetchJson<api.PipelineRecord>(base, {
        method: "POST",
        body: definition,
      });
      if (!saved?.id || !Array.isArray(saved.nodes))
        throw new Error("The server did not confirm the workflow. Refresh before trying again.");
      setPipelines((prev) => [...prev, saved]);
      setSelectedId(saved.id);
      setRun(null);
      setNodeId("");
      setCreateOpen(false);
      setName("");
      setDescription("");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkTool>
      <WorkHeader
        title="Workflows"
        description="Inspect workflow steps and record their progress. Runs are advanced manually; starting one does not dispatch agents."
      >
        <Button className="min-h-10" disabled={loading || busy} onClick={() => void load()}>
          Refresh
        </Button>
        <Button className="min-h-10" variant="primary" onClick={() => setCreateOpen(true)}>
          New workflow
        </Button>
      </WorkHeader>
      {!createOpen && <WorkError error={error} />}
      {loading && (
        <p role="status" className={mutedClass}>
          Loading workflows…
        </p>
      )}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3" aria-label="Workflows">
          <h2 className="font-semibold">
            Saved workflows <span className={mutedClass}>({pipelines.length})</span>
          </h2>
          <div className="max-h-96 overflow-y-auto space-y-2">
            {pipelines.map((p) => (
              <button
                key={p.id}
                disabled={busy}
                aria-pressed={selectedId === p.id}
                onClick={() => {
                  setSelectedId(p.id);
                  setNodeId("");
                  setRun(null);
                  setOutput("{}");
                  setError("");
                }}
                className={`w-full text-left ${panelClass} ${selectedId === p.id ? "border-brand-600 dark:border-brand-400" : "hover:border-gray-400"}`}
              >
                <span className="block font-semibold break-words">{p.name}</span>
                <span className={mutedClass}>
                  {p.nodes.length} steps · {p.edges.length} connections
                </span>
              </button>
            ))}
          </div>
          {!loading && !pipelines.length && !error && (
            <p className={mutedClass}>
              No workflows yet. Create a starter workflow to define your first run.
            </p>
          )}
          <details className={panelClass}>
            <summary className="cursor-pointer font-medium">
              Available personas ({personas.length})
            </summary>
            <WorkError error={personaError} />
            <ul className="mt-3 max-h-80 overflow-y-auto space-y-3">
              {personas.map((p) => (
                <li key={p.id}>
                  <strong className="font-medium">{p.name}</strong>
                  <p className={mutedClass}>{p.description}</p>
                </li>
              ))}
            </ul>
            {!personas.length && !personaError && (
              <p className={mutedClass}>No personas available.</p>
            )}
          </details>
        </aside>
        <section className="min-w-0 space-y-5">
          {current && (
            <>
              <div>
                <h2 className="text-xl font-semibold break-words">{current.name}</h2>
                <p className={mutedClass}>{current.description}</p>
              </div>
              <div className={panelClass}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-semibold">{run ? `Run: ${run.status}` : "Start a run"}</h3>
                  <Button
                    className="min-h-10"
                    variant="primary"
                    disabled={busy || run?.status === "running"}
                    onClick={() => void startRun()}
                  >
                    {busy ? "Working…" : "Start run"}
                  </Button>
                </div>
                {run ? (
                  <div className="mt-3 space-y-2">
                    <p className="break-all font-mono text-xs">{run.runId}</p>
                    <p className={mutedClass}>
                      Current steps:{" "}
                      {run.currentNodeIds
                        .map((id) => current.nodes.find((n) => n.id === id)?.name ?? id)
                        .join(", ") || "None"}
                    </p>
                  </div>
                ) : (
                  <label className="mt-3 block">
                    Initial context (JSON object)
                    <textarea
                      className={`${fieldClass} mt-2 font-mono`}
                      value={runContext}
                      onChange={(e) => setRunContext(e.target.value)}
                      rows={3}
                    />
                  </label>
                )}
              </div>
              <PipelineStudioCanvas
                pipeline={current}
                run={run}
                selectedNodeId={nodeId}
                onSelectNode={(id) => {
                  setNodeId(id);
                  setOutput("{}");
                }}
              />
              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,1fr)]">
                <div className="space-y-3">
                  <h3 className="font-semibold">Steps & connections</h3>
                  <p className={mutedClass}>
                    Select a step to inspect its settings. Connections below reflect the saved
                    graph, not list order.
                  </p>
                  {current.nodes.map((n) => (
                    <button
                      key={n.id}
                      aria-pressed={nodeId === n.id}
                      onClick={() => {
                        setNodeId(n.id);
                        setOutput("{}");
                      }}
                      className={`w-full text-left ${panelClass} ${nodeId === n.id ? "border-brand-600 dark:border-brand-400" : "hover:border-gray-400"}`}
                    >
                      <span className="flex flex-wrap justify-between gap-2">
                        <strong className="font-semibold break-words">{n.name}</strong>
                        <span className={mutedClass}>
                          {run?.nodeStates[n.id]?.status ?? n.kind}
                        </span>
                      </span>
                      <span className={`mt-2 block ${mutedClass}`}>
                        {current.edges
                          .filter((e) => e.from === n.id)
                          .map(
                            (e) =>
                              `→ ${current.nodes.find((target) => target.id === e.to)?.name ?? e.to}${e.conditionValue === undefined ? "" : ` (${String(e.conditionValue)})`}`,
                          )
                          .join(" · ") || "No outgoing connections"}
                      </span>
                    </button>
                  ))}
                </div>
                <section className={`${panelClass} self-start space-y-4`} aria-label="Step details">
                  {node ? (
                    <>
                      <h3 className="text-lg font-semibold break-words">{node.name}</h3>
                      <dl className="space-y-2">
                        <dt className={mutedClass}>Step ID</dt>
                        <dd className="font-mono break-all">{node.id}</dd>
                        <dt className={mutedClass}>Kind</dt>
                        <dd>{node.kind}</dd>
                        {node.agentRole && (
                          <>
                            <dt className={mutedClass}>Assigned role</dt>
                            <dd>{node.agentRole}</dd>
                          </>
                        )}
                      </dl>
                      {node.summary && <p className={mutedClass}>{node.summary}</p>}
                      {node.conditionField && (
                        <p className="break-words font-mono">
                          context.{node.conditionField} = {JSON.stringify(node.conditionExpected)}
                        </p>
                      )}
                      {run?.status === "running" && run.currentNodeIds.includes(node.id) && (
                        <>
                          <p className={mutedClass}>
                            Record the result after this step’s work is finished. This updates the
                            run; it does not execute the work.
                          </p>
                          <label className="block">
                            Step output (JSON object)
                            <textarea
                              className={`${fieldClass} mt-2 font-mono`}
                              rows={4}
                              value={output}
                              onChange={(e) => setOutput(e.target.value)}
                            />
                          </label>
                          <Button
                            className="min-h-10"
                            disabled={busy}
                            onClick={() => void completeNode()}
                          >
                            Mark step complete
                          </Button>
                        </>
                      )}
                    </>
                  ) : (
                    <p className={mutedClass}>
                      Select a step to view its role, conditions, and run controls.
                    </p>
                  )}
                </section>
              </div>
            </>
          )}
        </section>
      </div>
      <Modal
        open={createOpen}
        onClose={() => {
          if (!busy) setCreateOpen(false);
        }}
        title="New workflow"
      >
        <form className="space-y-4" onSubmit={create}>
          <WorkError error={error} />
          <p className={mutedClass}>
            Creates a three-step starter: Start → Worker → Output. You can inspect and manually
            advance runs here.
          </p>
          <label className="block">
            Name
            <input
              required
              className={`${fieldClass} mt-1`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            Description
            <textarea
              className={`${fieldClass} mt-1`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
              Create workflow
            </Button>
          </div>
        </form>
      </Modal>
    </WorkTool>
  );
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed. Please try again.";
}
function jsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Enter a JSON object, for example {}.");
  return Object.fromEntries(Object.entries(parsed));
}
