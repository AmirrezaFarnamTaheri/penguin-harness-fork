/**
 * Autonomous Workflow Pipeline & Organization DAG Workspace.
 *
 * Provides visual directed acyclic graph (DAG) pipelines, conditional gate inspection,
 * persona mask assignment, and step-by-step pipeline execution stepping.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowRunState,
  WorkflowNodeKind,
  PersonaMask,
} from "@prismshadow/penguin-core";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Modal } from "../../components/ui/modal";
import { toastSuccess, toastError } from "../../components/ui/toast";

interface PipelineSummary {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt?: number;
}

const KIND_COLORS: Record<WorkflowNodeKind, { bg: string; border: string; text: string; badge: string }> = {
  trigger: {
    bg: "bg-amber-500/10 dark:bg-amber-950/30",
    border: "border-amber-500/30 dark:border-amber-600/40",
    text: "text-amber-700 dark:text-amber-400",
    badge: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  },
  agent: {
    bg: "bg-cyan-500/10 dark:bg-cyan-950/30",
    border: "border-cyan-500/30 dark:border-cyan-600/40",
    text: "text-cyan-700 dark:text-cyan-400",
    badge: "border-cyan-500/40 text-cyan-600 dark:text-cyan-300",
  },
  condition: {
    bg: "bg-purple-500/10 dark:bg-purple-950/30",
    border: "border-purple-500/30 dark:border-purple-600/40",
    text: "text-purple-700 dark:text-purple-400",
    badge: "border-purple-500/40 text-purple-600 dark:text-purple-300",
  },
  gate: {
    bg: "bg-rose-500/10 dark:bg-rose-950/30",
    border: "border-rose-500/30 dark:border-rose-600/40",
    text: "text-rose-700 dark:text-rose-400",
    badge: "border-rose-500/40 text-rose-600 dark:text-rose-300",
  },
  output: {
    bg: "bg-emerald-500/10 dark:bg-emerald-950/30",
    border: "border-emerald-500/30 dark:border-emerald-600/40",
    text: "text-emerald-700 dark:text-emerald-400",
    badge: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
  },
};

export function PipelinesPage() {
  useDocumentTitle(S.nav.pipelines ?? "Pipelines");
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;

  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [personas, setPersonas] = useState<PersonaMask[]>([]);
  const [activeRun, setActiveRun] = useState<WorkflowRunState | null>(null);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);

  // New pipeline creation modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      setLoading(true);
      const [pipeRes, personaRes] = await Promise.all([
        api.listPipelines(projectId).catch(() => ({ pipelines: [] })),
        api.listPersonas().catch(() => ({ personas: [] })),
      ]);

      const loadedPipes: PipelineSummary[] = Array.isArray(pipeRes?.pipelines)
        ? pipeRes.pipelines
        : [
            // Sample default template if empty
            {
              id: "pipeline-triage-impl",
              name: "Autonomous Triage & Implementation Loop",
              description: "Schedules triage review, gates requirements, dispatches specialized subagent, and validates results.",
              nodes: [
                { id: "node-trigger", name: "Inbound Task Trigger", kind: "trigger", summary: "Fired when new task enters backlog" },
                { id: "node-triage", name: "Analyst Triage & Scope", kind: "agent", agentRole: "analyst", summary: "Verify clarity and acceptance criteria" },
                { id: "node-gate-review", name: "Specification Approval Gate", kind: "gate", summary: "Human-in-the-loop or consensus signoff" },
                { id: "node-exec", name: "Senior Developer Executor", kind: "agent", agentRole: "Senior Developer", summary: "Build implementation with test suite" },
                { id: "node-qa-condition", name: "Test Suite Evaluation", kind: "condition", conditionField: "test_passed", conditionExpected: true },
                { id: "node-output", name: "Production Artifact & Report", kind: "output", summary: "Publish commit & audit summary" },
              ],
              edges: [
                { from: "node-trigger", to: "node-triage" },
                { from: "node-triage", to: "node-gate-review" },
                { from: "node-gate-review", to: "node-exec" },
                { from: "node-exec", to: "node-qa-condition" },
                { from: "node-qa-condition", to: "node-output", conditionValue: true },
              ],
            },
          ];

      setPipelines(loadedPipes);
      const firstPipe = loadedPipes[0];
      if (firstPipe && !selectedPipelineId) {
        setSelectedPipelineId(firstPipe.id);
        setSelectedNode(firstPipe.nodes[0] ?? null);
      }
      if (Array.isArray(personaRes?.personas)) {
        setPersonas(personaRes.personas);
      }
    } catch (err) {
      console.error("Failed to load pipelines:", err);
      toastError("Failed to fetch pipelines");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedPipelineId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const currentPipeline = useMemo(() => {
    return pipelines.find((p) => p.id === selectedPipelineId) ?? pipelines[0] ?? null;
  }, [pipelines, selectedPipelineId]);

  const handleRunPipeline = async () => {
    if (!projectId || !currentPipeline) return;
    try {
      setExecuting(true);
      const res = await api.runPipeline(projectId, currentPipeline.id, {
        startedAt: Date.now(),
        author: "User",
      });
      if (res && res.run) {
        setActiveRun(res.run);
        toastSuccess(`Pipeline run started (#${res.run.runId.slice(0, 8)})`);
      } else {
        // Mock run simulation for preview
        const mockRun: WorkflowRunState = {
          runId: `run-${Date.now().toString(36)}`,
          pipelineId: currentPipeline.id,
          status: "running",
          currentNodeIds: [currentPipeline.nodes[0]?.id || "node-trigger"],
          nodeStates: {
            [currentPipeline.nodes[0]?.id || "node-trigger"]: {
              nodeId: currentPipeline.nodes[0]?.id || "node-trigger",
              status: "succeeded",
              startedAt: Date.now(),
              completedAt: Date.now() + 120,
            },
            [currentPipeline.nodes[1]?.id || "node-triage"]: {
              nodeId: currentPipeline.nodes[1]?.id || "node-triage",
              status: "running",
              startedAt: Date.now(),
            },
          },
          context: { triggerTime: Date.now() },
          startedAt: Date.now(),
        };
        setActiveRun(mockRun);
        toastSuccess("Pipeline execution simulated");
      }
    } catch (err) {
      console.error("Failed to execute pipeline:", err);
      toastError("Failed to trigger pipeline execution");
    } finally {
      setExecuting(false);
    }
  };

  const handleStepRun = async () => {
    if (!projectId || !activeRun) return;
    try {
      const res = await api.stepPipelineRun(projectId, activeRun.pipelineId, activeRun.runId);
      if (res && res.run) {
        setActiveRun(res.run);
        toastSuccess("Advanced to next step");
      } else {
        // Advance to next node locally
        const nodes = currentPipeline?.nodes || [];
        const currentIndex = nodes.findIndex((n) => activeRun.currentNodeIds.includes(n.id));
        const nextIndex = (currentIndex + 1) % nodes.length;
        const nextNode = nodes[nextIndex];
        if (nextNode) {
          setActiveRun((prev) =>
            prev
              ? {
                  ...prev,
                  currentNodeIds: [nextNode.id],
                  nodeStates: {
                    ...prev.nodeStates,
                    [nextNode.id]: {
                      nodeId: nextNode.id,
                      status: nextIndex === nodes.length - 1 ? "succeeded" : "running",
                      startedAt: Date.now(),
                    },
                  },
                }
              : null,
          );
          toastSuccess(`Advanced step: ${nextNode.name}`);
        }
      }
    } catch (err) {
      console.error("Failed to step pipeline:", err);
      toastError("Step execution failed");
    }
  };

  const handleCreatePipeline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newName.trim()) return;
    try {
      const newPipe: PipelineSummary = {
        id: `pipe-${Date.now().toString(36)}`,
        name: newName.trim(),
        description: newDesc.trim(),
        nodes: [
          { id: "node-trigger", name: "Trigger", kind: "trigger" },
          { id: "node-agent", name: "Worker Agent", kind: "agent", agentRole: "Senior Developer" },
          { id: "node-output", name: "Output Artifact", kind: "output" },
        ],
        edges: [
          { from: "node-trigger", to: "node-agent" },
          { from: "node-agent", to: "node-output" },
        ],
      };
      await api.createPipeline(projectId, newPipe);
      setPipelines((prev) => [...prev, newPipe]);
      setSelectedPipelineId(newPipe.id);
      setCreateOpen(false);
      setNewName("");
      setNewDesc("");
      toastSuccess("Workflow pipeline created");
    } catch (err) {
      console.error("Failed to create pipeline:", err);
      toastError("Failed to save new pipeline");
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-gray-50 dark:bg-gray-950 font-sans">
      {/* Top Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-6 py-3 backdrop-blur-xs dark:border-gray-800 dark:bg-gray-900/80">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Workflow Pipelines & Organization DAG
              </h1>
              <Badge tone="brand">
                Active DAG Runner
              </Badge>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Autonomous multi-agent execution graphs, condition gates, and persona orchestration
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            + New Pipeline
          </Button>
          {activeRun && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleStepRun()}
              className="border-amber-500/40 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
            >
              Step Forward
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleRunPipeline()}
            disabled={executing || !currentPipeline}
          >
            {executing ? "Running..." : "▶ Run Pipeline"}
          </Button>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Pipeline Selector Sidebar */}
        <div className="w-72 shrink-0 border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/50 flex flex-col">
          <div className="p-3 border-b border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Workflows ({pipelines.length})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {pipelines.map((p) => {
              const active = p.id === selectedPipelineId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setSelectedPipelineId(p.id);
                    setSelectedNode(p.nodes[0] ?? null);
                  }}
                  className={`w-full text-left p-3 rounded-lg border transition-all text-xs ${
                    active
                      ? "border-blue-500/40 bg-blue-50/50 dark:border-blue-500/40 dark:bg-blue-950/20 text-gray-900 dark:text-gray-100 font-medium"
                      : "border-transparent hover:border-gray-200 dark:hover:border-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100/50 dark:hover:bg-gray-800/40"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="truncate font-semibold">{p.name}</span>
                    <span className="text-[10px] font-mono opacity-60">
                      {p.nodes.length} nodes
                    </span>
                  </div>
                  {p.description && (
                    <p className="line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
                      {p.description}
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Active Run Status Badge at bottom of left sidebar */}
          {activeRun && (
            <div className="p-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/30 text-[11px]">
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-gray-700 dark:text-gray-300">Active Run</span>
                <span className="font-mono text-xs text-blue-600 dark:text-blue-400 font-medium">
                  {activeRun.status.toUpperCase()}
                </span>
              </div>
              <div className="text-gray-500 dark:text-gray-400 font-mono text-[10px]">
                ID: {activeRun.runId}
              </div>
            </div>
          )}
        </div>

        {/* Center: DAG Graph Canvas */}
        <div className="flex-1 flex flex-col bg-gray-100/60 dark:bg-gray-950 overflow-hidden relative">
          <div className="p-3 border-b border-gray-200/80 dark:border-gray-800/80 bg-white/50 dark:bg-gray-900/30 flex items-center justify-between text-xs">
            <span className="font-medium text-gray-700 dark:text-gray-300">
              {currentPipeline?.name ?? "No Pipeline Selected"}
            </span>
            <div className="flex items-center gap-3 text-[11px] text-gray-500 font-mono">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-500" /> Trigger
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-cyan-500" /> Agent
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-purple-500" /> Condition
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-rose-500" /> Gate
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> Output
              </span>
            </div>
          </div>

          {/* Interactive DAG Topological Flow */}
          <div className="flex-1 overflow-auto p-8 flex flex-col items-center justify-center gap-6">
            {currentPipeline?.nodes.map((node, index) => {
              const kindStyle = KIND_COLORS[node.kind] || KIND_COLORS.agent;
              const isSelected = selectedNode?.id === node.id;
              const nodeRunState = activeRun?.nodeStates[node.id];
              const isCurrent = activeRun?.currentNodeIds.includes(node.id);

              return (
                <div key={node.id} className="flex flex-col items-center">
                  {/* The Node Card */}
                  <div
                    onClick={() => setSelectedNode(node)}
                    className={`cursor-pointer w-96 p-4 rounded-xl border transition-all shadow-xs ${
                      kindStyle.bg
                    } ${kindStyle.border} ${
                      isSelected
                        ? "ring-2 ring-blue-500 dark:ring-blue-400 shadow-md"
                        : "hover:shadow-md hover:border-gray-400 dark:hover:border-gray-600"
                    } ${isCurrent ? "animate-pulse ring-2 ring-amber-400" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase font-semibold ${kindStyle.badge}`}
                        >
                          {node.kind}
                        </span>
                        {nodeRunState && (
                          <span
                            className={`px-1.5 py-0.2 text-[10px] font-mono rounded-sm ${
                              nodeRunState.status === "succeeded"
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                                : nodeRunState.status === "running"
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                                : "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                            }`}
                          >
                            {nodeRunState.status}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[11px] text-gray-400">{node.id}</span>
                    </div>

                    <div className="font-medium text-xs text-gray-900 dark:text-gray-100">
                      {node.name}
                    </div>

                    {node.agentRole && (
                      <div className="mt-1.5 text-[11px] flex items-center gap-1 text-cyan-600 dark:text-cyan-400 font-mono">
                        <span>Role:</span>
                        <span className="font-semibold">{node.agentRole}</span>
                      </div>
                    )}

                    {node.summary && (
                      <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">
                        {node.summary}
                      </p>
                    )}
                  </div>

                  {/* Directed Edge Connector Arrow */}
                  {index < currentPipeline.nodes.length - 1 && (
                    <div className="flex flex-col items-center py-2 text-gray-400 dark:text-gray-600">
                      <div className="w-0.5 h-6 bg-gray-300 dark:bg-gray-700" />
                      <svg className="w-4 h-4 -mt-1 text-gray-400 dark:text-gray-600" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Node & Persona Inspector Side Panel */}
        <div className="w-80 shrink-0 border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 flex flex-col">
          <div className="p-3 border-b border-gray-200 dark:border-gray-800">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Node Inspector
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
            {selectedNode ? (
              <div className="space-y-4">
                <div>
                  <div className="text-[11px] text-gray-400 font-mono">Node ID</div>
                  <div className="font-mono font-medium text-gray-900 dark:text-gray-100">
                    {selectedNode.id}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] text-gray-400 font-mono">Node Name</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {selectedNode.name}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] text-gray-400 font-mono">Kind</div>
                  <Badge tone="brand">
                    {selectedNode.kind.toUpperCase()}
                  </Badge>
                </div>

                {selectedNode.agentRole && (
                  <div>
                    <div className="text-[11px] text-gray-400 font-mono">Assigned Persona / Role</div>
                    <div className="mt-1 font-mono text-cyan-600 dark:text-cyan-400 font-medium">
                      {selectedNode.agentRole}
                    </div>
                  </div>
                )}

                {selectedNode.conditionField && (
                  <div className="p-2.5 rounded-md border border-purple-200 bg-purple-50/50 dark:border-purple-800/40 dark:bg-purple-950/20">
                    <div className="text-[11px] font-semibold text-purple-700 dark:text-purple-300">
                      Branch Condition
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-purple-900 dark:text-purple-200">
                      if context.{selectedNode.conditionField} === {String(selectedNode.conditionExpected)}
                    </div>
                  </div>
                )}

                {selectedNode.summary && (
                  <div>
                    <div className="text-[11px] text-gray-400 font-mono">Summary</div>
                    <div className="mt-1 text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/50 p-2.5 rounded-md border border-gray-200 dark:border-gray-800 leading-relaxed">
                      {selectedNode.summary}
                    </div>
                  </div>
                )}

                {/* Available Personas List */}
                <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                  <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Available Persona Masks ({personas.length})
                  </div>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {personas.map((p) => (
                      <div
                        key={p.id}
                        className="p-2 rounded border border-gray-200 dark:border-gray-800 hover:border-blue-400 text-[11px]"
                      >
                        <div className="font-semibold text-gray-800 dark:text-gray-200">
                          {p.name}
                        </div>
                        <div className="text-[10px] text-gray-500 line-clamp-1">{p.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-gray-400 text-center py-8">
                Select a DAG node to inspect parameters and persona assignments.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create Pipeline Modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create New Pipeline">
        <form onSubmit={handleCreatePipeline} className="space-y-4 p-4 text-xs">
          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Pipeline Name *
            </label>
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Code Review & QA Verification Pipeline"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Description
            </label>
            <textarea
              rows={3}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Describe the workflow purpose..."
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 font-mono"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Create Workflow
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
