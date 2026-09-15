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
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
          <CheckShieldIcon size={16} />
        </div>
        <div>
          <span className="font-semibold text-foreground">Zero Failure Causality</span>
          <p className="text-[11px] text-muted-foreground">
            All execution spans, model invocations, and tool executions terminated successfully.
          </p>
        </div>
      </div>
    );
  }

  const rootFault = chain[chain.length - 1];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-red-500">
          <AlertTriangleIcon size={18} />
          <span className="text-xs font-bold uppercase tracking-wider">
            Causal Error Diagnostics
          </span>
        </div>
        <Badge tone="red">{chain.length} Failure Hops</Badge>
      </div>

      {rootFault?.errorMessage && (
        <div className="rounded-lg border border-red-500/20 bg-background/80 p-3 font-mono text-xs text-red-600 dark:text-red-400">
          <span className="font-semibold">Root Cause: </span>
          {rootFault.errorMessage}
        </div>
      )}

      {/* Chain nodes sequence */}
      <div className="flex flex-col gap-2 pt-1">
        <span className="text-[11px] font-semibold text-muted-foreground">
          Causality Sequence (Root Cascade → Termination):
        </span>
        <div className="flex flex-col gap-1.5">
          {chain.map((node, index) => (
            <div
              key={node.spanId}
              onClick={() => onSelectSpanId(node.spanId)}
              className="flex cursor-pointer items-center justify-between rounded-md border border-border bg-card p-2 text-xs transition-colors hover:border-red-500/40"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/10 font-mono text-[11px] font-bold text-red-500">
                  {index + 1}
                </span>
                <Badge tone="red">{node.kind}</Badge>
                <span className="font-medium text-foreground">{node.name}</span>
              </div>

              <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>{formatDurationMs(node.endMs - node.startMs)}</span>
                <span className="text-primary hover:underline">Inspect →</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
