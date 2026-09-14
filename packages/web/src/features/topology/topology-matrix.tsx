import { useMemo, useState } from "react";
import type { CodeGraph, CodeGraphNode, CodeNodeKind } from "@prismshadow/penguin-core";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

export interface TopologyMatrixProps {
  graph: CodeGraph;
  nodes: CodeGraphNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function TopologyMatrix({
  graph,
  nodes,
  selectedNodeId,
  onSelectNode,
}: TopologyMatrixProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<CodeNodeKind | "all">("all");
  const [onlyDeadCode, setOnlyDeadCode] = useState(false);

  const deadCodeSet = useMemo(() => {
    const dead = new Set<string>();
    for (const node of nodes) {
      if (node.kind !== "file" && graph.getIncomingEdges(node.id).length === 0) {
        dead.add(node.id);
      }
    }
    return dead;
  }, [graph, nodes]);

  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (onlyDeadCode && !deadCodeSet.has(n.id)) return false;
      if (kindFilter !== "all" && n.kind !== kindFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return n.name.toLowerCase().includes(q) || n.filePath.toLowerCase().includes(q);
      }
      return true;
    });
  }, [nodes, search, kindFilter, onlyDeadCode, deadCodeSet]);

  return (
    <div className="flex flex-col h-full gap-3 p-4 bg-gray-950 border border-gray-800 rounded-xl font-mono text-xs select-none overflow-hidden">
      {/* Search and Filters Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter symbols or paths..."
            size="sm"
            className="h-8 bg-gray-900 border-gray-800 text-gray-200"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as CodeNodeKind | "all")}
            className="h-8 px-2 rounded-md bg-gray-900 border border-gray-800 text-xs text-gray-300 focus:outline-none focus:border-cyan-500"
          >
            <option value="all">All Kinds</option>
            <option value="file">Files</option>
            <option value="class">Classes</option>
            <option value="function">Functions</option>
            <option value="interface">Interfaces</option>
            <option value="component">Components</option>
          </select>

          <Button
            size="sm"
            variant={onlyDeadCode ? "danger" : "secondary"}
            onClick={() => setOnlyDeadCode(!onlyDeadCode)}
            className="text-[11px] h-8"
          >
            Dead Code ({deadCodeSet.size})
          </Button>
        </div>
      </div>

      {/* High-density Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500 text-[10px] uppercase tracking-wider sticky top-0 bg-gray-950">
              <th className="py-2 px-3">Symbol</th>
              <th className="py-2 px-3">Kind</th>
              <th className="py-2 px-3">File Path</th>
              <th className="py-2 px-3 text-right">LOC</th>
              <th className="py-2 px-3 text-right">In / Out</th>
              <th className="py-2 px-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-900">
            {filteredNodes.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-gray-600">
                  No matching symbols found.
                </td>
              </tr>
            ) : (
              filteredNodes.map((n) => {
                const isSelected = selectedNodeId === n.id;
                const isDead = deadCodeSet.has(n.id);
                const inbound = graph.getIncomingEdges(n.id).length;
                const outbound = graph.getOutgoingEdges(n.id).length;

                return (
                  <tr
                    key={n.id}
                    onClick={() => onSelectNode(n.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-cyan-950/40 text-cyan-200"
                        : "hover:bg-gray-900/60 text-gray-300"
                    }`}
                  >
                    <td className="py-2 px-3 font-semibold text-gray-100">{n.name}</td>
                    <td className="py-2 px-3">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-900 border border-gray-800 text-gray-400 uppercase">
                        {n.kind}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-gray-400 text-[11px] truncate max-w-xs" title={n.filePath}>
                      {n.filePath}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-gray-400">
                      {n.loc ?? "—"}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-gray-400">
                      <span className="text-cyan-400">{inbound}</span> /{" "}
                      <span className="text-indigo-400">{outbound}</span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      {isDead ? (
                        <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 text-[10px] font-bold">
                          DEAD
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[10px]">
                          ACTIVE
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
