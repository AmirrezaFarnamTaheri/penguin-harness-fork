import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import {
  calculateSpanLatencyBreakdown,
  formatDurationMs,
  type ExecutionSpan,
} from "./flamegraph-types";

export interface SpanDetailDrawerProps {
  span: ExecutionSpan | null;
  onClose: () => void;
}

export function SpanDetailDrawer({ span, onClose }: SpanDetailDrawerProps) {
  if (!span) return null;

  const breakdown = calculateSpanLatencyBreakdown(span);

  return (
    <div className="flex h-full w-96 flex-col border-l border-border bg-card p-4 shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Badge
            tone={span.status === "error" ? "red" : span.status === "running" ? "amber" : "green"}
          >
            {span.status.toUpperCase()}
          </Badge>
          <span className="font-mono text-xs font-semibold text-foreground">{span.kind}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close drawer"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Scrollable Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto py-3 text-xs">
        {/* Name & ID */}
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-foreground">{span.name}</span>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[11px] text-muted-foreground">{span.id}</span>
            <CopyButton text={span.id} label="Copy span id" />
          </div>
        </div>

        {/* Timing Breakdown Card */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <span className="font-semibold text-foreground">Timing Breakdown</span>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <span className="text-muted-foreground">Duration:</span>
              <div className="font-mono font-medium text-foreground">
                {formatDurationMs(span.durationMs)}
              </div>
            </div>
            {breakdown.ttftMs > 0 && (
              <div>
                <span className="text-muted-foreground">TTFT:</span>
                <div className="font-mono font-medium text-sky-500">
                  {formatDurationMs(breakdown.ttftMs)}
                </div>
              </div>
            )}
            {breakdown.generationMs > 0 && (
              <div>
                <span className="text-muted-foreground">Generation:</span>
                <div className="font-mono font-medium text-violet-500">
                  {formatDurationMs(breakdown.generationMs)}
                </div>
              </div>
            )}
            {breakdown.toolMs > 0 && (
              <div>
                <span className="text-muted-foreground">Tool Runtime:</span>
                <div className="font-mono font-medium text-amber-500">
                  {formatDurationMs(breakdown.toolMs)}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Token Attribution (if model span) */}
        {span.tokens && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">Token Consumption</span>
              <span className="font-mono font-semibold text-emerald-500">
                ${span.tokens.totalCostUsd.toFixed(4)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <span className="text-muted-foreground">Prompt:</span>
                <div className="font-mono font-medium text-foreground">
                  {span.tokens.promptTokens.toLocaleString()}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Completion:</span>
                <div className="font-mono font-medium text-foreground">
                  {span.tokens.completionTokens.toLocaleString()}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Cache Read:</span>
                <div className="font-mono font-medium text-foreground">
                  {span.tokens.cacheReadTokens.toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error Diagnostics (if failed) */}
        {span.errorMessage && (
          <div className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
            <span className="font-semibold text-red-500">Error Diagnostic</span>
            <div className="font-mono text-[11px] text-red-600 dark:text-red-400">
              {span.errorMessage}
            </div>
            {span.stackTrace && (
              <pre className="max-h-36 overflow-x-auto rounded bg-background p-2 font-mono text-[10px] text-muted-foreground">
                {span.stackTrace}
              </pre>
            )}
          </div>
        )}

        {/* Input Payload */}
        {span.inputPayload && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">Input Payload</span>
              <CopyButton text={span.inputPayload} label="Copy input payload" />
            </div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/50 p-2.5 font-mono text-[11px] text-foreground">
              {span.inputPayload}
            </pre>
          </div>
        )}

        {/* Output Payload */}
        {span.outputPayload && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">Output Payload</span>
              <CopyButton text={span.outputPayload} label="Copy output payload" />
            </div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/50 p-2.5 font-mono text-[11px] text-foreground">
              {span.outputPayload}
            </pre>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border pt-3">
        <Button variant="secondary" size="sm" onClick={onClose} className="w-full">
          Close Inspector
        </Button>
      </div>
    </div>
  );
}
