/**
 * PricingCatalog: the paths the sibling file (`test/pricing-catalog.test.ts`) does not reach.
 *
 * That file covers resolve's exact/custom/fuzzy cases and the cost arithmetic for entries with
 * every column shape. This one covers what is left: the constructor's `customEntries` path, the
 * interaction of overrides with the fuzzy pass, the boundaries of `formatCost`, the provider-key
 * bridge against `model-combos.ts`'s alias table, and the class API's token-count validation
 * (the `POST /cost` endpoint validates with `tokenCount()` in
 * `packages/server/src/http/routes/gateway.ts`; the class now fails closed on its own).
 *
 * As with the sibling file, behaviours that are hazards rather than features are pinned as what
 * the code does today and labelled in the comment — a change to any of them should come through
 * here deliberately.
 */
import { describe, expect, it } from "vitest";
import { PricingCatalog } from "../../src/llm/pricing-catalog.js";
import type { DetailedUsageCounts } from "../../src/llm/pricing-catalog.js";

describe("PricingCatalog: constructor custom entries", () => {
  it("resolves a custom entry supplied through the constructor, keyed case-insensitively", () => {
    // The ctor lowercases `${provider}:${modelId}` on insert, the same as setOverride.
    const catalog = new PricingCatalog([
      {
        provider: "Kimi",
        modelId: "MOONSHOT-V1-8K",
        promptPerMillion: 9,
        completionPerMillion: 9,
      },
    ]);
    expect(catalog.resolve("kimi", "moonshot-v1-8k")).toEqual({
      provider: "Kimi",
      modelId: "MOONSHOT-V1-8K",
      promptPerMillion: 9,
      completionPerMillion: 9,
    });
    // The lookup is case-insensitive from either direction.
    expect(catalog.resolve("KIMI", "Moonshot-v1-8k")?.promptPerMillion).toBe(9);
  });

  it("prefers a constructor entry over the same-shaped default entry", () => {
    // "kimi/moonshot-v1-8k" is in the default catalog at 1.2/1.2; the ctor entry replaces it
    // rather than being shadowed by it.
    const catalog = new PricingCatalog([
      { provider: "kimi", modelId: "moonshot-v1-8k", promptPerMillion: 5, completionPerMillion: 5 },
    ]);
    expect(catalog.resolve("kimi", "moonshot-v1-8k")?.promptPerMillion).toBe(5);
  });
});

describe("PricingCatalog: overrides and the fuzzy pass", () => {
  it("does not extend an override to a versioned id that only the fuzzy pass matches", () => {
    // The custom map is keyed by the exact `${provider}:${modelId}` pair, so an override on
    // gpt-4o is found only by an exact lookup. A versioned snapshot reaches gpt-4o through the
    // substring fallback, which reads the default catalog — the caller's override rate never
    // applies to it. Pinned: an override and a fuzzy match are two different resolution paths.
    const catalog = new PricingCatalog();
    catalog.setOverride({
      provider: "openai",
      modelId: "gpt-4o",
      promptPerMillion: 100,
      completionPerMillion: 200,
    });
    expect(catalog.resolve("openai", "gpt-4o")?.promptPerMillion).toBe(100);
    expect(catalog.resolve("openai", "gpt-4o-2024-08-06")?.promptPerMillion).toBe(2.5);
  });

  it("refuses a fragment that used to resolve to a zero-priced entry", () => {
    // The fuzzy pass used to reach the free experimental model first and calculateCost
    // reported priced: true, so a billable-looking request surfaced a genuine $0.00 instead
    // of "unknown". The fallback now accepts only a versioned variant of a catalog id, so
    // "2.0" resolves to nothing and the request is reported unpriced — the honest answer.
    const catalog = new PricingCatalog();
    expect(catalog.resolve("google", "2.0")).toBeUndefined();
    expect(
      catalog.calculateCost("google", "2.0", {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      }).priced,
    ).toBe(false);
  });
});

describe("PricingCatalog: provider keys vs the alias table", () => {
  it("prices a kimi entry under its catalog key and under its canonical alias", () => {
    // model-combos.ts maps `kimi -> moonshotai` in PROVIDER_ALIASES, but the catalog lists
    // the provider as `kimi`. A caller that normalises through the alias table first used
    // to find no entry and was reported unpriced for a model the catalog does list; resolve
    // now tries both spellings, so the catalog key and the canonical name both reach it.
    const catalog = new PricingCatalog();
    expect(catalog.resolve("kimi", "moonshot-v1-8k")?.promptPerMillion).toBe(1.2);
    expect(catalog.resolve("moonshotai", "moonshot-v1-8k")?.promptPerMillion).toBe(1.2);
    // The provider clause still gates the match, so this is a key-space bridge, not a
    // fuzzy free-for-all: a model the catalog does not list stays unpriced.
    expect(
      catalog.calculateCost("moonshotai", "moonshot-v1-8k", {
        promptTokens: 1,
        completionTokens: 1,
      }).priced,
    ).toBe(true);
    expect(catalog.resolve("moonshotai", "not-a-real-model")).toBeUndefined();
  });

  it("reaches a canonical-keyed entry from its alias too", () => {
    // The bridge works in the other direction: `gemini` is an alias of `google`, and the
    // catalog keys Gemini entries under the canonical `google`.
    const catalog = new PricingCatalog();
    expect(catalog.resolve("google", "gemini-2.0-flash")?.provider).toBe("google");
    expect(catalog.resolve("gemini", "gemini-2.0-flash")?.provider).toBe("google");
  });
});

