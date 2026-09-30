/**
 * Experimental retention and consolidation policy for memory records.
 *
 * Repository status: exported by `memory/index.ts`, but currently has no production call sites
 * in this repository. `retention.test.ts` tests these pure helpers; `RecallStore` has its own
 * independent age/count/token bounds, and `FindingsGraph` does not use this module. No scheduled
 * runner or persistence integration applies these decay, promotion, or eviction rules. Keep
 * this policy opt-in until a recall/storage baseline and an explicit integration owner exist.
 *
 * Constants and semantics are taken from the agentmemory lifecycle investigation
 * (absorb/reports/agentmemory-lifecycle.md + agentmemory-graph-search.md), which shipped the
 * benchmark-backed numbers rather than guesses:
 * - Upstream source: https://github.com/rohitg00/agentmemory; its LICENSE declares Apache-2.0
 *   (verified 2026-09-30). This module is an independent implementation of reported formulas,
 *   not copied upstream source.
 * - strength at read: `min(1, salience · e^(-λ·days) + σ · Σ 1/daysSinceAccess)` with λ=0.01/day,
 *   σ=0.3 (access reinforcement, diminishing per access);
 * - storage decay: ×0.9 per 30 idle days, floored at 0.1, and ONLY rows whose strength actually
 *   changed are written (a scan over fresh records must be a no-op on disk);
 * - tiers: hot ≥ 0.7, warm ≥ 0.4, cold ≥ 0.15;
 * - consolidation gates: ≥5 summaries promote semantic facts; ≥2 patterns with frequency ≥ 2
 *   promote procedural ones.
 *
 * Everything here is pure: given records and a clock, it computes. Persistence and I/O are the
 * caller's concern; there is no in-repository production caller today.
 */

/** A memory record this policy scores. Mirrors agentmemory's strength-bearing rows. */
export interface RetentionRecord {
  id: string;
  /** Author/importance weight in [0, 1] — the `confidence`/`salience` input. */
  salience: number;
  createdAt: number;
  updatedAt: number;
  /** Last time decay was applied; absent = never decayed. */
  lastDecayedAt?: number;
  /** Epoch-ms access timestamps (most recent last). Bounded by the caller. */
  accesses?: readonly number[];
  /** Reinforcement count — each access adds a diminishing term to the read-time score. */
  accessCount?: number;
  strength: number;
}

export type RetentionTier = "hot" | "warm" | "cold" | "expired";

export interface RetentionOptions {
  /** Exponential decay per day (agentmemory: 0.01). */
  decayPerDay?: number;
  /** Access-reinforcement weight σ (agentmemory: 0.3). */
  accessReinforcement?: number;
  /** Storage decay period in days (agentmemory: 30). */
  decayPeriodDays?: number;
  /** Per-period retention factor (agentmemory: 0.9). */
  decayFactor?: number;
  /** Storage floor (agentmemory: 0.1). */
  decayFloor?: number;
}

export const RETENTION_DEFAULTS = {
  decayPerDay: 0.01,
  accessReinforcement: 0.3,
  decayPeriodDays: 30,
  decayFactor: 0.9,
  decayFloor: 0.1,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionTier(strength: number): RetentionTier {
  if (strength >= 0.7) return "hot";
  if (strength >= 0.4) return "warm";
  if (strength >= 0.15) return "cold";
  return "expired";
}

/**
 * Read-time strength: salience decayed exponentially since the last update, plus a diminishing
 * reinforcement over access history (Σ 1/daysSinceAccess, each term ≥1 day old counted as 1).
 * Never stored — a reader must not rewrite history.
 */
export function strengthAt(
  record: RetentionRecord,
  at: number,
  options: RetentionOptions = {},
): number {
  const decayPerDay = options.decayPerDay ?? RETENTION_DEFAULTS.decayPerDay;
  const sigma = options.accessReinforcement ?? RETENTION_DEFAULTS.accessReinforcement;
  const anchor = Math.max(
    ...[record.createdAt, record.updatedAt, record.lastDecayedAt].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    ),
    Number.NEGATIVE_INFINITY,
  );
  const ageDays = Math.max(0, (at - anchor) / DAY_MS);
  const base = record.salience * Math.exp(-decayPerDay * ageDays);
  let reinforcement = 0;
  for (const access of record.accesses ?? []) {
    if (!Number.isFinite(access)) continue;
    const sinceDays = Math.max(1, (at - access) / DAY_MS);
    reinforcement += 1 / sinceDays;
  }
  reinforcement *= sigma / Math.max(1, record.accessCount ?? (record.accesses ?? []).length);
  return Math.min(1, base + reinforcement);
}

