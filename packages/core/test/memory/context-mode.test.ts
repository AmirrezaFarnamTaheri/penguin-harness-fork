import { describe, expect, it } from "vitest";

import {
  type ContextModeId,
  type ContextModeProfile,
  CONTEXT_MODES,
  compactionThresholds,
  escalateContextMode,
  isUnderPressure,
  modeForUtilization,
  resolveContextMode,
} from "../../src/memory/context-mode.js";

const MODE_IDS: ContextModeId[] = ["aggressive", "balanced", "conservative", "minimal"];

const REQUIRED_FIELDS: (keyof ContextModeProfile)[] = [
  "id",
  "label",
  "topK",
  "chunkTopK",
  "maxEntityTokens",
  "maxRelationTokens",
  "maxTotalTokens",
  "cosineThreshold",
  "rerank",
  "lexical",
  "recallMaxEvents",
  "recallMaxTokens",
  "maxChunkBytes",
  "compactionThresholdRatio",
  "slidingWindowRatio",
];

describe("context-mode", () => {
  describe("CONTEXT_MODES table", () => {
    it("has exactly the four shipped modes", () => {
      expect(Object.keys(CONTEXT_MODES).sort()).toEqual([...MODE_IDS].sort());
    });

    it("is frozen", () => {
      expect(Object.isFrozen(CONTEXT_MODES)).toBe(true);
    });

    it("gives every mode a complete profile whose id matches its key", () => {
      for (const id of MODE_IDS) {
        const profile = CONTEXT_MODES[id];
        expect(profile.id).toBe(id);
        for (const field of REQUIRED_FIELDS) {
          expect(field in profile).toBe(true);
        }
      }
    });

    it("ships sane numeric dials for every mode", () => {
      for (const id of MODE_IDS) {
        const profile = CONTEXT_MODES[id];
        expect(profile.topK).toBeGreaterThan(0);
        expect(profile.chunkTopK).toBeLessThanOrEqual(profile.topK);
        expect(profile.maxTotalTokens).toBeGreaterThan(0);
        expect(profile.maxEntityTokens).toBeLessThan(profile.maxTotalTokens);
        expect(profile.maxRelationTokens).toBeLessThan(profile.maxTotalTokens);
        expect(profile.cosineThreshold).toBeGreaterThan(0);
        expect(profile.cosineThreshold).toBeLessThanOrEqual(1);
        expect(profile.compactionThresholdRatio).toBeGreaterThan(0);
        expect(profile.compactionThresholdRatio).toBeLessThanOrEqual(1);
        expect(profile.slidingWindowRatio).toBeGreaterThan(0);
        expect(profile.slidingWindowRatio).toBeLessThan(1);
      }
    });

    it("ships balanced with the documented default dials", () => {
      expect(CONTEXT_MODES.balanced).toMatchObject({
        id: "balanced",
        topK: 40,
        chunkTopK: 20,
        maxTotalTokens: 30_000,
        cosineThreshold: 0.2,
        rerank: true,
        lexical: true,
        maxChunkBytes: 4_096,
      });
    });
  });

  describe("resolveContextMode", () => {
    it("returns the profile for a known id", () => {
      expect(resolveContextMode("aggressive")).toBe(CONTEXT_MODES.aggressive);
      expect(resolveContextMode("minimal")).toBe(CONTEXT_MODES.minimal);
    });

    it("falls back to balanced for an unknown id", () => {
      expect(resolveContextMode("unknown")).toBe(CONTEXT_MODES.balanced);
      expect(resolveContextMode("")).toBe(CONTEXT_MODES.balanced);
    });
  });

  describe("escalateContextMode", () => {
    it("walks the escalation ladder toward minimal", () => {
      expect(escalateContextMode("aggressive")).toBe("balanced");
      expect(escalateContextMode("balanced")).toBe("conservative");
      expect(escalateContextMode("conservative")).toBe("minimal");
      expect(escalateContextMode("minimal")).toBe("minimal");
    });

    it("never widens the appetite of any mode", () => {
      for (const id of MODE_IDS) {
        const escalated = escalateContextMode(id);
        const before = resolveContextMode(id);
        const after = resolveContextMode(escalated);
        expect(after.topK).toBeLessThanOrEqual(before.topK);
        expect(after.maxTotalTokens).toBeLessThanOrEqual(before.maxTotalTokens);
        expect(after.maxChunkBytes).toBeLessThanOrEqual(before.maxChunkBytes);
      }
    });

    it("reaches minimal within three escalations from any mode", () => {
      for (const id of MODE_IDS) {
        let current: ContextModeId = id;
        for (let step = 0; step < 3; step++) {
          if (current === "minimal") break;
          current = escalateContextMode(current);
        }
        expect(current).toBe("minimal");
      }
    });
  });

  describe("modeForUtilization", () => {
    it("tightens the mode as the context window fills", () => {
      expect(modeForUtilization(0.1)).toBe("aggressive");
      expect(modeForUtilization(0.5)).toBe("balanced");
      expect(modeForUtilization(0.7)).toBe("conservative");
      expect(modeForUtilization(0.9)).toBe("minimal");
    });

    it("fires the mode change before the compaction boundary", () => {
      // The minimal threshold (0.85) must sit at or below the aggressive compaction
      // trigger ratio so a mode change is the first response to pressure.
      expect(modeForUtilization(0.85)).toBe("minimal");
      expect(CONTEXT_MODES.aggressive.compactionThresholdRatio).toBeGreaterThanOrEqual(0.85);
    });

    it("treats the thresholds as inclusive lower bounds", () => {
      expect(modeForUtilization(0.5)).toBe("balanced");
      expect(modeForUtilization(0.4999)).toBe("aggressive");
      expect(modeForUtilization(0.7)).toBe("conservative");
      expect(modeForUtilization(0.6999)).toBe("balanced");
    });
  });

  describe("isUnderPressure", () => {
    it("is true at and above the 0.5 utilization", () => {
      expect(isUnderPressure(0.5)).toBe(true);
      expect(isUnderPressure(0.9)).toBe(true);
      expect(isUnderPressure(0.49)).toBe(false);
    });
  });

  describe("compactionThresholds", () => {
    it("derives the trigger and target from the profile ratios", () => {
      const { trigger, target } = compactionThresholds(CONTEXT_MODES.balanced, 100_000);
      expect(trigger).toBe(80_000);
      expect(target).toBe(70_000);
    });

    it("keeps less of the window as the mode tightens", () => {
      const balanced = compactionThresholds(CONTEXT_MODES.balanced, 100_000);
      const minimal = compactionThresholds(CONTEXT_MODES.minimal, 100_000);
      expect(minimal.trigger).toBeLessThan(balanced.trigger);
      expect(minimal.target).toBeGreaterThan(balanced.target);
    });

    it("clamps the target so a small window keeps something worth keeping", () => {
      // For a 10k window the 70% target (7k) is below the 30k floor clamp, and
      // min(10k, 30k) = 10k wins, so the target stays above the trigger.
      const { trigger, target } = compactionThresholds(CONTEXT_MODES.balanced, 10_000);
      expect(trigger).toBe(8_000);
      expect(target).toBe(10_000);
      expect(target).toBeGreaterThan(trigger);
    });
  });
});
