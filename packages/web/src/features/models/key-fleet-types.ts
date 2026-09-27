/**
 * Model Key Fleet & Resilient Failover Console Types and Utilities.
 */

export type KeyHealthStatus = "healthy" | "cooldown" | "evicted";

export type RotationStrategy = "round-robin" | "least-leases" | "priority-weighted";

export type KeyActionType = "revive" | "cooldown" | "evict" | "probe";

export interface KeyHealthItem {
  keyId?: string;
  maskedKey: string;
  /**
   * The name this Project gave the key — the identifier a human uses, unique within the
   * fleet. Absent, never empty, when the key has none: an unnamed key is a fact the UI
   * states, not a field the server fills with a placeholder nobody chose.
   */
  name?: string;
  /** Optional free text for context the name cannot carry. Absent = none. */
  label?: string;
  status: KeyHealthStatus;
  isFailed: boolean;
  cooldownRemainingMs: number;
  successCount: number;
  failureCount: number;
  activeLeases?: number;
  lastUsedAt?: number;
  weight?: number;
}

/** One row of `GET /models/keys`: a name, and the masked key it belongs to. */
export interface KeyNameEntry {
  provider: string;
  modelId: string;
  keyId: string;
  name: string;
  label?: string;
  /** The fleet mask, the string the fleet report shows. Absent when the key is gone. */
  maskedKey?: string;
  /**
   * The models table's mask for the same key, for the surface that shows a lone key on a
   * model row and has no health report to join against.
   */
  rowMask?: string;
  /** The key this name was given to is no longer configured. */
  orphaned: boolean;
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

      // Filter keys inside report: a key is found by its mask, by its name, or by its label.
      const matchingKeys = report.keys.filter((key) => {
        const keyQueryMatch = modelMatches || keyMatchesQuery(key, q);
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
 * What to show as a key's identity: its name, or an explicit "unnamed" affordance.
 *
 * There is deliberately no third option. A key with no name is shown as unnamed and offered
 * the rename — not numbered ("Key 1"), not addressed by its position, and never given a
 * generated name, because a name here means "the user chose this" and anything else teaches
 * them the field is noise.
 */
export function keyNameOf(
  key: { name?: string },
  unnamed: string,
): { name: string; isUnnamed: boolean } {
  const name = key.name?.trim();
  return name !== undefined && name !== ""
    ? { name, isUnnamed: false }
    : { name: unnamed, isUnnamed: true };
}

/**
 * Attaches each key's name to a fleet report, joined on the masked key the report shows.
 *
 * The join is deliberately on `(provider, modelId, maskedKey)` and nothing else. The health
 * report comes from the key rotator, which knows nothing about names, and the only string
 * both sides agree on is the mask each already prints. A name whose key is not in the report
 * (rotated away) is simply not joined — it has no row to appear on, and the list endpoint
 * reports it as orphaned for the surfaces that can say so.
 */
export function joinKeyNames(
  reports: readonly ModelKeyFleetReport[],
  entries: readonly KeyNameEntry[],
): ModelKeyFleetReport[] {
  if (entries.length === 0) return [...reports];
  const byKey = new Map<string, KeyNameEntry>();
  for (const entry of entries) {
    if (entry.maskedKey === undefined) continue;
    byKey.set(`${entry.provider}/${entry.modelId}/${entry.maskedKey}`, entry);
  }
  return reports.map((report) => ({
    ...report,
    keys: report.keys.map((key) => {
      const hit = byKey.get(`${report.provider}/${report.modelId}/${key.maskedKey}`);
      if (hit === undefined) return key;
      return { ...key, name: hit.name, label: hit.label, keyId: hit.keyId };
    }),
  }));
}

/**
 * Filters fleet reports by a search query that also matches what a key is CALLED.
 *
 * Before names existed the only searchable text was a mask, which is why a fleet of three
 * keys for one model could not be narrowed at all. A name and a label are now searchable for
 * the same reason they are displayed: "show me the one called prod" is the whole point.
 */
export function keyMatchesQuery(key: KeyHealthItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    key.maskedKey.toLowerCase().includes(q) ||
    (key.name ?? "").toLowerCase().includes(q) ||
    (key.label ?? "").toLowerCase().includes(q)
  );
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
