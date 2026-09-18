/**
 * Credential rotation, rate-limit tracking, and refresh scheduling for the Tool Mesh.
 *
 * This module is the TypeScript port of the Antigravity lineage's proxy fleet math, which
 * exists in two generations in the HPORT corpus:
 *
 *  - `Antigravity-Manager-main` (Rust/Tauri) — `rate_limit.rs`'s `RateLimitTracker` and
 *    `token_manager.rs`'s `ProxyToken`. SUPERSEDED as a code source, but its *math* is
 *    the reference: per-account and per-`account:model` limit keys, a failure-count
 *    expiry (1h) that resets backoff on success, a 300s lockout cap, and the
 *    `classify_rate_limit_reason` discriminator that separates quota exhaustion from a
 *    transient 429 — because only one of them should keep an account parked.
 *  - `AntigravityManager-main` (the later TS rewrite) — the `account-lease` policies:
 *    quota floors for third-party models, sticky session bindings with expiry, and the
 *    `cache-first` / `balance` / `performance-first` selection modes.
 *
 * Both are folded in here as fleet-credential rotation. Nothing in this file is LLM
 * specific: it tracks a *credential's* health, not a model's, and lives under `fleet/`
 * rather than `llm/`.
 *
 * Node built-ins only.
 */
import { randomUUID } from "node:crypto";

/**
 * Why a credential is parked. The distinction matters operationally: quota exhaustion
 * clears on the provider's clock, a rate limit clears on ours, and an auth failure does
 * not clear at all until a human reauthorizes.
 */
export const RATE_LIMIT_REASON = {
  QuotaExhausted: "QuotaExhausted",
  RateLimitExceeded: "RateLimitExceeded",
  ModelCapacityExhausted: "ModelCapacityExhausted",
  ServerError: "ServerError",
  AuthFailure: "AuthFailure",
  Unknown: "Unknown",
} as const;
export type RateLimitReason = (typeof RATE_LIMIT_REASON)[keyof typeof RATE_LIMIT_REASON];

/** Reasons that mean the credential is gone until someone reauthorizes it. */
export const PERMANENT_REASONS: ReadonlySet<RateLimitReason> = new Set([
  RATE_LIMIT_REASON.AuthFailure,
]);

/** Scheduling mode, from the account-lease selection policy. */
export const SELECTION_MODE = {
  /** Prefer the credential already bound to this session — fewest surprises. */
  CacheFirst: "cache-first",
  /** Spread load across healthy credentials. */
  Balance: "balance",
  /** Prefer the healthiest credential regardless of stickiness. */
  PerformanceFirst: "performance-first",
} as const;
export type SelectionMode = (typeof SELECTION_MODE)[keyof typeof SELECTION_MODE];

/**
 * Cap on how long a rate limit parks a credential. Without it, a provider that reports a
 * 24-hour reset keeps the credential out of rotation all day when the real wait is
 * usually minutes. The Antigravity lineage uses 300s; the mesh makes it configurable and
 * keeps the same default.
 */
export const MAX_LOCKOUT_MS = 300_000;

/** A rate-limited credential's failure count expires after this long without a failure. */
export const FAILURE_EXPIRY_MS = 3_600_000;

/** Minimum backoff floor and the multiplier ceiling for exponential growth. */
export const BACKOFF_FLOOR_MS = 1_000;
export const BACKOFF_CEILING_MS = 60_000;
export const BACKOFF_BASE_MS = 2_000;

export interface RateLimitEntry {
  /** Epoch-ms when the parking lifts. */
  resetAt: number;
  /** When the condition was first observed. */
  detectedAt: number;
  reason: RateLimitReason;
  /** Optional capability key, when a single capability is throttled, not the credential. */
  capability?: string;
  /** Consecutive failures feeding the exponential backoff. */
  failureCount: number;
  /** When `failureCount` was last touched, for expiry. */
  failureTouchedAt: number;
}

export interface CredentialHealth {
  credentialId: string;
  status: "healthy" | "cooldown" | "evicted";
  reason?: RateLimitReason;
  cooldownRemainingMs: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: number;
  /** 0..1 — the Antigravity lineage's health score, degraded by failures. */
  healthScore: number;
}

