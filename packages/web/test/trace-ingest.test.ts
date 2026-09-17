import { describe, expect, it } from "vitest";
import { parseTraceSpansToFlamegraph } from "../src/features/traces/trace-ingest.js";

/** Shaped like the live GET /api/sessions/:id/traces/:n/analysis payload (only the fields the converter reads). */
const analysis = {
  tasks: [
    {
      taskIndex: 0,
      startTs: "2026-09-17T10:00:00.000Z",
      endTs: "2026-09-17T10:00:00.500Z",
      messageFrom: 0,
      messageTo: 3,
      tokens: { cacheRead: 300, cacheWrite: 100, output: 50 },
      llmMs: 500,
      toolMs: 200,
    },
    {
      taskIndex: 1,
      startTs: "2026-09-17T10:00:01.000Z",
      endTs: "2026-09-17T10:00:01.200Z",
      messageFrom: 4,
      messageTo: 6,
      tokens: { cacheRead: 10, cacheWrite: 10, output: 5 },
      llmMs: 200,
      toolMs: 0,
    },
  ],
  requests: [
    {
      beginTs: "2026-09-17T10:00:00.000Z",
      endTs: "2026-09-17T10:00:00.500Z",
      durationMs: 500,
      status: "completed",
      taskIndex: 0,
    },
    {
      beginTs: "2026-09-17T10:00:01.000Z",
      endTs: "2026-09-17T10:00:01.200Z",
      durationMs: 200,
      status: "error",
      taskIndex: 1,
    },
  ],
  toolCalls: [
    {
      toolCallId: "tc-1",
      name: "read_file",
      startTs: "2026-09-17T10:00:00.100Z",
      endTs: "2026-09-17T10:00:00.300Z",
      durationMs: 200,
    },
    { toolCallId: "tc-2", name: "exec_command", startTs: "2026-09-17T10:00:01.050Z" },
  ],
};

describe("live trace analysis → flamegraph spans", () => {
  it("builds one root span per turn with model and tool children", () => {
    const spans = parseTraceSpansToFlamegraph(analysis);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      id: "task-0",
      kind: "session",
      status: "success",
      startMs: 0,
      durationMs: 500,
    });
    const model = spans[0]!.children!.find((s) => s.kind === "model");
    expect(model).toMatchObject({ durationMs: 500, status: "success" });
    const tool = spans[0]!.children!.find((s) => s.id === "tc-1");
    expect(tool).toMatchObject({
      kind: "tool",
      name: "Tool: read_file",
      durationMs: 200,
      status: "success",
    });
    expect(spans[0]!.tokens).toEqual({
      promptTokens: 400,
      completionTokens: 50,
      cacheReadTokens: 300,
      totalCostUsd: 0,
    });
  });

  it("marks failed requests as error spans and open tools as running", () => {
    const spans = parseTraceSpansToFlamegraph(analysis);
    expect(spans[1]!.status).toBe("error");
    expect(spans[1]!.children!.find((s) => s.kind === "model")!.status).toBe("error");
    const running = spans[1]!.children!.find((s) => s.id === "tc-2");
    expect(running).toMatchObject({
      kind: "tool",
      name: "Tool: exec_command",
      status: "running",
    });
  });

  it("returns no spans for an empty analysis", () => {
    expect(parseTraceSpansToFlamegraph({ tasks: [], requests: [], toolCalls: [] })).toEqual([]);
  });
});
