/**
 * Live trace analysis → flamegraph spans: converts the server-computed analysis
 * payload (GET /api/sessions/:id/traces/:n/analysis — the same JSON the Trace
 * file view renders) into the ExecutionSpan tree the waterfall page draws. One
 * root span per turn (taskIndex), model segments and tool calls as children.
 */
import type { ExecutionSpan, SpanStatus } from "./flamegraph-types";

/** The converter's public output: an ExecutionSpan root per turn, with children. */
export type ExecutionSpanTree = ExecutionSpan;

/** Only the fields the converter reads; importable directly from the server package. */
export interface TraceAnalysisInput {
  tasks: Array<{
    taskIndex: number;
    startTs: string;
    endTs: string;
    compaction?: boolean;
    tokens: { cacheRead: number; cacheWrite: number; output: number };
    cost?: number;
  }>;
  requests: Array<{ beginTs: string; endTs?: string; status?: string; taskIndex: number }>;
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    startTs: string;
    endTs?: string;
    durationMs?: number;
  }>;
}

const ms = (ts: string): number => new Date(ts).getTime();

export function parseTraceSpansToFlamegraph(analysis: TraceAnalysisInput): ExecutionSpanTree[] {
  if (analysis.tasks.length === 0) return [];
  const begin = Math.min(
    ...analysis.tasks.filter((t) => t.startTs !== "").map((t) => new Date(t.startTs).getTime()),
  );

  const requestStatus = new Map<number, SpanStatus>();
  for (const r of analysis.requests) {
    const failed = r.status !== undefined && r.status !== "completed";
    // A turn is an error turn when any of its requests failed.
    if (failed && !requestStatus.get(r.taskIndex)) requestStatus.set(r.taskIndex, "error");
  }

  return analysis.tasks
    .slice()
    .sort((a, b) => a.taskIndex - b.taskIndex)
    .map((task) => {
      const startMs = task.startTs === "" ? begin : new Date(task.startTs).getTime();
      const endMs = task.endTs === "" ? startMs : new Date(task.endTs).getTime();
      const requests = analysis.requests.filter((r) => r.taskIndex === task.taskIndex);
      const tools = analysis.toolCalls.filter((c) => {
        const t = new Date(c.startTs).getTime();
        return t >= startMs && t <= Math.max(endMs, startMs + 1);
      });
      const children: ExecutionSpanTree[] = [];
      for (const r of requests) {
        const rStart = new Date(r.beginTs).getTime();
        const rEnd = r.endTs === undefined ? rStart : new Date(r.endTs).getTime();
        children.push({
          id: `request-${task.taskIndex}-${r.beginTs}`,
          name: "Model request",
          kind: "model",
          status: r.status !== undefined && r.status !== "completed" ? "error" : "success",
          parentId: `task-${task.taskIndex}`,
          startMs: rStart - begin,
          endMs: rEnd - begin,
          durationMs: Math.max(0, rEnd - rStart),
        });
      }
      for (const c of tools) {
        const cStart = new Date(c.startTs).getTime();
        const cEnd = c.endTs === undefined ? cStart : new Date(c.endTs).getTime();
        children.push({
          id: c.toolCallId,
          name: `Tool: ${c.name}`,
          kind: "tool",
          status: c.endTs === undefined ? "running" : "success",
          parentId: `task-${task.taskIndex}`,
          startMs: cStart - begin,
          endMs: cEnd - begin,
          durationMs: Math.max(0, cEnd - cStart),
        });
      }
      children.sort((a, b) => a.startMs - b.startMs);
      return {
        id: `task-${task.taskIndex}`,
        name: `Turn ${task.taskIndex + 1}${task.compaction === true ? " (compaction)" : ""}`,
        kind: "session",
        status: requestStatus.get(task.taskIndex) ?? "success",
        startMs: startMs - begin,
        endMs: endMs - begin,
        durationMs: Math.max(0, endMs - startMs),
        children,
        tokens: {
          promptTokens: task.tokens.cacheRead + task.tokens.cacheWrite,
          completionTokens: task.tokens.output,
          cacheReadTokens: task.tokens.cacheRead,
          totalCostUsd: task.cost ?? 0,
        },
      };
    });
}