export interface CredentialStats {
  successCount: number;
  failureCount: number;
  lastUsedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

/**
 * Classifies an error body into the reason a credential should be parked. This is a
 * hand-port of the Rust `classify_rate_limit_reason`, with an auth-failure branch added
 * because the mesh must also recognize a revoked refresh token.
 *
 * The order is deliberate, and matches the reference exactly: auth failure first, because
 * a 401 body occasionally contains the word "quota"; then the rate-limit branch, because
 * "resource exhausted" is ambiguous and only explicit quota wording should count as quota.
 * Reordering these makes a transient 429 look like a day-long quota outage.
 */
export function classifyRateLimitReason(
  status: number,
  body: string,
  authHeader?: string,
): RateLimitReason {
  if (status === 401 || status === 403) return RATE_LIMIT_REASON.AuthFailure;
  if (authHeader !== undefined && /invalid[_ ]token|expired/i.test(authHeader)) {
    return RATE_LIMIT_REASON.AuthFailure;
  }

  const text = (body ?? "").toLowerCase();
  if (text.includes("model_capacity")) return RATE_LIMIT_REASON.ModelCapacityExhausted;

  const genericResourceExhausted =
    text.includes("resource has been exhausted") || text.includes("resource_exhausted");
  const explicitQuotaExhausted =
    text.includes("quota_exhausted") ||
    text.includes("quotaresetdelay") ||
    text.includes("quota reset") ||
    text.includes("quota limit") ||
    text.includes("per day") ||
    text.includes("daily quota");

  if (
    text.includes("per minute") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    (genericResourceExhausted && !explicitQuotaExhausted)
  ) {
    return RATE_LIMIT_REASON.RateLimitExceeded;
  }
  if (explicitQuotaExhausted || text.includes("exhausted") || text.includes("quota")) {
    return RATE_LIMIT_REASON.QuotaExhausted;
  }
  if (status >= 500) return RATE_LIMIT_REASON.ServerError;
  return RATE_LIMIT_REASON.Unknown;
}

/**
 * Computes the backoff for `failureCount` consecutive failures, with bounded jitter.
 * Exponential growth is capped at {@link BACKOFF_CEILING_MS} so a persistently failing
 * credential retries on a sane cadence instead of disappearing; jitter is added so a
 * fleet that fails together does not retry in lockstep.
 */
export function backoffFor(failureCount: number, now: number = Date.now()): number {
  const exponent = Math.max(0, Math.min(failureCount, 8));
  const raw = BACKOFF_BASE_MS * 2 ** exponent;
  const clamped = Math.min(Math.max(BACKOFF_FLOOR_MS, raw), BACKOFF_CEILING_MS);
  // Deterministic-ish jitter derived from the clock: tests need reproducibility, and a
  // full PRNG here buys nothing — the goal is spread, not unpredictability.
  const jitter = (now % 97) / 97;
  return Math.round(clamped * (0.75 + 0.5 * jitter));
}

/**
 * Limits key, mirroring the Rust `get_limit_key`: a credential alone, or a credential
 * plus the specific capability that was throttled. Per-capability keys matter because one
 * throttled API call must not park a whole account.
 */
export function limitKey(credentialId: string, capability?: string): string {
  return capability && capability.length > 0 ? `${credentialId}:${capability}` : credentialId;
}

export type RotationEvent =
  | { type: "success"; credentialId: string; capability?: string; at: number }
  | {
      type: "failure";
      credentialId: string;
      capability?: string;
      reason: RateLimitReason;
      at: number;
    }
  | { type: "revived"; credentialId: string; at: number }
  | { type: "evicted"; credentialId: string; reason: RateLimitReason; at: number };

/**
 * Tracks rate limits, failure counts, and health for a fleet of credentials.
 *
 * The state machine a credential moves through:
 *
 *   healthy ──failure──▶ cooldown ──reset──▶ healthy
 *      │                     │
 *      └─auth failure─▶ evicted (only manual reauthorization revives)
 *
 * `markSuccess` resets the failure count, which is the Antigravity insight that matters
 * most: without it, a credential that failed once at 09:00 and succeeded all day still
 * backs off like a repeat offender at 17:00.
 */
export class CredentialRotationTracker {
  private readonly limits = new Map<string, RateLimitEntry>();
  private readonly stats = new Map<string, CredentialStats>();
  private readonly evicted = new Set<string>();
  private readonly listeners = new Set<(event: RotationEvent) => void>();
  private readonly sessionBindings = new Map<string, { credentialId: string; expiresAt: number }>();
  private rotationCursor = -1;

