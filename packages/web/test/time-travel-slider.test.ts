import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTraceSpansToFlamegraph } from "../src/features/traces/trace-ingest";
import { replayTraceTurns, TimeTravelSlider } from "../src/features/traces/time-travel-slider";

const spans = parseTraceSpansToFlamegraph({
  tasks: [0, 1].map((taskIndex) => ({
    taskIndex,
    startTs: `2026-09-17T10:00:0${taskIndex}.000Z`,
    endTs: `2026-09-17T10:00:0${taskIndex}.900Z`,
    tokens: { cacheRead: 10, cacheWrite: 2, output: 3 },
  })),
  requests: [0, 1].map((taskIndex) => ({
    taskIndex,
    beginTs: `2026-09-17T10:00:0${taskIndex}.000Z`,
    endTs: `2026-09-17T10:00:0${taskIndex}.400Z`,
    status: "completed",
  })),
  toolCalls: [
    {
      toolCallId: "read-1",
      name: "read_file",
      startTs: "2026-09-17T10:00:00.500Z",
      endTs: "2026-09-17T10:00:00.700Z",
    },
  ],
});

describe("recorded trace turn replay", () => {
  it("rewinds deterministically without losing model/tool children or mutating records", () => {
    const before = JSON.stringify(spans);
    expect(replayTraceTurns(spans, 0)).toEqual([]);
    expect(replayTraceTurns(spans, 1).map((span) => span.id)).toEqual(["task-0"]);
    expect(replayTraceTurns(spans, 1)[0]?.children?.map((span) => span.kind)).toEqual([
      "model",
      "tool",
    ]);
    expect(replayTraceTurns(spans, 2)).toEqual(spans);
    expect(replayTraceTurns(spans, 1)).toEqual(spans.slice(0, 1));
    expect(JSON.stringify(spans)).toBe(before);
  });

  it("clamps invalid and out-of-range cursor values", () => {
    expect(replayTraceTurns(spans, -1)).toEqual([]);
    expect(replayTraceTurns(spans, NaN)).toEqual([]);
    expect(replayTraceTurns(spans, 1.9)).toEqual(spans.slice(0, 1));
    expect(replayTraceTurns(spans, 100)).toEqual(spans);
  });

  it("renders an accessible integer slider and an honest latest-recorded action", () => {
    const html = renderToStaticMarkup(
      createElement(TimeTravelSlider, { maxSteps: 2, currentStep: 1, onStepChange: () => {} }),
    );
    expect(html).toContain('aria-label="Recorded trace turn"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="2"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="1"');
    expect(html).toContain("1 / 2 recorded turns");
    expect(html).toContain("Latest recorded");
    expect(html).not.toContain(">Live<");
  });

  it("disables the slider and latest action when there are no recorded turns", () => {
    const html = renderToStaticMarkup(
      createElement(TimeTravelSlider, { maxSteps: 0, currentStep: 0, onStepChange: () => {} }),
    );
    expect(html).toContain("No recorded turns to replay.");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
