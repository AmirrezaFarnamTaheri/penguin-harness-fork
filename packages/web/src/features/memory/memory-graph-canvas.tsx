import { useState, useMemo } from "react";
import type { MemoryTopicNode } from "./memory-types";
import { parseMemoryLinks, formatBytes } from "./memory-types";
function ZoomInIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ZoomOutIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5" />
    </svg>
  );
}

function LayersIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
import { Button } from "../../components/ui/button";

export interface MemoryGraphCanvasProps {
  topics: MemoryTopicNode[];
  selectedTopicId: string | null;
  onSelectTopic: (id: string) => void;
  highlightedTopicIds?: Set<string>;
}

export function MemoryGraphCanvas({
  topics,
  selectedTopicId,
  onSelectTopic,
  highlightedTopicIds,
}: MemoryGraphCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [hoveredTopic, setHoveredTopic] = useState<MemoryTopicNode | null>(null);

  // Derive graph edges by parsing internal markdown links from each topic
  const edges = useMemo(() => {
    const topicByName = new Map<string, MemoryTopicNode>();
    for (const topic of topics) {
      topicByName.set(topic.name, topic);
      topicByName.set(topic.id, topic);
    }

    const list: Array<{ source: string; target: string }> = [];
    for (const topic of topics) {
      const links = parseMemoryLinks(topic.content);
      for (const link of links) {
        const cleanName = link.replace(/^\.\//, "");
        const target = topicByName.get(cleanName);
        if (target && target.id !== topic.id) {
          list.push({ source: topic.id, target: target.id });
        }
      }
    }
    return list;
  }, [topics]);

  // Deterministic circular layout grouped by scope
  const nodePositions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    if (topics.length === 0) return pos;

    const userTopics = topics.filter((t) => t.scope === "user");
    const workspaceTopics = topics.filter((t) => t.scope === "workspace");

    // Center-left: User topics circle
    userTopics.forEach((topic, idx) => {
      const angle = (idx / Math.max(1, userTopics.length)) * 2 * Math.PI;
      const radius = userTopics.length > 1 ? 120 : 0;
      pos.set(topic.id, {
        x: 320 + radius * Math.cos(angle),
        y: 350 + radius * Math.sin(angle),
      });
    });

    // Center-right: Workspace topics circle
    workspaceTopics.forEach((topic, idx) => {
      const angle = (idx / Math.max(1, workspaceTopics.length)) * 2 * Math.PI;
      const radius = workspaceTopics.length > 1 ? 190 : 0;
      pos.set(topic.id, {
        x: 680 + radius * Math.cos(angle),
        y: 350 + radius * Math.sin(angle),
      });
    });

    return pos;
  }, [topics]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsPanning(true);
      setStartPan({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({
        x: e.clientX - startPan.x,
        y: e.clientY - startPan.y,
      });
    }
  };

  const handleMouseUp = () => setIsPanning(false);

  return (
    <div className="relative w-full h-[520px] rounded-lg border border-border bg-card/60 overflow-hidden select-none flex flex-col">
      {/* Canvas Controls Header */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-background/80 backdrop-blur-md px-2.5 py-1.5 rounded-md border border-border text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <LayersIcon size={14} />
          <span>Knowledge Graph ({topics.length} Topics, {edges.length} Links)</span>
        </div>
        <div className="h-3 w-px bg-border mx-1" />
        <div className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500/80" />
          <span className="text-muted-foreground text-[11px]">User Scope</span>
        </div>
        <div className="flex items-center gap-1 ml-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
          <span className="text-muted-foreground text-[11px]">Workspace</span>
        </div>
      </div>

      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-background/80 backdrop-blur-md p-1 rounded-md border border-border">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))}
          title="Zoom In"
        >
          <ZoomInIcon size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
          title="Zoom Out"
        >
          <ZoomOutIcon size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          title="Reset View"
        >
          <RefreshIcon size={14} />
        </Button>
      </div>

      {/* SVG Canvas */}
      <svg
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Edge links */}
          {edges.map((edge, idx) => {
            const p1 = nodePositions.get(edge.source);
            const p2 = nodePositions.get(edge.target);
            if (!p1 || !p2) return null;

            const isHighlighted =
              highlightedTopicIds?.has(edge.source) && highlightedTopicIds?.has(edge.target);

            return (
              <line
                key={`edge-${idx}`}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={isHighlighted ? "#f59e0b" : "currentColor"}
                strokeOpacity={isHighlighted ? 0.9 : 0.25}
                strokeWidth={isHighlighted ? 2.5 : 1.2}
                strokeDasharray={isHighlighted ? "4,4" : undefined}
                className="text-border transition-all duration-200"
              />
            );
          })}

          {/* Node circles */}
          {topics.map((topic) => {
            const pos = nodePositions.get(topic.id);
            if (!pos) return null;

            const isSelected = selectedTopicId === topic.id;
            const isHighlighted = highlightedTopicIds?.has(topic.id);
            const isUserScope = topic.scope === "user";

            const strokeColor = isSelected
              ? "#f59e0b"
              : isHighlighted
              ? "#38bdf8"
              : isUserScope
              ? "#3b82f6"
              : "#10b981";

            const fillColor = isSelected
              ? "rgba(245, 158, 11, 0.25)"
              : isUserScope
              ? "rgba(59, 130, 246, 0.15)"
              : "rgba(16, 185, 129, 0.15)";

            return (
              <g
                key={topic.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTopic(topic.id);
                }}
                onMouseEnter={() => setHoveredTopic(topic)}
                onMouseLeave={() => setHoveredTopic(null)}
                className="cursor-pointer group"
              >
                <circle
                  r={isSelected ? 26 : 22}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={isSelected ? 3 : 2}
                  className="transition-all duration-150 group-hover:scale-110"
                />
                <text
                  textAnchor="middle"
                  dy="4"
                  className="fill-foreground text-[11px] font-medium pointer-events-none select-none"
                >
                  {topic.name.replace(".md", "").slice(0, 10)}
                </text>
                <text
                  textAnchor="middle"
                  dy="36"
                  className="fill-muted-foreground text-[9px] pointer-events-none select-none"
                >
                  {formatBytes(topic.bytes)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Hover Info Tooltip */}
      {hoveredTopic && (
        <div className="absolute bottom-3 left-3 z-10 bg-popover/95 backdrop-blur-md text-popover-foreground px-3 py-2 rounded-md border border-border shadow-lg max-w-sm pointer-events-none">
          <div className="font-semibold text-xs text-foreground flex items-center justify-between gap-2">
            <span>{hoveredTopic.title}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-normal ${
                hoveredTopic.scope === "user"
                  ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                  : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              }`}
            >
              {hoveredTopic.scope}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {hoveredTopic.name} • {formatBytes(hoveredTopic.bytes)} • {hoveredTopic.tokens} tokens
          </div>
          {hoveredTopic.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {hoveredTopic.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