  /** Subscribe to rotation events. Returns an unsubscribe function. */
  onChange(listener: (event: RotationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: RotationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a subscriber must not break rotation
      }
    }
  }

  /** Number of credentials currently parked for any reason. */
  get parkedCount(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.limits.values()) {
      if (entry.resetAt > now) count++;
    }
    return count;
  }

  /** Number of credentials permanently evicted. */
  get evictedCount(): number {
    return this.evicted.size;
  }

  /** Whether a credential has been permanently evicted (auth failure / reauth needed). */
  isEvicted(credentialId: string): boolean {
    return this.evicted.has(credentialId);
  }

  /** Seconds remaining until a credential (optionally a capability) is usable again. */
  remainingWaitMs(credentialId: string, capability?: string, now: number = Date.now()): number {
    if (this.evicted.has(credentialId)) return Number.POSITIVE_INFINITY;

    // Global credential lock first, then the finer capability lock.
    const global = this.limits.get(credentialId);
    if (global && global.resetAt > now) return global.resetAt - now;

    const key = limitKey(credentialId, capability);
    const entry = this.limits.get(key);
    if (entry && entry.resetAt > now) return entry.resetAt - now;

    return 0;
  }

  /** Whether a credential may be used right now. */
  isUsable(credentialId: string, capability?: string, now: number = Date.now()): boolean {
    return (
      !this.evicted.has(credentialId) && this.remainingWaitMs(credentialId, capability, now) === 0
    );
  }

  /**
   * Parks a credential until `resetAt`, classifying the reason first. Auth failures
   * bypass every cooldown and evict immediately — no amount of waiting fixes a revoked
   * token, and retrying it just burns the provider's rate budget.
   */
  markFailure(
    credentialId: string,
    status: number,
    body: string,
    options: { capability?: string; resetAt?: number; authHeader?: string } = {},
    now: number = Date.now(),
  ): RateLimitReason {
    const reason = classifyRateLimitReason(status, body, options.authHeader);
    if (reason === RATE_LIMIT_REASON.AuthFailure) {
      this.evict(credentialId, reason, now);
      return reason;
    }

    const key = limitKey(credentialId, options.capability);
    const existing = this.limits.get(key);
    const failureCount = this.nextFailureCount(credentialId, existing, now);

    let resetAt = options.resetAt;
    if (resetAt === undefined) {
      // Quota exhaustion is parked for the provider's reported window (capped); a rate
      // limit uses the exponential backoff derived from the failure count.
      resetAt =
        reason === RATE_LIMIT_REASON.QuotaExhausted
          ? now + Math.min(MAX_LOCKOUT_MS, backoffFor(failureCount, now) * 4)
          : now + backoffFor(failureCount, now);
    } else if (resetAt < now) {
      resetAt = now + BACKOFF_FLOOR_MS;
    }

    this.limits.set(key, {
      resetAt,
      detectedAt: now,
      reason,
      ...(options.capability !== undefined ? { capability: options.capability } : {}),
      failureCount,
      failureTouchedAt: now,
    });

    const stats = this.statsOf(credentialId);
    stats.failureCount++;
    stats.lastFailureAt = now;

    this.emit({
      type: "failure",
      credentialId,
      capability: options.capability,
      reason,
      at: now,
    });
    return reason;
  }

  /** Records a success and clears all parking for the credential, as `mark_success` does. */
  markSuccess(credentialId: string, capability?: string, now: number = Date.now()): void {
    this.evicted.delete(credentialId);
    this.limits.delete(credentialId);
    if (capability !== undefined) this.limits.delete(limitKey(credentialId, capability));

    const stats = this.statsOf(credentialId);
    stats.successCount++;
    stats.lastSuccessAt = now;
    stats.lastUsedAt = now;

    this.emit({ type: "success", credentialId, capability, at: now });
  }

  /** Revives a credential by hand, after a reauthorization. */
  revive(credentialId: string, now: number = Date.now()): void {
    this.evicted.delete(credentialId);
    this.limits.delete(credentialId);
    this.emit({ type: "revived", credentialId, at: now });
  }

  /** Permanently removes a credential from rotation. */
  evict(credentialId: string, reason: RateLimitReason, now: number = Date.now()): void {
    this.evicted.add(credentialId);
    this.limits.delete(credentialId);
    const stats = this.statsOf(credentialId);
    stats.failureCount++;
    stats.lastFailureAt = now;
    this.emit({ type: "evicted", credentialId, reason, at: now });
  }

  /** Health snapshot for one credential. */
  health(credentialId: string, now: number = Date.now()): CredentialHealth {
    const stats = this.statsOf(credentialId);
    const remaining = this.remainingWaitMs(credentialId, undefined, now);
    const entry = this.limits.get(credentialId);
    if (this.evicted.has(credentialId)) {
      return {
        credentialId,
        status: "evicted",
        reason: RATE_LIMIT_REASON.AuthFailure,
        cooldownRemainingMs: Number.POSITIVE_INFINITY,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        ...(stats.lastUsedAt !== undefined ? { lastUsedAt: stats.lastUsedAt } : {}),
        healthScore: 0,
      };
    }
    return {
      credentialId,
      status: remaining > 0 ? "cooldown" : "healthy",
      ...(entry?.reason !== undefined ? { reason: entry.reason } : {}),
      cooldownRemainingMs: Math.max(0, remaining),
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      ...(stats.lastUsedAt !== undefined ? { lastUsedAt: stats.lastUsedAt } : {}),
      healthScore: healthScore(stats),
    };
  }

  /** Health for the whole fleet, cheapest credentials first. */
  fleetHealth(now: number = Date.now()): CredentialHealth[] {
    const ids = new Set<string>([...this.limits.keys(), ...this.stats.keys(), ...this.evicted]);
    return [...ids]
      .map((id) => this.health(id, now))
      .sort(
        (a, b) => b.healthScore - a.healthScore || a.credentialId.localeCompare(b.credentialId),
      );
  }

  /** Clears all state. For tests and a full fleet reset. */
  clear(): void {
    this.limits.clear();
    this.stats.clear();
    this.evicted.clear();
    this.sessionBindings.clear();
    this.rotationCursor = -1;
  }

  /** Drops a session's sticky binding, or all bindings for a credential. */
  releaseSession(sessionKey?: string, credentialId?: string): void {
    if (sessionKey !== undefined) {
      this.sessionBindings.delete(sessionKey);
      return;
    }
    if (credentialId === undefined) return;
    for (const [key, binding] of this.sessionBindings) {
      if (binding.credentialId === credentialId) this.sessionBindings.delete(key);
    }
  }

  /**
   * Selects the next credential under a scheduling mode, with sticky sessions. Kept on the
   * tracker so the cursor and bindings belong to the fleet they rotate, not to the module.
   */
  select(request: Omit<SelectCredentialRequest, "now"> & { now?: number }): string | undefined {
    const now = request.now ?? Date.now();
    return selectCredential({ ...request, now }, this);
  }

  /** Advances the round-robin cursor and returns the next id from a sorted candidate list. */
  nextRotation(ids: readonly string[]): string {
    this.rotationCursor = (this.rotationCursor + 1) % ids.length;
    return ids[this.rotationCursor]!;
  }

  /** Binds a session to a credential for {@link SESSION_BINDING_MS}. */
  bindSession(sessionKey: string, credentialId: string, now: number): void {
    this.sessionBindings.set(sessionKey, {
      credentialId,
      expiresAt: now + SESSION_BINDING_MS,
    });
  }

  /** Reads a live sticky binding, or undefined if it lapsed or was released. */
  sessionBinding(sessionKey: string, now: number = Date.now()): string | undefined {
    const binding = this.sessionBindings.get(sessionKey);
    if (binding === undefined || binding.expiresAt <= now) return undefined;
    return binding.credentialId;
  }

  private statsOf(credentialId: string): CredentialStats {
    let stats = this.stats.get(credentialId);
    if (stats === undefined) {
      stats = { successCount: 0, failureCount: 0 };
      this.stats.set(credentialId, stats);
    }
    return stats;
  }

  private nextFailureCount(
    credentialId: string,
    existing: RateLimitEntry | undefined,
    now: number,
  ): number {
    if (existing !== undefined && now - existing.failureTouchedAt > FAILURE_EXPIRY_MS) {
      return 1;
    }
    return (existing?.failureCount ?? 0) + 1;
  }
}

