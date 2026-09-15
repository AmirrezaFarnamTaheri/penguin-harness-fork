import { useState, useMemo } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WaterfallCanvas } from "./waterfall-canvas";
import { CausalErrorTree } from "./causal-error-tree";
import { SpanDetailDrawer } from "./span-detail-drawer";
import { computeWaterfallBounds, formatDurationMs, type ExecutionSpan } from "./flamegraph-types";

function FlameIcon({ size = 20 }: { size?: number }) {
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
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

const SAMPLE_TRACES: Record<string, ExecutionSpan[]> = {
  "trace-autonomous-refactor": [
    {
      id: "span-root-refactor",
      name: "Autonomous Refactor Session",
      kind: "session",
      status: "error",
      startMs: 1000,
      endMs: 5250,
      durationMs: 4250,
      children: [
        {
          id: "span-subagent-worker",
          name: "Executor Subagent: refactor-pipeline",
          kind: "subagent",
          status: "error",
          parentId: "span-root-refactor",
          startMs: 1100,
          endMs: 5100,
          durationMs: 4000,
          children: [
            {
              id: "span-guardian-audit",
              name: "Guardian Pre-flight Validation",
              kind: "guardian",
              status: "success",
              parentId: "span-subagent-worker",
              startMs: 1150,
              endMs: 1350,
              durationMs: 200,
              outputPayload: '{"decision": "allow", "checks": 4}',
            },
            {
              id: "span-model-planner",
              name: "claude-3-5-sonnet: Plan Next Step",
              kind: "model",
              status: "success",
              parentId: "span-subagent-worker",
              startMs: 1400,
              endMs: 2600,
              durationMs: 1200,
              ttftMs: 350,
              tokens: {
                promptTokens: 4200,
                completionTokens: 850,
                cacheReadTokens: 3200,
                totalCostUsd: 0.021,
              },
              inputPayload: '{"task": "Refactor bash execution plugin with defensive timeouts"}',
              outputPayload:
                '{"thought": "I will execute pnpm run build to verify current pipeline state."}',
            },
            {
              id: "span-tool-exec-bash",
              name: "Tool: bash (pnpm run build)",
              kind: "tool",
              status: "error",
              parentId: "span-subagent-worker",
              startMs: 2700,
              endMs: 4800,
              durationMs: 2100,
              errorMessage: "Build failed with exit code 1: TS2322 Type mismatch in runtime.ts",
              stackTrace:
                "Error: Process exited with 1\n  at runBashCommand (bash-plugin.ts:42)\n  at executeTool (tool-runner.ts:108)",
              inputPayload: '{"command": "pnpm run build"}',
              outputPayload: "ELIFECYCLE Command failed with exit code 1",
            },
          ],
        },
      ],
    },
  ],
  "trace-codebase-indexing": [
    {
      id: "span-root-indexing",
      name: "Vector & AST Codebase Indexing",
      kind: "session",
      status: "success",
      startMs: 2000,
      endMs: 5400,
      durationMs: 3400,
      children: [
        {
          id: "span-subagent-indexer",
          name: "Indexer Worker: AstParser",
          kind: "subagent",
          status: "success",
          parentId: "span-root-indexing",
          startMs: 2100,
          endMs: 5300,
          durationMs: 3200,
          children: [
            {
              id: "span-tool-fd-find",
              name: "Tool: find_by_name (*.ts)",
              kind: "tool",
              status: "success",
              parentId: "span-subagent-indexer",
              startMs: 2200,
              endMs: 2650,
              durationMs: 450,
              inputPayload: '{"Pattern": "*.ts", "Directory": "packages/web"}',
              outputPayload: '{"matches": 142, "status": "ok"}',
            },
            {
              id: "span-model-embedding",
              name: "text-embedding-3-small: Generate Vectors",
              kind: "model",
              status: "success",
              parentId: "span-subagent-indexer",
              startMs: 2700,
              endMs: 4200,
              durationMs: 1500,
              ttftMs: 180,
              tokens: {
                promptTokens: 18400,
                completionTokens: 0,
                cacheReadTokens: 12000,
                totalCostUsd: 0.0035,
              },
            },
            {
              id: "span-tool-save-index",
              name: "Tool: write_to_file (ast-index.json)",
              kind: "tool",
              status: "success",
              parentId: "span-subagent-indexer",
              startMs: 4300,
              endMs: 5100,
              durationMs: 800,
              inputPayload: '{"target": "ast-index.json", "sizeBytes": 245000}',
              outputPayload: '{"written": true}',
            },
          ],
        },
      ],
    },
  ],
};

export function TraceFlamegraphPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [selectedTraceKey, setSelectedTraceKey] = useState<string>("trace-autonomous-refactor");
  const [selectedSpan, setSelectedSpan] = useState<ExecutionSpan | null>(null);

  const activeSpans = useMemo(() => {
    return SAMPLE_TRACES[selectedTraceKey] ?? [];
  }, [selectedTraceKey]);

  const bounds = useMemo(() => computeWaterfallBounds(activeSpans), [activeSpans]);

  // Aggregate metrics
  const metrics = useMemo(() => {
    let errorSpans = 0;
    let modelDuration = 0;
    let toolDuration = 0;
    let ttftCount = 0;
    let totalTtft = 0;

    function countMetrics(span: ExecutionSpan) {
      if (span.status === "error") errorSpans++;
      if (span.kind === "model") {
        modelDuration += span.durationMs;
        if (span.ttftMs) {
          totalTtft += span.ttftMs;
          ttftCount++;
        }
      }
      if (span.kind === "tool") {
        toolDuration += span.durationMs;
      }
      if (span.children) {
        for (const child of span.children) {
          countMetrics(child);
        }
      }
    }

    for (const span of activeSpans) {
      countMetrics(span);
    }

    const meanTtft = ttftCount > 0 ? Math.round(totalTtft / ttftCount) : 0;

    return {
      errorSpans,
      modelDuration,
      toolDuration,
      meanTtft,
    };
  }, [activeSpans]);

  const handleSelectSpanId = (spanId: string) => {
    function findSpan(current: ExecutionSpan): ExecutionSpan | null {
      if (current.id === spanId) return current;
      if (current.children) {
        for (const child of current.children) {
          const res = findSpan(child);
          if (res) return res;
        }
      }
      return null;
    }

    for (const root of activeSpans) {
      const found = findSpan(root);
      if (found) {
        setSelectedSpan(found);
        return;
      }
    }
  };

  return (
    <div className={`flex h-full flex-col gap-6 ${embedded ? "p-3" : "p-6"}`}>
      {/* Top Banner & Header */}
      {!embedded && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FlameIcon size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-foreground">
                  Deep Execution Waterfall & Flamegraph Profiler
                </h1>
                <Badge tone="amber">[Demo Studio]</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Sub-millisecond span profiling, time-to-first-token attribution, and root-cause
                failure causality
              </p>
            </div>
          </div>

          {/* Trace Selection Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Active Session:</span>
            <select
              value={selectedTraceKey}
              onChange={(e) => {
                setSelectedTraceKey(e.target.value);
                setSelectedSpan(null);
              }}
              className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="trace-autonomous-refactor">
                [Demo Session] Task-4819: Autonomous Refactor (1 Error)
              </option>
              <option value="trace-codebase-indexing">
                [Demo Session] Task-4818: Codebase Indexing (Clean)
              </option>
            </select>
          </div>
        </div>
      )}

      {/* Latency & Telemetry Metric Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Trace Duration</span>
          <span className="font-mono text-2xl font-bold text-foreground">
            {formatDurationMs(bounds.totalDuration)}
          </span>
          <span className="text-[11px] text-muted-foreground">Wall-clock execution span</span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Mean Model TTFT</span>
          <span className="font-mono text-2xl font-bold text-sky-500">{metrics.meanTtft}ms</span>
          <span className="text-[11px] text-muted-foreground">Time-to-first-token latency</span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Model Streaming</span>
          <span className="font-mono text-2xl font-bold text-violet-500">
            {formatDurationMs(metrics.modelDuration)}
          </span>
          <span className="text-[11px] text-muted-foreground">Autoregressive generation</span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Tool Runtime</span>
          <span className="font-mono text-2xl font-bold text-amber-500">
            {formatDurationMs(metrics.toolDuration)}
          </span>
          <span className="text-[11px] text-muted-foreground">Shell & plugin execution</span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Failing Spans</span>
          <span
            className={`font-mono text-2xl font-bold ${
              metrics.errorSpans > 0 ? "text-red-500" : "text-emerald-500"
            }`}
          >
            {metrics.errorSpans}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {metrics.errorSpans > 0 ? "Root-cause tree available" : "Clean execution"}
          </span>
        </div>
      </div>

      {/* Causal Error Diagnostics */}
      <CausalErrorTree spans={activeSpans} onSelectSpanId={handleSelectSpanId} />

      {/* Main Waterfall and Inspector Split */}
      <div className="relative flex flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex-1 overflow-y-auto p-4">
          <WaterfallCanvas
            spans={activeSpans}
            selectedSpanId={selectedSpan?.id}
            onSelectSpan={(span) => setSelectedSpan(span)}
          />
        </div>

        {/* Slide-over Inspector Drawer */}
        {selectedSpan && (
          <SpanDetailDrawer span={selectedSpan} onClose={() => setSelectedSpan(null)} />
        )}
      </div>
    </div>
  );
}
