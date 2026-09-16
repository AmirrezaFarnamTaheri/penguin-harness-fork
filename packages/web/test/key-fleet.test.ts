import { describe, expect, it } from "vitest";
import {
  calculateFleetHealth,
  calculateKeySuccessRate,
  filterKeyFleetReports,
  formatCooldownTimer,
  simulateKeyProbe,
  type KeyHealthItem,
  type ModelKeyFleetReport,
  type RotationStrategy,
} from "../src/features/models/key-fleet-types";

describe("key-fleet-types", () => {
  const sampleReports: ModelKeyFleetReport[] = [
    {
      modelRef: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      rotationStrategy: "round-robin",
      totalKeys: 3,
      healthyCount: 2,
      cooldownCount: 1,
      evictedCount: 0,
      activeLeases: 4,
      keys: [
        {
          maskedKey: "sk-...1234",
          status: "healthy",
          isFailed: false,
          cooldownRemainingMs: 0,
          successCount: 95,
          failureCount: 5,
          activeLeases: 3,
          lastUsedAt: Date.now() - 10_000,
        },
        {
          maskedKey: "sk-...5678",
          status: "healthy",
          isFailed: false,
          cooldownRemainingMs: 0,
          successCount: 48,
          failureCount: 2,
          activeLeases: 1,
          lastUsedAt: Date.now() - 25_000,
        },
        {
          maskedKey: "sk-...9999",
          status: "cooldown",
          isFailed: false,
          cooldownRemainingMs: 42_000,
          successCount: 10,
          failureCount: 6,
          activeLeases: 0,
          lastUsedAt: Date.now() - 5_000,
        },
      ],
    },
    {
      modelRef: "anthropic/claude-3-5-sonnet",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      rotationStrategy: "least-leases",
      totalKeys: 2,
      healthyCount: 1,
      cooldownCount: 0,
      evictedCount: 1,
      activeLeases: 1,
      keys: [
        {
          maskedKey: "sk-ant-...aaaa",
          status: "healthy",
          isFailed: false,
          cooldownRemainingMs: 0,
          successCount: 120,
          failureCount: 0,
          activeLeases: 1,
        },
        {
          maskedKey: "sk-ant-...bbbb",
          status: "evicted",
          isFailed: true,
          cooldownRemainingMs: 0,
          successCount: 2,
          failureCount: 8,
          activeLeases: 0,
        },
      ],
    },
  ];

  describe("calculateFleetHealth", () => {
    it("aggregates fleet statistics across all models and keys", () => {
      const stats = calculateFleetHealth(sampleReports);
      expect(stats.totalKeys).toBe(5);
      expect(stats.healthyCount).toBe(3);
      expect(stats.cooldownCount).toBe(1);
      expect(stats.evictedCount).toBe(1);
      expect(stats.activeLeases).toBe(5);
      expect(stats.healthPercentage).toBe(60); // 3 / 5 * 100
    });

    it("reports null health and empty availabilityState for empty fleet", () => {
      const stats = calculateFleetHealth([]);
      expect(stats.totalKeys).toBe(0);
      expect(stats.healthyCount).toBe(0);
      expect(stats.healthPercentage).toBeNull();
      expect(stats.availabilityState).toBe("empty");
    });
  });

  describe("calculateKeySuccessRate", () => {
    it("computes accurate invocation success percentage", () => {
      expect(calculateKeySuccessRate(95, 5)).toBe(95);
      expect(calculateKeySuccessRate(50, 50)).toBe(50);
      expect(calculateKeySuccessRate(0, 10)).toBe(0);
      expect(calculateKeySuccessRate(100, 0)).toBe(100);
    });

    it("returns 100% when there have been 0 calls", () => {
      expect(calculateKeySuccessRate(0, 0)).toBe(100);
    });
  });

  describe("formatCooldownTimer", () => {
    it("formats seconds and minutes correctly", () => {
      expect(formatCooldownTimer(0)).toBe("0s");
      expect(formatCooldownTimer(-100)).toBe("0s");
      expect(formatCooldownTimer(45_000)).toBe("45s");
      expect(formatCooldownTimer(75_000)).toBe("1m 15s");
      expect(formatCooldownTimer(120_000)).toBe("2m 0s");
    });
  });

  describe("filterKeyFleetReports", () => {
    it("filters reports by search query across model and provider", () => {
      const filtered = filterKeyFleetReports(sampleReports, "all", "claude");
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.modelId).toBe("claude-3-5-sonnet");
    });

    it("filters reports by status (cooldown)", () => {
      const filtered = filterKeyFleetReports(sampleReports, "cooldown", "");
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.keys.length).toBe(1);
      expect(filtered[0]!.keys[0]!.maskedKey).toBe("sk-...9999");
    });

    it("filters reports by status (evicted)", () => {
      const filtered = filterKeyFleetReports(sampleReports, "evicted", "");
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.keys.length).toBe(1);
      expect(filtered[0]!.keys[0]!.maskedKey).toBe("sk-ant-...bbbb");
    });
  });

  describe("simulateKeyProbe", () => {
    it("generates latency probe results with sparkline history", () => {
      const probe = simulateKeyProbe("sk-...1234", "openai");
      expect(probe.maskedKey).toBe("sk-...1234");
      expect(probe.provider).toBe("openai");
      expect(probe.latencyMs).toBeGreaterThanOrEqual(10);
      expect(probe.status).toBe("ok");
      expect(probe.sparkline.length).toBeGreaterThanOrEqual(5);
    });
  });
});