/**
 * Health score in 0..1, from the Antigravity `ProxyToken.health_score`. Fresh credentials
 * are 1.0; each failure costs, and successes recover it — but a credential that has only
 * ever failed must not score above one that has only ever succeeded.
 */
export function healthScore(stats: CredentialStats): number {
  const total = stats.successCount + stats.failureCount;
  if (total === 0) return 1;
  const ratio = stats.successCount / total;
  // A credential with recent failures is discounted below its lifetime ratio.
  const recencyPenalty =
    stats.lastFailureAt !== undefined &&
    (stats.lastSuccessAt === undefined || stats.lastFailureAt > stats.lastSuccessAt)
      ? 0.1
      : 0;
  return Math.max(0, Math.min(1, ratio - recencyPenalty));
}

export interface SelectCredentialRequest {
  /** Candidate credential ids with a precomputed health score each. */
  candidates: readonly { credentialId: string; healthScore: number }[];
  /** Session key for sticky selection. */
  sessionKey?: string;
  /** Optional capability, for per-capability parking. */
  capability?: string;
  now: number;
  mode: SelectionMode;
  /** Credential already preferred by the caller (a configured default). */
  preferred?: string;
}

/**
 * Selects the next credential under a scheduling mode, with sticky sessions.
 *
 * Cache-first binds a session to the first credential that served it and keeps it there
 * until that credential is parked — the Antigravity sticky-session behavior, which keeps
 * a provider-side session on one account. Balance rotates round-robin across the healthy
 * set. Performance-first always takes the highest score.
 */
