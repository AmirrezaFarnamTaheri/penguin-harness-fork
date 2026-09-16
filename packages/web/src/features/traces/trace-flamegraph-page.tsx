import { useState, useMemo } from "react";
import { Badge } from "../../components/ui/badge";
import { WaterfallCanvas } from "./waterfall-canvas";
import { CausalErrorTree } from "./causal-error-tree";
import { SpanDetailDrawer } from "./span-detail-drawer";
import { computeWaterfallBounds, formatDurationMs, type ExecutionSpan } from "./flamegraph-types";

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
    <div
      className={`min-w-0 flex flex-col gap-6 text-gray-900 dark:text-gray-100 ${embedded ? "p-3" : "p-4 sm:p-6"}`}
    >
      {/* Top Banner & Header */}
      {
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
                  Execution traces
                </h1>
                <Badge tone="amber">Sample traces</Badge>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Inspect timings, payloads and failures in sample traces. These are not live session
                records.
              </p>
            </div>
          </div>

          {/* Trace Selection Dropdown */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Sample trace:</span>
            <select
              aria-label="Sample trace"
              value={selectedTraceKey}
              onChange={(e) => {
                setSelectedTraceKey(e.target.value);
                setSelectedSpan(null);
              }}
              className="rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-1 text-sm font-medium text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-600"
            >
              <option value="trace-autonomous-refactor">Refactor — build failed</option>
              <option value="trace-codebase-indexing">Codebase indexing — completed</option>
            </select>
          </div>
        </div>
      }

      <dl className="flex flex-wrap gap-x-8 gap-y-3 border-b border-gray-200 pb-4 text-sm dark:border-gray-800">
        {[
          ["Duration", formatDurationMs(bounds.totalDuration)],
          ["Mean first token", `${metrics.meanTtft} ms`],
          ["Model time", formatDurationMs(metrics.modelDuration)],
          ["Tool time", formatDurationMs(metrics.toolDuration)],
          ["Failed spans", metrics.errorSpans],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {/* Causal Error Diagnostics */}
      <CausalErrorTree spans={activeSpans} onSelectSpanId={handleSelectSpanId} />

      {/* Main Waterfall and Inspector Split */}
      <div className="relative flex min-w-0 flex-col gap-6 xl:flex-row">
        <div className="min-w-0 flex-1">
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