/**
 * Storage decay: ×0.9 per 30 idle days since the decay anchor, floored at 0.1. Returns the
 * record copy with updated strength/lastDecayedAt, or `null` when nothing changed — the
 * write-only-what-changed contract from the reference (`decayAndWriteChanged`, pinned by their
 * test `{scanned: 2, written: 1}`).
 */
export function applyDecay(
  record: RetentionRecord,
  at: number,
  options: RetentionOptions = {},
): RetentionRecord | null {
  const periodDays = options.decayPeriodDays ?? RETENTION_DEFAULTS.decayPeriodDays;
  const factor = options.decayFactor ?? RETENTION_DEFAULTS.decayFactor;
  const floor = options.decayFloor ?? RETENTION_DEFAULTS.decayFloor;
  const anchor = Math.max(
    record.lastDecayedAt ?? Number.NEGATIVE_INFINITY,
    record.accesses?.length
      ? record.accesses[record.accesses.length - 1]!
      : Number.NEGATIVE_INFINITY,
    record.updatedAt,
    record.createdAt,
  );
  const idleDays = Math.max(0, (at - anchor) / DAY_MS);
  if (idleDays < periodDays) return null;
  const periods = Math.floor(idleDays / periodDays);
  const decayed = Math.max(floor, record.strength * factor ** periods);
  if (Math.abs(decayed - record.strength) <= 1e-9) return null;
  return { ...record, strength: decayed, lastDecayedAt: at };
}

/** Result of one consolidation pass over a record set. */
export interface ConsolidationResult<T extends RetentionRecord> {
  /** Records promoted to semantic facts (from ≥5 recent summaries). */
  semantic: T[];
  /** Records promoted to procedural patterns (≥2 occurrences at frequency ≥2). */
  procedural: T[];
  /** Records that received storage decay (only those whose strength changed). */
  decayed: T[];
  /** Records evicted by the retention budget, oldest/coldest first. */
  evicted: string[];
  scanned: number;
}

/** A consolidation candidate: a summary observation or a repeated pattern. */
export interface ConsolidationInput {
  /** Summary observations (recent session digests) to promote into semantic facts. */
  summaries?: readonly RetentionRecord[];
  /** Pattern observations with occurrence counts. */
  patterns?: ReadonlyArray<RetentionRecord & { frequency: number }>;
}

export const CONSOLIDATION_GATES = {
  /** ≥5 summaries promote a semantic fact (agentmemory `consolidation-pipeline`). */
  minSummaries: 5,
  /** ≥2 patterns at frequency ≥2 promote procedural knowledge. */
  minPatterns: 2,
  minPatternFrequency: 2,
} as const;

/**
 * One consolidation pass: apply the promotion gates, run storage decay, and (when a budget is
 * given) evict to fit. Promotion output is deterministic — the first `minSummaries` summaries
 * in input order become one semantic batch, and qualifying patterns keep input order.
 */
export function consolidate<T extends RetentionRecord>(
  input: ConsolidationInput,
  at: number,
  options: RetentionOptions & { maxRecords?: number } = {},
): ConsolidationResult<T> {
  const semantic: T[] = [];
  const procedural: T[] = [];
  const summaries = input.summaries ?? [];
  if (summaries.length >= CONSOLIDATION_GATES.minSummaries) {
    semantic.push(...(summaries.slice(0, CONSOLIDATION_GATES.minSummaries) as unknown as T[]));
  }
  for (const pattern of input.patterns ?? []) {
    if (
      pattern.frequency >= CONSOLIDATION_GATES.minPatternFrequency &&
      (input.patterns ?? []).length >= CONSOLIDATION_GATES.minPatterns
    ) {
      procedural.push(pattern as unknown as T);
    }
  }

  const all: T[] = [...semantic, ...procedural];
  const decayed: T[] = [];
  const decayedById = new Map<string, T>();
  for (const record of all) {
    const result = applyDecay(record, at, options);
    if (result !== null) {
      decayed.push(result as T);
      decayedById.set(record.id, result as T);
    }
  }

  const evicted: string[] = [];
  const budget = options.maxRecords;
  if (budget !== undefined && all.length > budget) {
    const ordered = [...all].sort((a, b) => {
      const tier = (r: T): number =>
        ({ hot: 3, warm: 2, cold: 1, expired: 0 })[
          retentionTier(decayedById.get(r.id)?.strength ?? r.strength)
        ];
      const byTier = tier(a) - tier(b);
      if (byTier !== 0) return byTier;
      return a.updatedAt - b.updatedAt;
    });
    while (ordered.length > budget) {
      const victim = ordered.shift();
      if (victim) evicted.push(victim.id);
    }
  }

  return {
    semantic,
    procedural,
    decayed,
    evicted,
    scanned: (input.summaries ?? []).length + (input.patterns ?? []).length,
  };
}
