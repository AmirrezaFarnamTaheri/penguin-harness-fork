import { describe, it, expect, beforeEach } from "vitest";
import { InferenceProxyPool, parseProxyUrl } from "../src/llm/proxy-pool.js";

describe("parseProxyUrl", () => {
  it("parses standard http and https proxy urls", () => {
    const res1 = parseProxyUrl("http://proxy.example.com:8080");
    expect(res1.protocol).toBe("http");
    expect(res1.host).toBe("proxy.example.com");
    expect(res1.port).toBe(8080);
    expect(res1.auth).toBeUndefined();
    expect(res1.canonicalUrl).toBe("http://proxy.example.com:8080");

    const res2 = parseProxyUrl("https://secure-proxy.org:8443");
    expect(res2.protocol).toBe("https");
    expect(res2.host).toBe("secure-proxy.org");
    expect(res2.port).toBe(8443);
  });

  it("parses socks4 and socks5 urls with authentication", () => {
    const res = parseProxyUrl("socks5://alice:secret123@192.168.1.50:1080");
    expect(res.protocol).toBe("socks5");
    expect(res.host).toBe("192.168.1.50");
    expect(res.port).toBe(1080);
    expect(res.auth).toEqual({ username: "alice", password: "secret123" });
  });

  it("defaults scheme to http if omitted", () => {
    const res = parseProxyUrl("10.0.0.1:3128");
    expect(res.protocol).toBe("http");
    expect(res.host).toBe("10.0.0.1");
    expect(res.port).toBe(3128);
  });

  it("assigns standard default ports when omitted", () => {
    expect(parseProxyUrl("http://proxy.lan").port).toBe(8080);
    expect(parseProxyUrl("https://proxy.lan").port).toBe(8443);
    expect(parseProxyUrl("socks5://proxy.lan").port).toBe(1080);
  });

  it("throws on empty or invalid protocol", () => {
    expect(() => parseProxyUrl("")).toThrow();
    expect(() => parseProxyUrl("ftp://bad.host:21")).toThrow("Unsupported proxy protocol");
  });
});

