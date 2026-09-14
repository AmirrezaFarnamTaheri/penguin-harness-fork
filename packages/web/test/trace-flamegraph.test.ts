import { describe, expect, it } from "vitest";
import {
  calculateSpanLatencyBreakdown,
  computeWaterfallBounds,
  extractCausalErrorChain,
  flattenSpanHierarchy,
  formatDurationMs,
  type ExecutionSpan,
} from "../src/features/traces/flamegraph-types";

describe("flamegraph-types", () => {
  const sampleSpans: ExecutionSpan[] = [
    {
      id: "span-root-session",
      name: "Autonomous Task Session",
      kind: "session",
      status: "error",
      startMs: 1000,
      endMs: 5000,
      durationMs: 4000,
      children: [
        {
          id: "span-subagent-worker",
          name: "Executor Subagent: refactor-pipeline",
          kind: "subagent",
          status: "error",
          parentId: "span-root-session",
          startMs: 1200,
          endMs: 4800,
          durationMs: 3600,
          children: [
            {
              id: "span-model-planner",
              name: "claude-3-5-sonnet: Plan Next Step",
              kind: "model",
              status: "success",
              parentId: "span-subagent-worker",
              startMs: 1300,
              endMs: 2500,
              durationMs: 1200,
              ttftMs: 350,
              tokens: {
                promptTokens: 4200,
                completionTokens: 850,
                cacheReadTokens: 3200,
                totalCostUsd: 0.021,
              },
            },
            {
              id: "span-tool-exec-bash",
              name: "Tool: bash (pnpm run build)",
              kind: "tool",
              status: "error",
              parentId: "span-subagent-worker",
              startMs: 2600,
              endMs: 4700,
              durationMs: 2100,
              errorMessage: "Build failed with exit code 1: TS2322 Type mismatch",
              stackTrace: "Error: Process exited with 1\n  at runBashCommand (bash-plugin.ts:42)",
              inputPayload: '{"command": "pnpm run build"}',
              outputPayload: 'ELIFECYCLE Command failed with exit code 1',
            },
          ],
        },
      ],
    },
  ];

  describe("computeWaterfallBounds", () => {
    it("calculates minimum start, maximum end, and total span duration", () => {
      const bounds = computeWaterfallBounds(sampleSpans);
      expect(bounds.minStart).toBe(1000);
      expect(bounds.maxEnd).toBe(5000);
      expect(bounds.totalDuration).toBe(4000);
    });

    it("handles empty span collections gracefully", () => {
      const bounds = computeWaterfallBounds([]);
      expect(bounds.minStart).toBe(0);
      expect(bounds.maxEnd).toBe(0);
      expect(bounds.totalDuration).toBe(0);
    });
  });

  describe("flattenSpanHierarchy", () => {
    it("flattens nested tree with depth metadata preserving DFS order", () => {
      const flattened = flattenSpanHierarchy(sampleSpans);
      expect(flattened.length).toBe(4);
      expect(flattened[0]!.id).toBe("span-root-session");
      expect(flattened[0]!.depth).toBe(0);
      expect(flattened[1]!.id).toBe("span-subagent-worker");
      expect(flattened[1]!.depth).toBe(1);
      expect(flattened[2]!.id).toBe("span-model-planner");
      expect(flattened[2]!.depth).toBe(2);
      expect(flattened[3]!.id).toBe("span-tool-exec-bash");
      expect(flattened[3]!.depth).toBe(2);
    });
  });

  describe("calculateSpanLatencyBreakdown", () => {
    it("partitions model span into ttft, generation, and overhead phases", () => {
      const modelSpan = sampleSpans[0]!.children![0]!.children![0]!;
      const breakdown = calculateSpanLatencyBreakdown(modelSpan);
      expect(breakdown.ttftMs).toBe(350);
      expect(breakdown.generationMs).toBe(850); // 1200 - 350
      expect(breakdown.toolMs).toBe(0);
      expect(breakdown.errorMs).toBe(0);
    });

    it("partitions tool error span into execution and error phases", () => {
      const toolSpan = sampleSpans[0]!.children![0]!.children![1]!;
      const breakdown = calculateSpanLatencyBreakdown(toolSpan);
      expect(breakdown.toolMs).toBe(2100);
      expect(breakdown.hasError).toBe(true);
    });
  });

  describe("extractCausalErrorChain", () => {
    it("extracts root-to-leaf causality sequence for failure analysis", () => {
      const chain = extractCausalErrorChain(sampleSpans);
      expect(chain.length).toBe(3);
      expect(chain[0]!.spanId).toBe("span-root-session");
      expect(chain[1]!.spanId).toBe("span-subagent-worker");
      expect(chain[2]!.spanId).toBe("span-tool-exec-bash");
      expect(chain[2]!.errorMessage).toContain("Build failed with exit code 1");
    });
  });

  describe("formatDurationMs", () => {
    it("formats milliseconds into human readable labels", () => {
      expect(formatDurationMs(45)).toBe("45ms");
      expect(formatDurationMs(1200)).toBe("1.20s");
      expect(formatDurationMs(65000)).toBe("1m 5s");
    });
  });
});
