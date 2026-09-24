/**
 * Model Key Fleet Monitor & Synthetic Health Prober.
 *
 * Tracks, rotates, and probes API key health across providers (Anthropic,
 * OpenAI, Google, Groq, DeepSeek, Local), recording sparkline latencies,
 * cooldown timers, failover states, and real-time fleet health statistics.
 */

import {
  ApiKeyRotator,
  KeyRotatorRegistry,
  type KeyStatus,
  type KeyHealth,
} from "./key-rotator.js";

export type KeyHealthStatus = "healthy" | "cooldown" | "evicted";
export type KeyFleetRotationStrategy = "round-robin" | "least-leases" | "priority-weighted";

export interface KeyHealthItem {
  keyId: string;
  maskedKey: string;
  status: KeyHealthStatus;
  isFailed: boolean;
  cooldownRemainingMs: number;
  successCount: number;
  failureCount: number;
  activeLeases?: number;
  lastUsedAt?: number;
  weight?: number;
}

export interface ModelKeyFleetReport {
  modelRef: string;
  provider: string;
  modelId: string;
  rotationStrategy: KeyFleetRotationStrategy;
  totalKeys: number;
  healthyCount: number;
  cooldownCount: number;
  evictedCount: number;
  activeLeases: number;
  keys: KeyHealthItem[];
}

export interface FleetHealthStats {
  totalKeys: number;
  healthyCount: number;
  cooldownCount: number;
  evictedCount: number;
  activeLeases: number;
  healthPercentage: number | null;
  availabilityState?: "healthy" | "degraded" | "critical" | "empty";
}

export interface KeyProbeResult {
  keyId: string;
  maskedKey: string;
  provider: string;
  latencyMs: number;
  status: "ok" | "error" | "skipped";
  timestamp: number;
  sparkline: number[];
  details?: string;
}

export interface CockpitKeyFleetSnapshot {
  healthy: boolean;
  activeCount: number;
  providers: Array<{
    provider: string;
    status: "active" | "cooldown" | "error";
    latencyMs: number;
    cooldownSec: number;
  }>;
}

