import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KeyFleetMonitor, maskApiKey } from "../src/llm/key-fleet-monitor.js";

describe("key-fleet-monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("masks API keys safely preserving prefix and suffix", () => {
    expect(maskApiKey("sk-ant-api03-1234567890abcdef")).toBe("sk-ant-...cdef");
    expect(maskApiKey("short")).toBe("key-***");
    expect(maskApiKey("")).toBe("empty-key");
  });

  it("initializes with default providers and reports healthy stats", () => {
    const monitor = new KeyFleetMonitor();
    const stats = monitor.getFleetStats();

    expect(stats.totalKeys).toBeGreaterThanOrEqual(4);
    expect(stats.healthyCount).toBe(stats.totalKeys);
    expect(stats.cooldownCount).toBe(0);
    expect(stats.evictedCount).toBe(0);
    expect(stats.healthPercentage).toBe(100);

    const snapshot = monitor.getCockpitSnapshot();
    expect(snapshot.healthy).toBe(true);
    expect(snapshot.activeCount).toBeGreaterThanOrEqual(4);
    expect(snapshot.providers.length).toBeGreaterThanOrEqual(4);
  });

  it("probes keys and records latency in sparkline history", async () => {
    const monitor = new KeyFleetMonitor();
    const reports = monitor.getFleetReport();
    const anthropicReport = reports.find((r) => r.provider === "anthropic")!;
    const targetKey = anthropicReport.keys[0]!.maskedKey;

    const probeRes = await monitor.probeKey("anthropic", targetKey);
    expect(probeRes.status).toBe("ok");
    expect(probeRes.latencyMs).toBeGreaterThan(0);
    expect(probeRes.sparkline.length).toBeGreaterThan(0);
  });

  it("handles custom probe function with success and failure simulation", async () => {
    const monitor = new KeyFleetMonitor([
      {
        provider: "custom-ai",
        modelId: "custom-v1",
        keys: ["sk-custom-secret-key-1234"],
        probeFn: async () => ({ ok: true, latencyMs: 75 }),
      },
    ]);

    const reports = monitor.getFleetReport();
    const targetKey = reports[0]!.keys[0]!.maskedKey;

    const result = await monitor.probeKey("custom-ai", targetKey);
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBe(75);

    // Custom probe failure
    const failingResult = await monitor.probeKey("custom-ai", targetKey, async () => ({
      ok: false,
      latencyMs: 500,
      error: "Rate limit exceeded (429)",
    }));
    expect(failingResult.status).toBe("error");
    expect(failingResult.details).toContain("429");
  });

  it("transitions keys through cooldown and eviction states and notifies subscribers", () => {
    const monitor = new KeyFleetMonitor();
    let notificationCount = 0;
    const unsubscribe = monitor.subscribe(() => {
      notificationCount++;
    });

    const reports = monitor.getFleetReport();
    const openai = reports.find((r) => r.provider === "openai")!;
    const key1 = openai.keys[0]!.maskedKey;

    // Cooldown
    monitor.cooldownKey("openai", key1, 60_000);
    let stats = monitor.getFleetStats();
    expect(stats.cooldownCount).toBe(1);
    expect(notificationCount).toBe(1);

    // Revive all
    monitor.reviveAllCooldowns();
    stats = monitor.getFleetStats();
    expect(stats.cooldownCount).toBe(0);
    expect(notificationCount).toBe(2);

    // Evict
    monitor.evictKey("openai", key1);
    stats = monitor.getFleetStats();
    expect(stats.evictedCount).toBe(1);
    expect(notificationCount).toBe(3);

    unsubscribe();
  });

  it("starts and stops periodic auto-probing ticker", () => {
    const monitor = new KeyFleetMonitor();
    const spy = vi.spyOn(monitor, "probeFleet");

    monitor.startAutoProbing(10_000);
    vi.advanceTimersByTime(25_000);

    expect(spy).toHaveBeenCalledTimes(2);

    monitor.stopAutoProbing();
    vi.advanceTimersByTime(30_000);
    expect(spy).toHaveBeenCalledTimes(2); // no further calls
  });
});
