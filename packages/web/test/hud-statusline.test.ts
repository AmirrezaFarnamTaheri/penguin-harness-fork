import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HudStatusline } from "../src/features/hud/hud-statusline";
import type { HudStatuslineProps } from "../src/features/hud/hud-statusline";

function render(props: HudStatuslineProps = {}): string {
  return renderToStaticMarkup(createElement(HudStatusline, props));
}

describe("HUD context occupancy", () => {
  it("uses latest main-request occupancy against the reported window", () => {
    expect(render({ tokensUsed: 32_000, contextWindow: 128_000 })).toContain("Context 25%");
  });

  it("does not show the pre-compaction reading while context is stale", () => {
    const html = render({ tokensUsed: 120_000, contextWindow: 128_000, contextStale: true });
    expect(html).toContain("Context unavailable");
    expect(html).not.toContain("Context 94%");
  });

  it("resumes measured occupancy after the next main request", () => {
    expect(render({ tokensUsed: 32_000, contextWindow: 128_000, contextStale: false })).toContain(
      "Context 25%",
    );
  });

  it.each([undefined, 0, -1, NaN, Infinity])("does not invent a window for %s", (contextWindow) => {
    expect(render({ tokensUsed: 32_000, contextWindow })).toContain("Context unavailable");
  });

  it.each([undefined, -1, NaN, Infinity])("does not invent occupancy for %s", (tokensUsed) => {
    expect(render({ tokensUsed, contextWindow: 128_000 })).toContain("Context unavailable");
  });

  it("distinguishes a supplied zero from missing occupancy", () => {
    expect(render({ tokensUsed: 0, contextWindow: 128_000 })).toContain("Context 0%");
    expect(render({ contextWindow: 128_000 })).toContain("Context unavailable");
  });

  it("preserves an over-window measurement instead of clamping it", () => {
    expect(render({ tokensUsed: 160_000, contextWindow: 128_000 })).toContain("Context 125%");
  });

  it("wires the real chat HUD to request context, not cumulative usage", () => {
    const source = readFileSync(
      new URL("../src/features/chat/chat-page.tsx", import.meta.url),
      "utf8",
    );
    const hud = source.slice(source.indexOf("<HudStatusline"));
    const contextProps = hud.slice(0, hud.indexOf("speed="));
    expect(contextProps).toContain(
      "tokensUsed={stream.loading ? undefined : stream.model.stats.contextNow}",
    );
    expect(contextProps).toContain("contextStale={stream.model.stats.contextStale}");
    expect(contextProps).toContain(
      "contextWindow={contextWindow !== undefined ? Number(contextWindow) : undefined}",
    );
    expect(contextProps).not.toContain("usageBuckets");
    expect(contextProps).not.toContain("stats.task");
    expect(contextProps).not.toContain("200000");
  });
});