export function selectCredential(
  request: SelectCredentialRequest,
  tracker: CredentialRotationTracker,
): string | undefined {
  const usable = request.candidates.filter(
    (candidate) =>
      !tracker.isEvicted(candidate.credentialId) &&
      tracker.remainingWaitMs(candidate.credentialId, request.capability, request.now) === 0,
  );
  if (usable.length === 0) return undefined;

  if (request.mode === SELECTION_MODE.CacheFirst && request.sessionKey) {
    const binding = tracker.sessionBinding(request.sessionKey, request.now);
    if (binding && usable.some((candidate) => candidate.credentialId === binding)) {
      return binding;
    }
    const chosen = chooseByMode(usable, request, tracker);
    tracker.bindSession(request.sessionKey, chosen, request.now);
    return chosen;
  }

  const preferred = request.preferred;
  if (preferred && usable.some((candidate) => candidate.credentialId === preferred)) {
    return preferred;
  }
  return chooseByMode(usable, request, tracker);
}

/** How long a sticky session stays bound to one credential. */
export const SESSION_BINDING_MS = 30 * 60 * 1000;

function chooseByMode(
  usable: readonly { credentialId: string; healthScore: number }[],
  request: SelectCredentialRequest,
  tracker: CredentialRotationTracker,
): string {
  if (request.mode === SELECTION_MODE.PerformanceFirst) {
    return [...usable].sort((a, b) => b.healthScore - a.healthScore)[0]!.credentialId;
  }
  // Balance: round-robin with a stable cursor over the sorted candidate list.
  const ids = usable.map((candidate) => candidate.credentialId).sort((a, b) => a.localeCompare(b));
  return tracker.nextRotation(ids);
}

/**
 * A refresh job the scheduler owns. The Antigravity lineage refreshes tokens with a
 * double-checked lock so a burst of concurrent requests does not fire N refreshes for one
 * account; this scheduler achieves the same with one in-flight promise per credential.
 */
export interface RefreshJob {
  readonly id: string;
  readonly credentialId: string;
  /** Epoch-ms when the refresh should run. */
  readonly dueAt: number;
  readonly attempt: number;
}

export interface RefreshSchedulerOptions {
  /** Refresh this far before expiry, so a slow provider does not cause a gap. */
  leadTimeMs?: number;
  /** Minimum interval between refresh attempts for one credential. */
  minIntervalMs?: number;
  /** Maximum refresh attempts before the credential is marked failed. */
  maxAttempts?: number;
  /** Clock source, for tests. */
  now?: () => number;
}

/**
 * Schedules credential refreshes from expiry times. It computes due dates, de-duplicates
 * in-flight work per credential, and backoffs retries — the rotation half of the mesh.
 *
 * The scheduler does not itself touch the network: `runDue` accepts a refresh callback, so
 * the transport stays injectable and a test never needs a real provider.
 */