describe("InferenceProxyPool", () => {
  let pool: InferenceProxyPool;

  beforeEach(() => {
    pool = new InferenceProxyPool({
      strategy: "least-latency",
      rateLimitCooldownMs: 1000,
      errorCooldownMs: 500,
      maxConsecutiveFailures: 3,
      deadCooldownMs: 5000,
      emaAlpha: 0.5,
    });
  });

  it("adds and deduplicates proxies by canonical url", () => {
    pool.addProxy("http://1.1.1.1:8080");
    pool.addProxy({ url: "http://1.1.1.1:8080", weight: 5, tags: ["fast"] });

    const stats = pool.getStats();
    expect(stats.total).toBe(1);
    expect(stats.healthy).toBe(1);

    const entry = pool.getProxyEntry("http://1.1.1.1:8080");
    expect(entry).toBeDefined();
    expect(entry?.weight).toBe(5);
    expect(entry?.tags).toContain("fast");
  });

  it("rejects non-finite and non-positive explicit weights", () => {
    for (const weight of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
      expect(() => pool.addProxy({ url: "http://weight.proxy:8080", weight })).toThrow(
        "positive finite number",
      );
    }
    expect(pool.getStats().total).toBe(0);
  });

  it("does not expose mutable internal proxy state", () => {
    const added = pool.addProxy({
      url: "http://encapsulated.proxy:8080",
      tags: ["initial"],
    });
    added.status = "disabled";
    added.tags.push("injected");

    const stored = pool.getProxyEntry("http://encapsulated.proxy:8080");
    expect(stored?.status).toBe("healthy");
    expect(stored?.tags).toEqual(["initial"]);

    const selected = pool.getNextProxy();
    expect(selected).toBeDefined();
    selected!.status = "dead";
    expect(pool.getProxyEntry("http://encapsulated.proxy:8080")?.status).toBe("healthy");
  });

  it("adds multiple proxies ignoring malformed inputs", () => {
    const entries = pool.addProxies([
      "http://1.1.1.1:8080",
      "invalid-broken://url",
      "socks5://2.2.2.2:1080",
    ]);
    expect(entries.length).toBe(2);
    expect(pool.getStats().total).toBe(2);
  });

  it("rotates using least-latency strategy", () => {
    pool.addProxy("http://fast.proxy:8080");
    pool.addProxy("http://slow.proxy:8080");

    pool.recordSuccess("http://fast.proxy:8080", 50);
    pool.recordSuccess("http://slow.proxy:8080", 300);

    const next = pool.getNextProxy();
    expect(next?.url).toBe("http://fast.proxy:8080");
  });

  it("rejects invalid latency observations", () => {
    pool.addProxy("http://latency.proxy:8080");
    expect(() => pool.recordSuccess("http://latency.proxy:8080", Number.POSITIVE_INFINITY)).toThrow(
      "non-negative finite number",
    );
    expect(() => pool.recordSuccess("http://latency.proxy:8080", -1)).toThrow(
      "non-negative finite number",
    );
    expect(pool.getProxyEntry("http://latency.proxy:8080")?.successCount).toBe(0);
  });

  it("calculates exponential moving average (EMA) latency", () => {
    pool.addProxy("http://proxy.test:8080");
    pool.recordSuccess("http://proxy.test:8080", 100);
    expect(pool.getProxyEntry("http://proxy.test:8080")?.latencyMs).toBe(100);

    // With alpha = 0.5: 0.5 * 200 + 0.5 * 100 = 150
    pool.recordSuccess("http://proxy.test:8080", 200);
    expect(pool.getProxyEntry("http://proxy.test:8080")?.latencyMs).toBe(150);
  });

  it("handles transient rate limits with cooldown", () => {
    pool.addProxy("http://ratelimited.proxy:8080");
    pool.recordFailure("http://ratelimited.proxy:8080", { isRateLimit: true });

    const entry = pool.getProxyEntry("http://ratelimited.proxy:8080");
    expect(entry?.status).toBe("cooldown");
    expect(entry?.cooldownUntil).toBeGreaterThan(Date.now());

    // Should return undefined when no healthy proxies exist
    expect(pool.getNextProxy()).toBeUndefined();
  });

  it("marks proxy as dead after max consecutive failures", () => {
    pool.addProxy("http://flaky.proxy:8080");
    pool.recordFailure("http://flaky.proxy:8080");
    expect(pool.getProxyEntry("http://flaky.proxy:8080")?.status).toBe("cooldown");

    pool.recordFailure("http://flaky.proxy:8080");
    expect(pool.getProxyEntry("http://flaky.proxy:8080")?.status).toBe("cooldown");

    // 3rd failure reaches maxConsecutiveFailures (3)
    pool.recordFailure("http://flaky.proxy:8080");
    expect(pool.getProxyEntry("http://flaky.proxy:8080")?.status).toBe("dead");
  });

  it("filters proxies by criteria (tags and protocol)", () => {
    pool.addProxy({ url: "http://us.proxy:8080", tags: ["us", "fast"] });
    pool.addProxy({ url: "socks5://eu.proxy:1080", tags: ["eu", "fast"] });

    const euProxy = pool.getNextProxy({ protocol: "socks5" });
    expect(euProxy?.url).toBe("socks5://eu.proxy:1080");

    const usProxy = pool.getNextProxy({ tags: ["us"] });
    expect(usProxy?.url).toBe("http://us.proxy:8080");

    const none = pool.getNextProxy({ tags: ["asia"] });
    expect(none).toBeUndefined();
  });

  it("supports export and import roundtrip", () => {
    pool.addProxy({ url: "http://1.1.1.1:8080", weight: 3, tags: ["p1"] });
    pool.recordSuccess("http://1.1.1.1:8080", 120);

    const exported = pool.exportEntries();
    expect(exported.length).toBe(1);

    const newPool = new InferenceProxyPool();
    newPool.importEntries(exported);

    expect(newPool.getStats().total).toBe(1);
    const importedEntry = newPool.getProxyEntry("http://1.1.1.1:8080");
    expect(importedEntry?.latencyMs).toBe(120);
    expect(importedEntry?.weight).toBe(3);
  });

  it("rejects imported entries with invalid weights", () => {
    const entry = pool.addProxy("http://import.proxy:8080");
    const newPool = new InferenceProxyPool();
    expect(() => newPool.importEntries([{ ...entry, weight: Number.POSITIVE_INFINITY }])).toThrow(
      "positive finite number",
    );
    expect(newPool.getStats().total).toBe(0);
  });
});
