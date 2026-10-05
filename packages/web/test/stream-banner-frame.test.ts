import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AttachedFilesBanner } from "../src/features/chat/attached-files-banner";
import { GoalStatusBanner } from "../src/features/chat/goal-banner";
import { HandoffBanner, ModelSwitchBanner } from "../src/features/chat/handoff-banner";
import { HarnessInjectedBanner } from "../src/features/chat/harness-banner";
import { McpConnectBanner } from "../src/features/chat/mcp-connect-banner";
import { OrgTriggerBanner } from "../src/features/chat/org-trigger-banner";
import { ScheduledBanner } from "../src/features/chat/scheduled-banner";
import { SkillsBanner } from "../src/features/chat/skills-banner";
import { StepBanner } from "../src/features/chat/step-banner";
import { STREAM_BANNER_FRAME } from "../src/features/chat/disclosure-row";

const COMPACT_FRAME =
  "items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400";
const DISCLOSURE_CARD =
  "anim-msg my-2 overflow-clip rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900";
const STEP_HEADER =
  "sticky -top-4 z-[5] flex w-full items-center gap-2 bg-gray-50 px-3 py-2 text-left transition-colors duration-150 hover:bg-gray-100 dark:bg-gray-900 dark:hover:bg-gray-800";
const HANDOFF_HOVER =
  "transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200";

function markup(element: ReactNode): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element));
}

function classAttributes(html: string, tag?: string): string[] {
  const matches = html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bclass="([^"]*)"/g);
  return Array.from(matches)
    .filter((match) => tag === undefined || match[1] === tag)
    .map((match) => match[2]!);
}

describe("compact stream notice frame", () => {
  it("keeps the shared token as the exact chrome rendered by each notice", () => {
    expect(STREAM_BANNER_FRAME).toBe(COMPACT_FRAME);

    const handoff = { agentId: "researcher", sessionId: "session-1", sessionTitle: "Research" };
    const modelSwitch = {
      sessionId: "session-1",
      sessionTitle: "Research",
      prevModelId: "model-x",
    };
    const cases: Array<[string, ReactNode, string]> = [
      [
        "attached files",
        createElement(AttachedFilesBanner, { files: ["report.pdf"] }),
        `flex w-fit max-w-full ${COMPACT_FRAME}`,
      ],
      [
        "goal",
        createElement(GoalStatusBanner, {
          goal: { objective: "Review", status: "active", budget: 1000, used: 100, rounds: 1 },
        }),
        `anim-fade mb-2 flex ${COMPACT_FRAME}`,
      ],
      [
        "handoff",
        createElement(HandoffBanner, { origin: { agentId: "researcher" } }),
        `anim-msg my-2 flex w-fit ${COMPACT_FRAME}`,
      ],
      [
        "handoff link",
        createElement(HandoffBanner, { origin: handoff }),
        `anim-msg my-2 flex w-fit ${COMPACT_FRAME} ${HANDOFF_HOVER}`,
      ],
      [
        "model switch",
        createElement(ModelSwitchBanner, { origin: modelSwitch }),
        `anim-msg my-2 flex w-fit ${COMPACT_FRAME} ${HANDOFF_HOVER}`,
      ],
      [
        "organization trigger",
        createElement(OrgTriggerBanner, {
          origin: { org: "acme", employee: "researcher", kind: "init" },
        }),
        `anim-msg my-2 flex w-fit flex-wrap ${COMPACT_FRAME}`,
      ],
      [
        "scheduled task",
        createElement(ScheduledBanner, { origin: { name: "daily", firedAt: "" } }),
        `anim-msg my-2 flex w-fit ${COMPACT_FRAME}`,
      ],
      [
        "skills",
        createElement(SkillsBanner, { names: ["review"] }),
        `anim-msg my-2 flex w-fit ${COMPACT_FRAME}`,
      ],
    ];

    for (const [name, element, expected] of cases) {
      const html = markup(element);
      expect(classAttributes(html)[0], name).toBe(expected);
    }
  });
});

describe("interactive disclosure surfaces keep their own shell", () => {
  it("keeps harness output inside its expandable card", () => {
    const html = markup(createElement(HarnessInjectedBanner, { text: "injected context" }));
    expect(classAttributes(html, "div")[0]).toBe(DISCLOSURE_CARD);
    expect(classAttributes(html, "button")[0]).toBe(
      "flex min-h-8 w-full items-center gap-2 bg-gray-50 px-3 py-2 text-left transition-colors duration-150 hover:bg-gray-100 dark:bg-gray-900 dark:hover:bg-gray-800",
    );
  });

  it("keeps process-step and MCP connection disclosures on the step shell", () => {
    const step = markup(
      createElement(
        StepBanner,
        { state: "done", title: "Step", detail: "Complete" },
        createElement("p", null, "step detail"),
      ),
    );
    const mcp = markup(
      createElement(McpConnectBanner, {
        item: {
          kind: "mcp_connect",
          id: 1,
          servers: ["docs"],
          running: false,
          results: [{ server: "docs", status: "completed", durationMs: 1, tools: 1 }],
        },
      }),
    );

    for (const html of [step, mcp]) {
      expect(classAttributes(html, "div")[0]).toBe(DISCLOSURE_CARD);
      expect(classAttributes(html, "button")[0]).toBe(STEP_HEADER);
    }
    expect(step).not.toContain(COMPACT_FRAME);
    expect(mcp).not.toContain(COMPACT_FRAME);
  });
});
