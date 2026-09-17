import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignalChainGraph } from "../src/features/cockpit/signal-chain-graph";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";

describe("Guardian chronological audit graph", () => {
  for (const dictionary of [en, zh]) {
    const copy = dictionary.guardian.audit;
    const chronology = { title: copy.title, empty: copy.empty, eventHashLabel: copy.eventHash };
    it(`renders localized empty and populated receipts: ${copy.title}`, () => {
      const empty = renderToStaticMarkup(
        createElement(SignalChainGraph, {
          chronology,
          chain: { chainId: "project", nodes: [] },
        }),
      );
      expect(empty).toContain(copy.empty);
      expect(empty).toContain(copy.title);
      const populated = renderToStaticMarkup(
        createElement(SignalChainGraph, {
          chronology,
          chain: {
            chainId: "project",
            nodes: [
              {
                id: "new",
                type: "tool_call",
                label: "new receipt",
                timestamp: 1700000001000,
                eventHash: "0123456789abcdef",
              },
              {
                id: "old",
                type: "approval_decision",
                label: "old receipt",
                timestamp: 1700000000000,
              },
            ],
          },
        }),
      );
      expect(populated.indexOf("new receipt")).toBeLessThan(populated.indexOf("old receipt"));
      expect(populated).toContain('dateTime="2023-11-14T22:13:21.000Z"');
      expect(populated).toContain("01234567");
      expect(populated).not.toContain("012345678");
      expect(populated).not.toContain("→");
      expect(populated).not.toContain("Causal provenance chain");
      expect(populated).not.toContain(copy.empty);
    });
  }
});
