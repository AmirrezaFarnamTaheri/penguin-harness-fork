/**
 * Model Token Pricing and Cost Calculator.
 */

import type { TokenCounts } from "../omnimessage/types.js";
import { PROVIDER_ALIASES, normalizeProvider } from "./model-combos.js";

export interface ModelPricingEntry {
  provider: string;
  modelId: string;
  promptPerMillion: number;
  completionPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  reasoningPerMillion?: number;
}

export interface DetailedUsageCounts {
  /**
   * Input tokens that were NOT served from a cached prefix. The runtime's three-bucket
   * convention calls this `cache_write` (see `usageCountsFromTokenCounts`).
   */
  promptTokens: number;
  /**
   * Output tokens: thoughts + response. A provider's separately-reported reasoning tokens
   * are already inside this figure and must not also be priced as `reasoningTokens`.
   */
  completionTokens: number;
  /** Reasoning tokens, only when the provider reports them OUTSIDE `completionTokens`. */
  reasoningTokens?: number;
  /** Input tokens served from a cached prefix, priced at the cache-read rate. */
  cacheReadTokens?: number;
  /** Input tokens written into the cache, priced at the cache-write rate. */
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  /** False means pricing is unavailable; numeric fields are placeholders and must not be presented as known $0 cost. */
  priced: boolean;
  promptCost: number;
  completionCost: number;
  reasoningCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  currency: "USD";
  savingsFromCache: number;
}

