import { useMemo, useRef, useState } from "react";
import type { CodeGraphNode, CodeGraphEdge } from "@prismshadow/penguin-core/browser";
import { Button } from "../../components/ui/button";
import { mutedClass, useInspectionCopy } from "../context/inspection-ui";
export interface TopologyGraphCanvasProps {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  highlightedPathNodeIds?: Set<string>;
  highlightedImpactNodeIds?: Set<string>;
}
export function TopologyGraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  highlightedPathNodeIds,
  highlightedImpactNodeIds,
}: TopologyGraphCanvasProps) {
  const copy = useInspectionCopy();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const width = Math.max(600, columns * 220);
  const height = Math.max(360, Math.ceil(nodes.length / columns) * 110);
  const positions = useMemo(
    () =>
      new Map(
        nodes.map((node, index) => [
          node.id,
          { x: (index % columns) * 220 + 110, y: Math.floor(index / columns) * 110 + 55 },
        ]),
      ),
    [nodes, columns],
  );
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-label={copy("Zoom in", "放大")}
          disabled={zoom >= 3}
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
        >
          +
        </Button>
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button
          aria-label={copy("Zoom out", "缩小")}
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          −
        </Button>
        <Button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          {copy("Reset view", "重置视图")}
        </Button>
      </div>
      <p className={mutedClass}>
        {copy(
          "Drag the background to pan. Select a symbol for details. Blue outlines mark the traced path; dashed outlines mark potential impact.",
          "拖动背景平移，选择符号查看详情。蓝色边框表示路径，虚线边框表示潜在影响。",
        )}
      </p>
      <svg
        aria-label={copy("Symbol dependency graph", "符号依赖图")}
        className="h-[28rem] w-full touch-none rounded-md border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900"
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const scale = width / event.currentTarget.getBoundingClientRect().width;
          const dx = (event.clientX - drag.current.x) * scale;
          const dy = (event.clientY - drag.current.y) * scale;
          setPan((position) => ({ x: position.x + dx, y: position.y + dy }));
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {edges.map((edge, index) => {
            const start = positions.get(edge.source);
            const end = positions.get(edge.target);
            return start && end ? (
              <line
                key={index}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke="currentColor"
                className="text-gray-400 dark:text-gray-600"
                strokeDasharray={edge.kind === "imports" ? "5 4" : undefined}
              >
                <title>
                  {edge.kind}: {edge.source} → {edge.target}
                </title>
              </line>
            ) : null;
          })}
          {nodes.map((node) => {
            const position = positions.get(node.id)!;
            const active = selectedNodeId === node.id || highlightedPathNodeIds?.has(node.id);
            return (
              <g
                key={node.id}
                transform={`translate(${position.x} ${position.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.name}, ${node.kind}, ${node.filePath}`}
                aria-pressed={selectedNodeId === node.id}
                className="cursor-pointer outline-none focus:stroke-brand-600"
                onClick={() => onSelectNode(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectNode(node.id);
                  }
                }}
              >
                <title>
                  {node.name} · {node.kind}\n{node.filePath}
                </title>
                <rect
                  x={-95}
                  y={-30}
                  width={190}
                  height={60}
                  rx={6}
                  strokeWidth={active ? 3 : 1}
                  strokeDasharray={highlightedImpactNodeIds?.has(node.id) ? "5 3" : undefined}
                  className={`fill-white dark:fill-gray-950 ${active ? "stroke-brand-600 dark:stroke-brand-300" : "stroke-gray-400 dark:stroke-gray-600"}`}
                />
                <text
                  textAnchor="middle"
                  y={-3}
                  fontSize={14}
                  className="fill-gray-900 dark:fill-gray-100"
                >
                  {node.name.length > 22 ? `${node.name.slice(0, 20)}…` : node.name}
                </text>
                <text
                  textAnchor="middle"
                  y={18}
                  fontSize={12}
                  className="fill-gray-600 dark:fill-gray-400"
                >
                  {node.kind}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </section>
  );
}
