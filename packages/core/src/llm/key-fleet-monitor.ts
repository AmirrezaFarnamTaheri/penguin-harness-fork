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

export function maskApiKey(key: string): string {
  if (!key) return "empty-key";
  if (key.length <= 8) return "key-***";
  const prefix = key.slice(0, Math.min(7, Math.floor(key.length / 2)));
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

export class KeyFleetMonitor {
  private rotators = new Map<string, ApiKeyRotator>();
  private providerMeta = new Map<
    string,
    {
      modelId: string;
      modelRef: string;
      strategy: KeyFleetRotationStrategy;
      probeFn?: ProbeFunction;
      keyById: Map<string, { keyId: string; maskedKey: string; rawKey: string }>;
      keyByMask: Map<string, { keyId: string; maskedKey: string; rawKey: string }>;
      rawToId: Map<string, string>;
      latencies: number[];
    }
  >();
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

  public registerProvider(reg: ProviderRegistration): void {
    const provider = reg.provider.toLowerCase();
    const rotator =
      reg.rotator ??
      (reg.projectId
        ? KeyRotatorRegistry.get(`${reg.projectId}/${provider}/${reg.modelId}`, reg.keys)
        : new ApiKeyRotator(reg.keys));
    this.rotators.set(provider, rotator);

    const keyById = new Map<string, { keyId: string; maskedKey: string; rawKey: string }>();
    const keyByMask = new Map<string, { keyId: string; maskedKey: string; rawKey: string }>();
    const rawToId = new Map<string, string>();

    reg.keys.forEach((k, index) => {
      const keyId = `${provider}-key-${index + 1}`;
      const masked = maskApiKey(k);
      const entry = { keyId, maskedKey: masked, rawKey: k };
      keyById.set(keyId, entry);
      keyByMask.set(masked, entry);
      rawToId.set(k, keyId);
    });

    this.providerMeta.set(provider, {
      modelId: reg.modelId,
      modelRef: reg.modelRef ?? `${provider}/${reg.modelId}`,
      strategy: reg.strategy ?? "round-robin",
      probeFn: reg.probeFn,
      keyById,
      keyByMask,
      rawToId,
      latencies: [],
    });
  }

  public getProviders(): string[] {
    return Array.from(this.rotators.keys());
  }

  public getRotator(provider: string): ApiKeyRotator | undefined {
    return this.rotators.get(provider.toLowerCase());
  }

  public clear(): void {
    this.rotators.clear();
    this.providerMeta.clear();
    this.notifyListeners();
  }

  /**
   * Executes a synthetic or live latency probe for a specific key under a provider.
   */
  public async probeKey(
    provider: string,
    keyIdOrMask: string,
    overrideProbeFn?: ProbeFunction,
  ): Promise<KeyProbeResult> {
    const prov = provider.toLowerCase();
    const meta = this.providerMeta.get(prov);
    const rotator = this.rotators.get(prov);

    const now = Date.now();
    const entry = meta?.keyById.get(keyIdOrMask) ?? meta?.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    const keyId = entry?.keyId ?? keyIdOrMask;
    const maskedKey = entry?.maskedKey ?? maskApiKey(keyIdOrMask);

    const probeFn = overrideProbeFn ?? meta?.probeFn;

    let latencyMs = 0;
    let status: "ok" | "error" | "skipped" = "skipped";
    let details: string | undefined;

    if (probeFn && rawKey) {
      try {
        const res = await probeFn(prov, rawKey);
        latencyMs = res.latencyMs;
        status = res.ok ? "ok" : "error";
        details = res.error;
        if (res.ok) {
          rotator?.recordSuccess(rawKey);
        } else {
          rotator?.recordFailure(rawKey, "other");
        }
      } catch (err) {
        status = "error";
        latencyMs = 999;
        details = err instanceof Error ? err.message : String(err);
        rotator?.recordFailure(rawKey, "other");
      }
    } else {
      latencyMs = 0;
      status = "skipped";
      details = "No probe function configured for provider";
    }

    if (meta && status !== "skipped" && latencyMs > 0) {
      meta.latencies.push(latencyMs);
      if (meta.latencies.length > 10) {
        meta.latencies.shift();
      }
    }

    const sparkline = meta ? [...meta.latencies] : [];

    return {
      keyId,
      maskedKey,
      provider: prov,
      latencyMs,
      status,
      timestamp: now,
      sparkline,
      details,
    };
  }

  /**
   * Probes all providers across the fleet.
   */
  public async probeFleet(): Promise<KeyProbeResult[]> {
    const results: KeyProbeResult[] = [];
    for (const [provider, meta] of this.providerMeta) {
      for (const keyId of meta.keyById.keys()) {
        const res = await this.probeKey(provider, keyId);
        results.push(res);
      }
    }
    this.notifyListeners();
    return results;
  }

  /**
   * Revives a key from cooldown or eviction. Returns true if key was found and updated.
   */
  public reviveKey(provider: string, keyIdOrMask: string): boolean {
    const meta = this.providerMeta.get(provider.toLowerCase());
    const rotator = this.rotators.get(provider.toLowerCase());
    const entry = meta?.keyById.get(keyIdOrMask) ?? meta?.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    if (rawKey && rotator) {
      rotator.reviveKey(rawKey);
      this.notifyListeners();
      return true;
    }
    return false;
  }

  /**
   * Places a key in temporary cooldown. Returns true if key was found and updated.
   */
  public cooldownKey(provider: string, keyIdOrMask: string, cooldownMs = 60_000): boolean {
    const meta = this.providerMeta.get(provider.toLowerCase());
    const rotator = this.rotators.get(provider.toLowerCase());
    const entry = meta?.keyById.get(keyIdOrMask) ?? meta?.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    if (rawKey && rotator) {
      rotator.recordFailure(rawKey, "rate_limit", cooldownMs);
      this.notifyListeners();
      return true;
    }
    return false;
  }

  /**
   * Evicts a key permanently (e.g. auth failure). Returns true if key was found and updated.
   */
  public evictKey(provider: string, keyIdOrMask: string): boolean {
    const meta = this.providerMeta.get(provider.toLowerCase());
    const rotator = this.rotators.get(provider.toLowerCase());
    const entry = meta?.keyById.get(keyIdOrMask) ?? meta?.keyByMask.get(keyIdOrMask);
    const rawKey = entry?.rawKey;
    if (rawKey && rotator) {
      rotator.recordFailure(rawKey, "auth");
      this.notifyListeners();
      return true;
    }
    return false;
  }

  /**
   * Checks whether a key identifier or mask exists for a provider.
   */
  public hasKey(provider: string, keyIdOrMask: string): boolean {
    const meta = this.providerMeta.get(provider.toLowerCase());
    if (!meta) return false;
    return meta.keyById.has(keyIdOrMask) || meta.keyByMask.has(keyIdOrMask);
  }

  /**
   * Revives all cooling-down keys across all providers.
   */
  public reviveAllCooldowns(): void {
    for (const rotator of this.rotators.values()) {
      rotator.resetAllCooldowns();
    }
    this.notifyListeners();
  }

  /**
   * Generates a detailed model fleet report.
   */
  public getFleetReport(): ModelKeyFleetReport[] {
    const reports: ModelKeyFleetReport[] = [];
    const now = Date.now();

    for (const [provider, meta] of this.providerMeta) {
      const rotator = this.rotators.get(provider);
      const keys: KeyHealthItem[] = [];

      let healthyCount = 0;
      let cooldownCount = 0;
      let evictedCount = 0;
      let activeLeases = 0;

      if (rotator) {
        const statuses = rotator.getKeys();
        for (const s of statuses) {
          const masked = maskApiKey(s.key);
          const keyId = meta?.rawToId.get(s.key) ?? masked;
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
            keyId,
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
        provider,
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
      const meta = this.providerMeta.get(r.provider);
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
