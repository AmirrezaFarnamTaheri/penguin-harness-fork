/**
 * Causal provenance chain (T19): renders an audit chain — root source through executed
 * action — as a read-only ordered sequence. Node order is the chain's own; the component
 * adds no causality of its own.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignalChainGraph } from "../src/features/cockpit/signal-chain-graph";

const chain = {
  chainId: "chain-1",
  nodes: [
    { id: "src-1", type: "user_prompt", label: "Fix bug #42" },
    { id: "tc-1", type: "approval_decision", label: "allowed" },
    { id: "act-1", type: "tool_execution", label: "run_command: pnpm test" },
  ],
};

describe("signal chain causal audit graph", () => {
  it("renders every causal node from root source to executed action in order", () => {
    const html = renderToStaticMarkup(createElement(SignalChainGraph, { chain }));
    expect(html).toContain("Fix bug #42");
    expect(html).toContain("run_command: pnpm test");
    expect(html).toContain("allowed");
    expect(html.indexOf("Fix bug #42")).toBeLessThan(html.indexOf("run_command: pnpm test"));
    expect(html).toContain("user_prompt");
    expect(html).toContain("tool_execution");
  });

  it("marks the chain as an auditable region with an explicit empty state", () => {
    const empty = createElement(SignalChainGraph, { chain: { chainId: "chain-2", nodes: [] } });
    const html = renderToStaticMarkup(empty);
    expect(html).toContain('aria-label="Causal provenance chain"');
    expect(html).toContain("No recorded chain");
    // No nodes: no arrow separators may render either.
    expect(html).not.toContain("→");
  });

  it("keeps the cryptographic receipt visible for audit nodes that carry one", () => {
    const hashed = createElement(SignalChainGraph, {
      chain: {
        chainId: "chain-3",
        nodes: [
          {
            id: "tc-2",
            type: "tool_call",
            label: "read_file",
            eventHash: "b7f2c9e1a3",
          },
        ],
      },
    });
    const html = renderToStaticMarkup(hashed);
    expect(html).toContain("b7f2c9e1");
    expect(html).toContain("event");
  });
});
