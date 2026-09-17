import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoopEventFeed } from "../src/features/agent/loop-event-feed";
import { LOOP_EVENT_LIMIT, retainLoopEvent } from "../src/features/agent/use-cockpit-telemetry";

const alert = {
  type: "loop_detected",
  taskId: "task-a",
  agentId: "coder",
  timestamp: 1700000000000,
  payload: { message: "Repeated identical coder execution" },
};

describe("loop alerts", () => {
  it("retains actual messages and metadata, deduplicates, and caps newest received events", () => {
    let events = retainLoopEvent([], alert);
    expect(events[0]).toMatchObject({
      taskId: alert.taskId,
      agentId: "coder",
      timestamp: alert.timestamp,
      message: alert.payload.message,
    });
    expect(retainLoopEvent(events, alert)).toBe(events);
    for (let i = 0; i < LOOP_EVENT_LIMIT; i++) {
      events = retainLoopEvent(events, { ...alert, taskId: `task-${i}` });
    }
    expect(events).toHaveLength(LOOP_EVENT_LIMIT);
    expect(events[0]?.taskId).toBe("task-49");
    expect(events.at(-1)?.taskId).toBe("task-0");
    expect(events.some((event) => event.taskId === "task-a")).toBe(false);
  });

  it("rejects malformed or unrelated events without inventing an alert", () => {
    const events = retainLoopEvent([], alert);
    for (const value of [
      null,
      {},
      { ...alert, type: "task_failed" },
      { ...alert, taskId: " " },
      { ...alert, timestamp: NaN },
      { ...alert, timestamp: 1e20 },
      { ...alert, payload: { patternType: "fictional" } },
      { ...alert, payload: { message: "" } },
    ]) {
      expect(retainLoopEvent(events, value)).toBe(events);
    }
    const withoutAgent = retainLoopEvent([], { ...alert, agentId: undefined });
    expect(withoutAgent).toHaveLength(1);
    expect(withoutAgent[0]).toMatchObject({ agentId: undefined, message: alert.payload.message });
  });

  it("renders a named polite log with escaped messages and source timestamps", () => {
    const html = renderToStaticMarkup(
      createElement(LoopEventFeed, {
        events: retainLoopEvent([], { ...alert, payload: { message: "<script>bad()</script>" } }),
        transport: "ws",
        locale: "en",
      }),
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("coder");
    expect(html).toContain("task-a");
    expect(html).toContain('dateTime="2023-11-14T22:13:20.000Z"');
    expect(html).toContain("connection gaps are not recovered");
    expect(html).toContain("Listening for live loop alerts.");
  });

  it("does not call HTTP polling a live alert connection and translates empty states", () => {
    const render = (transport: "http" | "offline" | "connecting", locale: "en" | "zh" = "en") =>
      renderToStaticMarkup(createElement(LoopEventFeed, { events: [], transport, locale }));
    for (const transport of ["http", "offline"] as const) {
      expect(render(transport)).toContain("Periodic updates do not include loop alerts.");
      expect(render(transport)).toContain("This does not confirm a healthy run.");
    }
    expect(render("connecting")).toContain("Connecting to the loop alert stream");
    expect(render("http", "zh")).toContain("定期更新不包含循环告警");
    expect(render("http", "zh")).toContain("最多 50 条");
  });
});
