/**
 * Guardian audit receipts (T-audit): the verified, Project-scoped projection of the
 * append-only audit log, mounted on the command-safety page. Receipts are independent
 * signed records — the panel renders them as a chronology, never as a causal chain.
 *
 * The receipt→node mapping is exercised through the chronology mode the panel delegates
 * to; causal-mode coverage of the same component lives in signal-chain-graph.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AuditReceipts } from "../src/features/guardian/audit-receipts";
import { SignalChainGraph } from "../src/features/cockpit/signal-chain-graph";
import { S, setActiveStrings } from "../src/lib/strings";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";
import type { AuditReceipt } from "@prismshadow/penguin-server/api";

const originalStrings = S;
afterEach(() => setActiveStrings(originalStrings));

describe("guardian audit receipts panel", () => {
  it("renders the localized shell and a loading state, not an empty log", () => {
    setActiveStrings(en);
    const html = renderToStaticMarkup(createElement(AuditReceipts, { projectId: "project-1" }));
    const copy = en.guardian.audit;
    expect(html).toContain(copy.title);
    expect(html).toContain(copy.description);
    expect(html).toContain(copy.scope);
    expect(html).toContain(copy.loading);
    expect(html).toContain(copy.refresh);
    // The panel is its own labelled chronology region, not a causal chain.
    expect(html).toContain(`aria-label="${copy.title}"`);
    expect(html).not.toContain("Causal provenance chain");
    // Loading is not "no receipts": the empty state stays suppressed until settlement.
    expect(html).not.toContain(copy.empty);
  });

  it("translates with the active dictionary", () => {
    setActiveStrings(zh);
    const html = renderToStaticMarkup(createElement(AuditReceipts, { projectId: "project-1" }));
    const copy = zh.guardian.audit;
    expect(html).toContain(copy.title);
    expect(html).toContain(copy.loading);
    expect(html).toContain(copy.refresh);
    expect(html).not.toContain(en.guardian.audit.title);
  });
});

describe("audit receipt chronology", () => {
  for (const dictionary of [en, zh]) {
    const copy = dictionary.guardian.audit;
    const chronology = { title: copy.title, empty: copy.empty, eventHashLabel: copy.eventHash };
    it(`renders newest-first receipts without causal wording: ${copy.title}`, () => {
      const receipts: AuditReceipt[] = [
        {
          payloadHash: "a".repeat(64),
          projectId: "project-1",
          agentId: "agent-a",
          sessionId: "session-a",
          executingSessionId: "session-b",
          timestamp: 1700000001000,
          type: "tool_call",
          eventHash: "0123456789abcdef",
        },
        {
          payloadHash: "b".repeat(64),
          projectId: "project-1",
          agentId: "agent-a",
          sessionId: "session-a",
          executingSessionId: null,
          timestamp: 1700000000000,
          type: "approval_decision",
          eventHash: "fedcba9876543210",
        },
      ];
      const html = renderToStaticMarkup(
        createElement(SignalChainGraph, {
          chronology,
          chain: {
            chainId: "project-1",
            nodes: receipts.map((receipt, index) => ({
              id: `${receipt.payloadHash}-${index}`,
              type: receipt.type,
              label: `${copy[receipt.type]} · ${copy.owner}: ${receipt.agentId} / ${receipt.sessionId} · ${copy.executingSession}: ${receipt.executingSessionId ?? copy.unknownExecutor}`,
              timestamp: receipt.timestamp,
              eventHash: receipt.eventHash,
            })),
          },
        }),
      );
      // Server order is newest-first and is rendered as-is.
      expect(html.indexOf('dateTime="2023-11-14T22:13:21.000Z"')).toBeLessThan(
        html.indexOf('dateTime="2023-11-14T22:13:20.000Z"'),
      );
      expect(html).toContain('dateTime="2023-11-14T22:13:21.000Z"');
      // Truncated to 8 hex chars so a digest is correlatable, not printed in full.
      expect(html).toContain("01234567");
      expect(html).not.toContain("012345678");
      // Independent records: no causal arrows, no causal heading, no empty state.
      expect(html).not.toContain("→");
      expect(html).not.toContain("Causal provenance chain");
      expect(html).not.toContain(copy.empty);
      // Both receipt kinds are named and their executing sessions are shown.
      expect(html).toContain(copy.tool_call);
      expect(html).toContain(copy.approval_decision);
      expect(html).toContain(copy.eventHash);
      expect(html).toContain("session-b");
      expect(html).toContain(copy.unknownExecutor);
    });

    it(`renders the localized empty chronology: ${copy.title}`, () => {
      const html = renderToStaticMarkup(
        createElement(SignalChainGraph, {
          chronology,
          chain: { chainId: "project-1", nodes: [] },
        }),
      );
      expect(html).toContain(copy.empty);
      expect(html).toContain(copy.title);
      expect(html).not.toContain("→");
    });
  }
});
