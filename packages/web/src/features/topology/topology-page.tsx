import { useState, useMemo, useCallback, useEffect } from "react";
import { CodeGraph, type CodeGraphNode, type CodeGraphEdge } from "@prismshadow/penguin-core";
import { useProject } from "../../state/project";
import { Button } from "../../components/ui/button";
import { Segmented } from "../../components/ui/segmented";
import { createPenguinCodeGraph } from "./topology-graph-factory";
import { TopologyGraphCanvas } from "./topology-graph-canvas";
import { TopologyInspector } from "./topology-inspector";
import { TopologyMatrix } from "./topology-matrix";
import type { TopologyViewMode } from "./topology-types";

export interface TopologyPageProps {
  embedded?: boolean;
}

export function TopologyPage({ embedded = false }: TopologyPageProps) {
  const { currentProject } = useProject();
  const [viewMode, setViewMode] = useState<TopologyViewMode>("studio");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("core/code-graph");
  const [fromNodeId, setFromNodeId] = useState<string | null>("web/chat-page");
  const [toNodeId, setToNodeId] = useState<string | null>("sym/ShellGuardian#analyzeCommand");
  const [impactNodeIds, setImpactNodeIds] = useState<Set<string>>(new Set());

  const [liveGraph, setLiveGraph] = useState<CodeGraph | null>(null);
  const [isLiveSynced, setIsLiveSynced] = useState(false);

  const fetchTopology = useCallback(async () => {
    try {
      const res = await fetch("/api/cockpit/topology");
      if (res.ok) {
        const data = await res.json();
        if (data.nodes && Array.isArray(data.nodes) && data.nodes.length > 0) {
          const constructed = CodeGraph.fromJSON(data);
          setLiveGraph(constructed);
          setIsLiveSynced(true);
        }
      }
    } catch {
      // offline or standalone mode: fallback to static factory
    }
  }, []);

  useEffect(() => {
    void fetchTopology();
  }, [fetchTopology]);

  // Fallback factory or live graph
  const defaultGraph = useMemo(() => createPenguinCodeGraph(), []);
  const graph = liveGraph ?? defaultGraph;

  const allNodes = useMemo(() => graph.getAllNodes(), [graph]);

  const allEdges = useMemo(() => {
    const edges: CodeGraphEdge[] = [];
    for (const node of allNodes) {
      edges.push(...graph.getOutgoingEdges(node.id));
    }
    return edges;
  }, [graph, allNodes]);

  // Telemetry metrics
  const hubNodes = useMemo(() => graph.getHubNodes(3), [graph]);
  const bridgeNodes = useMemo(() => graph.getBridgeNodes(), [graph]);
  const deadCode = useMemo(() => {
    return allNodes.filter(
      (n) => n.kind !== "file" && graph.getIncomingEdges(n.id).length === 0,
    );
  }, [graph, allNodes]);

  // Selected node object
  const selectedNode = useMemo(() => {
    return selectedNodeId ? graph.getNode(selectedNodeId) ?? null : null;
  }, [graph, selectedNodeId]);

  // Shortest path tracing
  const tracedPath = useMemo(() => {
    if (!fromNodeId || !toNodeId) return null;
    return graph.findShortestPath(fromNodeId, toNodeId);
  }, [graph, fromNodeId, toNodeId]);

  const pathNodeIds = useMemo(() => {
    if (!tracedPath) return new Set<string>();
    return new Set(tracedPath.map((step) => step.node.id));
  }, [tracedPath]);

  const handleUpdateImpact = useCallback(
    (nodes: CodeGraphNode[]) => {
      setImpactNodeIds(new Set(nodes.map((n) => n.id)));
    },
    [],
  );

  return (
    <div className={`flex flex-col h-full gap-4 ${embedded ? "p-2" : "p-6"} bg-gray-950 text-gray-100 font-sans select-none overflow-hidden`}>
      {/* Top Header & Telemetry Cards */}
      <div className="flex flex-col gap-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2 font-mono">
              <span className={`w-2 h-2 rounded-full ${isLiveSynced ? "bg-emerald-400 animate-pulse" : "bg-cyan-400 animate-pulse"}`} />
              CodeGraph & AST Symbol Topology
            </h1>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              Architectural knowledge graph, relational call paths, and blast-radius analysis for {currentProject?.name ?? "Penguin"}
            </p>
          </div>

          {/* Sync badge, refresh & view mode switcher */}
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono bg-gray-900 border border-gray-800 text-gray-400">
              <span className={`w-1.5 h-1.5 rounded-full ${isLiveSynced ? "bg-emerald-400" : "bg-gray-500"}`} />
              {isLiveSynced ? "Live AST Stream" : "AST Static"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void fetchTopology()}
              className="text-xs h-7 px-2 text-gray-400 hover:text-white"
            >
              Refresh
            </Button>
            <div className="w-56">
              <Segmented
                cols={3}
                options={[
                  { value: "studio", label: "Studio" },
                  { value: "canvas", label: "Canvas" },
                  { value: "matrix", label: "Matrix" },
                ]}
                value={viewMode}
                onChange={(val) => setViewMode(val as TopologyViewMode)}
              />
            </div>
          </div>
        </div>

        {/* Telemetry Chips Row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 font-mono text-xs">
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Symbols</span>
            <span className="text-base font-bold text-gray-100 tabular-nums">{allNodes.length}</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">AST Edges</span>
            <span className="text-base font-bold text-cyan-400 tabular-nums">{allEdges.length}</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Hub Nodes</span>
            <span className="text-base font-bold text-indigo-400 tabular-nums">{hubNodes.length}</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Bridge Nodes</span>
            <span className="text-base font-bold text-purple-400 tabular-nums">{bridgeNodes.length}</span>
          </div>
          <div className="p-2.5 rounded-lg border border-gray-800 bg-gray-900/60 flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase">Dead Code Candidates</span>
            <span className="text-base font-bold text-rose-400 tabular-nums">{deadCode.length}</span>
          </div>
        </div>

        {/* Path Tracer Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-800 bg-gray-900/40 text-xs font-mono">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-gray-400 font-semibold">Path Finder:</span>
            <span className="px-2 py-0.5 rounded bg-gray-800 text-cyan-300 truncate max-w-[160px]">
              {fromNodeId ? graph.getNode(fromNodeId)?.name ?? fromNodeId : "Select Start"}
            </span>
            <span className="text-gray-500">→</span>
            <span className="px-2 py-0.5 rounded bg-gray-800 text-indigo-300 truncate max-w-[160px]">
              {toNodeId ? graph.getNode(toNodeId)?.name ?? toNodeId : "Select Target"}
            </span>
            {tracedPath && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                Connected in {tracedPath.length - 1} hops
              </span>
            )}
          </div>
          {(fromNodeId || toNodeId) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-[11px] h-6 px-2 text-gray-400 hover:text-white"
              onClick={() => {
                setFromNodeId(null);
                setToNodeId(null);
              }}
            >
              Clear Path
            </Button>
          )}
        </div>
      </div>

      {/* Main Workspace Body */}
      <div className="flex-1 min-h-0">
        {viewMode === "studio" && (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 h-full">
            <div className="md:col-span-8 h-full">
              <TopologyGraphCanvas
                nodes={allNodes}
                edges={allEdges}
                selectedNodeId={selectedNodeId}
                onSelectNode={(id) => setSelectedNodeId(id)}
                highlightedPathNodeIds={pathNodeIds}
                highlightedImpactNodeIds={impactNodeIds}
              />
            </div>
            <div className="md:col-span-4 h-full">
              <TopologyInspector
                graph={graph}
                selectedNode={selectedNode}
                onSelectNode={(id) => setSelectedNodeId(id)}
                onSetPathFrom={(id) => setFromNodeId(id)}
                onSetPathTo={(id) => setToNodeId(id)}
                onUpdateImpact={handleUpdateImpact}
              />
            </div>
          </div>
        )}

        {viewMode === "canvas" && (
          <div className="h-full">
            <TopologyGraphCanvas
              nodes={allNodes}
              edges={allEdges}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => setSelectedNodeId(id)}
              highlightedPathNodeIds={pathNodeIds}
              highlightedImpactNodeIds={impactNodeIds}
            />
          </div>
        )}

        {viewMode === "matrix" && (
          <div className="h-full">
            <TopologyMatrix
              graph={graph}
              nodes={allNodes}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => setSelectedNodeId(id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
