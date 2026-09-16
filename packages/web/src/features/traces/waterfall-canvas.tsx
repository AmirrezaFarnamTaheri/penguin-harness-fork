import { useMemo, useState } from "react";
import {
  computeWaterfallBounds,
  flattenSpanHierarchy,
  formatDurationMs,
  type ExecutionSpan,
} from "./flamegraph-types";

export interface WaterfallCanvasProps {
  spans: ExecutionSpan[];
  selectedSpanId?: string | null;
  onSelectSpan: (span: ExecutionSpan) => void;
}

export function WaterfallCanvas({ spans, selectedSpanId, onSelectSpan }: WaterfallCanvasProps) {
  const [zoomLevel, setZoomLevel] = useState(1);
  const bounds = useMemo(() => computeWaterfallBounds(spans), [spans]);
  const flattened = useMemo(() => flattenSpanHierarchy(spans), [spans]);
  const total = bounds.totalDuration || 1;
  return (
    <section className="min-w-0 space-y-4 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Span timings</h2>
        <div className="flex flex-wrap items-center gap-2" aria-label="Timeline zoom">
          {[1, 2, 4].map((level) => (
            <button
              type="button"
              key={level}
              aria-pressed={zoomLevel === level}
              onClick={() => setZoomLevel(level)}
              className={`min-h-9 rounded-md border px-3 py-2 ${zoomLevel === level ? "border-blue-600" : "border-gray-300 dark:border-gray-700"}`}
            >
              {level === 1 ? "Fit" : `${level}×`}
            </button>
          ))}
        </div>
      </header>
      <p className="text-gray-600 dark:text-gray-400">
        Select a span to inspect it. Bars show time relative to the start; exact duration and status
        are listed beside each span.
      </p>
      <div className="overflow-x-auto" role="region" aria-label="Execution timeline" tabIndex={0}>
        <div style={{ width: `${zoomLevel * 100}%`, minWidth: "640px" }}>
          <div className="grid grid-cols-[minmax(220px,1fr)_minmax(240px,2fr)_90px] gap-3 border-b border-gray-200 py-2 dark:border-gray-800">
            <span>Span / status</span>
            <div className="flex justify-between tabular-nums">
              <span>0 ms</span>
              <span>{formatDurationMs(total / 2)}</span>
              <span>{formatDurationMs(total)}</span>
            </div>
            <span className="text-right">Duration</span>
          </div>
          {flattened.map((span) => {
            const left = Math.max(
              0,
              Math.min(100, ((span.startMs - bounds.minStart) / total) * 100),
            );
            const width = Math.max(0, Math.min(100 - left, (span.durationMs / total) * 100));
            return (
              <button
                type="button"
                key={span.id}
                onClick={() => onSelectSpan(span)}
                aria-pressed={selectedSpanId === span.id}
                className={`grid w-full grid-cols-[minmax(220px,1fr)_minmax(240px,2fr)_90px] items-center gap-3 border-b border-gray-200 py-3 text-left dark:border-gray-800 ${selectedSpanId === span.id ? "bg-blue-50 dark:bg-gray-800" : "hover:bg-gray-50 dark:hover:bg-gray-900"}`}
              >
                <span
                  className="min-w-0 break-words"
                  style={{ paddingLeft: Math.min(span.depth, 6) * 12 }}
                >
                  <span className="block font-medium">{span.name}</span>
                  <span className="text-gray-600 dark:text-gray-400">
                    {span.kind} · {span.status}
                  </span>
                </span>
                <span className="relative h-5 bg-gray-100 dark:bg-gray-800" aria-hidden="true">
                  <span
                    className={`absolute inset-y-1 rounded-sm ${span.status === "error" ? "bg-red-700 dark:bg-red-400" : "bg-blue-700 dark:bg-blue-400"}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">{formatDurationMs(span.durationMs)}</span>
              </button>
            );
          })}
        </div>
      </div>
      {flattened.length === 0 && <p>No spans available.</p>}
    </section>
  );
}
