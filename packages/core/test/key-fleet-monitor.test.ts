import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KeyFleetMonitor, maskApiKey } from "../src/llm/key-fleet-monitor.js";

describe("key-fleet-monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("masks API keys safely preserving prefix and suffix", () => {
    expect(maskApiKey("sk-ant-api03-1234567890abcdef")).toBe("sk-ant-...cdef");
    // No digest of a short, low-entropy secret is exposed in the display mask.
    expect(maskApiKey("short")).toBe("key-***");
    expect(maskApiKey("shorter")).toBe("key-***");
    expect(maskApiKey("")).toBe("empty-key");
  });

  it("gives two short keys distinct masks, so mask-based lookups do not collide", () => {
    // Two 8-character keys share the fixed part; only the digest separates them. Both are
    // registered under one model, and each has to be reachable by its own mask.
    const monitor = new KeyFleetMonitor([
      {
        provider: "custom-ai",
        modelId: "local-1",
        keys: ["aaaaaaaa", "bbbbbbbb"],
      },
    ]);
    const report = monitor.getFleetReport()[0]!;
    const [first, second] = report.keys;
    expect(first!.maskedKey).not.toBe(second!.maskedKey);
    expect(monitor.hasKey("custom-ai", first!.maskedKey)).toBe(true);
    expect(monitor.hasKey("custom-ai", second!.maskedKey)).toBe(true);
    // A mask points at exactly one key, not at the last one registered.
    expect(monitor.cooldownKey("custom-ai", first!.maskedKey, 60_000)).toBe(true);
    const stats = monitor.getFleetStats();
    expect(stats.cooldownCount).toBe(1);
  });

  it("disambiguates long keys with the same visible prefix and suffix", () => {
    const monitor = new KeyFleetMonitor([
      {
        provider: "custom-ai",
        modelId: "local-1",
        keys: ["sk-test-first-secret-1234", "sk-test-second-secret-1234"],
      },
    ]);
    const [first, second] = monitor.getFleetReport()[0]!.keys;
    expect(first!.maskedKey).not.toBe(second!.maskedKey);
    expect(monitor.cooldownKey("custom-ai", first!.maskedKey, 60_000)).toBe(true);
    expect(monitor.getFleetReport()[0]!.keys.map((key) => key.status)).toEqual([
      "cooldown",
      "healthy",
    ]);
  });

  it("initializes without default providers (safe unconfigured state)", () => {
    const monitor = new KeyFleetMonitor();
    const stats = monitor.getFleetStats();

    expect(stats.totalKeys).toBe(0);
    expect(stats.healthyCount).toBe(0);
    expect(stats.cooldownCount).toBe(0);
    expect(stats.healthPercentage).toBeNull();
    expect(stats.availabilityState).toBe("empty");

    const snapshot = monitor.getCockpitSnapshot();
    expect(snapshot.healthy).toBe(false);
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.providers.length).toBe(0);
  });

  it("registers providers with stable keyIds and reports healthy stats", () => {
    const monitor = new KeyFleetMonitor([
      {
        provider: "anthropic",
        modelId: "claude-3-5-sonnet",
        keys: ["sk-ant-api03-sample-primary-key-8a1c", "sk-ant-api03-sample-secondary-key-9f2e"],
      },
      {
        provider: "openai",
        modelId: "gpt-4o",
        keys: ["sk-proj-sample-prod-key-1c4a"],
      },
    ]);
    const stats = monitor.getFleetStats();
    expect(stats.totalKeys).toBe(3);
    expect(stats.healthyCount).toBe(3);
    expect(stats.cooldownCount).toBe(0);
    expect(stats.evictedCount).toBe(0);
    expect(stats.healthPercentage).toBe(100);

    const reports = monitor.getFleetReport();
    expect(reports[0]?.keys[0]?.keyId).toBe("anthropic-key-1");
    expect(reports[0]?.keys[0]?.maskedKey).toBe("sk-ant-...8a1c");
  });

  it("returns skipped status when probing without probe function", async () => {
    const monitor = new KeyFleetMonitor([
      {
        provider: "anthropic",
        modelId: "claude-3-5-sonnet",
        keys: ["sk-ant-api03-sample-primary-key-8a1c"],
      },
    ]);
    const probeRes = await monitor.probeKey("anthropic", "anthropic-key-1");
    expect(probeRes.status).toBe("skipped");
    expect(probeRes.latencyMs).toBe(0);
    expect(probeRes.sparkline).toEqual([]);
  });

  it("does not fabricate a 999ms latency when a probe throws", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(137);
    const monitor = new KeyFleetMonitor([
      {
        provider: "local",
        modelId: "test",
        keys: ["test-only-key"],
        probeFn: async () => {
          throw new Error("offline");
        },
      },
    ]);
    const result = await monitor.probeKey("local", "local-key-1");
    expect(result.status).toBe("error");
    expect(result.latencyMs).toBe(37);
    expect(result.sparkline).toEqual([37]);
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
    const targetKey = reports[0]!.keys[0]!.keyId;

    const result = await monitor.probeKey("custom-ai", targetKey);
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBe(75);
    expect(result.sparkline).toEqual([75]);

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
    const monitor = new KeyFleetMonitor([
      {
        provider: "openai",
        modelId: "gpt-4o",
        keys: ["sk-proj-sample-prod-key-1c4a"],
      },
    ]);
    let notificationCount = 0;
    const unsubscribe = monitor.subscribe(() => {
      notificationCount++;
    });

    const reports = monitor.getFleetReport();
    const openai = reports.find((r) => r.provider === "openai")!;
    const key1 = openai.keys[0]!.keyId;

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

    // Revive single
    const revived = monitor.reviveKey("openai", key1);
    expect(revived).toBe(true);
    stats = monitor.getFleetStats();
    expect(stats.evictedCount).toBe(0);
    expect(notificationCount).toBe(4);

    // Revive unknown key returns false
    expect(monitor.reviveKey("openai", "non-existent-key")).toBe(false);
    expect(monitor.hasKey("openai", key1)).toBe(true);
    expect(monitor.hasKey("openai", "non-existent-key")).toBe(false);
    expect(monitor.hasKey("unknown-provider", key1)).toBe(false);

    unsubscribe();
  });

  it("binds to authoritative KeyRotatorRegistry when projectId is provided", () => {
    const monitor = new KeyFleetMonitor([
      {
        provider: "anthropic",
        modelId: "claude-3-5-sonnet",
        projectId: "test-proj",
        keys: ["sk-ant-sample-key-1", "sk-ant-sample-key-2"],
      },
    ]);

    expect(monitor.hasKey("anthropic", "anthropic-key-1")).toBe(true);
    const rotator = monitor.getRotator("anthropic");
    expect(rotator).toBeDefined();

    // Key operations mutate the rotator directly
    const cooldownSuccess = monitor.cooldownKey("anthropic", "anthropic-key-1", 30_000);
    expect(cooldownSuccess).toBe(true);
    expect(rotator!.getKeys()[0]?.cooldownUntil).toBeGreaterThan(0);
  });

  it("probes the fleet concurrently, so one hung key does not stall the sweep", async () => {
    // The probes are independent per key. A sequential sweep awaited each before starting
    // the next, so a single unresponsive endpoint blocked every key behind it — and the
    // listeners, which fire only after the loop. A hung probe still has to be bounded, or
    // the sweep never settles at all.
    const started: string[] = [];
    let resolveHung: (() => void) | undefined;
    const monitor = new KeyFleetMonitor([
      {
        provider: "custom-ai",
        modelId: "hungry",
        keys: ["hung-key-aaaa", "fast-key-bbbb", "fast-key-cccc"],
        probeFn: async (provider, key) => {
          started.push(key);
          if (key.startsWith("hung")) {
            await new Promise<void>((resolve) => {
              resolveHung = resolve;
            });
            return { ok: true, latencyMs: 1 };
          }
          return { ok: true, latencyMs: 5 };
        },
      },
    ]);

    const settled = monitor.probeFleet(100);
    // The fast keys complete without waiting for the hung one.
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(3);
    resolveHung!();
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("reports a probe that outlives its deadline instead of awaiting it forever", async () => {
    const monitor = new KeyFleetMonitor([
      {
        provider: "custom-ai",
        modelId: "hungry",
        keys: ["never-resolves-key"],
        probeFn: async () => new Promise(() => {}),
      },
    ]);

    let done = false;
    const settled = monitor.probeFleet(50).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(49);
    // Still pending at 49ms: the deadline is 50, so the sweep has not settled.
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
    const results = await settled;
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.keyId).toBe("custom-ai-key-1");
    expect(results[0]!.latencyMs).toBe(50);
    expect(results[0]!.details).toContain("deadline");
  });

  it("does not apply a late probe result after its fleet deadline", async () => {
    let resolveProbe!: (result: { ok: boolean; latencyMs: number }) => void;
    let probeSignal: AbortSignal | undefined;
    const monitor = new KeyFleetMonitor([
      {
        provider: "custom-ai",
        modelId: "slow",
        keys: ["slow-key-aaaa"],
        probeFn: async (_provider, _key, signal) => {
          probeSignal = signal;
          return new Promise((resolve) => {
            resolveProbe = resolve;
          });
        },
      },
    ]);

    const sweep = monitor.probeFleet(50);
    await vi.advanceTimersByTimeAsync(51);
    expect((await sweep)[0]!.status).toBe("error");
    expect(probeSignal?.aborted).toBe(true);

    resolveProbe({ ok: false, latencyMs: 300 });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getFleetStats().healthyCount).toBe(1);
    expect(monitor.getFleetReport()[0]!.keys[0]!.failureCount).toBe(0);
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
