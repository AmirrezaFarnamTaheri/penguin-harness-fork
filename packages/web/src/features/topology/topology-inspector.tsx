import { useMemo, useState } from "react";
import type { CodeGraph, CodeGraphNode, CodeGraphEdge } from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";

export interface TopologyInspectorProps {
  graph: CodeGraph;
  selectedNode: CodeGraphNode | null;
  onSelectNode: (nodeId: string) => void;
  onSetPathFrom: (nodeId: string) => void;
  onSetPathTo: (nodeId: string) => void;
  onUpdateImpact: (nodes: CodeGraphNode[], edges: CodeGraphEdge[]) => void;
}

export function TopologyInspector({
  graph,
  selectedNode,
  onSelectNode,
  onSetPathFrom,
  onSetPathTo,
  onUpdateImpact,
}: TopologyInspectorProps) {
  const [impactDepth, setImpactDepth] = useState<number>(2);

  const callers = useMemo(() => {
    if (!selectedNode) return [];
    return graph.getCallers(selectedNode.id, 2);
  }, [graph, selectedNode]);

  const callees = useMemo(() => {
    if (!selectedNode) return [];
    return graph.getCallees(selectedNode.id, 2);
  }, [graph, selectedNode]);

  const impact = useMemo(() => {
    if (!selectedNode) return { nodes: [], edges: [] };
    const res = graph.getImpactRadius(selectedNode.id, impactDepth);
    onUpdateImpact(res.nodes, res.edges);
    return res;
  }, [graph, selectedNode, impactDepth, onUpdateImpact]);

  if (!selectedNode) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-xs text-gray-500 font-mono border border-gray-800 rounded-xl bg-gray-900/60 backdrop-blur-md">
        <div className="w-8 h-8 rounded-full border border-gray-700 flex items-center justify-center text-gray-400 mb-2">
          i
        </div>
        <div className="font-semibold text-gray-300">No Symbol Selected</div>
        <div className="text-[11px] text-gray-500 mt-1 max-w-xs">
          Click any node in the AST graph or table row to inspect callers, callees, and simulate
          alteration blast radius.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 border border-gray-800 rounded-xl bg-gray-900/80 backdrop-blur-md text-xs font-mono select-none">
      {/* Header Symbol Info */}
      <div className="flex flex-col gap-1.5 pb-3 border-b border-gray-800">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-sm text-gray-100 truncate">{selectedNode.name}</span>
          <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 uppercase font-semibold">
            {selectedNode.kind}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px] text-gray-400">
          <span className="truncate pr-2" title={selectedNode.filePath}>
            {selectedNode.filePath}
          </span>
          <CopyButton text={selectedNode.filePath} label="Copy path" />
        </div>
        {selectedNode.loc !== undefined && (
          <div className="text-[10px] text-gray-500">
            Source Size: <strong className="text-gray-300">{selectedNode.loc}</strong> lines
          </div>
        )}
      </div>

      {/* Action Buttons: Path Trace */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="flex-1 text-[11px]"
          onClick={() => onSetPathFrom(selectedNode.id)}
        >
          Set As Path Start
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1 text-[11px]"
          onClick={() => onSetPathTo(selectedNode.id)}
        >
          Set As Path End
        </Button>
      </div>

      {/* Blast Radius & Impact Simulator */}
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-gray-800 bg-gray-950/60">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-rose-400">Blast Radius Simulator</span>
          <span className="text-[11px] text-gray-400">
            Depth: <strong className="text-gray-200">{impactDepth}</strong>
          </span>
        </div>
        <input
          type="range"
          min="1"
          max="4"
          value={impactDepth}
          onChange={(e) => setImpactDepth(Number(e.target.value))}
          className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
        />
        <div className="text-[11px] text-gray-400">
          Altering this symbol directly or transitively impacts{" "}
          <strong className="text-rose-400">{Math.max(0, impact.nodes.length - 1)}</strong>{" "}
          dependent symbols across <strong className="text-gray-200">{impact.edges.length}</strong>{" "}
          relationships.
        </div>
        {impact.nodes.length > 1 && (
          <div className="flex flex-wrap gap-1 mt-1 max-h-24 overflow-y-auto">
            {impact.nodes
              .filter((n) => n.id !== selectedNode.id)
              .map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelectNode(n.id)}
                  className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 text-[10px] hover:bg-rose-500/20 transition-colors truncate max-w-[140px]"
                  title={n.name}
                >
                  {n.name}
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Callers Tree */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-gray-300 font-semibold">
          <span>Inbound Callers & Dependents</span>
          <span className="text-gray-500 text-[10px]">({callers.length})</span>
        </div>
        {callers.length === 0 ? (
          <div className="text-[11px] text-gray-600 italic">No inbound callers detected.</div>
        ) : (
          <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
            {callers.map((c) => (
              <div
                key={c.id}
                onClick={() => onSelectNode(c.id)}
                className="flex items-center justify-between px-2 py-1.5 rounded bg-gray-950 border border-gray-800/80 hover:border-cyan-500/40 cursor-pointer transition-colors"
              >
                <span className="text-cyan-400 font-medium truncate">{c.name}</span>
                <span className="text-[10px] text-gray-500 uppercase">{c.kind}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Callees Tree */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-gray-300 font-semibold">
          <span>Outbound Callees & Imports</span>
          <span className="text-gray-500 text-[10px]">({callees.length})</span>
        </div>
        {callees.length === 0 ? (
          <div className="text-[11px] text-gray-600 italic">No outbound callees detected.</div>
        ) : (
          <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
            {callees.map((c) => (
              <div
                key={c.id}
                onClick={() => onSelectNode(c.id)}
                className="flex items-center justify-between px-2 py-1.5 rounded bg-gray-950 border border-gray-800/80 hover:border-indigo-500/40 cursor-pointer transition-colors"
              >
                <span className="text-indigo-300 font-medium truncate">{c.name}</span>
                <span className="text-[10px] text-gray-500 uppercase">{c.kind}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