export class CredentialRefreshScheduler {
  private readonly jobs = new Map<string, RefreshJob>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly options: Required<RefreshSchedulerOptions>;

  constructor(options: RefreshSchedulerOptions = {}) {
    this.options = {
      leadTimeMs: options.leadTimeMs ?? 60_000,
      minIntervalMs: options.minIntervalMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 5,
      now: options.now ?? (() => Date.now()),
    };
  }

  /** Number of refresh jobs currently scheduled. */
  get scheduledCount(): number {
    return this.jobs.size;
  }

  /** Number of refreshes currently executing. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Schedules a refresh for a credential expiring at `expiresAt`. A credential without an
   * expiry (an API key) is never scheduled — there is nothing to refresh.
   */
  schedule(credentialId: string, expiresAt: number | undefined): RefreshJob | undefined {
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return undefined;
    const dueAt = Math.max(this.options.now(), expiresAt - this.options.leadTimeMs);
    const existing = this.jobs.get(credentialId);
    if (existing && existing.dueAt <= dueAt) return existing;
    const job: RefreshJob = {
      id: randomUUID(),
      credentialId,
      dueAt,
      attempt: existing?.attempt ?? 0,
    };
    this.jobs.set(credentialId, job);
    return job;
  }

  /** Deschedules a credential (deleted or reauthorized). */
  cancel(credentialId: string): void {
    this.jobs.delete(credentialId);
  }

  /** Jobs due now or in the past, earliest first. */
  dueJobs(): readonly RefreshJob[] {
    const now = this.options.now();
    return [...this.jobs.values()]
      .filter((job) => job.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** The scheduled job for a credential, or nothing if none is scheduled. */
  jobFor(credentialId: string): RefreshJob | undefined {
    return this.jobs.get(credentialId);
  }

  /**
   * Runs every due refresh through `refresh`. Returns the number that succeeded.
   * Concurrency is collapsed: a credential already refreshing yields its in-flight
   * promise rather than starting a second refresh — the double-checked lock, without a lock.
   */
  async runDue(
    refresh: (credentialId: string, attempt: number) => Promise<boolean>,
  ): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;
    for (const job of this.dueJobs()) {
      const result = await this.runOne(job.credentialId, job.attempt, refresh);
      if (result) succeeded++;
      else failed++;
    }
    return { succeeded, failed };
  }

  /** Runs one refresh with de-duplication and retry accounting. */
  async runOne(
    credentialId: string,
    attempt: number,
    refresh: (credentialId: string, attempt: number) => Promise<boolean>,
  ): Promise<boolean> {
    const existing = this.inFlight.get(credentialId);
    if (existing) return existing;

    // The job as it stands before the refresh runs. A callback that reschedules during the
    // refresh replaces this entry, which is how it tells the scheduler it owns the next due
    // date; comparing identity afterwards separates that from a callback that did nothing.
    const priorJob = this.jobs.get(credentialId);

    const promise = (async (): Promise<boolean> => {
      try {
        const ok = await refresh(credentialId, attempt);
        if (ok) {
          // Success consumes the spent job. The caller reschedules from the new expiry — if
          // it did not, the entry is stale and must go, or the old due date would re-run the
          // refresh on the next tick.
          if (this.jobs.get(credentialId) === priorJob) this.jobs.delete(credentialId);
        } else {
          // A callback that canceled the entry retired the credential: a refresh that dies on
          // auth is not retryable, and backing it off would resurrect a dead token. Only a
          // job still waiting gets a backoff.
          if (this.jobs.has(credentialId)) this.recordFailure(credentialId, attempt);
        }
        return ok;
      } catch {
        if (this.jobs.has(credentialId)) this.recordFailure(credentialId, attempt);
        return false;
      } finally {
        this.inFlight.delete(credentialId);
      }
    })();

    this.inFlight.set(credentialId, promise);
    return promise;
  }

  private recordFailure(credentialId: string, attempt: number): void {
    const nextAttempt = attempt + 1;
    if (nextAttempt >= this.options.maxAttempts) {
      this.jobs.delete(credentialId);
      return;
    }
    const job = this.jobs.get(credentialId);
    const dueAt = this.options.now() + backoffFor(nextAttempt, this.options.now());
    this.jobs.set(credentialId, {
      id: job?.id ?? randomUUID(),
      credentialId,
      dueAt,
      attempt: nextAttempt,
    });
  }
}
