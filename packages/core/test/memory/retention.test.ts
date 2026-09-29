import { describe, expect, it } from "vitest";
import {
  CONSOLIDATION_GATES,
  RETENTION_DEFAULTS,
  applyDecay,
  consolidate,
  retentionTier,
  strengthAt,
  type RetentionRecord,
} from "../../src/memory/retention.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function record(overrides: Partial<RetentionRecord> = {}): RetentionRecord {
  return {
    id: "mem-1",
    salience: 1,
    createdAt: T0,
    updatedAt: T0,
    strength: 1,
    ...overrides,
  };
}

describe("retention strength (agentmemory formula)", () => {
  it("decays exponentially at λ=0.01/day from the update anchor", () => {
    const fresh = strengthAt(record(), T0);
    const after100 = strengthAt(record(), T0 + 100 * DAY);
    expect(fresh).toBeCloseTo(1, 5);
    expect(after100).toBeCloseTo(Math.exp(-1), 5);
  });

  it("adds diminishing access reinforcement (σ=0.3)", () => {
    const accessed = record({ accesses: [T0], accessCount: 1 });
    const withAccess = strengthAt(accessed, T0 + 10 * DAY);
    const withoutAccess = strengthAt(record(), T0 + 10 * DAY);
    expect(withAccess).toBeGreaterThan(withoutAccess);
    // σ · 1/days over one access 10 days old on top of the decayed base.
    expect(withAccess).toBeCloseTo(Math.exp(-0.1) + 0.3 * (1 / 10), 5);
  });

  it("classifies tiers at the reference cutovers 0.7 / 0.4 / 0.15", () => {
    expect(retentionTier(0.7)).toBe("hot");
    expect(retentionTier(0.69)).toBe("warm");
    expect(retentionTier(0.4)).toBe("warm");
    expect(retentionTier(0.39)).toBe("cold");
    expect(retentionTier(0.15)).toBe("cold");
    expect(retentionTier(0.14)).toBe("expired");
    expect(RETENTION_DEFAULTS.decayFactor).toBe(0.9);
    expect(RETENTION_DEFAULTS.decayFloor).toBe(0.1);
  });
});

describe("storage decay (write-only-what-changed)", () => {
  it("returns null for fresh records — a scan writes nothing", () => {
    expect(applyDecay(record({ strength: 0.8 }), T0 + 29 * DAY)).toBeNull();
  });

  it("applies ×0.9 per 30 idle days and floors at 0.1", () => {
    const decayed = applyDecay(record({ strength: 0.8 }), T0 + 45 * DAY);
    expect(decayed).not.toBeNull();
    expect(decayed!.strength).toBeCloseTo(0.72, 5); // 0.8 × 0.9^1
    expect(decayed!.lastDecayedAt).toBe(T0 + 45 * DAY);

    const deep = applyDecay(record({ strength: 0.5 }), T0 + 3000 * DAY);
    expect(deep!.strength).toBe(0.1); // floored
  });

  it("does not decay below the floor and reports no change at the floor", () => {
    const atFloor = record({ strength: 0.1, lastDecayedAt: T0 });
    expect(applyDecay(atFloor, T0 + 90 * DAY)).toBeNull();
  });

  it("anchors on access, so a used record does not decay", () => {
    const used = record({ strength: 0.8, accesses: [T0 + 40 * DAY] });
    expect(applyDecay(used, T0 + 45 * DAY)).toBeNull();
  });
});

describe("consolidation gates", () => {
  it("promotes semantic facts only at ≥5 summaries", () => {
    const summaries = Array.from({ length: 4 }, (_, i) => record({ id: `s${i}` }));
    const under = consolidate({ summaries }, T0);
    expect(under.semantic).toHaveLength(0);

    const five = consolidate({ summaries: [...summaries, record({ id: "s4" })] }, T0);
    expect(five.semantic).toHaveLength(CONSOLIDATION_GATES.minSummaries);
  });

  it("promotes procedural patterns at ≥2 patterns with frequency ≥2", () => {
    const patterns = [record({ id: "p1", strength: 0.5 }), record({ id: "p2", strength: 0.5 })].map(
      (r) => ({ ...r, frequency: 2 }),
    );
    const promoted = consolidate({ patterns }, T0);
    expect(promoted.procedural.map((p) => p.id)).toEqual(["p1", "p2"]);

    const weak = consolidate(
      {
        patterns: [
          { ...record({ id: "p1" }), frequency: 1 },
          { ...record({ id: "p2" }), frequency: 1 },
        ],
      },
      T0,
    );
    expect(weak.procedural).toHaveLength(0);
  });

  it("decays only changed records and evicts to a budget oldest/coldest first", () => {
    const stale = record({
      id: "stale",
      strength: 1,
      updatedAt: T0 - 45 * DAY,
      createdAt: T0 - 45 * DAY,
    });
    const fresh = record({ id: "fresh", strength: 1 });
    const result = consolidate(
      {
        summaries: [stale, fresh, record({ id: "s2" }), record({ id: "s3" }), record({ id: "s4" })],
      },
      T0,
      { maxRecords: 3 },
    );
    expect(result.scanned).toBe(5);
    // Only `stale` changed under decay.
    expect(result.decayed.map((d) => d.id)).toEqual(["stale"]);
    expect(result.evicted).toHaveLength(2);
  });
});
