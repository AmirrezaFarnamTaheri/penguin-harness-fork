import { describe, it, expect } from "vitest";
import {
  TokenMeter,
  calculateIntensities,
  saturatingAdd,
  formatUtcDate,
  type DailyContribution,
  type UsageEvent,
} from "../src/hud/token-meter.js";

describe("hud-token-meter", () => {
  describe("saturatingAdd", () => {
    it("sums positive numbers safely", () => {
      expect(saturatingAdd(10, 20, 30)).toBe(60);
    });

    it("ignores negative numbers, NaN, and null/undefined", () => {
      expect(saturatingAdd(10, -5, NaN, null, undefined, 40)).toBe(50);
    });

    it("returns 0 for empty or all-invalid inputs", () => {
      expect(saturatingAdd()).toBe(0);
      expect(saturatingAdd(-10, NaN, null)).toBe(0);
    });
  });

  describe("calculateIntensities", () => {
    it("handles empty contributions", () => {
      const list: DailyContribution[] = [];
      calculateIntensities(list);
      expect(list).toEqual([]);
    });

    it("assigns 0 intensity when costs and tokens are 0", () => {
      const list: DailyContribution[] = [
        {
          date: "2026-03-01",
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          messageCount: 0,
          intensity: 0,
          modelBreakdown: {},
        },
      ];
      calculateIntensities(list);
      expect(list[0]!.intensity).toBe(0);
    });

    it("buckets intensities (1 to 4) relative to maximum cost", () => {
      const makeDay = (date: string, costUsd: number): DailyContribution => ({
        date,
        inputTokens: 100,
        outputTokens: 100,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 200,
        costUsd,
        messageCount: 1,
        intensity: 0,
        modelBreakdown: {},
      });

      const days = [
        makeDay("2026-03-01", 0.0), // 0% -> 0
        makeDay("2026-03-02", 0.1), // 10% -> 1
        makeDay("2026-03-03", 0.3), // 30% -> 2
        makeDay("2026-03-04", 0.6), // 60% -> 3
        makeDay("2026-03-05", 1.0), // 100% -> 4
      ];

      calculateIntensities(days);

      expect(days[0]!.intensity).toBe(0);
      expect(days[1]!.intensity).toBe(1);
      expect(days[2]!.intensity).toBe(2);
      expect(days[3]!.intensity).toBe(3);
      expect(days[4]!.intensity).toBe(4);
    });
  });

  describe("formatUtcDate", () => {
    it("formats timestamps into YYYY-MM-DD format", () => {
      const ts = Date.UTC(2026, 2, 12, 15, 30, 0); // Month is 0-indexed (2 = March)
      expect(formatUtcDate(ts)).toBe("2026-03-12");
    });
  });

  describe("TokenMeter", () => {
    it("records events and calculates rate in window", () => {
      const meter = new TokenMeter();
      const now = 1_000_000;

      meter.record(
        {
          tsMs: now - 2000,
          input: 100,
          output: 50,
          costUsd: 0.002,
          model: "claude-3-7-sonnet",
        },
        now,
      );

      meter.record(
        {
          tsMs: now - 1000,
          input: 200,
          output: 150,
          costUsd: 0.005,
          model: "claude-3-7-sonnet",
        },
        now,
      );

      const rate = meter.getRateInWindow(5000, now);
      expect(rate.inputTokens).toBe(300);
      expect(rate.outputTokens).toBe(200);
      expect(rate.totalTokens).toBe(500);
      expect(rate.costUsd).toBe(0.007);
      expect(rate.tokensPerSecond).toBe(40); // 200 tokens / 5 seconds
      expect(rate.tokensPerMinute).toBe(2400); // 40 * 60
    });

    it("generates trace breakdown across models and agents", () => {
      const meter = new TokenMeter();
      const now = 1_000_000;

      meter.record(
        {
          tsMs: now - 1000,
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          agent: "coder",
          client: "vscode",
          input: 100,
          output: 50,
          costUsd: 0.002,
        },
        now,
      );

      meter.record(
        {
          tsMs: now - 500,
          provider: "openai",
          model: "gpt-4o",
          agent: "reviewer",
          client: "cli",
          input: 300,
          output: 100,
          costUsd: 0.004,
        },
        now,
      );

      const trace = meter.getTrace(5000, now);
      expect(trace.length).toBe(2);
      expect(trace[0]!.provider).toBe("openai");
      expect(trace[0]!.totalTokens).toBe(400);
      expect(trace[1]!.provider).toBe("anthropic");
      expect(trace[1]!.totalTokens).toBe(150);
    });

    it("projects quota burn and warns on depletion", () => {
      const meter = new TokenMeter();
      const now = 1_000_000;

      // 100 output tokens in 1000ms window = 100 tps
      meter.record(
        {
          tsMs: now - 500,
          output: 100,
        },
        now,
      );

      // Remaining 10,000 tokens at 100 tps -> 100 seconds left -> critical (< 300s)
      const proj = meter.projectQuotaBurn(10_000, 1000, now);
      expect(proj.burnLevel).toBe("critical");
      expect(proj.estimatedSecondsToDepletion).toBe(100);
      expect(proj.estimatedDepletionTimestamp).toBe(now + 100_000);

      // Depleted quota
      const depleted = meter.projectQuotaBurn(0, 1000, now);
      expect(depleted.burnLevel).toBe("depleted");
      expect(depleted.estimatedSecondsToDepletion).toBe(0);

      // No activity / zero rate
      const idle = new TokenMeter();
      const idleProj = idle.projectQuotaBurn(50_000, 1000, now);
      expect(idleProj.burnLevel).toBe("nominal");
      expect(idleProj.estimatedSecondsToDepletion).toBeNull();
    });

    it("folds events into daily contributions with intensities", () => {
      const meter = new TokenMeter({ retentionMs: 7 * 24 * 60 * 60 * 1000 });
      const day1 = Date.UTC(2026, 2, 10, 12, 0, 0);
      const day2 = Date.UTC(2026, 2, 11, 14, 0, 0);

      meter.record({
        tsMs: day1,
        input: 100,
        output: 100,
        costUsd: 0.1,
        model: "claude-3-7-sonnet",
      });

      meter.record({
        tsMs: day2,
        input: 500,
        output: 500,
        costUsd: 1.0,
        model: "claude-3-7-sonnet",
      });

      const daily = meter.foldDaily();
      expect(daily.length).toBe(2);
      expect(daily[0]!.date).toBe("2026-03-10");
      expect(daily[0]!.totalTokens).toBe(200);
      expect(daily[0]!.costUsd).toBe(0.1);
      expect(daily[0]!.intensity).toBe(1); // 0.1 / 1.0 = 10% -> 1

      expect(daily[1]!.date).toBe("2026-03-11");
      expect(daily[1]!.totalTokens).toBe(1000);
      expect(daily[1]!.costUsd).toBe(1.0);
      expect(daily[1]!.intensity).toBe(4); // 1.0 / 1.0 = 100% -> 4
    });

    it("prunes events older than the retention window", () => {
      const meter = new TokenMeter({ retentionMs: 10_000 });
      const now = 100_000;

      meter.record({ tsMs: now - 15_000, input: 10, output: 10 }, now);
      meter.record({ tsMs: now - 5_000, input: 20, output: 20 }, now);

      expect(meter.size()).toBe(1);
      expect(meter.getEvents()[0]!.input).toBe(20);
    });
  });
});
