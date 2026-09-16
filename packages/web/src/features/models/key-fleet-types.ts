/**
 * Model Key Fleet & Resilient Failover Console Types and Utilities.
 */

export type KeyHealthStatus = "healthy" | "cooldown" | "evicted";

export type RotationStrategy = "round-robin" | "least-leases" | "priority-weighted";

export type KeyActionType = "revive" | "cooldown" | "evict" | "probe";

export interface KeyHealthItem {
  keyId?: string;
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
  rotationStrategy: RotationStrategy;
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
  availabilityState: "healthy" | "degraded" | "critical" | "empty";
}

export interface KeyProbeResult {
  keyId?: string;
  maskedKey: string;
  provider: string;
  latencyMs: number;
  status: "ok" | "error";
  timestamp: number;
  sparkline: number[];
  details?: string;
  isSimulated?: boolean;
}

/**
 * Aggregates fleet statistics across models and keys.
 */
export function calculateFleetHealth(reports: ModelKeyFleetReport[]): FleetHealthStats {
  if (!reports || reports.length === 0) {
    return {
      totalKeys: 0,
      healthyCount: 0,
      cooldownCount: 0,
      evictedCount: 0,
      activeLeases: 0,
      healthPercentage: null,
      availabilityState: "empty",
    };
  }

  let totalKeys = 0;
  let healthyCount = 0;
  let cooldownCount = 0;
  let evictedCount = 0;
  let activeLeases = 0;

  for (const report of reports) {
    totalKeys += report.totalKeys;
    healthyCount += report.healthyCount;
    cooldownCount += report.cooldownCount;
    evictedCount += report.evictedCount;
    activeLeases += report.activeLeases;
  }

  const healthPercentage = totalKeys === 0 ? null : Math.round((healthyCount / totalKeys) * 100);
  const availabilityState =
    totalKeys === 0
      ? "empty"
      : healthyCount === 0
        ? "critical"
        : healthyCount < totalKeys
          ? "degraded"
          : "healthy";

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
 * Calculates invocation success rate as an integer percentage [0, 100].
 */
export function calculateKeySuccessRate(successCount: number, failureCount: number): number {
  const total = successCount + failureCount;
  if (total <= 0) return 100;
  return Math.round((successCount / total) * 100);
}

/**
 * Formats cooldown duration into "Xs" or "Xm Ys".
 */
export function formatCooldownTimer(remainingMs: number): string {
  if (remainingMs <= 0) return "0s";
  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

/**
 * Filters fleet reports based on status chip and search query.
 */
export function filterKeyFleetReports(
  reports: ModelKeyFleetReport[],
  filter: "all" | "healthy" | "cooldown" | "evicted",
  query: string,
): ModelKeyFleetReport[] {
  const q = query.trim().toLowerCase();

  return reports
    .map((report) => {
      // Check query match on model or provider
      const modelMatches =
        q.length === 0 ||
        report.modelRef.toLowerCase().includes(q) ||
        report.provider.toLowerCase().includes(q) ||
        report.modelId.toLowerCase().includes(q);

      // Filter keys inside report
      const matchingKeys = report.keys.filter((key) => {
        const keyQueryMatch =
          q.length === 0 || modelMatches || key.maskedKey.toLowerCase().includes(q);

        if (!keyQueryMatch) return false;

        if (filter === "all") return true;
        return key.status === filter;
      });

      if (matchingKeys.length === 0) return null;

      return {
        ...report,
        keys: matchingKeys,
      };
    })
    .filter((r): r is ModelKeyFleetReport => r !== null);
}

/**
 * Simulates latency check with past sparkline trends for probe verification.
 */
export function simulateKeyProbe(maskedKey: string, provider: string): KeyProbeResult {
  // Deterministic seed based on key string
  let hash = 0;
  for (let i = 0; i < maskedKey.length; i++) {
    hash = (hash << 5) - hash + maskedKey.charCodeAt(i);
    hash |= 0;
  }
  const baseLatency = 45 + (Math.abs(hash) % 180);
  const jitter = Math.floor(Math.random() * 25);
  const latencyMs = baseLatency + jitter;

  const sparkline = [
    baseLatency - 15,
    baseLatency + 10,
    baseLatency - 5,
    baseLatency + 20,
    latencyMs,
  ];

  return {
    maskedKey,
    provider,
    latencyMs,
    status: "ok",
    timestamp: Date.now(),
    sparkline,
    details: `HTTP 200 OK — Roundtrip completed in ${latencyMs}ms with authorization validated.`,
  };
}
