/**
 * PricingCatalog: model resolution and the /cost arithmetic.
 *
 * `calculateCost` feeds the live `POST /cost` endpoint, so every figure below is hand-computed
 * from the formula in `pricing-catalog.ts` and asserted as a real dollar amount — not compared
 * to another call's output. The fallback rates are the interesting half: when a catalog entry
 * omits the cache/reasoning columns, the code invents them from the prompt price
 * (cache write = 1.25x prompt, cache read = 0.1x prompt, reasoning = completion).
 *
 * `resolve` also has a fuzzy substring fallback with no exact-match guard, and its behaviour is
 * pinned explicitly further down: the fallback is symmetric and first-wins, so a short model id
 * can silently resolve to an unrelated cheaper tier (and even to a zero-priced entry). Those
 * cases are documented, not endorsed — a change to the fallback should come here and be
 * deliberate.
 */
import { describe, expect, it } from "vitest";
import { PricingCatalog } from "../src/llm/index.js";
import type { DetailedUsageCounts } from "../src/llm/index.js";

describe("PricingCatalog.resolve", () => {
  it("resolves an exact provider + model pair from the default catalog", () => {
    const catalog = new PricingCatalog();
    expect(catalog.resolve("openai", "gpt-4o")).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      promptPerMillion: 2.5,
      completionPerMillion: 10.0,
      cacheReadPerMillion: 1.25,
    });
    expect(catalog.resolve("anthropic", "claude-3-7-sonnet-20250219")?.reasoningPerMillion).toBe(
      15.0,
    );
  });

  it("matches the provider and model case-insensitively", () => {
    const catalog = new PricingCatalog();
    // The gateway takes provider/model straight off the request body, which arrives in any case.
    expect(catalog.resolve("OpenAI", "GPT-4O")?.modelId).toBe("gpt-4o");
    expect(catalog.resolve("GOOGLE", "gemini-2.5-flash")?.promptPerMillion).toBe(0.075);
    expect(catalog.resolve("Anthropic", "CLAUDE-3-5-HAIKU-20241022")?.completionPerMillion).toBe(
      4.0,
    );
  });

  it("prefers a custom override over the default catalog and keys it case-insensitively", () => {
    const catalog = new PricingCatalog();
    catalog.setOverride({
      provider: "openai",
      modelId: "gpt-4o",
      promptPerMillion: 100.0,
      completionPerMillion: 200.0,
    });
    // The override wins over the catalog's exact 2.5 / 10.0 entry.
    expect(catalog.resolve("openai", "gpt-4o")).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
      promptPerMillion: 100.0,
      completionPerMillion: 200.0,
    });
    // The custom key is lowercased on insert, so any-case lookup reaches it.
    expect(catalog.resolve("OPENAI", "GPT-4O")?.promptPerMillion).toBe(100.0);
  });

  it("leaves an unknown provider unpriced rather than guessing a model", () => {
    const catalog = new PricingCatalog();
    // No catalog entry carries this provider, so neither the exact nor the fuzzy pass can match.
    expect(catalog.resolve("unknown-provider", "unknown-model")).toBeUndefined();
    expect(catalog.resolve("acme", "gpt-4o")).toBeUndefined();
  });
});

describe("PricingCatalog resolution fuzz (documented over-match)", () => {
  // The fuzzy pass is a symmetric substring test with no length or boundary guard, and `find`
  // returns the first catalog entry that matches. Each case below is what the code does today;
  // the hazard is that a short id silently lands on a different — usually cheaper — tier.
  const catalog = new PricingCatalog();

  it("resolves a versioned snapshot id down to its base model", () => {
    // The intended use of the fallback: modelId CONTAINS the catalog id.
    expect(catalog.resolve("openai", "gpt-4o-2024-08-06")?.modelId).toBe("gpt-4o");
  });

  it("resolves a short fragment to the first catalog model containing it", () => {
    // "flash" is contained in "gemini-2.5-flash" — the first google entry that matches.
    expect(catalog.resolve("google", "flash")?.modelId).toBe("gemini-2.5-flash");
    expect(catalog.resolve("openai", "mini")?.modelId).toBe("gpt-4o-mini");
  });

  it("matches a single-letter fragment, landing on an unrelated cheaper tier", () => {
    // "o" is contained in "gpt-4o", which precedes "o1" in the catalog — so this resolves to
    // gpt-4o at $2.50/$10 per million, not o1 at $15/$60. A wrong tier, chosen silently.
    const resolved = catalog.resolve("openai", "o");
    expect(resolved?.modelId).toBe("gpt-4o");
    expect(resolved?.promptPerMillion).toBe(2.5);
    expect(resolved?.completionPerMillion).toBe(10.0);
  });

  it("can resolve to a zero-priced catalog entry, hiding the cost entirely", () => {
    // "2.0" first matches the free experimental model, so a real billable request prices at $0.
    const resolved = catalog.resolve("google", "2.0");
    expect(resolved?.modelId).toBe("gemini-2.0-flash-thinking-exp");
    expect(resolved?.promptPerMillion).toBe(0.0);
  });

  it("takes the first of several substring matches, not the closest", () => {
    // Both qwen coder models contain "coder"; the 32b precedes the 72b in the catalog.
    expect(catalog.resolve("qwen", "coder")?.modelId).toBe("qwen-2.5-coder-32b-instruct");
  });

  it("never crosses providers, even when the model id is a substring", () => {
    // The provider clause is load-bearing: dropping it would route anthropic/gpt-4o to openai's
    // entry through the fuzzy pass.
    expect(catalog.resolve("anthropic", "gpt-4o")).toBeUndefined();
  });
});

