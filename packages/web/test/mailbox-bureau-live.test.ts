import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MailboxBureau } from "../src/features/consensus/mailbox-bureau";
import type { LiveMailboxEntry } from "../src/features/agent/use-cockpit-telemetry";

const live: LiveMailboxEntry[] = [
  {
    agentName: "agent-live-1",
    queueDepth: 2,
    pendingReplies: 1,
    leaseState: "acquired",
    leaseRemainingSec: 20,
  },
  {
    agentName: "agent-live-2",
    queueDepth: 0,
    pendingReplies: 0,
    leaseState: "idle",
  },
];

describe("mailbox bureau live feed", () => {
  it("renders the live cockpit mailbox entries instead of the demo agents", () => {
    const html = renderToStaticMarkup(createElement(MailboxBureau, { entries: live }));
    expect(html).toContain("agent-live-1");
    expect(html).toContain("agent-live-2");
    expect(html).toContain("2 pending");
    expect(html).not.toContain("agent-orchestrator");
    expect(html).not.toContain("agent-coder-1");
  });

  it("keeps the demo data when no live feed is supplied", () => {
    const html = renderToStaticMarkup(createElement(MailboxBureau));
    expect(html).toContain("agent-orchestrator");
  });
});
