import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffTimeline } from "../src/features/consensus/handoff-timeline.js";
import { ConsensusPage } from "../src/features/consensus/consensus-page.js";
import { LocaleProvider } from "../src/state/locale.js";

const taskStarted = {
  messageId: "task_started:task-1:1700000000000",
  source: "task_started" as const,
  taskId: "task-1",
  from: "orchestrator",
  to: "coder",
  content: "Implement <safe> changes",
  timestamp: 1700000000000,
};

afterEach(() => vi.unstubAllGlobals());

describe("coordinator task starts in the live handoff timeline", () => {
  it("shows the task and planned target without claiming mailbox delivery", () => {
    const html = renderToStaticMarkup(
      createElement(HandoffTimeline, {
        handoffs: [
          {
            messageId: "task_started:task-1:1700000000000",
            source: "task_started",
            taskId: "task-1",
            from: "orchestrator",
            to: "coder",
            content: "Implement <safe> changes",
            timestamp: 1700000000000,
          },
        ],
      }),
    );
    expect(html).toContain("Task started");
    expect(html).toContain("task-1");
    expect(html).toContain("orchestrator");
    expect(html).toContain("coder");
    expect(html).toContain("Planned target; assignment delivery is not reported by this event.");
    expect(html).toContain("Implement &lt;safe&gt; changes");
    expect(html).not.toContain("Dispatched");
    expect(html).not.toContain("Simulate Next Stage");
  });

  it("preserves actual directive dispatches", () => {
    const html = renderToStaticMarkup(
      createElement(HandoffTimeline, {
        handoffs: [
          {
            messageId: "directive-1",
            from: "operator",
            to: "coder",
            content: "Review changes",
            timestamp: 1700000000000,
          },
        ],
      }),
    );
    expect(html).toContain("Dispatched");
    expect(html).toContain("Review changes");
    expect(html).not.toContain("Planned target;");
  });

  it("renders an authoritative empty feed without sample handoffs", () => {
    const html = renderToStaticMarkup(createElement(HandoffTimeline, { handoffs: [] }));
    expect(html).toContain("No task starts or directives observed in this connection.");
    expect(html).not.toContain("step-1");
    expect(html).not.toContain("Simulate Next Stage");
  });

  it("renders the live feed only when the cockpit actually passes handoffs", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en" });
    vi.stubGlobal("navigator", { language: "en" });
    // HandoffTimeline keys its live/demo mode on `handoffs !== undefined`, so an unwired
    // caller shows demo data and claims to be a local demo even when a live feed exists.
    const withLive = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(ConsensusPage, { embedded: true, handoffs: [taskStarted] }),
      ),
    );
    expect(withLive).toContain("Handoffs (live)");
    expect(withLive).toContain("Handoffs reflect the current project");

    // Without any live feed the component still falls back to its sample timeline.
    const demo = renderToStaticMarkup(
      createElement(LocaleProvider, null, createElement(ConsensusPage, { embedded: true })),
    );
    expect(demo).toContain("Handoffs (local demo)");
    expect(demo).toContain("local sample data");
  });
});
