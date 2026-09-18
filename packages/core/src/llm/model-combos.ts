/**
 * Model Combos (Fusion Fallback Cascades).
 * Allows an ordered sequence of models to cascade on explicitly configured failure reasons.
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

const DEFAULT_FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
  "rate_limit",
  "quota_exhausted",
  "overloaded",
  "timeout",
];

function cloneCombo(combo: ModelCombo): ModelCombo {
  return {
    ...combo,
    targets: combo.targets.map((target) => ({ ...target })),
    fallbackTriggers: combo.fallbackTriggers ? [...combo.fallbackTriggers] : undefined,
  };
}

function classifyFallbackReasons(
  detection: QuotaDetectionResult,
  isTimeout: boolean,
): Set<FallbackTrigger> {
  const reasons = new Set<FallbackTrigger>();
  if (isTimeout) reasons.add("timeout");
  if (detection.isQuota) {
    reasons.add("rate_limit");
    reasons.add("quota_exhausted");
  }
  if (detection.isAuthenticationFailure) reasons.add("auth_error");
  if (detection.isOverloaded) reasons.add("overloaded");
  if (detection.isContextLengthExceeded) reasons.add("context_length_exceeded");

  // Backward compatibility for callers constructing older QuotaDetectionResult objects manually.
  const diagnosticText = `${detection.code ?? ""} ${detection.reason ?? ""}`.toLowerCase();
  if (
    /\boverload(?:ed|ing)?\b|\bcapacity\b|temporar(?:y|ily) unavailable|service unavailable|server busy|\b529\b|\b503\b/.test(
      diagnosticText,
    )
  ) {
    reasons.add("overloaded");
  }
  if (
    /context[_\s-]*(?:length|window)|context_length_exceeded|maximum context|max(?:imum)? tokens|too many tokens/.test(
      diagnosticText,
    )
  ) {
    reasons.add("context_length_exceeded");
  }

  return reasons;
}

export class ModelComboRegistry {
  private combos = new Map<string, ModelCombo>();

  constructor(initialCombos?: ModelCombo[]) {
    if (initialCombos) {
      for (const combo of initialCombos) this.combos.set(combo.id, cloneCombo(combo));
    }
  }

  get(id: string): ModelCombo | undefined {
    const combo = this.combos.get(id);
    return combo ? cloneCombo(combo) : undefined;
  }

  list(): ModelCombo[] {
    return Array.from(this.combos.values(), cloneCombo);
  }

  set(combo: ModelCombo): void {
    const existing = this.combos.get(combo.id);
    const now = new Date().toISOString();
    this.combos.set(
      combo.id,
      cloneCombo({
        ...combo,
        createdAt: combo.createdAt ?? existing?.createdAt ?? now,
        updatedAt: now,
      }),
    );
  }

  delete(id: string): boolean {
    return this.combos.delete(id);
  }

  resolveCandidate(
    comboId: string,
    context: ComboResolutionContext = {},
  ): ModelComboTarget | undefined {
    const combo = this.combos.get(comboId);
    if (!combo || combo.targets.length === 0) return undefined;

    const failedKeys = new Set(
      (context.failedTargets ?? []).map((target) => `${target.provider}:${target.modelId}`),
    );
    const cooling = context.coolingModels ?? new Set<string>();

    for (const target of combo.targets) {
      const key = `${target.provider}:${target.modelId}`;
      if (failedKeys.has(key) || cooling.has(key)) continue;
      return { ...target };
    }
    return undefined;
  }

  public shouldTriggerFallback(
    combo: ModelCombo,
    detection: QuotaDetectionResult,
    isTimeout: boolean = false,
  ): boolean {
    const allowed = new Set(combo.fallbackTriggers ?? DEFAULT_FALLBACK_TRIGGERS);
    if (allowed.size === 0) return false;

    const detected = classifyFallbackReasons(detection, isTimeout);
    for (const reason of detected) {
      if (allowed.has(reason)) return true;
    }
    return false;
  }
}

export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

export function normalizeProvider(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

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

export function slimModelCatalog(
  rawCatalog: Record<string, any>,
): Record<string, Record<string, SlimModelEntry>> {
  const out: Record<string, Record<string, SlimModelEntry>> = {};

  const providers = Object.entries(rawCatalog).sort(([rawA], [rawB]) => {
    const normalizedA = normalizeProvider(rawA);
    const normalizedB = normalizeProvider(rawB);
    if (normalizedA !== normalizedB) return normalizedA.localeCompare(normalizedB);

    const canonicalA = rawA.trim().toLowerCase() === normalizedA ? 0 : 1;
    const canonicalB = rawB.trim().toLowerCase() === normalizedB ? 0 : 1;
    if (canonicalA !== canonicalB) return canonicalA - canonicalB;
    return rawA.localeCompare(rawB);
  });

  for (const [rawProviderId, provider] of providers) {
    const providerId = normalizeProvider(rawProviderId);
    const models = out[providerId] ?? (out[providerId] = {});
    const rawModels = provider?.models ?? {};

    for (const [modelId, model] of Object.entries<any>(rawModels).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const id = baseModelId(modelId);
      if (models[id] !== undefined) continue;

      const modalities: string[] = (model?.modalities?.input ?? []).filter(
        (value: string) => value !== "text",
      );
      models[id] = {
        inputModalities: modalities,
        contextLimit: model?.limit?.context,
        outputLimit: model?.limit?.output,
        supportsReasoning: Boolean(model?.reasoning),
      };
    }
  }

  return out;
}
