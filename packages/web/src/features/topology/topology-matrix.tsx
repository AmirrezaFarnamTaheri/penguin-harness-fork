import { useMemo, useState } from "react";
import type { CodeGraph, CodeGraphNode } from "@prismshadow/penguin-core/browser";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import {
  mutedClass,
  rowButtonClass,
  selectedClass,
  selectClass,
  useInspectionCopy,
} from "../context/inspection-ui";
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
  const copy = useInspectionCopy();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [unreferenced, setUnreferenced] = useState(false);
  const filtered = useMemo(
    () =>
      nodes.filter((node) => {
        const query = search.trim().toLowerCase();
        return (
          (kind === "all" || node.kind === kind) &&
          (!unreferenced ||
            (node.kind !== "file" && graph.getIncomingEdges(node.id).length === 0)) &&
          `${node.name} ${node.filePath}`.toLowerCase().includes(query)
        );
      }),
    [nodes, graph, search, kind, unreferenced],
  );
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={copy("Filter symbols or paths", "筛选符号或路径")}
          placeholder={copy("Filter symbols or paths", "筛选符号或路径")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1"
        />
        <select
          aria-label={copy("Symbol kind", "符号类型")}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={selectClass}
        >
          <option value="all">{copy("All kinds", "全部类型")}</option>
          {[...new Set(nodes.map((node) => node.kind))].sort().map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label className="flex min-h-10 items-center gap-2">
          <input
            type="checkbox"
            checked={unreferenced}
            onChange={(e) => setUnreferenced(e.target.checked)}
          />
          {copy("Unreferenced only", "仅无引用项")}
        </label>
      </div>
      <p className={mutedClass}>
        {copy(
          "No inbound references is a review hint, not proof of dead code. Entry points and partial indexes may appear here.",
          "无传入引用仅为检查线索，不代表无用代码；入口或不完整索引也可能如此。",
        )}
      </p>
      <p role="status" className={mutedClass}>
        {filtered.length} / {nodes.length} {copy("symbols", "个符号")}
      </p>
      {!filtered.length ? (
        <div className="space-y-3 py-6">
          <p>{copy("No matching symbols.", "没有匹配的符号。")}</p>
          <Button
            onClick={() => {
              setSearch("");
              setKind("all");
              setUnreferenced(false);
            }}
          >
            {copy("Clear filters", "清除筛选")}
          </Button>
        </div>
      ) : (
        <ul className="max-h-[36rem] overflow-y-auto">
          {filtered.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                aria-pressed={selectedNodeId === node.id}
                onClick={() => onSelectNode(node.id)}
                className={`${rowButtonClass} ${selectedNodeId === node.id ? selectedClass : ""}`}
              >
                <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="break-all font-semibold">{node.name}</span>
                  <span className={mutedClass}>
                    {node.kind} · {node.loc ?? "—"} LOC
                  </span>
                </span>
                <span className={`mt-1 block break-all font-mono ${mutedClass}`}>
                  {node.filePath}
                </span>
                <span className={`mt-1 block ${mutedClass}`}>
                  {graph.getIncomingEdges(node.id).length} {copy("inbound", "传入")} ·{" "}
                  {graph.getOutgoingEdges(node.id).length} {copy("outbound", "传出")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
