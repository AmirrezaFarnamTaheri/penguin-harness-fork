import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceGraphCache,
  type ScannableWorkspaceGraph,
} from "../../src/environment/tools/code-graph-cache.js";

function makeWatcher(scanWorkspace: () => Promise<void> = async () => undefined) {
  return {
    scanWorkspace: vi.fn(scanWorkspace),
    close: vi.fn(() => undefined),
  } satisfies ScannableWorkspaceGraph;
}

describe("WorkspaceGraphCache", () => {
  it("single-flights twenty concurrent requests for one workspace", async () => {
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let resolveScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      resolveScanStarted = resolve;
    });
    const watcher = makeWatcher(async () => {
      resolveScanStarted();
      await scanGate;
    });
    const createWatcher = vi.fn(() => watcher);
    const cache = new WorkspaceGraphCache(createWatcher);

    const pending = Array.from({ length: 20 }, () => cache.get("workspace"));
    await scanStarted;
    expect(createWatcher).toHaveBeenCalledTimes(1);
    expect(watcher.scanWorkspace).toHaveBeenCalledTimes(1);
    releaseScan();

    const results = await Promise.all(pending);
    expect(results.every((result) => result.watcher === watcher && !result.cached)).toBe(true);
    expect(cache.stats()).toEqual({ cacheSize: 1, cacheEvictions: 0 });
  });

  it("evicts the least recently used watchers at the eight-workspace cap", async () => {
    const watchers = new Map<string, ReturnType<typeof makeWatcher>>();
    const cache = new WorkspaceGraphCache((workspace) => {
      const watcher = makeWatcher();
      watchers.set(workspace, watcher);
      return watcher;
    });

    for (let index = 0; index < 8; index += 1) await cache.get(`workspace-${index}`);
    expect((await cache.get("workspace-0")).cached).toBe(true);
    await cache.get("workspace-8");
    await cache.get("workspace-9");

    expect(cache.stats()).toEqual({ cacheSize: 8, cacheEvictions: 2 });
    expect(watchers.get("workspace-0")?.close).not.toHaveBeenCalled();
    expect(watchers.get("workspace-1")?.close).toHaveBeenCalledTimes(1);
    expect(watchers.get("workspace-2")?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the prior entry alive until a TTL refresh succeeds", async () => {
    let now = 100;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const oldWatcher = makeWatcher();
    const refreshedWatcher = makeWatcher(async () => refreshGate);
    const createWatcher = vi
      .fn<(workspace: string) => ReturnType<typeof makeWatcher>>()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(refreshedWatcher);
    const cache = new WorkspaceGraphCache(createWatcher, { ttlMs: 60, now: () => now });

    await cache.get("workspace");
    now = 161;
    const refresh = cache.get("workspace");
    const sameRefresh = cache.get("workspace");
    expect(oldWatcher.close).not.toHaveBeenCalled();
    expect(createWatcher).toHaveBeenCalledTimes(2);

    releaseRefresh();
    const [result, concurrentResult] = await Promise.all([refresh, sameRefresh]);
    expect(result.watcher).toBe(refreshedWatcher);
    expect(concurrentResult.watcher).toBe(refreshedWatcher);
    expect(result.cached).toBe(false);
    expect(oldWatcher.close).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toEqual({ cacheSize: 1, cacheEvictions: 0 });
  });

  it("closes a failed refresh and preserves the stale entry for a later retry", async () => {
    let now = 0;
    const oldWatcher = makeWatcher();
    const failedWatcher = makeWatcher(async () => {
      throw new Error("scan failed");
    });
    const cache = new WorkspaceGraphCache(
      vi.fn().mockReturnValueOnce(oldWatcher).mockReturnValueOnce(failedWatcher),
      { ttlMs: 10, now: () => now },
    );

    await cache.get("workspace");
    now = 11;
    await expect(cache.get("workspace")).rejects.toThrow("scan failed");

    expect(failedWatcher.close).toHaveBeenCalledTimes(1);
    expect(oldWatcher.close).not.toHaveBeenCalled();
    expect(cache.stats()).toEqual({ cacheSize: 1, cacheEvictions: 0 });
  });
});
