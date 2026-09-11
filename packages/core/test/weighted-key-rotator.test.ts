import { describe, expect, it } from "vitest";
import { WeightedKeyRotator } from "../src/llm/key-rotator.js";

describe("WeightedKeyRotator", () => {
  it("initializes with keys and default weights", () => {
    const rotator = new WeightedKeyRotator(["key-a", "key-b"]);
    expect(rotator.totalKeys).toBe(2);
    expect(rotator.workingKeys.length).toBe(2);
    const statuses = rotator.getStatuses();
    expect(statuses[0]?.weight).toBe(100);
    expect(statuses[1]?.weight).toBe(100);
  });

  it("supports explicit custom weights", () => {
    const rotator = new WeightedKeyRotator([
      { key: "tier-1-heavy", weight: 300 },
      { key: "tier-2-light", weight: 50 },
    ]);
    const statuses = rotator.getStatuses();
    expect(statuses[0]?.weight).toBe(300);
    expect(statuses[1]?.weight).toBe(50);
  });

  it("selects key and tracks lastUsedAt timestamp", () => {
    const now = 1_000_000;
    const rotator = new WeightedKeyRotator(["key-single"]);
    const key = rotator.selectKey(now);
    expect(key).toBe("key-single");
    const status = rotator.getStatuses()[0];
    expect(status?.lastUsedAt).toBe(now);
  });

  it("adapts score dynamically on success and failure", () => {
    const rotator = new WeightedKeyRotator([{ key: "target-key", weight: 100 }], {
      boostStep: 10,
      decayStep: 25,
    });
    const status = rotator.getStatuses()[0]!;

    expect(rotator.computeScore(status)).toBe(100);

    rotator.recordSuccess("target-key");
    const afterSuccess = rotator.getStatuses()[0]!;
    expect(afterSuccess.consecutiveSuccesses).toBe(1);
    expect(rotator.computeScore(afterSuccess)).toBe(110);

    rotator.recordFailure("target-key", false, 0); // zero cooldown for score test
    const afterFailure = rotator.getStatuses()[0]!;
    expect(afterFailure.consecutiveFailures).toBe(1);
    expect(afterFailure.consecutiveSuccesses).toBe(0);
    expect(rotator.computeScore(afterFailure, Date.now() + 10)).toBe(75);
  });

  it("handles concurrency penalty with lease acquire/release", () => {
    const rotator = new WeightedKeyRotator([{ key: "lease-key", weight: 100 }]);
    const status = rotator.getStatuses()[0]!;
    expect(rotator.computeScore(status)).toBe(100);

    rotator.acquireLease("lease-key");
    const leasedStatus = rotator.getStatuses()[0]!;
    expect(leasedStatus.activeLeases).toBe(1);
    // score = 100 / (1 + 1 * 2) = 100 / 3 = 33.333...
    expect(rotator.computeScore(leasedStatus)).toBeCloseTo(33.33, 1);

    rotator.releaseLease("lease-key");
    const releasedStatus = rotator.getStatuses()[0]!;
    expect(releasedStatus.activeLeases).toBe(0);
    expect(rotator.computeScore(releasedStatus)).toBe(100);
  });

  it("excludes permanently failed keys from workingKeys", () => {
    const rotator = new WeightedKeyRotator(["key-1", "key-2"]);
    rotator.recordFailure("key-1", true); // permanent 401
    expect(rotator.workingKeys.length).toBe(1);
    expect(rotator.selectKey()).toBe("key-2");
  });
});
