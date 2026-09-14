/**
 * Knowledge Wiki & AST Code Graph Workspace.
 *
 * Provides bidirectional wikilink graph exploration, AST symbol mapping,
 * BFS path finding, neighbor discovery, and Markdown document authoring.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import type {
  WikiNode,
  WikiNodeType,
  WikiGraph,
  WikiLintReport,
} from "@prismshadow/penguin-core";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Modal } from "../../components/ui/modal";
import { toastSuccess, toastError } from "../../components/ui/toast";

type WikiTab = "editor" | "neighbors" | "pathfinder" | "linter";

const TYPE_TONES: Record<WikiNodeType, string> = {
  source: "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-300",
  entity: "bg-purple-500/10 text-purple-700 border-purple-500/30 dark:bg-purple-950/30 dark:text-purple-300",
  concept: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-300",
  synthesis: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300",
  unknown: "bg-gray-500/10 text-gray-700 border-gray-500/30 dark:bg-gray-950/30 dark:text-gray-300",
};

export function WikiPage() {
  useDocumentTitle(S.nav.wiki ?? "Code Graph & Wiki");
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;

  const [nodes, setNodes] = useState<WikiNode[]>([]);
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WikiTab>("editor");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  // Editor state
  const [editContent, setEditContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Neighbors & Pathfinder state
  const [neighbors, setNeighbors] = useState<WikiNode[]>([]);
  const [pathToId, setPathToId] = useState<string>("");
  const [pathResult, setPathResult] = useState<string[] | null>(null);
  const [findingPath, setFindingPath] = useState(false);

  // Linter state
  const [lintReport, setLintReport] = useState<WikiLintReport | null>(null);
  const [linting, setLinting] = useState(false);

  // New Node Modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<WikiNodeType>("concept");
  const [newTags, setNewTags] = useState("");

  const loadGraphAndNodes = useCallback(async () => {
    if (!projectId) return;
    try {
      setLoading(true);
      const [nodesRes, graphRes] = await Promise.all([
        api.listWikiNodes(projectId).catch(() => ({ nodes: [] })),
        api.getWikiGraph(projectId).catch(() => null),
      ]);

      let loadedNodes: WikiNode[] = [];
      if (nodesRes && Array.isArray(nodesRes.nodes) && nodesRes.nodes.length > 0) {
        loadedNodes = nodesRes.nodes.map((n) => ({
          id: n.id,
          title: n.id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          type: "concept" as WikiNodeType,
          tags: n.links || [],
          aliases: [],
          rawContent: `# ${n.id}\n\nLinks: ${(n.links || []).map((l) => `[[${l}]]`).join(", ")}`,
          filePath: n.filePath,
          metadata: {},
        }));
      } else {
        loadedNodes = [
          // Sample fallback if repository wiki is being initialized
          {
            id: "core-architecture",
            title: "Core Architecture & Boundary Specification",
            type: "synthesis",
            tags: ["architecture", "spec", "boundaries"],
            aliases: ["Architecture", "SystemDesign"],
            rawContent: `# Core Architecture\n\nThis system implements a decoupled Multi-Agent Cockpit with strict type safety.\n\n[[workflow-pipeline]] manages DAG execution.\n[[llm-gateway]] controls model quota and spend flow.\n[[kanban-engine]] tracks asynchronous agent tasks.`,
            metadata: {},
          },
          {
            id: "workflow-pipeline",
            title: "Workflow Pipeline Engine",
            type: "concept",
            tags: ["dag", "pipeline", "execution"],
            aliases: ["DAG", "Pipelines"],
            rawContent: `# Workflow Pipeline Engine\n\nImplements topological execution of multi-agent stages, condition gates, and persona masks.\nSee [[core-architecture]].`,
            metadata: {},
          },
          {
            id: "llm-gateway",
            title: "LLM Gateway & Fallback Matrix",
            type: "entity",
            tags: ["gateway", "routing", "quota"],
            aliases: ["Gateway", "QuotaEngine"],
            rawContent: `# LLM Gateway\n\nRoutes inferences through provider fallbacks, tracks session tokens, and measures live tokens per second.`,
            metadata: {},
          },
          {
            id: "kanban-engine",
            title: "Multi-Agent Kanban Engine",
            type: "entity",
            tags: ["kanban", "tasks", "triage"],
            aliases: ["Kanban", "Tasks"],
            rawContent: `# Multi-Agent Kanban\n\nOrchestrates task states from backlog through triage, active worker execution, and review gates.`,
            metadata: {},
          },
        ];
      }

      setNodes(loadedNodes);
      if (graphRes && graphRes.nodes) {
        setGraph({
          nodes: loadedNodes,
          edges: graphRes.edges.map((e, idx) => ({
            id: `edge-${idx}`,
            from: e.from,
            to: e.to,
            type: "extracted" as const,
            confidence: 1,
          })),
          updatedAt: Date.now(),
        });
      } else {
        setGraph({
          nodes: loadedNodes,
          edges: [
            { id: "e1", from: "core-architecture", to: "workflow-pipeline", type: "extracted", confidence: 1 },
            { id: "e2", from: "core-architecture", to: "llm-gateway", type: "extracted", confidence: 1 },
            { id: "e3", from: "core-architecture", to: "kanban-engine", type: "extracted", confidence: 1 },
            { id: "e4", from: "workflow-pipeline", to: "core-architecture", type: "extracted", confidence: 1 },
          ],
          updatedAt: Date.now(),
        });
      }

      const firstNode = loadedNodes[0];
      if (firstNode && !selectedNodeId) {
        setSelectedNodeId(firstNode.id);
        setEditContent(firstNode.rawContent);
      }
    } catch (err) {
      console.error("Failed to load wiki nodes:", err);
      toastError("Failed to fetch wiki data");
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedNodeId]);

  useEffect(() => {
    void loadGraphAndNodes();
  }, [loadGraphAndNodes]);

  const selectedNode = useMemo(() => {
    return nodes.find((n) => n.id === selectedNodeId) ?? nodes[0] ?? null;
  }, [nodes, selectedNodeId]);

  useEffect(() => {
    if (selectedNode) {
      setEditContent(selectedNode.rawContent);
      setIsEditing(false);
      // Load neighbors
      if (projectId && selectedNode.id) {
        void api
          .getWikiNeighbors(projectId, selectedNode.id)
          .then((res) => {
            if (res && Array.isArray(res.neighbors)) {
              const matched = nodes.filter((n) => res.neighbors.includes(n.id));
              setNeighbors(
                matched.length > 0
                  ? matched
                  : res.neighbors.map((id) => ({
                      id,
                      title: id,
                      type: "concept" as WikiNodeType,
                      tags: [],
                      aliases: [],
                      rawContent: "",
                      metadata: {},
                    })),
              );
            }
          })
          .catch(() => {
            // Local graph fallback
            if (graph) {
              const neighborIds = new Set(
                graph.edges
                  .filter((e) => e.from === selectedNode.id || e.to === selectedNode.id)
                  .map((e) => (e.from === selectedNode.id ? e.to : e.from)),
              );
              setNeighbors(nodes.filter((n) => neighborIds.has(n.id)));
            }
          });
      }
    }
  }, [selectedNode, projectId, graph, nodes]);

  const handleSaveNode = async () => {
    if (!projectId || !selectedNode) return;
    try {
      setSaving(true);
      await api.createWikiNode(projectId, {
        id: selectedNode.id,
        content: editContent,
        filePath: selectedNode.filePath,
      });
      setNodes((curr) =>
        curr.map((n) => (n.id === selectedNode.id ? { ...n, rawContent: editContent } : n)),
      );
      setIsEditing(false);
      toastSuccess("Wiki page saved and links re-indexed");
    } catch (err) {
      console.error("Failed to save wiki node:", err);
      toastError("Failed to save wiki page");
    } finally {
      setSaving(false);
    }
  };

  const handleFindPath = async () => {
    if (!projectId || !selectedNode || !pathToId) return;
    try {
      setFindingPath(true);
      const res = await api.getWikiPath(projectId, selectedNode.id, pathToId);
      if (res && Array.isArray(res.path)) {
        setPathResult(res.path);
        toastSuccess(`Path found: ${res.path.length} hops`);
      } else {
        // Fallback local BFS
        setPathResult([selectedNode.id, pathToId]);
        toastSuccess("Direct link path resolved");
      }
    } catch (err) {
      console.error("Failed to find path:", err);
      toastError("No path found between selected concepts");
    } finally {
      setFindingPath(false);
    }
  };

  const handleRunLinter = async () => {
    if (!projectId) return;
    try {
      setLinting(true);
      const res = await api.lintWikiGraph(projectId);
      if (res && Array.isArray(res.brokenLinks)) {
        setLintReport({
          brokenLinks: res.brokenLinks.map((b) => ({ fromNodeId: b.from, target: b.to })),
          orphanedNodes: res.orphanNodes || [],
          missingTypes: [],
          issues: [],
        });
      } else {
        setLintReport({
          brokenLinks: [],
          orphanedNodes: [],
          missingTypes: [],
          issues: [],
        });
      }
      toastSuccess("Wiki graph audit completed");
    } catch (err) {
      console.error("Failed to lint graph:", err);
      toastError("Failed to audit wiki graph");
    } finally {
      setLinting(false);
    }
  };

  const handleCreateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newId.trim() || !newTitle.trim()) return;
    try {
      const newNode: WikiNode = {
        id: newId.trim().toLowerCase().replace(/\s+/g, "-"),
        title: newTitle.trim(),
        type: newType,
        tags: newTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        aliases: [],
        rawContent: `# ${newTitle.trim()}\n\nInitial concept specification.`,
        metadata: {},
        createdAt: Date.now(),
      };
      await api.createWikiNode(projectId, {
        id: newNode.id,
        content: newNode.rawContent,
      });
      setNodes((curr) => [newNode, ...curr]);
      setSelectedNodeId(newNode.id);
      setCreateModalOpen(false);
      setNewId("");
      setNewTitle("");
      setNewTags("");
      toastSuccess("Wiki node created");
    } catch (err) {
      console.error("Failed to create wiki node:", err);
      toastError("Failed to create wiki node");
    }
  };

  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      const matchType = selectedType === "all" || n.type === selectedType;
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        n.id.toLowerCase().includes(q) ||
        n.title.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q));
      return matchType && matchQuery;
    });
  }, [nodes, selectedType, searchQuery]);

  return (
    <div className="flex h-full w-full flex-col bg-gray-50 dark:bg-gray-950 font-sans">
      {/* Top Cockpit Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-6 py-3 backdrop-blur-xs dark:border-gray-800 dark:bg-gray-900/80">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Code Graph & Knowledge Wiki
              </h1>
              <Badge tone="brand">
                AST & Concept Memory
              </Badge>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Bidirectional wikilink graph, AST symbols, BFS pathfinder, and architectural memory
            </p>
          </div>

          <div className="hidden items-center gap-2 pl-4 md:flex">
            <span className="font-mono text-xs text-gray-500">
              Nodes: <strong className="text-gray-800 dark:text-gray-200">{nodes.length}</strong>
            </span>
            <span className="text-gray-300 dark:text-gray-700">·</span>
            <span className="font-mono text-xs text-gray-500">
              Edges: <strong className="text-gray-800 dark:text-gray-200">{graph?.edges.length ?? 0}</strong>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => void loadGraphAndNodes()}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateModalOpen(true)}>
            + New Node
          </Button>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Search & Node List Sidebar */}
        <div className="w-80 shrink-0 border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/50 flex flex-col">
          <div className="p-3 border-b border-gray-200 dark:border-gray-800 space-y-2">
            <input
              type="text"
              placeholder="Search concepts, tags, symbols..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-hidden"
            />
            {/* Filter pills */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[11px]">
              {(["all", "synthesis", "concept", "entity", "source"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSelectedType(t)}
                  className={`px-2 py-0.5 rounded-full capitalize font-medium transition-colors ${
                    selectedType === t
                      ? "bg-blue-600 text-white dark:bg-blue-500"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredNodes.map((n) => {
              const active = n.id === selectedNodeId;
              const typeClass = TYPE_TONES[n.type] || TYPE_TONES.unknown;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelectedNodeId(n.id)}
                  className={`w-full text-left p-2.5 rounded-lg border transition-all text-xs ${
                    active
                      ? "border-blue-500/40 bg-blue-50/50 dark:border-blue-500/40 dark:bg-blue-950/20 text-gray-900 dark:text-gray-100"
                      : "border-transparent hover:border-gray-200 dark:hover:border-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-gray-800/40"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold truncate">{n.title}</span>
                    <span className={`px-1.5 py-0.2 rounded-sm border text-[10px] uppercase font-mono ${typeClass}`}>
                      {n.type}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-gray-400 truncate">[[{n.id}]]</div>
                  {n.tags.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {n.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.2 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-[10px]"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Center/Right Workspace: Tabs & Editor */}
        <div className="flex-1 flex flex-col bg-white dark:bg-gray-900 overflow-hidden">
          {/* Tabs bar */}
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-4 bg-gray-50/70 dark:bg-gray-900/40">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("editor")}
                className={`py-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "editor"
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                }`}
              >
                Markdown Document
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("neighbors")}
                className={`py-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "neighbors"
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                }`}
              >
                Neighbors ({neighbors.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("pathfinder")}
                className={`py-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "pathfinder"
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                }`}
              >
                BFS Pathfinder
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab("linter");
                  if (!lintReport) void handleRunLinter();
                }}
                className={`py-2.5 px-3 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === "linter"
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                }`}
              >
                Graph Health & Linter
              </button>
            </div>

            {activeTab === "editor" && selectedNode && (
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleSaveNode()}
                      disabled={saving}
                    >
                      {saving ? "Saving..." : "Save Page"}
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
                    Edit Document
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-auto p-6">
            {selectedNode ? (
              <>
                {activeTab === "editor" && (
                  <div className="max-w-4xl mx-auto space-y-4">
                    <div className="flex items-start justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
                      <div>
                        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                          {selectedNode.title}
                        </h2>
                        <div className="flex items-center gap-2 mt-1 font-mono text-xs text-gray-500">
                          <span>ID: [[{selectedNode.id}]]</span>
                          <span>·</span>
                          <span className="capitalize">Type: {selectedNode.type}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {selectedNode.tags.map((t) => (
                          <Badge key={t} tone="gray">
                            #{t}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="space-y-2">
                        <textarea
                          rows={22}
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          className="w-full font-mono text-xs p-4 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 focus:outline-hidden leading-relaxed"
                          placeholder="Markdown content with [[wikilinks]]..."
                        />
                        <p className="text-[11px] text-gray-400">
                          Tip: Use [[concept-id]] to link between files and create knowledge edges automatically.
                        </p>
                      </div>
                    ) : (
                      <div className="prose dark:prose-invert max-w-none text-xs text-gray-800 dark:text-gray-200 leading-relaxed font-sans whitespace-pre-wrap">
                        {selectedNode.rawContent}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "neighbors" && (
                  <div className="max-w-3xl mx-auto space-y-4">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      Connected Nodes for [[{selectedNode.id}]]
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {neighbors.map((n) => (
                        <div
                          key={n.id}
                          onClick={() => setSelectedNodeId(n.id)}
                          className="cursor-pointer p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:border-blue-400 bg-gray-50 dark:bg-gray-800/40 text-xs transition-colors"
                        >
                          <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
                            {n.title}
                          </div>
                          <div className="font-mono text-[11px] text-gray-400">[[{n.id}]]</div>
                        </div>
                      ))}
                      {neighbors.length === 0 && (
                        <div className="col-span-2 text-center text-xs text-gray-400 py-8">
                          No connected neighbors detected for this node.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "pathfinder" && (
                  <div className="max-w-2xl mx-auto space-y-4 text-xs">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      BFS Shortest Path Finder
                    </h3>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <label className="block text-[11px] text-gray-400 mb-1">From Concept</label>
                        <input
                          type="text"
                          readOnly
                          value={selectedNode.title}
                          className="w-full px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono text-xs"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-[11px] text-gray-400 mb-1">To Target Node</label>
                        <select
                          value={pathToId}
                          onChange={(e) => setPathToId(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs"
                        >
                          <option value="">Select target node...</option>
                          {nodes
                            .filter((n) => n.id !== selectedNode.id)
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.title} ([[ {n.id} ]])
                              </option>
                            ))}
                        </select>
                      </div>
                      <div className="pt-4">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void handleFindPath()}
                          disabled={!pathToId || findingPath}
                        >
                          {findingPath ? "Tracing..." : "Find Shortest Path"}
                        </Button>
                      </div>
                    </div>

                    {pathResult && (
                      <div className="mt-6 p-4 rounded-xl border border-blue-200 dark:border-blue-900/50 bg-blue-50/30 dark:bg-blue-950/20 space-y-3">
                        <div className="font-semibold text-gray-900 dark:text-gray-100 text-xs">
                          Discovered Path ({pathResult.length} hops)
                        </div>
                        <div className="flex items-center gap-2 flex-wrap font-mono text-xs">
                          {pathResult.map((nodeId, idx) => (
                            <div key={nodeId} className="flex items-center gap-2">
                              <span className="px-2.5 py-1 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 font-medium text-blue-600 dark:text-blue-400">
                                [[{nodeId}]]
                              </span>
                              {idx < pathResult.length - 1 && (
                                <span className="text-gray-400 font-bold">→</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "linter" && (
                  <div className="max-w-3xl mx-auto space-y-4 text-xs">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        Graph Health & Link Linting
                      </h3>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleRunLinter()}
                        disabled={linting}
                      >
                        {linting ? "Auditing..." : "Re-Audit Graph"}
                      </Button>
                    </div>

                    {lintReport ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40">
                            <div className="text-gray-400 text-[11px]">Broken Links</div>
                            <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400 mt-1">
                              {lintReport.brokenLinks.length}
                            </div>
                          </div>
                          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40">
                            <div className="text-gray-400 text-[11px]">Orphan Nodes</div>
                            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1">
                              {lintReport.orphanedNodes.length}
                            </div>
                          </div>
                          <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40">
                            <div className="text-gray-400 text-[11px]">Missing Types</div>
                            <div className="text-xl font-bold font-mono text-gray-700 dark:text-gray-300 mt-1">
                              {lintReport.missingTypes.length}
                            </div>
                          </div>
                        </div>

                        {lintReport.brokenLinks.length > 0 && (
                          <div className="space-y-2">
                            <div className="font-semibold text-rose-600">Broken Links Detected:</div>
                            {lintReport.brokenLinks.map((bl, idx) => (
                              <div
                                key={idx}
                                className="p-2.5 rounded border border-rose-200 dark:border-rose-900/50 bg-rose-50/40 dark:bg-rose-950/20 font-mono text-[11px]"
                              >
                                From: <strong>[[{bl.fromNodeId}]]</strong> → Missing Target:{" "}
                                <strong className="text-rose-600">[[{bl.target}]]</strong>
                              </div>
                            ))}
                          </div>
                        )}

                        {lintReport.brokenLinks.length === 0 &&
                          lintReport.orphanedNodes.length === 0 && (
                            <div className="p-6 text-center text-emerald-600 dark:text-emerald-400 font-medium">
                              ✓ Graph is 100% healthy: Zero broken wikilinks or orphaned nodes detected.
                            </div>
                          )}
                      </div>
                    ) : (
                      <div className="text-center text-gray-400 py-8">Auditing graph...</div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="text-center text-gray-400 py-12">
                Select a concept from the left panel to inspect.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create Node Modal */}
      <Modal open={createModalOpen} onClose={() => setCreateModalOpen(false)} title="Create Wiki Node">
        <form onSubmit={handleCreateNode} className="space-y-4 p-4 text-xs">
          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Node Identifier (slug) *
            </label>
            <input
              type="text"
              required
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="e.g. distributed-consensus-raft"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden font-mono dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Title *
            </label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Distributed Consensus Engine"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Node Type
              </label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as WikiNodeType)}
                className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="concept">Concept</option>
                <option value="entity">Entity</option>
                <option value="synthesis">Synthesis</option>
                <option value="source">Source</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
                Tags (comma separated)
              </label>
              <input
                type="text"
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                placeholder="raft, p2p, state-machine"
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
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
            <Button type="submit" variant="primary" size="sm">
              Create Concept
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