describe("PricingCatalog.calculateCost", () => {
  it("costs every field at the catalog rate when the entry has them all", () => {
    // claude-3-7-sonnet: prompt 3.0, completion 15.0, cacheRead 0.3, cacheWrite 3.75, reasoning 15.0
    //   prompt      = 2_000_000 / 1e6 * 3.0  = 6.0
    //   completion  = 1_000_000 / 1e6 * 15.0 = 15.0
    //   reasoning   =   400_000 / 1e6 * 15.0 = 6.0
    //   cacheRead   = 1_000_000 / 1e6 * 0.3  = 0.3
    //   cacheWrite  =   500_000 / 1e6 * 3.75 = 1.875
    //   fullUncached = (2_000_000 + 1_000_000) / 1e6 * 3.0 = 9.0
    //   savings     = max(0, 9.0 - (6.0 + 0.3)) = 2.7
    //   total       = 6.0 + 15.0 + 6.0 + 0.3 + 1.875 = 29.175
    const catalog = new PricingCatalog();
    const usage: DetailedUsageCounts = {
      promptTokens: 2_000_000,
      completionTokens: 1_000_000,
      reasoningTokens: 400_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 500_000,
    };
    expect(catalog.calculateCost("anthropic", "claude-3-7-sonnet-20250219", usage)).toEqual({
      priced: true,
      promptCost: 6.0,
      completionCost: 15.0,
      reasoningCost: 6.0,
      cacheReadCost: 0.3,
      cacheWriteCost: 1.875,
      totalCost: 29.175,
      currency: "USD",
      savingsFromCache: 2.7,
    });
  });

  it("costs an entry that defines only prompt and completion rates", () => {
    // gpt-4o: prompt 2.5, completion 10.0, cacheRead 1.25 — no cacheWrite, no reasoning column.
    //   prompt      = 1_000_000 / 1e6 * 2.5 = 2.5
    //   completion  =   500_000 / 1e6 * 10  = 5.0
    //   reasoning   = 0 tokens              = 0
    //   cacheRead   =   200_000 / 1e6 * 1.25 = 0.25
    //   cacheWrite  = 100_000 / 1e6 * (2.5 * 1.25) = 0.1 * 3.125 = 0.3125   <- the 1.25x fallback
    //   fullUncached = 1_200_000 / 1e6 * 2.5 = 3.0
    //   savings     = max(0, 3.0 - (2.5 + 0.25)) = 0.25
    //   total       = 2.5 + 5.0 + 0 + 0.25 + 0.3125 = 8.0625
    const catalog = new PricingCatalog();
    const cost = catalog.calculateCost("openai", "gpt-4o", {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 100_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.promptCost).toBe(2.5);
    expect(cost.completionCost).toBe(5.0);
    expect(cost.reasoningCost).toBe(0);
    expect(cost.cacheReadCost).toBe(0.25);
    // cacheWritePerMillion is absent, so it falls back to 1.25x the prompt rate.
    expect(cost.cacheWriteCost).toBe(0.3125);
    expect(cost.totalCost).toBe(8.0625);
    expect(cost.savingsFromCache).toBe(0.25);
    expect(cost.currency).toBe("USD");
  });

  it("falls back to prompt*1.25 for cache write and prompt*0.1 for cache read when both are absent", () => {
    // qwen-max is the sparsest shape in the catalog: prompt 1.6, completion 6.4, nothing else.
    // Every optional column is synthesized:
    //   reasoning   = 300_000 / 1e6 * 6.4            = 1.92     <- reasoning ?? completion
    //   cacheRead   = 500_000 / 1e6 * (1.6 * 0.1)    = 0.08     <- cacheRead ?? prompt * 0.1
    //   cacheWrite  = 200_000 / 1e6 * (1.6 * 1.25)   = 0.4      <- cacheWrite ?? prompt * 1.25
    //   fullUncached = 1_500_000 / 1e6 * 1.6 = 2.4
    //   savings     = max(0, 2.4 - (1.6 + 0.08)) = 0.72
    //   total       = 1.6 + 6.4 + 1.92 + 0.08 + 0.4 = 10.4
    const catalog = new PricingCatalog();
    const cost = catalog.calculateCost("qwen", "qwen-max", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      reasoningTokens: 300_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 200_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.promptCost).toBe(1.6);
    expect(cost.completionCost).toBe(6.4);
    expect(cost.reasoningCost).toBe(1.92);
    expect(cost.cacheReadCost).toBeCloseTo(0.08, 10);
    expect(cost.cacheWriteCost).toBe(0.4);
    expect(cost.totalCost).toBeCloseTo(10.4, 10);
    expect(cost.savingsFromCache).toBeCloseTo(0.72, 10);
  });

  it("reports zero cost when every rate is zero, and prices it as a real $0.00", () => {
    // The experimental google model has 0.0 rates: a priced breakdown whose total is genuinely
    // zero — not an unpriced model. savings is 0 because there is nothing to save.
    const catalog = new PricingCatalog();
    const cost = catalog.calculateCost("google", "gemini-2.0-flash-thinking-exp", {
      promptTokens: 5_000_000,
      completionTokens: 1_000_000,
      reasoningTokens: 500_000,
    });
    expect(cost).toEqual({
      priced: true,
      promptCost: 0,
      completionCost: 0,
      reasoningCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      currency: "USD",
      savingsFromCache: 0,
    });
  });

  it("clamps savingsFromCache at zero when cached input costs more than uncached input", () => {
    // An override where cache reads are pricier than fresh prompts (10x here). The naive
    // subtraction would go negative; Math.max keeps it at 0.
    //   prompt      = 1_000_000 / 1e6 * 1.0 = 1.0
    //   cacheRead   = 1_000_000 / 1e6 * 10  = 10.0
    //   fullUncached = 2_000_000 / 1e6 * 1.0 = 2.0
    //   savings     = max(0, 2.0 - (1.0 + 10.0)) = max(0, -9.0) = 0
    //   total       = 1.0 + 0 + 0 + 10.0 + 0 = 11.0
    const catalog = new PricingCatalog();
    catalog.setOverride({
      provider: "openai",
      modelId: "gpt-4o",
      promptPerMillion: 1.0,
      completionPerMillion: 2.0,
      cacheReadPerMillion: 10.0,
    });
    const cost = catalog.calculateCost("openai", "gpt-4o", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.promptCost).toBe(1.0);
    expect(cost.cacheReadCost).toBe(10.0);
    expect(cost.savingsFromCache).toBe(0);
    expect(cost.totalCost).toBe(11.0);
  });

  it("charges the override's rates, not the catalog's, through the cost path", () => {
    // Same tokens as the gpt-4o case above, but the override retires it to 1.0 / 2.0.
    const catalog = new PricingCatalog();
    catalog.setOverride({
      provider: "openai",
      modelId: "gpt-4o",
      promptPerMillion: 1.0,
      completionPerMillion: 2.0,
    });
    const cost = catalog.calculateCost("openai", "gpt-4o", {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
    });
    expect(cost.promptCost).toBe(1.0);
    expect(cost.completionCost).toBe(1.0);
    expect(cost.totalCost).toBe(2.0);
    // No cache columns on the override and no cache tokens: both fallbacks contribute zero.
    expect(cost.savingsFromCache).toBe(0);
  });

  it("reports unpriced zeros for a model the catalog cannot resolve", () => {
    const catalog = new PricingCatalog();
    const cost = catalog.calculateCost("unknown-provider", "unknown-model", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toEqual({
      priced: false,
      promptCost: 0,
      completionCost: 0,
      reasoningCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      currency: "USD",
      savingsFromCache: 0,
    });
    // `priced: false` is the caller's signal that these zeros mean "unknown", not "free".
    expect(catalog.formatCost(cost.totalCost, cost.priced)).toBe("Unknown");
  });
});

describe("PricingCatalog.formatCost", () => {
  const catalog = new PricingCatalog();

  it("renders known amounts with three decimals, or four below a cent", () => {
    expect(catalog.formatCost(8.0625)).toBe("$8.063");
    expect(catalog.formatCost(12.5)).toBe("$12.500");
    expect(catalog.formatCost(0.0009)).toBe("$0.0009");
    expect(catalog.formatCost(0.00001)).toBe("< $0.0001");
  });

  it("renders an exact zero as $0.00 and never renders an unpriced amount", () => {
    expect(catalog.formatCost(0)).toBe("$0.00");
    expect(catalog.formatCost(0, false)).toBe("Unknown");
    expect(catalog.formatCost(12.5, false)).toBe("Unknown");
  });
});
