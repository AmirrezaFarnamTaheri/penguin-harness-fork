import { useState, useMemo, useCallback, useEffect } from "react";
import { CodeGraph, type CodeGraphNode } from "@prismshadow/penguin-core/browser";
import { useProject } from "../../state/project";
import { Button } from "../../components/ui/button";
import { TopologyGraphCanvas } from "./topology-graph-canvas";
import { TopologyInspector } from "./topology-inspector";
import { TopologyMatrix } from "./topology-matrix";
import { pageClass, mutedClass, selectClass, useInspectionCopy } from "../context/inspection-ui";

export interface TopologyPageProps {
  embedded?: boolean;
}
export function TopologyPage({ embedded = false }: TopologyPageProps) {
  const { currentProject } = useProject();
  const copy = useInspectionCopy();
  if (!currentProject)
    return (
      <p className={`p-4 ${mutedClass}`}>
        {copy("Select a project to inspect its code structure.", "请选择项目以查看代码结构。")}
      </p>
    );
  return (
    <ProjectTopology
      key={currentProject.projectId}
      projectId={currentProject.projectId}
      embedded={embedded}
    />
  );
}

export function ProjectTopology({
  projectId,
  embedded = false,
}: {
  projectId: string;
  embedded?: boolean;
}) {
  const copy = useInspectionCopy();
  const [view, setView] = useState("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [impactIds, setImpactIds] = useState<Set<string>>(new Set());
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/cockpit/topology?project=${encodeURIComponent(projectId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges))
          throw new Error("Invalid topology response");
        const next = CodeGraph.fromJSON(data);
        if (controller.signal.aborted) return;
        setGraph(next);
        setSelectedId((id) => (id && next.getNode(id) ? id : null));
        setFrom((id) => (next.getNode(id) ? id : ""));
        setTo((id) => (next.getNode(id) ? id : ""));
        setImpactIds(new Set());
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
          setGraph(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [projectId, revision]);
  const nodes = useMemo(() => graph?.getAllNodes() ?? [], [graph]);
  const edges = useMemo(
    () => nodes.flatMap((node) => graph?.getOutgoingEdges(node.id) ?? []),
    [graph, nodes],
  );
  const path = useMemo(
    () => (from && to && graph ? graph.findShortestPath(from, to) : null),
    [from, to, graph],
  );
  const pathIds = useMemo(() => new Set(path?.map((step) => step.node.id) ?? []), [path]);
  const updateImpact = useCallback(
    (items: CodeGraphNode[]) => setImpactIds(new Set(items.map((node) => node.id))),
    [],
  );
  // Stable node identity: a fresh node object per render would retrigger the inspector's impact effect forever.
  const selectedNode = useMemo(
    () => (selectedId && graph ? (graph.getNode(selectedId) ?? null) : null),
    [graph, selectedId],
  );
  return (
    <section className={`${pageClass} ${embedded ? "p-4" : "p-6"}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{copy("Code structure", "代码结构")}</h1>
          <p className={`mt-1 ${mutedClass}`}>
            {copy(
              "Inspect indexed symbols, trace dependencies, and review possible change impact.",
              "检查已索引符号、追踪依赖并评估变更影响。",
            )}
          </p>
        </div>
        <Button disabled={loading} onClick={() => setRevision((r) => r + 1)}>
          {loading ? copy("Loading…", "加载中…") : copy("Refresh", "刷新")}
        </Button>
      </header>
      {error ? (
        <div role="alert" className="space-y-3 py-6">
          <h2 className="font-semibold">
            {copy("Could not load code structure", "无法加载代码结构")}
          </h2>
          <p className={mutedClass}>{error}</p>
          <Button onClick={() => setRevision((r) => r + 1)}>{copy("Try again", "重试")}</Button>
        </div>
      ) : loading && !graph ? (
        <p role="status" className={`py-8 ${mutedClass}`}>
          {copy("Loading indexed symbols…", "正在加载索引符号…")}
        </p>
      ) : !graph || nodes.length === 0 ? (
        <div role="status" className="space-y-2 py-8">
          <h2 className="font-semibold">{copy("No indexed symbols", "暂无索引符号")}</h2>
          <p className={mutedClass}>
            {copy(
              "This project's topology endpoint returned no symbols. Refresh after an index is available. Sample repository data is never substituted.",
              "此项目的拓扑接口未返回符号。索引可用后请刷新；此处不会用示例仓库数据代替。",
            )}
          </p>
        </div>
      ) : (
        <>
          <div className={`flex flex-wrap gap-x-6 gap-y-2 ${mutedClass}`}>
            <span>
              {nodes.length} {copy("symbols", "个符号")}
            </span>
            <span>
              {edges.length} {copy("relationships", "条关系")}
            </span>
            <span>
              {graph.getHubNodes(3).length} {copy("hubs", "个枢纽")}
            </span>
            <span>
              {graph.getBridgeNodes().length} {copy("bridges", "个桥接节点")}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-3 border-y border-gray-200 py-4 dark:border-gray-800">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              {copy("Path start", "路径起点")}
              <select
                className={selectClass}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                <option value="">{copy("Choose a symbol", "选择符号")}</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} · {node.filePath}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              {copy("Path end", "路径终点")}
              <select className={selectClass} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{copy("Choose a symbol", "选择符号")}</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} · {node.filePath}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!from && !to}
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              {copy("Clear path", "清除路径")}
            </Button>
          </div>
          {from && to && (
            <p role="status" className="break-words">
              {path
                ? path.map((step) => step.node.name).join(" → ")
                : copy("No directed path connects these symbols.", "这些符号之间没有有向路径。")}
            </p>
          )}
          <div className="flex gap-2" aria-label={copy("Code structure views", "代码结构视图")}>
            {[
              ["list", copy("Symbols", "符号列表")],
              ["graph", copy("Graph", "关系图")],
            ].map(([value, label]) => (
              <Button
                key={value}
                aria-pressed={view === value}
                variant={view === value ? "primary" : "secondary"}
                onClick={() => setView(value!)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.5fr)]">
            <div className="min-w-0">
              {view === "list" ? (
                <TopologyMatrix
                  graph={graph}
                  nodes={nodes}
                  selectedNodeId={selectedId}
                  onSelectNode={setSelectedId}
                />
              ) : (
                <TopologyGraphCanvas
                  nodes={nodes}
                  edges={edges}
                  selectedNodeId={selectedId}
                  onSelectNode={setSelectedId}
                  highlightedPathNodeIds={pathIds}
                  highlightedImpactNodeIds={impactIds}
                />
              )}
            </div>
            <TopologyInspector
              graph={graph}
              selectedNode={selectedNode}
              onSelectNode={setSelectedId}
              onSetPathFrom={setFrom}
              onSetPathTo={setTo}
              onUpdateImpact={updateImpact}
            />
          </div>
        </>
      )}
    </section>
  );
}
