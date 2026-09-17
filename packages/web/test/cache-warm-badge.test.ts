import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HudStatusline } from "../src/features/hud/hud-statusline";
import {
  createTaskStatsTracker,
  resetTaskCounters,
  trackMainUsage,
} from "../src/lib/omni/task-stats";

function render(cacheRead?: number, cacheWrite?: number): string {
  return renderToStaticMarkup(
    createElement(HudStatusline, {
      promptCache:
        cacheRead === undefined || cacheWrite === undefined ? undefined : { cacheRead, cacheWrite },
    }),
  );
}

describe("measured prompt cache badge", () => {
  it("shows recorded input hit rate in the collapsed HUD, not cache lifetime", () => {
    const html = render(300, 100);
    expect(html).toContain("Cache hit: 75%");
    expect(html).toContain('role="status"');
    expect(html).toContain("Current task");
    expect(html).not.toMatch(/remaining|Cache Warm|Cache Cold/);
  });

  it("distinguishes no measurement from a measured miss", () => {
    expect(render()).toContain("Cache not reported");
    expect(render(0, 0)).toContain("Cache not reported");
    expect(render(0, 100)).toContain("Cache hit: 0%");
    expect(render(100, 0)).toContain("Cache hit: 100%");
  });

  it.each([-1, NaN, Infinity])("rejects invalid counts %s", (invalid) => {
    expect(render(invalid, 100)).toContain("Cache not reported");
    expect(render(100, invalid)).toContain("Cache not reported");
  });

  it("follows successive real token_usage snapshots and task resets", () => {
    const stats = createTaskStatsTracker();
    const snapshot = () => render(stats.taskCacheRead, stats.taskCacheWrite);
    expect(snapshot()).toContain("Cache not reported");
    const report = (cache_read: number, cache_write: number) => {
      const counts = { cache_read, cache_write, output: 10, total: cache_read + cache_write + 10 };
      trackMainUsage(stats, { type: "token_usage", request: counts, session: counts });
    };
    report(0, 100);
    expect(snapshot()).toContain("Cache hit: 0%");
    report(300, 0);
    expect(snapshot()).toContain("Cache hit: 75%");
    resetTaskCounters(stats);
    expect(snapshot()).toContain("Cache not reported");
  });

  it("wires live task buckets rather than the polled session total or a fabricated TTL", () => {
    const source = readFileSync(
      new URL("../src/features/chat/chat-page.tsx", import.meta.url),
      "utf8",
    );
    const hud = source.slice(source.indexOf("<HudStatusline"));
    const cache = hud.slice(hud.indexOf("promptCache="), hud.indexOf("costUsd="));
    expect(cache).toContain("stream.loading");
    expect(cache).toContain("cacheRead: stream.model.stats.taskCacheRead");
    expect(cache).toContain("cacheWrite: stream.model.stats.taskCacheWrite");
    expect(cache).not.toMatch(/usageBuckets|ttlSeconds|remainingSeconds|cacheCreationTokens/);
  });
});
