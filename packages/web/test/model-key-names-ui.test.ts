/**
 * The named-key-fleet UI helpers: how a name joins onto a health report, what an unnamed key
 * is called instead, and what the search box matches.
 *
 * These are the parts of the feature that can silently do the WRONG thing rather than fail
 * loudly: a join that keys on the wrong string attaches a name to the wrong key, which is
 * worse than showing no name at all, and a search that ignores the name leaves the fleet
 * exactly as unmanageable as it was before the feature existed.
 */
import { describe, expect, it } from "vitest";
import {
  filterKeyFleetReports,
  joinKeyNames,
  keyMatchesQuery,
  keyNameOf,
  type KeyHealthItem,
  type KeyNameEntry,
  type ModelKeyFleetReport,
} from "../src/features/models/key-fleet-types";

function key(over: Partial<KeyHealthItem> = {}): KeyHealthItem {
  return {
    maskedKey: "sk-proj...aaaa",
    status: "healthy",
    isFailed: false,
    cooldownRemainingMs: 0,
    successCount: 1,
    failureCount: 0,
    ...over,
  };
}

function report(over: Partial<ModelKeyFleetReport> = {}): ModelKeyFleetReport {
  return {
    modelRef: "deepseek/deepseek-chat",
    provider: "deepseek",
    modelId: "deepseek-chat",
    rotationStrategy: "round-robin",
    totalKeys: 1,
    healthyCount: 1,
    cooldownCount: 0,
    evictedCount: 0,
    activeLeases: 0,
    keys: [key()],
    ...over,
  };
}

function entry(over: Partial<KeyNameEntry> = {}): KeyNameEntry {
  return {
    provider: "deepseek",
    modelId: "deepseek-chat",
    keyId: "k_0123456789ab",
    name: "prod",
    maskedKey: "sk-proj...aaaa",
    orphaned: false,
    ...over,
  };
}

describe("keyNameOf", () => {
  it("returns the name when there is one", () => {
    expect(keyNameOf({ name: "prod" }, "Unnamed")).toEqual({ name: "prod", isUnnamed: false });
  });

  /**
   * The backfill decision, enforced in the one place a user would see it violated. Nothing
   * writes "Key 1" or a position number: an unnamed key says so, and offers the rename.
   */
  it("says an unnamed key is unnamed, never invents one", () => {
    for (const input of [{}, { name: undefined }, { name: "" }, { name: "   " }]) {
      expect(keyNameOf(input, "Unnamed")).toEqual({ name: "Unnamed", isUnnamed: true });
    }
  });
});

describe("joinKeyNames", () => {
  it("attaches a name to the key whose mask matches, inside the same fleet", () => {
    const joined = joinKeyNames(
      [report({ keys: [key(), key({ maskedKey: "sk-proj...bbbb" })] })],
      [entry({ name: "staging" })],
    );
    expect(joined[0]!.keys[0]!.name).toBe("staging");
    expect(joined[0]!.keys[1]!.name).toBeUndefined();
  });

  it("carries the label and the rename handle along with the name", () => {
    const joined = joinKeyNames([report()], [entry({ name: "prod", label: "shared team pool" })]);
    expect(joined[0]!.keys[0]).toMatchObject({
      name: "prod",
      label: "shared team pool",
      keyId: "k_0123456789ab",
    });
  });

  it("leaves every key alone when the Project has named none", () => {
    const before = report();
    expect(joinKeyNames([before], [])).toEqual([before]);
  });

  /**
   * The join is scoped to the fleet on purpose. The same masked key text can legitimately
   * appear under two providers; a name given to one model's key must not appear on the other.
   */
  it("does not carry a name across fleets that happen to share a mask", () => {
    const joined = joinKeyNames(
      [
        report({ keys: [key({ maskedKey: "sk-...same" })] }),
        report({
          modelRef: "openai/gpt-4o",
          provider: "openai",
          modelId: "gpt-4o",
          keys: [key({ maskedKey: "sk-...same" })],
        }),
      ],
      [entry({ name: "prod", maskedKey: "sk-...same" })],
    );
    expect(joined[0]!.keys[0]!.name).toBe("prod");
    expect(joined[1]!.keys[0]!.name).toBeUndefined();
  });
  it("ignores an entry whose key is gone: it has no row to be shown on", () => {
    const joined = joinKeyNames(
      [report()],
      [entry({ name: "rotated away", orphaned: true, maskedKey: undefined })],
    );
    expect(joined[0]!.keys[0]!.name).toBeUndefined();
  });

  it("does not mutate the reports it was given", () => {
    const before = report();
    const snapshot = JSON.parse(JSON.stringify(before));
    joinKeyNames([before], [entry({ name: "prod" })]);
    expect(before).toEqual(snapshot);
  });
});

describe("keyMatchesQuery", () => {
  it("matches on the mask, the name and the label", () => {
    const named = key({ maskedKey: "sk-proj...aaaa", name: "prod", label: "team pool" });
    expect(keyMatchesQuery(named, "")).toBe(true);
    expect(keyMatchesQuery(named, "9j0k")).toBe(false);
    expect(keyMatchesQuery(named, "AAAA")).toBe(true);
    expect(keyMatchesQuery(named, "PRO")).toBe(true);
    expect(keyMatchesQuery(named, "team")).toBe(true);
    expect(keyMatchesQuery(named, "nope")).toBe(false);
  });

  it("matches a key that has no name on nothing but its own text", () => {
    expect(keyMatchesQuery(key(), "")).toBe(true);
    expect(keyMatchesQuery(key(), "aaaa")).toBe(true);
    expect(keyMatchesQuery(key(), "prod")).toBe(false);
  });
});

describe("filterKeyFleetReports", () => {
  const reports = [
    report({
      keys: [
        key({ maskedKey: "sk-proj...aaaa", name: "prod", label: "the billing one" }),
        key({ maskedKey: "sk-proj...bbbb", name: "staging", status: "cooldown" }),
      ],
      totalKeys: 2,
      healthyCount: 1,
      cooldownCount: 1,
    }),
  ];

  it("narrows a fleet by a key's NAME, which is the whole point of naming it", () => {
    const found = filterKeyFleetReports(reports, "all", "staging");
    expect(found).toHaveLength(1);
    expect(found[0]!.keys).toHaveLength(1);
    expect(found[0]!.keys[0]!.name).toBe("staging");
  });

  it("narrows by a key's LABEL too", () => {
    const found = filterKeyFleetReports(reports, "all", "billing");
    expect(found[0]!.keys.map((k) => k.name)).toEqual(["prod"]);
  });

  it("still narrows by the mask, as before", () => {
    const found = filterKeyFleetReports(reports, "all", "bbbb");
    expect(found[0]!.keys.map((k) => k.name)).toEqual(["staging"]);
  });

  it("combines the name search with the status filter", () => {
    expect(filterKeyFleetReports(reports, "healthy", "staging")).toHaveLength(0);
    expect(filterKeyFleetReports(reports, "cooldown", "staging")).toHaveLength(1);
  });
});
