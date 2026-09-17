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
    <div className="flex w-full min-w-0 flex-col border-t border-gray-200 dark:border-gray-800 py-4 xl:w-96 xl:shrink-0 xl:border-t-0 xl:border-l xl:pl-4 ">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={span.status === "error" ? "red" : span.status === "running" ? "amber" : "green"}
          >
            {span.status}
          </Badge>
          <span className=" text-sm font-semibold text-gray-900 dark:text-gray-100">
            {span.kind}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-gray-600 dark:text-gray-400 hover:bg-muted hover:text-foreground"
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
      <div className="flex flex-1 min-w-0 flex-col gap-4 py-3 text-sm">
        {/* Name & ID */}
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-gray-900 dark:text-gray-100">{span.name}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className=" text-sm text-gray-600 dark:text-gray-400">{span.id}</span>
            <CopyButton text={span.id} label="Copy span id" />
          </div>
        </div>

        {/* Timing Breakdown Card */}
        <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-800 py-3">
          <span className="font-semibold text-gray-900 dark:text-gray-100">Timing Breakdown</span>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-600 dark:text-gray-400">Duration:</span>
              <div className=" font-medium text-gray-900 dark:text-gray-100">
                {formatDurationMs(span.durationMs)}
              </div>
            </div>
            {breakdown.ttftMs > 0 && (
              <div>
                <span className="text-gray-600 dark:text-gray-400">TTFT:</span>
                <div className=" font-medium text-sky-700 dark:text-sky-400">
                  {formatDurationMs(breakdown.ttftMs)}
                </div>
              </div>
            )}
            {breakdown.generationMs > 0 && (
              <div>
                <span className="text-gray-600 dark:text-gray-400">Generation:</span>
                <div className=" font-medium text-violet-700 dark:text-violet-400">
                  {formatDurationMs(breakdown.generationMs)}
                </div>
              </div>
            )}
            {breakdown.toolMs > 0 && (
              <div>
                <span className="text-gray-600 dark:text-gray-400">Tool Runtime:</span>
                <div className=" font-medium text-amber-700 dark:text-amber-400">
                  {formatDurationMs(breakdown.toolMs)}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Token Attribution (if model span) */}
        {span.tokens && (
          <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-800 py-3">
            <div className="flex flex-wrap items-center justify-between">
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                Token Consumption
              </span>
              <span className=" font-semibold text-emerald-700 dark:text-emerald-400">
                ${span.tokens.totalCostUsd.toFixed(4)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <span className="text-gray-600 dark:text-gray-400">Prompt:</span>
                <div className=" font-medium text-gray-900 dark:text-gray-100">
                  {span.tokens.promptTokens.toLocaleString()}
                </div>
              </div>
              <div>
                <span className="text-gray-600 dark:text-gray-400">Completion:</span>
                <div className=" font-medium text-gray-900 dark:text-gray-100">
                  {span.tokens.completionTokens.toLocaleString()}
                </div>
              </div>
              <div>
                <span className="text-gray-600 dark:text-gray-400">Cache Read:</span>
                <div className=" font-medium text-gray-900 dark:text-gray-100">
                  {span.tokens.cacheReadTokens.toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error Diagnostics (if failed) */}
        {span.errorMessage && (
          <div className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
            <span className="font-semibold text-red-700 dark:text-red-400">Error Diagnostic</span>
            <div className=" text-sm text-red-600 dark:text-red-400">{span.errorMessage}</div>
            {span.stackTrace && (
              <pre className="font-mono break-words whitespace-pre-wrap max-h-36 overflow-x-auto rounded bg-white dark:bg-gray-950 p-2 text-sm text-gray-600 dark:text-gray-400">
                {span.stackTrace}
              </pre>
            )}
          </div>
        )}

        {/* Input Payload */}
        {span.inputPayload && (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between">
              <span className="font-semibold text-gray-900 dark:text-gray-100">Input Payload</span>
              <CopyButton text={span.inputPayload} label="Copy input payload" />
            </div>
            <pre className="font-mono break-words whitespace-pre-wrap max-h-40 overflow-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-900 p-2.5 text-sm text-gray-900 dark:text-gray-100">
              {span.inputPayload}
            </pre>
          </div>
        )}

        {/* Output Payload */}
        {span.outputPayload && (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between">
              <span className="font-semibold text-gray-900 dark:text-gray-100">Output Payload</span>
              <CopyButton text={span.outputPayload} label="Copy output payload" />
            </div>
            <pre className="font-mono break-words whitespace-pre-wrap max-h-40 overflow-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-900 p-2.5 text-sm text-gray-900 dark:text-gray-100">
              {span.outputPayload}
            </pre>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-gray-200 dark:border-gray-800 pt-3">
        <Button variant="secondary" size="sm" onClick={onClose} className="w-full">
          Close Inspector
        </Button>
      </div>
    </div>
  );
}
