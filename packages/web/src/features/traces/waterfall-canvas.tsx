import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import {
  computeWaterfallBounds,
  flattenSpanHierarchy,
  formatDurationMs,
  type ExecutionSpan,
  type SpanKind,
} from "./flamegraph-types";

export interface WaterfallCanvasProps {
  spans: ExecutionSpan[];
  selectedSpanId?: string | null;
  onSelectSpan: (span: ExecutionSpan) => void;
}

function kindTone(kind: SpanKind) {
  switch (kind) {
    case "session":
      return "brand";
    case "subagent":
      return "gray";
    case "model":
      return "brand";
    case "tool":
      return "amber";
    case "guardian":
      return "green";
    default:
      return "gray";
  }
}

export function WaterfallCanvas({
  spans,
  selectedSpanId,
  onSelectSpan,
}: WaterfallCanvasProps) {
  const [zoomLevel, setZoomLevel] = useState<number>(1);

  const bounds = useMemo(() => computeWaterfallBounds(spans), [spans]);
  const flattened = useMemo(() => flattenSpanHierarchy(spans), [spans]);

  const totalDuration = bounds.totalDuration || 1;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      {/* Canvas Controls Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">
            Execution Waterfall
          </span>
          <span className="text-xs text-muted-foreground">
            ({flattened.length} spans • {formatDurationMs(bounds.totalDuration)})
          </span>
        </div>

        {/* Zoom Presets */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Zoom:</span>
          <button
            type="button"
            onClick={() => setZoomLevel(1)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              zoomLevel === 1
                ? "bg-muted text-foreground"
                : "hover:bg-muted hover:text-foreground"
            }`}
          >
            1x Fit
          </button>
          <button
            type="button"
            onClick={() => setZoomLevel(2)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              zoomLevel === 2
                ? "bg-muted text-foreground"
                : "hover:bg-muted hover:text-foreground"
            }`}
          >
            2x
          </button>
          <button
            type="button"
            onClick={() => setZoomLevel(4)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              zoomLevel === 4
                ? "bg-muted text-foreground"
                : "hover:bg-muted hover:text-foreground"
            }`}
          >
            4x
          </button>
        </div>
      </div>

      {/* Timeline Ruler */}
      <div className="relative h-6 border-b border-border/60 text-[10px] text-muted-foreground">
        <span className="absolute left-0 top-1 font-mono">0ms</span>
        <span className="absolute left-1/4 top-1 -translate-x-1/2 font-mono">
          {formatDurationMs(totalDuration * 0.25)}
        </span>
        <span className="absolute left-1/2 top-1 -translate-x-1/2 font-mono">
          {formatDurationMs(totalDuration * 0.5)}
        </span>
        <span className="absolute left-3/4 top-1 -translate-x-1/2 font-mono">
          {formatDurationMs(totalDuration * 0.75)}
        </span>
        <span className="absolute right-0 top-1 font-mono">
          {formatDurationMs(totalDuration)}
        </span>
      </div>

      {/* Waterfall Rows List */}
      <div className="flex flex-col gap-1 overflow-x-auto py-2">
        <div style={{ minWidth: `${zoomLevel * 100}%` }} className="flex flex-col gap-1.5">
          {flattened.map((span) => {
            const isSelected = selectedSpanId === span.id;
            const startOffset = Math.max(0, span.startMs - bounds.minStart);
            const leftPct = (startOffset / totalDuration) * 100;
            const widthPct = Math.max(0.8, (span.durationMs / totalDuration) * 100);

            let barBg = "bg-primary/80 hover:bg-primary";
            if (span.status === "error") {
              barBg = "bg-red-500 hover:bg-red-600";
            } else if (span.kind === "model") {
              barBg = "bg-sky-500 hover:bg-sky-600";
            } else if (span.kind === "tool") {
              barBg = "bg-amber-500 hover:bg-amber-600";
            } else if (span.kind === "guardian") {
              barBg = "bg-emerald-500 hover:bg-emerald-600";
            }

            return (
              <div
                key={span.id}
                onClick={() => onSelectSpan(span)}
                className={`group flex cursor-pointer items-center rounded-md p-1.5 transition-colors ${
                  isSelected
                    ? "bg-primary/10 ring-1 ring-primary"
                    : "hover:bg-muted/60"
                }`}
              >
                {/* Left Hierarchy Label column */}
                <div
                  className="flex w-64 shrink-0 items-center gap-1.5 truncate pr-2 text-xs"
                  style={{ paddingLeft: `${span.depth * 16}px` }}
                >
                  <span className="text-muted-foreground/60">
                    {span.depth > 0 ? "└─" : "●"}
                  </span>
                  <Badge tone={kindTone(span.kind)}>{span.kind}</Badge>
                  <span
                    className={`truncate font-medium ${
                      span.status === "error"
                        ? "text-red-500 font-semibold"
                        : "text-foreground"
                    }`}
                    title={span.name}
                  >
                    {span.name}
                  </span>
                </div>

                {/* Right Bar Timeline Column */}
                <div className="relative h-6 flex-1 rounded bg-muted/40">
                  <div
                    className={`absolute top-0.5 flex h-5 items-center rounded px-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 ${barBg}`}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                    }}
                    title={`${span.name}: ${formatDurationMs(span.durationMs)}`}
                  >
                    <span className="truncate drop-shadow-sm font-mono text-[10px]">
                      {formatDurationMs(span.durationMs)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
