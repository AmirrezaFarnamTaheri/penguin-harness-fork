/**
 * Model Token Pricing and Cost Calculator.
 */

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
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
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
  { provider: "anthropic", modelId: "claude-3-7-sonnet-20250219", promptPerMillion: 3.0, completionPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75, reasoningPerMillion: 15.0 },
  { provider: "anthropic", modelId: "claude-3-5-sonnet-20241022", promptPerMillion: 3.0, completionPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  { provider: "anthropic", modelId: "claude-3-5-haiku-20241022", promptPerMillion: 0.8, completionPerMillion: 4.0, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1.0 },
  { provider: "openai", modelId: "gpt-4o", promptPerMillion: 2.5, completionPerMillion: 10.0, cacheReadPerMillion: 1.25 },
  { provider: "openai", modelId: "gpt-4o-mini", promptPerMillion: 0.15, completionPerMillion: 0.6, cacheReadPerMillion: 0.075 },
  { provider: "openai", modelId: "o1", promptPerMillion: 15.0, completionPerMillion: 60.0, cacheReadPerMillion: 7.5, reasoningPerMillion: 60.0 },
  { provider: "openai", modelId: "o3-mini", promptPerMillion: 1.1, completionPerMillion: 4.4, cacheReadPerMillion: 0.55, reasoningPerMillion: 4.4 },
  { provider: "deepseek", modelId: "deepseek-chat", promptPerMillion: 0.14, completionPerMillion: 0.28, cacheReadPerMillion: 0.014 },
  { provider: "deepseek", modelId: "deepseek-reasoner", promptPerMillion: 0.55, completionPerMillion: 2.19, cacheReadPerMillion: 0.14, reasoningPerMillion: 2.19 },
  { provider: "google", modelId: "gemini-2.5-pro", promptPerMillion: 1.25, completionPerMillion: 5.0, cacheReadPerMillion: 0.3125 },
  { provider: "google", modelId: "gemini-2.5-flash", promptPerMillion: 0.075, completionPerMillion: 0.3, cacheReadPerMillion: 0.01875 },
  { provider: "google", modelId: "gemini-2.0-flash-thinking-exp", promptPerMillion: 0.0, completionPerMillion: 0.0, reasoningPerMillion: 0.0 },
  { provider: "google", modelId: "gemini-2.0-flash", promptPerMillion: 0.1, completionPerMillion: 0.4, cacheReadPerMillion: 0.025 },
  { provider: "qwen", modelId: "qwen-2.5-coder-32b-instruct", promptPerMillion: 0.2, completionPerMillion: 0.6 },
  { provider: "qwen", modelId: "qwen-2.5-coder-72b", promptPerMillion: 0.4, completionPerMillion: 1.2 },
  { provider: "qwen", modelId: "qwen-max", promptPerMillion: 1.6, completionPerMillion: 6.4 },
  { provider: "kimi", modelId: "moonshot-v1-8k", promptPerMillion: 1.2, completionPerMillion: 1.2 },
  { provider: "kimi", modelId: "moonshot-v1-32k", promptPerMillion: 2.4, completionPerMillion: 2.4 },
  { provider: "kimi", modelId: "kimi-k1.5", promptPerMillion: 1.5, completionPerMillion: 4.5 },
  { provider: "xai", modelId: "grok-2", promptPerMillion: 2.0, completionPerMillion: 10.0 },
  { provider: "xai", modelId: "grok-3", promptPerMillion: 3.0, completionPerMillion: 15.0 },
  { provider: "ollama", modelId: "qwen2.5-coder:32b", promptPerMillion: 0.0, completionPerMillion: 0.0 },
  { provider: "local", modelId: "local-model", promptPerMillion: 0.0, completionPerMillion: 0.0 },
];

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

    const exact = DEFAULT_PRICING_CATALOG.find(
      (entry) => entry.provider.toLowerCase() === provider.toLowerCase() && entry.modelId.toLowerCase() === modelId.toLowerCase(),
    );
    if (exact) return exact;

    return DEFAULT_PRICING_CATALOG.find(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        (modelId.toLowerCase().includes(entry.modelId.toLowerCase()) || entry.modelId.toLowerCase().includes(modelId.toLowerCase())),
    );
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

    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;
    const reasoningTokens = usage.reasoningTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

    const promptCost = (promptTokens / 1_000_000) * pricing.promptPerMillion;
    const completionCost = (completionTokens / 1_000_000) * pricing.completionPerMillion;
    const reasoningCost = (reasoningTokens / 1_000_000) * (pricing.reasoningPerMillion ?? pricing.completionPerMillion);
    const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.promptPerMillion * 0.1);
    const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMillion ?? pricing.promptPerMillion * 1.25);
    const fullUncachedCost = ((promptTokens + cacheReadTokens) / 1_000_000) * pricing.promptPerMillion;
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
