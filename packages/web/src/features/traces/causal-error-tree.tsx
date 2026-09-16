import { useMemo } from "react";
import { Badge } from "../../components/ui/badge";
import { extractCausalErrorChain, formatDurationMs, type ExecutionSpan } from "./flamegraph-types";

export interface CausalErrorTreeProps {
  spans: ExecutionSpan[];
  onSelectSpanId: (spanId: string) => void;
}

function AlertTriangleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CheckShieldIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function CausalErrorTree({ spans, onSelectSpanId }: CausalErrorTreeProps) {
  const chain = useMemo(() => extractCausalErrorChain(spans), [spans]);

  if (chain.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-200 dark:border-gray-800 py-4 text-sm text-gray-600 dark:text-gray-400">
        <div className="flex min-h-9 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
          <CheckShieldIcon size={16} />
        </div>
        <div>
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            Zero Failure Causality
          </span>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            All execution spans, model invocations, and tool executions terminated successfully.
          </p>
        </div>
      </div>
    );
  }

  const rootFault = chain[chain.length - 1];

  return (
    <div className="flex flex-col gap-3 rounded-md border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between">
        <div className="flex flex-wrap items-center gap-2 text-red-700 dark:text-red-400">
          <AlertTriangleIcon size={18} />
          <span className="text-sm font-semibold  ">Failed spans</span>
        </div>
        <Badge tone="red">{chain.length} failed spans</Badge>
      </div>

      {rootFault?.errorMessage && (
        <div className="rounded-lg border border-red-500/20 bg-white dark:bg-gray-950 p-3 text-sm text-red-600 dark:text-red-400">
          <span className="font-semibold">Deepest reported error: </span>
          {rootFault.errorMessage}
        </div>
      )}

      {/* Chain nodes sequence */}
      <div className="flex flex-col gap-2 pt-1">
        <span className="text-sm font-semibold text-gray-600 dark:text-gray-400">
          Failure path:
        </span>
        <div className="flex flex-col gap-1.5">
          {chain.map((node, index) => (
            <button
              type="button"
              key={node.spanId}
              onClick={() => onSelectSpanId(node.spanId)}
              className="flex cursor-pointer items-center justify-between rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-2 text-sm transition-colors hover:border-red-500/40"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/10 text-sm font-semibold text-red-700 dark:text-red-400">
                  {index + 1}
                </span>
                <Badge tone="red">{node.kind}</Badge>
                <span className="font-medium text-gray-900 dark:text-gray-100">{node.name}</span>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <span>{formatDurationMs(node.endMs - node.startMs)}</span>
                <span className="text-blue-700 dark:text-blue-400 hover:underline">Inspect →</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
