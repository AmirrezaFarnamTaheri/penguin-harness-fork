import { useState, useMemo, useRef, useEffect } from "react";
import type { CodeGraphNode, CodeGraphEdge, CodeNodeKind } from "@prismshadow/penguin-core/browser";

export interface TopologyGraphCanvasProps {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  highlightedPathNodeIds?: Set<string>;
  highlightedImpactNodeIds?: Set<string>;
}

const KIND_COLORS: Record<CodeNodeKind, { bg: string; border: string; text: string }> = {
  file: { bg: "#1e293b", border: "#3b82f6", text: "#93c5fd" },
  module: { bg: "#1e1b4b", border: "#6366f1", text: "#c7d2fe" },
  class: { bg: "#064e3b", border: "#10b981", text: "#a7f3d0" },
  struct: { bg: "#022c22", border: "#059669", text: "#6ee7b7" },
  interface: { bg: "#3b0764", border: "#a855f7", text: "#e9d5ff" },
  trait: { bg: "#4c0519", border: "#f43f5e", text: "#fecdd3" },
  function: { bg: "#083344", border: "#06b6d4", text: "#a5f3fc" },
  type: { bg: "#2e1065", border: "#8b5cf6", text: "#ddd6fe" },
  component: { bg: "#451a03", border: "#f59e0b", text: "#fde68a" },
};

