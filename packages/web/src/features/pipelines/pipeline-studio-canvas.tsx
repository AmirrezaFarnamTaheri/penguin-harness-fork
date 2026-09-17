import { useId } from "react";
import type { WorkflowRunState } from "@prismshadow/penguin-core/browser";
import type { PipelineRecord } from "../../api/endpoints";
import { mutedClass } from "../kanban/work-tool-ui";

export interface PipelineStudioCanvasProps {
  pipeline: PipelineRecord;
  run?: WorkflowRunState | null;
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
}

/** Saved topology only: inspecting a node never edits the graph or advances a run. */
export function PipelineStudioCanvas({
  pipeline,
  run,
  selectedNodeId,
  onSelectNode,
}: PipelineStudioCanvasProps) {
  const arrowId = `workflow-arrow-${useId()}`;
  const { nodes, edges } = pipeline;
  // Match TopologyGraphCanvas's deterministic grid, not an implied execution order.
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const width = columns * 300;
  const height = Math.ceil(nodes.length / columns) * 160;
  const positions = new Map(
    nodes.map((node, index) => [
      node.id,
      {
        x: (index % columns) * 300 + 150,
        y: Math.floor(index / columns) * 160 + 80,
        name: node.name,
      },
    ]),
  );
  const unresolved = edges.filter(
    (edge) => !positions.has(edge.from) || !positions.has(edge.to),
  ).length;
  const state = run?.pipelineId === pipeline.id ? run : null;
  const shorten = (text: string) => (text.length > 24 ? `${text.slice(0, 22)}…` : text);

  return (
    <section className="min-w-0 space-y-3" aria-label="Workflow graph">
      <h3 className="font-semibold">Workflow graph</h3>
      <p className={mutedClass}>
        Read-only saved connections. Arrows show direction; labels show branch values, not execution
        results. Select a step for details. Scroll to explore larger workflows.
      </p>
      {unresolved > 0 && (
        <p role="status" className={mutedClass}>
          {unresolved} unresolved connection{unresolved === 1 ? "" : "s"} not drawn.
        </p>
      )}
      {!nodes.length ? (
        <p className={mutedClass}>No steps in this workflow.</p>
      ) : (
        <div className="max-h-[32rem] overflow-auto rounded-md border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
          <svg
            aria-label={`${pipeline.name} saved connections`}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ minWidth: width }}
          >
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 0 L 10 5 L 0 10 z"
                  fill="currentColor"
                  className="text-gray-500 dark:text-gray-400"
                />
              </marker>
            </defs>
            {edges.map((edge, index) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const scale = Math.max(Math.abs(dx) / 106, Math.abs(dy) / 48, 1);
              const x1 = from.x + dx / scale;
              const y1 = from.y + dy / scale;
              const x2 = to.x - dx / scale;
              const y2 = to.y - dy / scale;
              const branch =
                edge.conditionValue === undefined ? "" : ` (${String(edge.conditionValue)})`;
              const label = `${from.name} → ${to.name}${branch}`;
              return (
                <g key={index} data-edge-from={edge.from} data-edge-to={edge.to}>
                  <title>{label}</title>
                  <path
                    d={
                      edge.from === edge.to
                        ? `M ${from.x + 80} ${from.y - 44} C ${from.x + 180} ${from.y - 110}, ${from.x - 180} ${from.y - 110}, ${from.x - 80} ${from.y - 44}`
                        : `M ${x1} ${y1} L ${x2} ${y2}`
                    }
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeDasharray={edge.conditionValue === undefined ? undefined : "5 4"}
                    markerEnd={`url(#${arrowId})`}
                    className="text-gray-500 dark:text-gray-400"
                  />
                  {edge.conditionValue !== undefined && (
                    <text
                      x={(from.x + to.x) / 2}
                      y={(from.y + to.y) / 2 - 8}
                      textAnchor="middle"
                      fontSize={12}
                      className="fill-gray-700 dark:fill-gray-300"
                    >
                      {shorten(String(edge.conditionValue))}
                    </text>
                  )}
                </g>
              );
            })}
            {nodes.map((node) => {
              const position = positions.get(node.id)!;
              const selected = node.id === selectedNodeId;
              const status = state?.nodeStates[node.id]?.status;
              const detail = [node.kind, node.agentRole, status].filter(Boolean).join(", ");
              return (
                <g
                  key={node.id}
                  transform={`translate(${position.x} ${position.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.name}, ${detail}`}
                  aria-pressed={selected}
                  className="group cursor-pointer outline-none"
                  onClick={() => onSelectNode(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectNode(node.id);
                    }
                  }}
                >
                  <title>{`${node.name} · ${detail}`}</title>
                  <rect
                    x={-104}
                    y={-44}
                    width={208}
                    height={88}
                    rx={6}
                    strokeWidth={selected ? 3 : 1}
                    className={`fill-white dark:fill-gray-950 group-focus-visible:stroke-brand-600 group-focus-visible:stroke-[3] ${selected ? "stroke-brand-600 dark:stroke-brand-300" : "stroke-gray-400 dark:stroke-gray-600"}`}
                  />
                  <text
                    textAnchor="middle"
                    y={-19}
                    fontSize={14}
                    className="fill-gray-900 dark:fill-gray-100"
                  >
                    {shorten(node.name)}
                  </text>
                  <text
                    textAnchor="middle"
                    y={3}
                    fontSize={12}
                    className="fill-gray-600 dark:fill-gray-400"
                  >
                    {node.kind}
                    {status ? ` · ${status}` : ""}
                  </text>
                  {node.agentRole && (
                    <text
                      textAnchor="middle"
                      y={25}
                      fontSize={12}
                      className="fill-gray-600 dark:fill-gray-400"
                    >
                      {shorten(node.agentRole)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}
