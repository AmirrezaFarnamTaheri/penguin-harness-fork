/**
 * Model Combos (Fusion Fallback Cascades).
 * Absorbed and unified from 9router, agentgateway, and AIClient2API.
 *
 * Allows configuring an ordered sequence of models (e.g. Claude 3.7 Sonnet -> DeepSeek R1 -> GPT-4o)
 * that automatically cascades and falls back upon quota exhaustion, rate limits, or service outages.
 */

import type { QuotaDetectionResult } from "./quota-parser.js";

export interface ModelComboTarget {
  provider: string;
  modelId: string;
  label?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export type FallbackTrigger =
  | "rate_limit"
  | "quota_exhausted"
  | "auth_error"
  | "overloaded"
  | "timeout"
  | "context_length_exceeded";

export interface ModelCombo {
  id: string;
  name: string;
  description?: string;
  targets: ModelComboTarget[];
  fallbackTriggers?: FallbackTrigger[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ComboResolutionContext {
  failedTargets?: Array<{ provider: string; modelId: string; reason?: string }>;
  coolingModels?: Set<string>;
  triggerReason?: FallbackTrigger;
}

export class ModelComboRegistry {
  private combos = new Map<string, ModelCombo>();

  constructor(initialCombos?: ModelCombo[]) {
    if (initialCombos) {
      for (const c of initialCombos) {
        this.combos.set(c.id, c);
      }
    }
  }

  get(id: string): ModelCombo | undefined {
    return this.combos.get(id);
  }

  list(): ModelCombo[] {
    return Array.from(this.combos.values());
  }

  set(combo: ModelCombo): void {
    this.combos.set(combo.id, {
      ...combo,
      updatedAt: new Date().toISOString(),
    });
  }

  delete(id: string): boolean {
    return this.combos.delete(id);
  }

  /**
   * Resolves the next candidate model to execute within a combo sequence.
   * Returns undefined if all candidates in the combo have been exhausted or are cooling down.
   */
  resolveCandidate(
    comboId: string,
    context: ComboResolutionContext = {},
  ): ModelComboTarget | undefined {
    const combo = this.combos.get(comboId);
    if (!combo || combo.targets.length === 0) return undefined;

    const failedKeys = new Set(
      (context.failedTargets ?? []).map((t) => `${t.provider}:${t.modelId}`),
    );
    const cooling = context.coolingModels ?? new Set<string>();

    for (const target of combo.targets) {
      const key = `${target.provider}:${target.modelId}`;
      if (failedKeys.has(key)) continue;
      if (cooling.has(key)) continue;
      return target;
    }

    return undefined;
  }

  /**
   * Checks if an error condition qualifies for triggering a fallback based on the combo's rules.
   */
  shouldTriggerFallback(
    combo: ModelCombo,
    detection: QuotaDetectionResult,
    isTimeout: boolean = false,
  ): boolean {
    const allowed = combo.fallbackTriggers ?? [
      "rate_limit",
      "quota_exhausted",
      "overloaded",
      "timeout",
    ];

    if (isTimeout && allowed.includes("timeout")) return true;
    if (detection.isQuota && (allowed.includes("rate_limit") || allowed.includes("quota_exhausted"))) {
      return true;
    }
    if (detection.isAuthenticationFailure && allowed.includes("auth_error")) {
      return true;
    }
    return false;
  }
}

/**
 * 9router catalog synchronization constants and provider normalizer.
 */
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours (86,400,000 ms)

export const PROVIDER_ALIASES: Record<string, string> = {
  glm: "zai",
  "glm-cn": "zhipuai",
  claude: "anthropic",
  gemini: "google",
  kimi: "moonshotai",
  "kimi-cn": "moonshotai-cn",
  qwen: "alibaba",
  "qwen-cn": "alibaba-cn",
  zhipu: "zhipuai",
  hunyuan: "tencent",
  doubao: "volcengine",
  "cloudflare-ai": "cloudflare-workers-ai",
};

/**
 * Normalizes provider identifiers against known alias mappings.
 */
export function normalizeProvider(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

/**
 * Strips vendor prefix and version tags to extract canonical base model ID.
 * e.g. "zai-org/GLM-4.6V:free" -> "glm-4.6v"
 */
export function baseModelId(modelId: string): string {
  const withoutVendor = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return withoutVendor.toLowerCase().split(":")[0]!;
}

export interface SlimModelEntry {
  inputModalities: string[];
  contextLimit?: number;
  outputLimit?: number;
  supportsReasoning?: boolean;
}

/**
 * Compresses an upstream 4+ MB capability catalog to a lightweight lookup table
 * containing only input modalities, context limits, output limits, and reasoning capability.
 */
export function slimModelCatalog(
  rawCatalog: Record<string, any>,
): Record<string, Record<string, SlimModelEntry>> {
  const out: Record<string, Record<string, SlimModelEntry>> = {};

  for (const [rawProviderId, provider] of Object.entries(rawCatalog)) {
    const providerId = normalizeProvider(rawProviderId);
    const models: Record<string, SlimModelEntry> = {};

    const rawModels = provider?.models || {};
    for (const [modelId, model] of Object.entries<any>(rawModels)) {
      const id = baseModelId(modelId);
      const modalities: string[] = (model?.modalities?.input || []).filter(
        (x: string) => x !== "text",
      );

      models[id] = {
        inputModalities: modalities,
        contextLimit: model?.limit?.context,
        outputLimit: model?.limit?.output,
        supportsReasoning: Boolean(model?.reasoning),
      };
    }
    out[providerId] = models;
  }

  return out;
}
