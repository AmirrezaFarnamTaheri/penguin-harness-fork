import { useEffect, useMemo, useState } from "react";
import type { CodeGraph, CodeGraphNode, CodeGraphEdge } from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import {
  mutedClass,
  rowButtonClass,
  sectionClass,
  useInspectionCopy,
} from "../context/inspection-ui";
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
  const copy = useInspectionCopy();
  const [depth, setDepth] = useState(2);
  const impact = useMemo(
    () => (selectedNode ? graph.getImpactRadius(selectedNode.id, depth) : { nodes: [], edges: [] }),
    [graph, selectedNode, depth],
  );
  // Parent notification is an effect, never a state update during another component's render.
  useEffect(() => {
    onUpdateImpact(impact.nodes, impact.edges);
  }, [impact, onUpdateImpact]);
  if (!selectedNode)
    return (
      <aside className={sectionClass}>
        <h2 className="text-base font-semibold">{copy("Symbol details", "符号详情")}</h2>
        <p className={mutedClass}>
          {copy(
            "Select a symbol from the list or graph to inspect its relationships.",
            "从列表或关系图选择符号以检查其关系。",
          )}
        </p>
      </aside>
    );
  const relations = [
    {
      title: copy("Callers · up to 2 steps", "调用方 · 最多两步"),
      nodes: graph.getCallers(selectedNode.id, 2),
    },
    {
      title: copy("Callees · up to 2 steps", "被调用方 · 最多两步"),
      nodes: graph.getCallees(selectedNode.id, 2),
    },
    {
      title: copy("Potentially affected symbols", "可能受影响的符号"),
      nodes: impact.nodes.filter((node) => node.id !== selectedNode.id),
    },
  ];
  return (
    <aside className="min-w-0 space-y-5">
      <section className={sectionClass}>
        <h2 className="break-all text-base font-semibold">{selectedNode.name}</h2>
        <p className={mutedClass}>
          {selectedNode.kind} · {selectedNode.loc ?? "—"} LOC
        </p>
        <div className="flex items-start gap-2">
          <code className="min-w-0 break-all">{selectedNode.filePath}</code>
          <CopyButton text={selectedNode.filePath} label={copy("Copy path", "复制路径")} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onSetPathFrom(selectedNode.id)}>
            {copy("Use as start", "设为起点")}
          </Button>
          <Button onClick={() => onSetPathTo(selectedNode.id)}>
            {copy("Use as end", "设为终点")}
          </Button>
        </div>
      </section>
      <section className={sectionClass}>
        <label className="flex flex-wrap items-center justify-between gap-3">
          {copy("Impact depth", "影响深度")} <span>{depth}</span>
          <input
            aria-label={copy("Impact depth", "影响深度")}
            className="w-full accent-brand-600"
            type="range"
            min="1"
            max="4"
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          />
        </label>
        <p className={mutedClass}>
          {copy(
            "Potential impact follows indexed dependencies; it does not predict runtime behavior.",
            "潜在影响基于索引依赖，并不预测运行时行为。",
          )}
        </p>
      </section>
      {relations.map((relation) => (
        <section key={relation.title} className={sectionClass}>
          <h3 className="font-semibold">
            {relation.title} ({relation.nodes.length})
          </h3>
          {!relation.nodes.length ? (
            <p className={mutedClass}>
              {copy("No relationships found in this index.", "此索引中未找到关系。")}
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {relation.nodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onSelectNode(node.id)}
                    className={rowButtonClass}
                  >
                    <span className="block break-all">{node.name}</span>
                    <span className={mutedClass}>{node.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </aside>
  );
}
