/**
 * Deep Execution Waterfall & Flamegraph Profiler Types & Algorithms.
 */

export type SpanKind = "session" | "subagent" | "model" | "tool" | "guardian";

export type SpanStatus = "success" | "error" | "running";

export interface TokenMetrics {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
}

export interface ExecutionSpan {
  id: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  startMs: number;
  endMs: number;
  durationMs: number;
  ttftMs?: number;
  parentId?: string;
  children?: ExecutionSpan[];
  tokens?: TokenMetrics;
  inputPayload?: string;
  outputPayload?: string;
  errorMessage?: string;
  stackTrace?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface SpanLatencyBreakdown {
  ttftMs: number;
  generationMs: number;
  toolMs: number;
  errorMs: number;
  overheadMs: number;
  hasError: boolean;
}

export interface CausalChainNode {
  spanId: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  errorMessage?: string;
  startMs: number;
  endMs: number;
}

/**
 * Computes bounding interval [minStart, maxEnd] across root spans and all descendants.
 */
export function computeWaterfallBounds(spans: ExecutionSpan[]): {
  minStart: number;
  maxEnd: number;
  totalDuration: number;
} {
  if (!spans || spans.length === 0) {
    return { minStart: 0, maxEnd: 0, totalDuration: 0 };
  }

  let minStart = Infinity;
  let maxEnd = -Infinity;

  function traverse(span: ExecutionSpan) {
    if (span.startMs < minStart) minStart = span.startMs;
    if (span.endMs > maxEnd) maxEnd = span.endMs;
    if (span.children) {
      for (const child of span.children) {
        traverse(child);
      }
    }
  }

  for (const root of spans) {
    traverse(root);
  }

  if (minStart === Infinity || maxEnd === -Infinity) {
    return { minStart: 0, maxEnd: 0, totalDuration: 0 };
  }

  return {
    minStart,
    maxEnd,
    totalDuration: Math.max(0, maxEnd - minStart),
  };
}

/**
 * Recursively flattens span hierarchy into a DFS array with indentation depth.
 */
export function flattenSpanHierarchy(
  spans: ExecutionSpan[],
  depth = 0,
): Array<ExecutionSpan & { depth: number }> {
  const result: Array<ExecutionSpan & { depth: number }> = [];

  for (const span of spans) {
    result.push({
      ...span,
      depth,
    });
    if (span.children && span.children.length > 0) {
      result.push(...flattenSpanHierarchy(span.children, depth + 1));
    }
  }

  return result;
}

/**
 * Deconstructs span execution into latency phases:
 * - ttft (time to first token)
 * - generation (token emission duration)
 * - tool (tool execution time)
 * - error (retry or crash duration)
 */
export function calculateSpanLatencyBreakdown(span: ExecutionSpan): SpanLatencyBreakdown {
  const hasError = span.status === "error";

  if (span.kind === "model") {
    const ttftMs = span.ttftMs ?? 0;
    const generationMs = Math.max(0, span.durationMs - ttftMs);
    return {
      ttftMs,
      generationMs,
      toolMs: 0,
      errorMs: hasError ? 50 : 0,
      overheadMs: 0,
      hasError,
    };
  }

  if (span.kind === "tool") {
    return {
      ttftMs: 0,
      generationMs: 0,
      toolMs: span.durationMs,
      errorMs: hasError ? span.durationMs : 0,
      overheadMs: 0,
      hasError,
    };
  }

  return {
    ttftMs: 0,
    generationMs: 0,
    toolMs: 0,
    errorMs: hasError ? 100 : 0,
    overheadMs: span.durationMs,
    hasError,
  };
}

/**
 * Finds the deepest failing span and constructs the causality chain back to root.
 */
export function extractCausalErrorChain(spans: ExecutionSpan[]): CausalChainNode[] {
  const chain: CausalChainNode[] = [];

  function findErrorPath(current: ExecutionSpan): boolean {
    if (current.status !== "error") return false;

    chain.push({
      spanId: current.id,
      name: current.name,
      kind: current.kind,
      status: current.status,
      errorMessage: current.errorMessage,
      startMs: current.startMs,
      endMs: current.endMs,
    });

    if (current.children) {
      for (const child of current.children) {
        if (findErrorPath(child)) {
          return true;
        }
      }
    }

    return true;
  }

  for (const root of spans) {
    if (findErrorPath(root)) {
      break;
    }
  }

  return chain;
}

/**
 * Formats millisecond duration into human-readable label.
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(2)}s`;
  }
  const minutes = Math.floor(sec / 60);
  const remainingSec = Math.round(sec % 60);
  return `${minutes}m ${remainingSec}s`;
}