describe("PricingCatalog.calculateCost: token-count validation", () => {
  // The class used to multiply every field straight through, so a negative count produced a
  // negative component and a NaN propagated into fields declared `number` (serialising as
  // `null`). The live endpoint guards at the boundary (`tokenCount` rejects non-safe-integers
  // and negatives); the class now fails closed too — a count that cannot produce a billable
  // figure yields the unpriced shape with all zeros rather than a number that does not mean
  // spend. Clamping to 0 would under-report, so the request is refused, not approximated.
  const catalog = new PricingCatalog();

  it("refuses a negative count instead of costing it into a negative component", () => {
    const cost = catalog.calculateCost("openai", "gpt-4o", {
      promptTokens: -1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost.priced).toBe(false);
    expect(cost.promptCost).toBe(0);
    expect(cost.completionCost).toBe(0);
    expect(cost.totalCost).toBe(0);
  });

  it("refuses a NaN count instead of propagating it into the breakdown", () => {
    // A NaN used to surface on every field that depends on it (and serialise as `null`).
    const cost = catalog.calculateCost("openai", "gpt-4o", {
      promptTokens: Number.NaN,
      completionTokens: 1_000_000,
    });
    expect(cost.priced).toBe(false);
    expect(cost.totalCost).toBe(0);
    expect(cost.savingsFromCache).toBe(0);
  });

  it("accepts fractional counts, which the endpoint's safe-integer guard would reject", () => {
    // 0.5 prompt tokens: 0.5/1e6 * 2.5 = 1.25e-6. The arithmetic is exact enough to assert.
    const cost = catalog.calculateCost("openai", "gpt-4o", {
      promptTokens: 0.5,
      completionTokens: 1_000_000,
    });
    expect(cost.promptCost).toBeCloseTo(0.00000125, 12);
    expect(cost.totalCost).toBeCloseTo(10.00000125, 10);
  });
});

describe("PricingCatalog.calculateCost: bucket contract", () => {
  const catalog = new PricingCatalog();

  it("sums the five priced buckets into the total", () => {
    // The buckets are additive by construction: totalCost is a plain sum, so the invariant
    // holds for any resolved entry and any token shape.
    const cost = catalog.calculateCost("anthropic", "claude-3-7-sonnet-20250219", {
      promptTokens: 2_000_000,
      completionTokens: 1_000_000,
      reasoningTokens: 400_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 500_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.totalCost).toBeCloseTo(
      cost.promptCost +
        cost.completionCost +
        cost.reasoningCost +
        cost.cacheReadCost +
        cost.cacheWriteCost,
      10,
    );
  });

  it("treats promptTokens as uncached input: savings is the cache-read delta only", () => {
    // 1M uncached prompt tokens at 3.0 = 3.0; 500k cache-read tokens at 0.3 = 0.15. Had the
    // 500k been counted as prompt tokens too, the input would bill 4.65 instead of 3.15 — the
    // cached tokens would be priced once at the prompt rate and again at the cache-read rate.
    // Pinned so the bucket convention stays explicit: promptTokens must exclude cached input.
    const usage: DetailedUsageCounts = {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 500_000,
    };
    const cost = catalog.calculateCost("anthropic", "claude-3-7-sonnet-20250219", usage);
    expect(cost.promptCost).toBe(3.0);
    expect(cost.cacheReadCost).toBeCloseTo(0.15, 10);
    expect(cost.totalCost).toBeCloseTo(3.15, 10);
    // fullUncached = (1M + 500k)/1M * 3.0 = 4.5; savings = max(0, 4.5 - (3.0 + 0.15)) = 1.35.
    expect(cost.savingsFromCache).toBeCloseTo(1.35, 10);
  });
});

describe("PricingCatalog.formatCost: boundaries", () => {
  const catalog = new PricingCatalog();

  it("keeps an amount at exactly the sub-milli threshold on the four-digit side", () => {
    // The comparison is strict: 0.0001 itself renders with four decimals, not as "< $0.0001".
    expect(catalog.formatCost(0.0001)).toBe("$0.0001");
    expect(catalog.formatCost(0.00009999)).toBe("< $0.0001");
  });

  it("switches to three decimals at exactly one cent", () => {
    expect(catalog.formatCost(0.0099)).toBe("$0.0099");
    expect(catalog.formatCost(0.01)).toBe("$0.010");
    expect(catalog.formatCost(12.5)).toBe("$12.500");
  });

  it("renders a negative amount as a sub-milli positive, hiding the sign", () => {
    // Nothing in formatCost guards the negative direction: -2.5 is below 0.0001, so it takes the
    // "< $0.0001" branch and reads as nearly free rather than as a negative amount. Reachable
    // only through an unvalidated negative token count (see the unvalidated-counts suite), but
    // the rendering makes the result look benign instead of wrong. Pinned as current behaviour.
    expect(catalog.formatCost(-2.5)).toBe("< $0.0001");
    expect(catalog.formatCost(-0.00001)).toBe("< $0.0001");
  });
});