export type ProbeFunction = (
  provider: string,
  key: string,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;

export interface ProviderRegistration {
  provider: string;
  modelId: string;
  modelRef?: string;
  keys: string[];
  strategy?: KeyFleetRotationStrategy;
  probeFn?: ProbeFunction;
  rotator?: ApiKeyRotator;
  projectId?: string;
}

/**
 * Masks an API key for display, keeping enough of prefix and suffix to be recognisable
 * without recovering the secret.
 *
 * The mask is also a fleet lookup key. Registration disambiguates collisions with a suffix,
 * including short keys and long keys with the same visible prefix and suffix. Short secrets
 * never expose a deterministic digest that could be guessed offline.
 */
export function maskApiKey(key: string): string {
  if (!key) return "empty-key";
  if (key.length <= 8) return "key-***";
  const prefix = key.slice(0, Math.min(7, Math.floor(key.length / 2)));
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

interface ModelRegistrationMeta {
  modelId: string;
  modelRef: string;
  provider: string;
  strategy: KeyFleetRotationStrategy;
  probeFn?: ProbeFunction;
  keyById: Map<string, { keyId: string; maskedKey: string; rawKey: string }>;
  keyByMask: Map<string, { keyId: string; maskedKey: string; rawKey: string }>;
  rawToId: Map<string, string>;
  latencies: number[];
  unsubRotator?: () => void;
}

export class KeyFleetMonitor {
  private rotators = new Map<string, ApiKeyRotator>();
  private modelMeta = new Map<string, ModelRegistrationMeta>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(stats: FleetHealthStats) => void>();

  constructor(initialProviders?: ProviderRegistration[]) {
    if (initialProviders && initialProviders.length > 0) {
      for (const reg of initialProviders) {
        this.registerProvider(reg);
      }
    } else {
      this.registerDefaults();
    }
  }

  private registerDefaults(): void {
    // Defaults are intentionally empty to prevent synthetic or unconfigured keys in production.
  }

  private hasKeyIdInOtherModels(keyId: string, currentModelRef: string): boolean {
    for (const [ref, meta] of this.modelMeta) {
      if (ref !== currentModelRef && meta.keyById.has(keyId)) {
        return true;
      }
    }
    return false;
  }

  public registerProvider(reg: ProviderRegistration): void {
    const provider = reg.provider.toLowerCase().trim();
    const modelId = reg.modelId.trim();
    const modelRef = reg.modelRef?.trim() || `${provider}/${modelId}`;

    const existingMeta = this.modelMeta.get(modelRef);
    if (existingMeta?.unsubRotator) {
      existingMeta.unsubRotator();
    }

    const rotator =
      reg.rotator ??
      (reg.projectId
        ? KeyRotatorRegistry.get(`${reg.projectId}/${provider}/${modelId}`, reg.keys, {
            updateExisting: false,
          })
        : new ApiKeyRotator(reg.keys));

    // Connect observable change listener to push real inference events live
    const unsubRotator = rotator.onChange(() => {
      this.notifyListeners();
    });

    this.rotators.set(modelRef, rotator);

    const keyById = new Map<string, { keyId: string; maskedKey: string; rawKey: string }>();
    const keyByMask = new Map<string, { keyId: string; maskedKey: string; rawKey: string }>();
    const rawToId = new Map<string, string>();

    reg.keys.forEach((k, index) => {
      const baseKeyId = `${provider}-key-${index + 1}`;
      const keyId = this.hasKeyIdInOtherModels(baseKeyId, modelRef)
        ? `${provider}-${modelId.replace(/[^a-zA-Z0-9_-]/g, "-")}-key-${index + 1}`
        : baseKeyId;
      const baseMask = maskApiKey(k);
      let masked = baseMask;
      for (let suffix = 2; keyByMask.has(masked); suffix++) {
        masked = `${baseMask}#${suffix}`;
      }
      const entry = { keyId, maskedKey: masked, rawKey: k };
      keyById.set(keyId, entry);
      keyByMask.set(masked, entry);
      rawToId.set(k, keyId);
    });

    this.modelMeta.set(modelRef, {
      modelId,
      modelRef,
      provider,
      strategy: reg.strategy ?? "round-robin",
      probeFn: reg.probeFn,
      keyById,
      keyByMask,
      rawToId,
      latencies: existingMeta?.latencies ?? [],
      unsubRotator,
    });
  }

  private findMetaAndRotator(
    providerOrRef: string,
    keyIdOrMask?: string,
  ): { meta: ModelRegistrationMeta; rotator: ApiKeyRotator; modelRef: string } | undefined {
    const norm = providerOrRef.toLowerCase().trim();

    // 1. Direct match on modelRef
    for (const [ref, meta] of this.modelMeta) {
      if (ref.toLowerCase() === norm) {
        if (!keyIdOrMask || meta.keyById.has(keyIdOrMask) || meta.keyByMask.has(keyIdOrMask)) {
          const rotator = this.rotators.get(ref);
          if (rotator) return { meta, rotator, modelRef: ref };
        }
      }
    }

    // 2. Match where provider or modelId matches and key exists (if keyIdOrMask provided)
    for (const [ref, meta] of this.modelMeta) {
      if (meta.provider === norm || meta.modelId.toLowerCase() === norm) {
        if (!keyIdOrMask || meta.keyById.has(keyIdOrMask) || meta.keyByMask.has(keyIdOrMask)) {
          const rotator = this.rotators.get(ref);
          if (rotator) return { meta, rotator, modelRef: ref };
        }
      }
    }

    // 3. Fallback: match by provider alone only when keyIdOrMask is not provided
    if (!keyIdOrMask) {
      for (const [ref, meta] of this.modelMeta) {
        if (meta.provider === norm) {
          const rotator = this.rotators.get(ref);
          if (rotator) return { meta, rotator, modelRef: ref };
        }
      }
    }

    return undefined;
  }

  public getProviders(): string[] {
    return [...new Set([...this.modelMeta.values()].map((m) => m.provider))];
  }

  public getRotator(providerOrRef: string): ApiKeyRotator | undefined {
    return this.findMetaAndRotator(providerOrRef)?.rotator;
  }

  public clear(): void {
    for (const meta of this.modelMeta.values()) {
      meta.unsubRotator?.();
    }
    this.rotators.clear();
    this.modelMeta.clear();
    this.notifyListeners();
  }

  /**
   * Executes a synthetic or live latency probe for a specific key under a provider/model.
   */
  public async probeKey(
    providerOrRef: string,
    keyIdOrMask: string,
    overrideProbeFn?: ProbeFunction,
  ): Promise<KeyProbeResult> {
    return this.probeKeyWithSignal(providerOrRef, keyIdOrMask, overrideProbeFn);
  }

  private async probeKeyWithSignal(
    providerOrRef: string,
    keyIdOrMask: string,
    overrideProbeFn?: ProbeFunction,
    signal?: AbortSignal,
  ): Promise<KeyProbeResult> {
    const found = this.findMetaAndRotator(providerOrRef, keyIdOrMask);
    const now = Date.now();
    const entry = found?.meta.keyById.get(keyIdOrMask) ?? found?.meta.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    const keyId = entry?.keyId ?? keyIdOrMask;
    const maskedKey = entry?.maskedKey ?? maskApiKey(keyIdOrMask);
    const provider = found?.meta.provider ?? providerOrRef.toLowerCase();

    const probeFn = overrideProbeFn ?? found?.meta.probeFn;

    let latencyMs = 0;
    let status: "ok" | "error" | "skipped" = "skipped";
    let details: string | undefined;

    if (probeFn && rawKey) {
      const startedAt = performance.now();
      try {
        const res = await probeFn(provider, rawKey, signal);
        latencyMs = res.latencyMs;
        status = res.ok ? "ok" : "error";
        details = res.error;
        if (signal?.aborted) return this.abortedProbeResult(keyId, maskedKey, provider, now, found);
        if (res.ok) {
          found?.rotator.recordSuccess(rawKey);
        } else {
          found?.rotator.recordFailure(rawKey, "other");
        }
      } catch (err) {
        if (signal?.aborted) return this.abortedProbeResult(keyId, maskedKey, provider, now, found);
        status = "error";
        latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
        details = err instanceof Error ? err.message : String(err);
        found?.rotator.recordFailure(rawKey, "other");
      }
    } else {
      latencyMs = 0;
      status = "skipped";
      details = "No probe function configured for provider";
    }

    if (found && status !== "skipped" && latencyMs > 0) {
      found.meta.latencies.push(latencyMs);
      if (found.meta.latencies.length > 10) {
        found.meta.latencies.shift();
      }
    }

    const sparkline = found ? [...found.meta.latencies] : [];

    return {
      keyId,
      maskedKey,
      provider,
      latencyMs,
      status,
      timestamp: now,
      sparkline,
      details,
    };
  }

  private abortedProbeResult(
    keyId: string,
    maskedKey: string,
    provider: string,
    timestamp: number,
    found: ReturnType<KeyFleetMonitor["findMetaAndRotator"]>,
  ): KeyProbeResult {
    return {
      keyId,
      maskedKey,
      provider,
      latencyMs: 0,
      status: "error",
      timestamp,
      sparkline: found ? [...found.meta.latencies] : [],
      details: "Probe was aborted",
    };
  }

  /**
   * Probes all providers across the fleet.
   *
   * The probes are independent per key, so they run concurrently: a sequential sweep made
   * one unresponsive endpoint stall every key behind it, and — because the listeners are
   * notified only after the loop — blocked fleet health updates too. Each probe still gets
   * a deadline, since a hung probe would otherwise keep the sweep from ever settling; a
   * probe that outlives it is reported as an error for the key it was issued against
   * rather than awaited indefinitely.
   */
  public async probeFleet(perProbeTimeoutMs = 30_000): Promise<KeyProbeResult[]> {
    const pending: Promise<KeyProbeResult>[] = [];
    for (const [ref, meta] of this.modelMeta) {
      for (const keyId of meta.keyById.keys()) {
        pending.push(this.probeKeyWithDeadline(ref, keyId, perProbeTimeoutMs));
      }
    }
    // `Promise.all` preserves the iteration order, so the results line up with the sweep
    // order a sequential caller used to see.
    const results = await Promise.all(pending);
    this.notifyListeners();
    return results;
  }

  private async probeKeyWithDeadline(
    providerOrRef: string,
    keyIdOrMask: string,
    timeoutMs: number,
  ): Promise<KeyProbeResult> {
    const found = this.findMetaAndRotator(providerOrRef, keyIdOrMask);
    const entry = found?.meta.keyById.get(keyIdOrMask) ?? found?.meta.keyByMask.get(keyIdOrMask);
    // Resolved up front so a probe that misses its deadline can still say which key it was
    // for — the probe's own result would carry those fields, but it never arrives.
    const keyId = entry?.keyId ?? keyIdOrMask;
    const maskedKey = entry?.maskedKey ?? maskApiKey(keyIdOrMask);
    const provider = found?.meta.provider ?? providerOrRef.toLowerCase();

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<KeyProbeResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          keyId,
          maskedKey,
          provider,
          latencyMs: timeoutMs,
          status: "error",
          timestamp: Date.now(),
          sparkline: found ? [...found.meta.latencies] : [],
          details: `Probe exceeded the ${timeoutMs}ms deadline`,
        });
      }, timeoutMs);
      // A fleet sweep must not keep the event loop alive on its own.
      (timer as { unref?: () => void })?.unref?.();
    });
    try {
      return await Promise.race([
        this.probeKeyWithSignal(providerOrRef, keyIdOrMask, undefined, controller.signal),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Revives a key from cooldown or eviction. Returns true if key was found and updated.
   */
  public reviveKey(providerOrRef: string, keyIdOrMask: string): boolean {
    const found = this.findMetaAndRotator(providerOrRef, keyIdOrMask);
    if (!found) return false;
    const entry = found.meta.keyById.get(keyIdOrMask) ?? found.meta.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    if (rawKey) {
      found.rotator.reviveKey(rawKey);
      return true;
    }
    return false;
  }

  /**
   * Places a key in temporary cooldown. Returns true if key was found and updated.
   */
  public cooldownKey(providerOrRef: string, keyIdOrMask: string, cooldownMs = 60_000): boolean {
    const found = this.findMetaAndRotator(providerOrRef, keyIdOrMask);
    if (!found) return false;
    const entry = found.meta.keyById.get(keyIdOrMask) ?? found.meta.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    if (rawKey) {
      found.rotator.recordFailure(rawKey, "rate_limit", cooldownMs);
      return true;
    }
    return false;
  }

  /**
   * Evicts a key permanently (e.g. auth failure). Returns true if key was found and updated.
   */
  public evictKey(providerOrRef: string, keyIdOrMask: string): boolean {
    const found = this.findMetaAndRotator(providerOrRef, keyIdOrMask);
    if (!found) return false;
    const entry = found.meta.keyById.get(keyIdOrMask) ?? found.meta.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    if (rawKey) {
      found.rotator.recordFailure(rawKey, "auth");
      return true;
    }
    return false;
  }

  /**
   * Checks whether a key identifier or mask exists for a provider/model.
   */
  public hasKey(providerOrRef: string, keyIdOrMask: string): boolean {
    return this.findMetaAndRotator(providerOrRef, keyIdOrMask) !== undefined;
  }

  /**
   * Revives all cooling-down keys across all providers.
   */
  public reviveAllCooldowns(): void {
    for (const rotator of this.rotators.values()) {
      rotator.resetAllCooldowns();
    }
  }

  /**
   * Generates a detailed model fleet report.
   */
  public getFleetReport(): ModelKeyFleetReport[] {
    const reports: ModelKeyFleetReport[] = [];
    const now = Date.now();

    for (const [modelRef, meta] of this.modelMeta) {
      const rotator = this.rotators.get(modelRef);
      const keys: KeyHealthItem[] = [];

      let healthyCount = 0;
      let cooldownCount = 0;
      let evictedCount = 0;
      let activeLeases = 0;

      if (rotator) {
        const statuses = rotator.getKeys();
        for (const s of statuses) {
          const keyId = meta.rawToId.get(s.key);
          const masked = (keyId && meta.keyById.get(keyId)?.maskedKey) ?? maskApiKey(s.key);
          let st: KeyHealthStatus = "healthy";
          let cooldownRemainingMs = 0;

          if (s.isFailed) {
            st = "evicted";
            evictedCount++;
          } else if (s.cooldownUntil > now) {
            st = "cooldown";
            cooldownRemainingMs = Math.max(0, s.cooldownUntil - now);
            cooldownCount++;
          } else {
            st = "healthy";
            healthyCount++;
          }

          const leases = s.activeLeases ?? 0;
          activeLeases += leases;

          keys.push({
            keyId: keyId ?? masked,
            maskedKey: masked,
            status: st,
            isFailed: s.isFailed,
            cooldownRemainingMs,
            successCount: s.successCount,
            failureCount: s.failureCount,
            activeLeases: leases,
            lastUsedAt: s.lastUsedAt,
          });
        }
      }

      reports.push({
        modelRef: meta.modelRef,
        provider: meta.provider,
        modelId: meta.modelId,
        rotationStrategy: meta.strategy,
        totalKeys: keys.length,
        healthyCount,
        cooldownCount,
        evictedCount,
        activeLeases,
        keys,
      });
    }

    return reports;
  }

  /**
   * Computes aggregate fleet health metrics.
   */
  public getFleetStats(): FleetHealthStats {
    const reports = this.getFleetReport();
    let totalKeys = 0;
    let healthyCount = 0;
    let cooldownCount = 0;
    let evictedCount = 0;
    let activeLeases = 0;

    for (const r of reports) {
      totalKeys += r.totalKeys;
      healthyCount += r.healthyCount;
      cooldownCount += r.cooldownCount;
      evictedCount += r.evictedCount;
      activeLeases += r.activeLeases;
    }

    const healthPercentage =
      totalKeys === 0 ? null : Math.round(((healthyCount + cooldownCount * 0.5) / totalKeys) * 100);

    let availabilityState: FleetHealthStats["availabilityState"] = "empty";
    if (totalKeys > 0) {
      if (healthyCount === totalKeys) {
        availabilityState = "healthy";
      } else if (healthyCount > 0) {
        availabilityState = "degraded";
      } else {
        availabilityState = "critical";
      }
    }

    return {
      totalKeys,
      healthyCount,
      cooldownCount,
      evictedCount,
      activeLeases,
      healthPercentage,
      availabilityState,
    };
  }

  /**
   * Produces a lightweight snapshot formatted for Cockpit Web telemetry.
   */
  public getCockpitSnapshot(): CockpitKeyFleetSnapshot {
    const reports = this.getFleetReport();
    const providers: CockpitKeyFleetSnapshot["providers"] = [];

    let totalHealthy = 0;

    for (const r of reports) {
      const meta = this.modelMeta.get(r.modelRef);
      const lastLat =
        meta && meta.latencies.length > 0 ? meta.latencies[meta.latencies.length - 1]! : 0;

      let status: "active" | "cooldown" | "error" = "active";
      let maxCooldownSec = 0;

      if (r.healthyCount > 0) {
        status = "active";
        totalHealthy++;
      } else if (r.cooldownCount > 0) {
        status = "cooldown";
        const maxCooldownMs = Math.max(0, ...r.keys.map((k) => k.cooldownRemainingMs));
        maxCooldownSec = Math.round(maxCooldownMs / 1000);
      } else {
        status = "error";
      }

      providers.push({
        provider: r.provider,
        status,
        latencyMs: lastLat,
        cooldownSec: maxCooldownSec,
      });
    }

    return {
      healthy: totalHealthy > 0,
      activeCount: totalHealthy,
      providers,
    };
  }

  public subscribe(listener: (stats: FleetHealthStats) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const stats = this.getFleetStats();
    for (const l of this.listeners) {
      try {
        l(stats);
      } catch {
        // ignore
      }
    }
  }

  public startAutoProbing(intervalMs = 30_000): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => {
      void this.probeFleet();
    }, intervalMs);
    this.probeTimer.unref?.();
  }

  public stopAutoProbing(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }
}