export const DEFAULT_PRICING_CATALOG: readonly ModelPricingEntry[] = [
  {
    provider: "anthropic",
    modelId: "claude-3-7-sonnet-20250219",
    promptPerMillion: 3.0,
    completionPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    reasoningPerMillion: 15.0,
  },
  {
    provider: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    promptPerMillion: 3.0,
    completionPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  {
    provider: "anthropic",
    modelId: "claude-3-5-haiku-20241022",
    promptPerMillion: 0.8,
    completionPerMillion: 4.0,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1.0,
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    promptPerMillion: 2.5,
    completionPerMillion: 10.0,
    cacheReadPerMillion: 1.25,
  },
  {
    provider: "openai",
    modelId: "gpt-4o-mini",
    promptPerMillion: 0.15,
    completionPerMillion: 0.6,
    cacheReadPerMillion: 0.075,
  },
  {
    provider: "openai",
    modelId: "o1",
    promptPerMillion: 15.0,
    completionPerMillion: 60.0,
    cacheReadPerMillion: 7.5,
    reasoningPerMillion: 60.0,
  },
  {
    provider: "openai",
    modelId: "o3-mini",
    promptPerMillion: 1.1,
    completionPerMillion: 4.4,
    cacheReadPerMillion: 0.55,
    reasoningPerMillion: 4.4,
  },
  {
    provider: "deepseek",
    modelId: "deepseek-chat",
    promptPerMillion: 0.14,
    completionPerMillion: 0.28,
    cacheReadPerMillion: 0.014,
  },
  {
    provider: "deepseek",
    modelId: "deepseek-reasoner",
    promptPerMillion: 0.55,
    completionPerMillion: 2.19,
    cacheReadPerMillion: 0.14,
    reasoningPerMillion: 2.19,
  },
  {
    provider: "google",
    modelId: "gemini-2.5-pro",
    promptPerMillion: 1.25,
    completionPerMillion: 5.0,
    cacheReadPerMillion: 0.3125,
  },
  {
    provider: "google",
    modelId: "gemini-2.5-flash",
    promptPerMillion: 0.075,
    completionPerMillion: 0.3,
    cacheReadPerMillion: 0.01875,
  },
  {
    provider: "google",
    modelId: "gemini-2.0-flash-thinking-exp",
    promptPerMillion: 0.0,
    completionPerMillion: 0.0,
    reasoningPerMillion: 0.0,
  },
  {
    provider: "google",
    modelId: "gemini-2.0-flash",
    promptPerMillion: 0.1,
    completionPerMillion: 0.4,
    cacheReadPerMillion: 0.025,
  },
  {
    provider: "qwen",
    modelId: "qwen-2.5-coder-32b-instruct",
    promptPerMillion: 0.2,
    completionPerMillion: 0.6,
  },
  {
    provider: "qwen",
    modelId: "qwen-2.5-coder-72b",
    promptPerMillion: 0.4,
    completionPerMillion: 1.2,
  },
  { provider: "qwen", modelId: "qwen-max", promptPerMillion: 1.6, completionPerMillion: 6.4 },
  { provider: "kimi", modelId: "moonshot-v1-8k", promptPerMillion: 1.2, completionPerMillion: 1.2 },
  {
    provider: "kimi",
    modelId: "moonshot-v1-32k",
    promptPerMillion: 2.4,
    completionPerMillion: 2.4,
  },
  { provider: "kimi", modelId: "kimi-k1.5", promptPerMillion: 1.5, completionPerMillion: 4.5 },
  { provider: "xai", modelId: "grok-2", promptPerMillion: 2.0, completionPerMillion: 10.0 },
  { provider: "xai", modelId: "grok-3", promptPerMillion: 3.0, completionPerMillion: 15.0 },
  {
    provider: "ollama",
    modelId: "qwen2.5-coder:32b",
    promptPerMillion: 0.0,
    completionPerMillion: 0.0,
  },
  { provider: "local", modelId: "local-model", promptPerMillion: 0.0, completionPerMillion: 0.0 },
];

/**
 * A version tail: an optional separator then a digit, optionally preceded by `v`
 * (`-2024-08-06`, `:v3`, `.1`, `/002`). Sibling models that differ by a word —
 * `gpt-4o` vs `gpt-4o-mini` — do not qualify, so they stay unpriced rather than being
 * priced at a relative's rate.
 */
const VERSION_TAIL_RE = /^[-:.\/]?v?\d/;

/**
 * True only when `candidate` is `base` plus a version tail. The strict direction matters:
 * a short id can never be a variant of a longer catalog id, which is what used to land
 * `google/2.0` on the zero-priced experimental entry.
 */
function isVersionedVariantOf(candidate: string, base: string): boolean {
  return (
    candidate.length > base.length &&
    candidate.startsWith(base) &&
    VERSION_TAIL_RE.test(candidate.slice(base.length))
  );
}

/**
 * The runtime's token convention and this catalog's are not interchangeable.
 *
 * `usageToTokenCounts` (generative-model.ts, mirrored by state/model-catalog.ts) produces
 * three buckets — `cache_read`, `cache_write`, `output` — while this catalog prices five.
 * Every plausible hand-translation double-bills something:
 *   - passing total input as `promptTokens` bills the cached prefix once at the prompt rate
 *     and again at the cache-read rate;
 *   - passing reasoning tokens that are already inside `completionTokens` (OpenAI's
 *     `completion_tokens_details` convention) bills the thoughts twice.
 *
 * This is the only mapping that preserves the one-to-one property — each of the three
 * buckets lands in exactly one of the five:
 *
 *   promptTokens     = cache_write   input tokens on a cache miss
 *   cacheReadTokens  = cache_read    input tokens served from a cached prefix
 *   completionTokens = output        thoughts + response, reasoning already inside
 *   reasoningTokens  = 0             already counted in `output`
 *   cacheWriteTokens = 0             `cache_write` is the miss count, not a second input batch
 *
 * `calculateCost` and `POST /cost` expect disjoint buckets. A caller whose provider reports
 * `promptTokens` as total input must subtract `cacheReadTokens` (and any separately reported
 * `cacheWriteTokens`) before passing the counts. Forwarding the provider's total input together
 * with cached counts would bill those tokens twice.
 */
export function usageCountsFromTokenCounts(counts: TokenCounts): DetailedUsageCounts {
  return {
    promptTokens: counts.cache_write,
    completionTokens: counts.output,
    cacheReadTokens: counts.cache_read,
    reasoningTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * The provider spellings worth trying against the default catalog: the name as given and
 * its alias-normalised form, plus any alias whose canonical name is that form.
 *
 * The catalog keys some providers by their alias (`kimi`, `qwen`) and others by their
 * canonical name, so a lookup has to work from either direction: `resolve("moonshotai", …)`
 * has to reach the `kimi` entry, and `resolve("kimi", …)` must not lose the alias spelling
 * it already matched. A provider that is itself canonical collapses to one spelling.
 */
function providerSpellings(provider: string): string[] {
  const lowered = provider.toLowerCase();
  const canonical = normalizeProvider(lowered);
  const spellings = new Set<string>([lowered, canonical]);
  for (const [alias, canonicalName] of Object.entries(PROVIDER_ALIASES)) {
    if (canonicalName === lowered || canonicalName === canonical) spellings.add(alias);
  }
  return [...spellings];
}

/**
 * Coerces one token count to a non-negative finite number, or returns undefined to signal
 * that the input cannot be priced. `undefined` (an omitted optional field) is 0; NaN,
 * Infinity and negatives cannot produce a billable figure.
 */
function sanitiseTokenCount(count: number | undefined): number | undefined {
  if (count === undefined) return 0;
  if (!Number.isFinite(count) || count < 0) return undefined;
  return count;
}

export class PricingCatalog {
  private customPricing = new Map<string, ModelPricingEntry>();

  constructor(customEntries?: ModelPricingEntry[]) {
    if (customEntries) {
      for (const entry of customEntries) {
        this.customPricing.set(`${entry.provider}:${entry.modelId}`.toLowerCase(), entry);
      }
    }
  }

  setOverride(entry: ModelPricingEntry): void {
    this.customPricing.set(`${entry.provider}:${entry.modelId}`.toLowerCase(), entry);
  }

  resolve(provider: string, modelId: string): ModelPricingEntry | undefined {
    const key = `${provider}:${modelId}`.toLowerCase();
    const custom = this.customPricing.get(key);
    if (custom) return custom;

    // The catalog keys some providers by their alias (`kimi`, `qwen`) while
    // `PROVIDER_ALIASES` in model-combos.ts maps those to canonical names (`moonshotai`,
    // `alibaba`). A caller that normalises through the alias table first used to miss an
    // entry the catalog does list, and was reported unpriced; both spellings are therefore
    // tried. An override is keyed by the exact pair the caller supplied, which is why the
    // alias pass runs on the default catalog only.
    const requested = modelId.toLowerCase();
    for (const spelling of providerSpellings(provider)) {
      const exact = DEFAULT_PRICING_CATALOG.find(
        (entry) =>
          entry.provider.toLowerCase() === spelling && entry.modelId.toLowerCase() === requested,
      );
      if (exact) return exact;
    }

    // Fallback: the requested id is a *versioned variant* of a catalog id — the same base
    // model carrying a version or snapshot tail (`gpt-4o` → `gpt-4o-2024-08-06`). A bare
    // substring is deliberately not accepted: a short or fragmentary id would otherwise
    // resolve to an unrelated tier, and possibly to a zero-priced experimental entry, and
    // `calculateCost` would report that as a real priced $0.00. An id that is not an exact
    // match and not a versioned variant resolves to undefined, i.e. unpriced — the honest
    // answer when the catalog cannot identify the model.
    for (const spelling of providerSpellings(provider)) {
      const variant = DEFAULT_PRICING_CATALOG.find(
        (entry) =>
          entry.provider.toLowerCase() === spelling &&
          isVersionedVariantOf(requested, entry.modelId.toLowerCase()),
      );
      if (variant) return variant;
    }
    return undefined;
  }

  calculateCost(provider: string, modelId: string, usage: DetailedUsageCounts): CostBreakdown {
    const pricing = this.resolve(provider, modelId);
    if (!pricing) {
      return {
        priced: false,
        promptCost: 0,
        completionCost: 0,
        reasoningCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        totalCost: 0,
        currency: "USD",
        savingsFromCache: 0,
      };
    }

    const promptTokens = sanitiseTokenCount(usage.promptTokens);
    const completionTokens = sanitiseTokenCount(usage.completionTokens);
    const reasoningTokens = sanitiseTokenCount(usage.reasoningTokens);
    const cacheReadTokens = sanitiseTokenCount(usage.cacheReadTokens);
    const cacheWriteTokens = sanitiseTokenCount(usage.cacheWriteTokens);

    // A non-finite or negative count makes the breakdown meaningless. This fails closed for a
    // billable figure: the caller gets the unpriced shape (`priced: false`, all zeros) instead
    // of a NaN that JSON-serialises as `null` into a field declared `number`, or a negative
    // component that makes `totalCost` mean something other than spend. Clamping to 0 would
    // under-report, so the request is refused rather than approximated.
    if (
      promptTokens === undefined ||
      completionTokens === undefined ||
      reasoningTokens === undefined ||
      cacheReadTokens === undefined ||
      cacheWriteTokens === undefined
    ) {
      return {
        priced: false,
        promptCost: 0,
        completionCost: 0,
        reasoningCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        totalCost: 0,
        currency: "USD",
        savingsFromCache: 0,
      };
    }

    const promptCost = (promptTokens / 1_000_000) * pricing.promptPerMillion;
    const completionCost = (completionTokens / 1_000_000) * pricing.completionPerMillion;
    const reasoningCost =
      (reasoningTokens / 1_000_000) * (pricing.reasoningPerMillion ?? pricing.completionPerMillion);
    const cacheReadCost =
      (cacheReadTokens / 1_000_000) *
      (pricing.cacheReadPerMillion ?? pricing.promptPerMillion * 0.1);
    const cacheWriteCost =
      (cacheWriteTokens / 1_000_000) *
      (pricing.cacheWritePerMillion ?? pricing.promptPerMillion * 1.25);
    const fullUncachedCost =
      ((promptTokens + cacheReadTokens) / 1_000_000) * pricing.promptPerMillion;
    const savingsFromCache = Math.max(0, fullUncachedCost - (promptCost + cacheReadCost));
    const totalCost = promptCost + completionCost + reasoningCost + cacheReadCost + cacheWriteCost;

    return {
      priced: true,
      promptCost,
      completionCost,
      reasoningCost,
      cacheReadCost,
      cacheWriteCost,
      totalCost,
      currency: "USD",
      savingsFromCache,
    };
  }

  formatCost(costUsd: number, priced = true): string {
    if (!priced) return "Unknown";
    if (costUsd === 0) return "$0.00";
    if (costUsd < 0.0001) return "< $0.0001";
    if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
    return `$${costUsd.toFixed(3)}`;
  }
}