export function TopologyGraphCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  highlightedPathNodeIds,
  highlightedImpactNodeIds,
}: TopologyGraphCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<CodeGraphNode | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Compute layout positions for nodes deterministically
  const nodePositions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const total = nodes.length;
    if (total === 0) return pos;

    // Group by kind / category
    const files = nodes.filter((n) => n.kind === "file");
    const classes = nodes.filter((n) => n.kind === "class" || n.kind === "struct");
    const functions = nodes.filter((n) => n.kind === "function");
    const others = nodes.filter(
      (n) =>
        n.kind !== "file" && n.kind !== "class" && n.kind !== "struct" && n.kind !== "function",
    );

    // Circular multi-tier concentric layout
    // Center: Classes (tier 1)
    classes.forEach((node, idx) => {
      const angle = (idx / Math.max(1, classes.length)) * 2 * Math.PI;
      const radius = 180;
      pos.set(node.id, {
        x: 500 + radius * Math.cos(angle),
        y: 400 + radius * Math.sin(angle),
      });
    });

    // Tier 2: Functions & components
    functions.concat(others).forEach((node, idx) => {
      const angle = (idx / Math.max(1, functions.length + others.length)) * 2 * Math.PI + 0.3;
      const radius = 340;
      pos.set(node.id, {
        x: 500 + radius * Math.cos(angle),
        y: 400 + radius * Math.sin(angle),
      });
    });

    // Outer Tier: Files
    files.forEach((node, idx) => {
      const angle = (idx / Math.max(1, files.length)) * 2 * Math.PI + 0.15;
      const radius = 500;
      pos.set(node.id, {
        x: 500 + radius * Math.cos(angle),
        y: 400 + radius * Math.sin(angle),
      });
    });

    return pos;
  }, [nodes]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target instanceof SVGElement && e.target.tagName === "svg") {
      setIsPanning(true);
      setStartPan({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  // Throttle pan state updates to display refresh rate via requestAnimationFrame
  // Source: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      const nextX = e.clientX - startPan.x;
      const nextY = e.clientY - startPan.y;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        setPan({ x: nextX, y: nextY });
        rafRef.current = null;
      });
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  return (
    <div className="relative w-full h-full min-h-[500px] bg-gray-950 border border-gray-800 rounded-xl overflow-hidden select-none">
      {/* Zoom / Pan Controls Toolbar */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5 p-1 bg-gray-900/90 backdrop-blur-md border border-gray-800 rounded-lg shadow-xl text-xs font-mono text-gray-400">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))}
          className="px-2 py-1 rounded hover:bg-gray-800 hover:text-white transition-colors"
          title="Zoom In"
        >
          +
        </button>
        <span className="px-1 text-[11px] tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
          className="px-2 py-1 rounded hover:bg-gray-800 hover:text-white transition-colors"
          title="Zoom Out"
        >
          -
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          className="px-2 py-1 rounded hover:bg-gray-800 hover:text-white transition-colors border-l border-gray-800 ml-1"
          title="Reset View"
        >
          Reset
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-2 p-2 bg-gray-900/80 backdrop-blur-md border border-gray-800 rounded-lg text-[10px] font-mono text-gray-400">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-blue-500" /> File
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500" /> Class
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-cyan-500" /> Function
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-500" /> Component
        </span>
        <span className="flex items-center gap-1 border-l border-gray-700 pl-2">
          <span className="w-2.5 h-0.5 bg-cyan-400" /> Calls
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-0.5 bg-indigo-400" /> Imports
        </span>
      </div>

      {/* Hover Card */}
      {hoveredNode && (
        <div className="absolute top-3 left-3 z-10 p-2.5 max-w-sm bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-lg shadow-2xl text-xs font-mono">
          <div className="flex items-center justify-between gap-2 pb-1 border-b border-gray-800">
            <span className="font-semibold text-gray-100">{hoveredNode.name}</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-gray-800 text-gray-400 uppercase">
              {hoveredNode.kind}
            </span>
          </div>
          <div className="mt-1.5 text-[11px] text-gray-400 truncate">{hoveredNode.filePath}</div>
          {hoveredNode.loc !== undefined && (
            <div className="mt-1 text-[10px] text-cyan-400">LOC: {hoveredNode.loc} lines</div>
          )}
        </div>
      )}

      {/* SVG Canvas */}
      <svg
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        viewBox="0 0 1000 800"
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Defs for arrow markers and glow filters */}
          <defs>
            <marker
              id="arrow-calls"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#06b6d4" />
            </marker>
            <marker
              id="arrow-imports"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#6366f1" />
            </marker>
            <marker
              id="arrow-contains"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
            </marker>
            <filter id="glow-selected" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Level of Detail threshold: skip heavy filters, markers, and text labels at low zoom */}
          {(() => {
            const isLowDetail = zoom < 0.6;
            return (
              <>
                {/* Edges */}
                {edges.map((edge, idx) => {
                  const p1 = nodePositions.get(edge.source);
                  const p2 = nodePositions.get(edge.target);
                  if (!p1 || !p2) return null;

                  const isHighlighted =
                    highlightedPathNodeIds?.has(edge.source) &&
                    highlightedPathNodeIds?.has(edge.target);

                  const isImpacted =
                    highlightedImpactNodeIds?.has(edge.source) &&
                    highlightedImpactNodeIds?.has(edge.target);

                  const color = isHighlighted
                    ? "#10b981"
                    : isImpacted
                      ? "#f43f5e"
                      : edge.kind === "calls"
                        ? "#06b6d4"
                        : edge.kind === "imports"
                          ? "#6366f1"
                          : "#334155";

                  const marker =
                    isLowDetail && !isHighlighted && !isImpacted
                      ? undefined
                      : edge.kind === "calls"
                        ? "url(#arrow-calls)"
                        : edge.kind === "imports"
                          ? "url(#arrow-imports)"
                          : "url(#arrow-contains)";

                  // Slightly curved cubic bezier path
                  const dx = p2.x - p1.x;
                  const dy = p2.y - p1.y;
                  const cx1 = p1.x + dx * 0.25 - dy * 0.05;
                  const cy1 = p1.y + dy * 0.25 + dx * 0.05;
                  const cx2 = p1.x + dx * 0.75 - dy * 0.05;
                  const cy2 = p1.y + dy * 0.75 + dx * 0.05;

                  return (
                    <path
                      key={idx}
                      d={`M ${p1.x} ${p1.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p2.x} ${p2.y}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={isHighlighted ? 2.5 : isImpacted ? 2 : 1.2}
                      strokeDasharray={edge.kind === "imports" ? "4,4" : undefined}
                      markerEnd={marker}
                      className="transition-all duration-300 opacity-70 hover:opacity-100"
                    />
                  );
                })}

                {/* Nodes */}
                {nodes.map((node) => {
                  const pos = nodePositions.get(node.id);
                  if (!pos) return null;

                  const isSelected = selectedNodeId === node.id;
                  const isPathNode = highlightedPathNodeIds?.has(node.id);
                  const isImpactNode = highlightedImpactNodeIds?.has(node.id);
                  const style = KIND_COLORS[node.kind] ?? KIND_COLORS.file;

                  const radius = node.kind === "file" ? 14 : node.kind === "class" ? 16 : 12;

                  return (
                    <g
                      key={node.id}
                      transform={`translate(${pos.x}, ${pos.y})`}
                      className="cursor-pointer transition-transform duration-150"
                      onClick={() => onSelectNode(node.id)}
                      onMouseEnter={() => setHoveredNode(node)}
                      onMouseLeave={() => setHoveredNode(null)}
                    >
                      {/* Node Outer Halo for Selected / Path / Impact */}
                      {(isSelected || isPathNode || isImpactNode) && (
                        <circle
                          r={radius + 6}
                          fill="none"
                          stroke={isSelected ? "#06b6d4" : isPathNode ? "#10b981" : "#f43f5e"}
                          strokeWidth={2}
                          className={isLowDetail ? undefined : "animate-pulse"}
                          filter={isLowDetail ? undefined : "url(#glow-selected)"}
                        />
                      )}

                      {/* Node Circle */}
                      <circle
                        r={radius}
                        fill={style.bg}
                        stroke={isSelected ? "#38bdf8" : style.border}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                      />

                      {/* Node Label (hidden at low zoom level unless selected to improve SVG render throughput) */}
                      {(!isLowDetail || isSelected) && (
                        <text
                          dy={radius + 14}
                          textAnchor="middle"
                          fill={isSelected ? "#ffffff" : style.text}
                          fontSize="11"
                          fontFamily="monospace"
                          className="pointer-events-none font-medium tracking-tight"
                        >
                          {node.name.length > 20 ? `${node.name.slice(0, 18)}…` : node.name}
                        </text>
                      )}
                    </g>
                  );
                })}
              </>
            );
          })()}
        </g>
      </svg>
    </div>
  );
}
