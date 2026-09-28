/**
 * A keyed registry of expensive, read-only verification runs that concurrent agents can share.
 *
 * WHAT IT DOES. One agent starts `vitest run`; a second agent, asking the same question about the
 * same tree, joins the run that is already in flight rather than starting a second copy of the
 * same work. A third, arriving after it finished, takes the retained result. The three outcomes
 * are reported separately and never blurred: `JOINED` is a wait on someone else's work, `REUSED`
 * is a retained result, and `RAN` is doing it yourself.
 *
 * WHAT IT REFUSES TO DO, AND WHY EACH REFUSAL IS THE WHOLE POINT
 *
 * 1. **It never shares without a fingerprint.** `policy.ts` decides whether an operation is
 *    observably free of effects; this module decides whether its answer is still true. Both must
 *    say yes. An operation with no fingerprint is not "shared less carefully", it is not shared,
 *    because the alternative is handing out an answer whose age nobody can measure.
 * 2. **It never blocks indefinitely.** Every wait is a race against a timer, and a caller that
 *    loses the race runs the work itself. The product owner's rule — "if the first has a lengthy
 *    work, can create a 2nd if needed" — is the reason a caller CAN become a second runner, and
 *    it is why this registry holds a *list* of in-flight runs per key rather than one: a second
 *    caller who gave up waiting does not vacate the slot, so a third caller can use whichever run
 *    finishes first.
 * 3. **It never inherits a failure.** A joined run that failed or threw means the waiting caller
 *    runs the work itself and says so. A failure is a result, but it is not one that transfers:
 *    the owner is entitled to have run it themselves. `shareFailures` turns this off for a caller
 *    who has decided otherwise, and even then `inherited` stays `true`, so a caller that was
 *    handed a failure can always tell that it was handed one.
 * 4. **It never retains a result whose tree moved while it ran.** After `execute()` returns, the
 *    fingerprint is recomputed; a mismatch means the answer describes a tree that no longer
 *    exists, and it is discarded rather than cached. This is the case that keying alone cannot
 *    catch: the run started at a state and ended at another, and only the second reading knows.
 * 5. **It is bounded by count, by bytes and by age.** Completed results are a cache, and a cache
 *    without a bound is a memory leak with a good reputation. Evictions are counted and exposed,
 *    never silent — a registry quietly dropping what it holds is indistinguishable from one that
 *    never stored it.
 *
 * WHAT IS IN THE SCOPE OF THE GUARANTEE. Sharing is decided per workspace and per key. A result
 * is only ever handed to a caller whose own fingerprint matches, computed at the moment of the
 * call. What this cannot do is make a test suite hermetic, and the honest limit is stated in
 * `policy.ts`: a test file can write wherever it likes, and what bounds that is the roots the
 * caller chose plus `invalidateAll()` at the boundaries the fingerprint cannot see (a dependency
 * reinstall, most obviously).
 *
 * THE SHARED OBJECT IS SHARED. `value` is handed over by reference, because deep-cloning a test
 * result to protect a caller from itself would cost more than the run it saved. Callers treat
 * their result as immutable, which is what `readonly` in `OperationOutcome` asks of them.
 */

import { fingerprintOperation, shareKey, type FingerprintInput } from "./fingerprint.js";
import { admitOperation, type ExcludeReason, type ShareOperationSpec } from "./policy.js";

/**
 * What a caller hands back after running. `bytes` is required rather than estimated here because
 * the registry's byte bound has to be decided by someone who knows the real size; a registry that
 * guessed would be a byte bound in name only.
 */
export interface OperationOutcome<T> {
  readonly value: T;
  /** Bytes this result occupies while retained. */
  readonly bytes: number;
  /** Whether the operation itself failed, by the caller's own definition. */
  readonly failed?: boolean;
}

/** How a caller got its result. `own` means it did the work, whatever else is true. */
export type ShareOrigin = "own" | "joined-in-flight" | "completed-entry";

export interface SharedRun<T> {
  /** `JOINED` waited on a run already in progress; `REUSED` took a retained result; `RAN` worked. */
  readonly outcome: "JOINED" | "REUSED" | "RAN";
  readonly value: T;
  /** The operation's own success/failure, never the sharing mechanism's. */
  readonly failed: boolean;
  /** True when `value` was produced by another caller's execution. */
  readonly inherited: boolean;
  /** Time this caller actually spent blocked before it had a value. */
  readonly waitedMs: number;
  /** Someone else's execution time this caller avoided. Zero when it ran the work. */
  readonly msAvoidedMs: number;
  readonly origin: ShareOrigin;
  /** True when the caller waited and then ran the work itself anyway. */
  readonly fellBack: boolean;
  /** The share key, or null when the operation was not shareable and nothing was keyed. */
  readonly key: string | null;
  /** Why it was not shareable, when `key` is null. */
  readonly excluded: ExcludeReason | null;
  /** Whether this result was retained for later callers. */
  readonly stored: boolean;
}

export interface ShareRegistryLimits {
  /**
   * Default ceiling on how long a caller waits for someone else's run before running it itself.
   * Long enough that a second agent normally saves the whole run; short enough that a stuck
   * runner costs a duplicate run rather than a stalled agent.
   */
  readonly waitMs: number;
  /** Ceiling on callers waiting against one key at once. Beyond it, callers run immediately. */
  readonly maxWaiters: number;
  /** Ceiling on simultaneous runs of one key. Bounds the cost of everyone giving up at once. */
  readonly maxConcurrentRuns: number;
  /** Retained results. */
  readonly maxEntries: number;
  /** A single result larger than this is not retained at all. */
  readonly maxEntryBytes: number;
  /** Total retained bytes across all entries. */
  readonly maxTotalBytes: number;
  /** A retained result older than this is not reused, however well its key still matches. */
  readonly maxEntryAgeMs: number;
}

export const DEFAULT_SHARE_LIMITS: ShareRegistryLimits = {
  waitMs: 15_000,
  maxWaiters: 8,
  maxConcurrentRuns: 3,
  maxEntries: 64,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxEntryAgeMs: 10 * 60 * 1000,
};

export interface ShareRegistryOptions {
  readonly now?: () => number;
  readonly limits?: Partial<ShareRegistryLimits>;
  /**
   * Retain and hand over failures as failures. Off by default, and the reason is in the module
   * header: a caller is entitled to have run a failing check itself. When it is on, a caller
   * receiving a failure still gets `inherited: true` and `failed: true`, so "I ran it and it
   * failed" and "someone else ran it and it failed" never look the same.
   */
  readonly shareFailures?: boolean;
}

/**
 * The counters as the registry HOLDS them. Deliberately mutable and deliberately not exported:
 * a reader's view of a number must not be a handle for changing it, and the way to guarantee
 * that is to have exactly one declaration of the fields and derive the read-only view from it,
 * rather than maintaining a second interface that can drift from the first.
 */
interface Counters {
  calls: number;
  ran: number;
  joined: number;
  reused: number;
  /** Arrived while the key was at its waiter cap, and ran immediately instead of waiting. */
  waiterCapHit: number;
  /** Passed `waitMs: 0` while runs were in flight. */
  noWait: number;
  /** Needed to run while the key was already at `maxConcurrentRuns`. */
  concurrencyCapHit: number;
  /** Waited the full budget on an in-flight run, then ran the work itself. */
  waitTimedOut: number;
  /** Reached a settled in-flight run that failed, and ran the work itself instead. */
  joinedFailureNotInherited: number;
  /** A joined run failed its post-run freshness check, so the caller ran its own work. */
  joinedStaleNotInherited: number;
  /** A result whose tree moved while it ran, so it was discarded instead of retained. */
  discardedTreeMovedDuringRun: number;
  /** The registry was invalidated while a run was active, so its answer was not cached. */
  discardedInvalidatedDuringRun: number;
  /** A failure that was run and deliberately not retained, because `shareFailures` is off. */
  failuresNotRetained: number;
  /** A run the caller asked not to have retained (`cacheResult: false`). */
  notRetainedByCaller: number;
  /** `execute` threw. Counted here, and rethrown to the owner unchanged. */
  errors: number;
  /** Joins and reuses per program. Keyed by the allowlist, so this cannot grow with traffic. */
  byProgram: Record<string, number>;
  refusals: Record<ExcludeReason, number>;
  evictions: {
    count: number;
    /** Dropped for being past `maxEntryAgeMs`. */
    expired: number;
    /** Dropped to stay inside `maxEntries` or `maxTotalBytes`. */
    lru: number;
    /** Never retained: larger than `maxEntryBytes` or `maxTotalBytes`. */
    oversize: number;
    bytes: number;
  };
  /** Time callers spent blocked. */
  waitedMs: number;
  /** Execution time callers avoided by sharing. */
  msAvoidedMs: number;
  /** Fingerprints computed, which is roughly the number of filesystem walks. */
  fingerprints: number;
  /** Explicit `invalidateAll()` calls and the entries they dropped. */
  invalidations: { calls: number; entries: number };
}

/** The read-only view of {@link Counters.evictions} that a caller receives. */
export type ShareEvictionCounters = Readonly<Counters["evictions"]>;

/** The read-only view of the registry's counters. Every number here is a report, not a control. */
export type ShareCounters = { readonly [K in keyof Counters]: Readonly<Counters[K]> };

export interface ShareStats {
  readonly counters: ShareCounters;
  readonly live: {
    readonly entries: number;
    readonly bytes: number;
    readonly inFlightKeys: number;
    readonly inFlightRuns: number;
    /**
     * Callers currently blocked on someone else's run. The number a host wants when a
     * verification looks stuck: it separates "one run is slow" from "ten agents are waiting on
     * one slow run", and it is the only place the registry's internal waiter accounting is
     * visible at all.
     */
    readonly waiters: number;
  };
  readonly limits: ShareRegistryLimits;
  /** Whether failures are retained and shareable. See {@link ShareRegistryOptions.shareFailures}. */
  readonly shareFailures: boolean;
}

type FlightResult<T> =
  | {
      readonly status: "ok";
      readonly outcome: OperationOutcome<T>;
      readonly durationMs: number;
      readonly fresh: boolean;
      readonly generation: number;
    }
  | { readonly status: "error"; readonly error: unknown; readonly durationMs: number };

interface Flight {
  readonly key: string;
  readonly startedAt: number;
  readonly promise: Promise<FlightResult<unknown>>;
  waiters: number;
}

interface CompletedEntry {
  readonly key: string;
  readonly program: string;
  /** When the result was produced. Never refreshed by a later identical store, so an entry ages
   *  out on schedule instead of being kept alive by a repeated run of the same question. */
  readonly createdAt: number;
  lastUsedAt: number;
  hits: number;
  bytes: number;
  /** The owner's execution time, reported to whoever inherits the result. Refreshed in place. */
  durationMs: number;
  value: unknown;
  failed: boolean;
}

function refusalTable(): Record<ExcludeReason, number> {
  return {
    "declared-effects": 0,
    "unknown-program": 0,
    "command-shape": 0,
    "tool-requires-flag": 0,
    "no-fingerprint": 0,
  };
}

function programTable(): Counters["byProgram"] {
  return {
    vitest: 0,
    jest: 0,
    node: 0,
    eslint: 0,
    oxlint: 0,
    biome: 0,
    prettier: 0,
    tsc: 0,
    tsgo: 0,
  };
}

/**
 * Races `promise` against a timer. The timer is unref'd, so a caller that loses the race leaves
 * nothing behind to hold the process open — a registry that kept a pending timer alive would make
 * every CLI that used it wait to exit.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ readonly timedOut: true } | { readonly timedOut: false; readonly value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  const settled = promise.then((value) => ({ timedOut: false as const, value }));
  try {
    return await Promise.race([settled, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class OperationShareRegistry {
  private readonly now: () => number;
  private readonly limits: ShareRegistryLimits;
  private readonly shareFailures: boolean;
  private readonly completed = new Map<string, CompletedEntry>();
  private readonly flights = new Map<string, Flight[]>();
  private completedBytes = 0;
  private invalidationGeneration = 0;
  private counters: Counters = {
    calls: 0,
    ran: 0,
    joined: 0,
    reused: 0,
    waiterCapHit: 0,
    noWait: 0,
    concurrencyCapHit: 0,
    waitTimedOut: 0,
    joinedFailureNotInherited: 0,
    joinedStaleNotInherited: 0,
    discardedTreeMovedDuringRun: 0,
    discardedInvalidatedDuringRun: 0,
    failuresNotRetained: 0,
    notRetainedByCaller: 0,
    errors: 0,
    byProgram: programTable(),
    refusals: refusalTable(),
    evictions: { count: 0, expired: 0, lru: 0, oversize: 0, bytes: 0 },
    waitedMs: 0,
    msAvoidedMs: 0,
    fingerprints: 0,
    invalidations: { calls: 0, entries: 0 },
  };

  constructor(options: ShareRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.shareFailures = options.shareFailures ?? false;
    this.limits = { ...DEFAULT_SHARE_LIMITS, ...(options.limits ?? {}) };
  }

  /**
   * Runs `execute`, or takes someone else's run of the identical question.
   *
   * The order of the checks is the design. Admission is pure and costs nothing, so an operation
   * that is not shareable pays no filesystem walk at all. The fingerprint comes next because it
   * is what makes the key mean something. Only then is the cache consulted, and only after that is
   * there any question of waiting — a caller that can be answered instantly is never made to
   * queue behind one that cannot.
   */
  async run<T>(
    spec: ShareOperationSpec,
    dependencies: FingerprintInput,
    execute: () => Promise<OperationOutcome<T>>,
    runOptions: { readonly waitMs?: number } = {},
  ): Promise<SharedRun<T>> {
    this.counters.calls += 1;

    const decision = admitOperation(spec);
    if (!decision.admitted) {
      this.counters.refusals[decision.reason] += 1;
      return this.runAlone(execute, decision.reason);
    }

    const before = await fingerprintOperation(dependencies);
    if (!before.ok) {
      // Fail closed. A tree that cannot be walked is a tree whose verdict must not be handed to
      // another agent, and the cost of that decision is one duplicate run.
      this.counters.refusals["no-fingerprint"] += 1;
      return this.runAlone(execute, "no-fingerprint");
    }
    this.counters.fingerprints += 1;
    const key = shareKey({
      program: decision.program,
      argv: spec.argv,
      scope: spec.cwd,
      fingerprintHex: before.hex,
    });

    const now = this.now();
    this.pruneExpired(now);
    const cached = this.completed.get(key);
    if (cached !== undefined) {
      cached.lastUsedAt = now;
      cached.hits += 1;
      this.counters.reused += 1;
      this.counters.byProgram[decision.program] =
        (this.counters.byProgram[decision.program] ?? 0) + 1;
      this.counters.msAvoidedMs += cached.durationMs;
      return {
        outcome: "REUSED",
        value: cached.value as T,
        failed: cached.failed,
        inherited: true,
        waitedMs: 0,
        msAvoidedMs: cached.durationMs,
        origin: "completed-entry",
        fellBack: false,
        key,
        excluded: null,
        stored: true,
      };
    }

    const flights = this.flights.get(key) ?? [];
    let fellBack = false;
    // Measured around the wait itself, not from the top of this method: a caller that never
    // queued behind anyone waited zero, and reporting its fingerprint walk as "waited" would make
    // the number mean two different things.
    let waitedMs = 0;
    const waitMs = runOptions.waitMs ?? this.limits.waitMs;
    if (flights.length > 0) {
      const waiters = flights.reduce((total, flight) => total + flight.waiters, 0);
      if (waiters >= this.limits.maxWaiters) {
        // A queue, not a share. Running immediately is better than joining a pile-up behind a
        // run that is evidently not finishing fast enough for anyone.
        this.counters.waiterCapHit += 1;
      } else if (waitMs <= 0) {
        this.counters.noWait += 1;
      } else {
        const waitStart = this.now();
        for (const flight of flights) flight.waiters += 1;
        const settled = await withDeadline(
          Promise.race(flights.map((flight) => flight.promise)),
          waitMs,
        );
        for (const flight of flights) flight.waiters -= 1;
        waitedMs = this.now() - waitStart;
        this.counters.waitedMs += waitedMs;
        fellBack = true;
        if (settled.timedOut) {
          this.counters.waitTimedOut += 1;
        } else {
          const result = settled.value;
          if (
            result.status === "ok" &&
            result.fresh &&
            result.generation === this.invalidationGeneration &&
            (!result.outcome.failed || this.shareFailures)
          ) {
            this.counters.joined += 1;
            this.counters.byProgram[decision.program] =
              (this.counters.byProgram[decision.program] ?? 0) + 1;
            this.counters.msAvoidedMs += result.durationMs;
            return {
              outcome: "JOINED",
              value: result.outcome.value as T,
              failed: result.outcome.failed === true,
              inherited: true,
              waitedMs,
              msAvoidedMs: result.durationMs,
              origin: "joined-in-flight",
              fellBack: false,
              key,
              excluded: null,
              stored: true,
            };
          }
          if (
            result.status === "ok" &&
            (!result.fresh || result.generation !== this.invalidationGeneration)
          ) {
            this.counters.joinedStaleNotInherited += 1;
          } else {
            this.counters.joinedFailureNotInherited += 1;
          }
        }
      }
    }

    return this.runAsOwner({
      key,
      program: decision.program,
      dependencies,
      execute,
      fingerprintHex: before.hex,
      flights,
      waitedMs,
      fellBack,
      retain: spec.cacheResult !== false,
    });
  }

  /**
   * The unshareable path. Deliberately does no fingerprinting, keeps no flight, and reports
   * `key: null` — a caller that gets a result with no key has a fact it can act on (this one was
   * not shared) rather than a null it has to interpret.
   *
   * `waitedMs` is zero because it is: this caller never queued behind anyone, and the work it
   * just did is its own, not time spent blocked. Counting the execution here would be the same
   * number the caller times on its own clock.
   */
  private async runAlone<T>(
    execute: () => Promise<OperationOutcome<T>>,
    excluded: ExcludeReason,
  ): Promise<SharedRun<T>> {
    this.counters.ran += 1;
    try {
      const outcome = await execute();
      return {
        outcome: "RAN",
        value: outcome.value,
        failed: outcome.failed === true,
        inherited: false,
        waitedMs: 0,
        msAvoidedMs: 0,
        origin: "own",
        fellBack: false,
        key: null,
        excluded,
        stored: false,
      };
    } catch (error) {
      this.counters.errors += 1;
      throw error;
    }
  }

  /**
   * Runs the work, publishing it as a flight so the next caller can use it.
   *
   * The flight promise RESOLVES with a result object rather than rejecting, for two reasons: a
   * joiner gets a uniform shape to branch on, and a flight nobody ever joined cannot produce an
   * unhandled rejection that takes a process down. The owner still sees the original error
   * rethrown from its own reference to the same promise.
   */
  private async runAsOwner<T>(options: {
    readonly key: string;
    readonly program: string;
    readonly dependencies: FingerprintInput;
    readonly execute: () => Promise<OperationOutcome<T>>;
    readonly fingerprintHex: string;
    readonly flights: Flight[];
    readonly waitedMs: number;
    readonly fellBack: boolean;
    readonly retain: boolean;
  }): Promise<SharedRun<T>> {
    const { key, program, dependencies, execute, fingerprintHex, flights } = options;
    const startedAt = this.now();
    const generation = this.invalidationGeneration;
    const runOnce = async (): Promise<FlightResult<T>> => {
      try {
        const outcome = await execute();
        const durationMs = this.now() - startedAt;
        // A waiter must not see the result until the owner's freshness proof is complete.
        // Otherwise it can inherit a verdict for a tree that changed during execution.
        let fingerprintFresh = false;
        try {
          const after = await fingerprintOperation(dependencies);
          this.counters.fingerprints += 1;
          fingerprintFresh = after.ok && after.hex === fingerprintHex;
          if (after.ok && after.hex !== fingerprintHex) {
            this.counters.discardedTreeMovedDuringRun += 1;
          }
        } catch {
          this.counters.fingerprints += 1;
        }
        const sameGeneration = generation === this.invalidationGeneration;
        if (!sameGeneration) this.counters.discardedInvalidatedDuringRun += 1;
        return {
          status: "ok",
          outcome,
          durationMs,
          fresh: fingerprintFresh && sameGeneration,
          generation,
        };
      } catch (error) {
        return { status: "error", error, durationMs: this.now() - startedAt };
      }
    };
    const typed = runOnce();
    // `FlightResult` is covariant in T through a readonly field, so the typed promise is
    // assignable to the untyped one a Flight holds without a cast in either direction.
    const published: Promise<FlightResult<unknown>> = typed;

    const registerable = flights.length < this.limits.maxConcurrentRuns;
    if (registerable) {
      flights.push({ key, startedAt, promise: published, waiters: 0 });
      this.flights.set(key, flights);
    } else {
      this.counters.concurrencyCapHit += 1;
    }

    let settled: FlightResult<T>;
    try {
      settled = await typed;
    } finally {
      if (registerable) {
        const live = this.flights.get(key);
        const index = live?.findIndex((flight) => flight.promise === published) ?? -1;
        if (live !== undefined && index !== -1) live.splice(index, 1);
        if (live !== undefined && live.length === 0) this.flights.delete(key);
      }
    }
    if (settled.status === "error") {
      this.counters.errors += 1;
      this.counters.ran += 1;
      throw settled.error;
    }

    this.counters.ran += 1;
    const outcome = settled.outcome;
    const stored =
      settled.fresh && generation === this.invalidationGeneration
        ? this.retain({
            key,
            program,
            outcome,
            durationMs: settled.durationMs,
            now: this.now(),
            enabled: options.retain,
          })
        : false;
    return {
      outcome: "RAN",
      value: outcome.value,
      failed: outcome.failed === true,
      inherited: false,
      waitedMs: options.waitedMs,
      msAvoidedMs: 0,
      origin: "own",
      fellBack: options.fellBack,
      key,
      excluded: null,
      stored,
    };
  }

  /**
   * Retains a verified result inside the count, byte and age bounds, evicting to make room.
   *
   * Expired entries go first and are not counted against the LRU bound, because dropping a dead
   * entry to make space is housekeeping and dropping a live one is a loss. A re-run of the same
   * key REPLACES the value but keeps the original `createdAt`: the two results answer the same
   * question, so keeping the older timestamp only makes the entry age out sooner, which is the
   * conservative direction.
   */
  private retain<T>(options: {
    readonly key: string;
    readonly program: string;
    readonly outcome: OperationOutcome<T>;
    readonly durationMs: number;
    readonly now: number;
    readonly enabled: boolean;
  }): boolean {
    const { key, program, outcome, durationMs, now } = options;
    const failed = outcome.failed === true;
    if (!options.enabled) {
      // The caller wants the run shared while it runs and not kept afterwards. Counted here and
      // not at the call site, so the number is "runs that completed and were not retained" — one
      // per run, never one per caller who happened to ask.
      this.counters.notRetainedByCaller += 1;
      return false;
    }
    if (failed && !this.shareFailures) {
      // Not an eviction and not a refusal: a failure simply is not a retained result. Counted on
      // its own counter rather than folded into `evictions`, because "we dropped it" and "we were
      // never going to keep it" are different facts and a reader should not have to guess which
      // one made the number move.
      this.counters.failuresNotRetained += 1;
      return false;
    }
    if (this.limits.maxEntries <= 0) return false;
    if (outcome.bytes > this.limits.maxEntryBytes || outcome.bytes > this.limits.maxTotalBytes) {
      this.counters.evictions.count += 1;
      this.counters.evictions.oversize += 1;
      this.counters.evictions.bytes += outcome.bytes;
      return false;
    }
    this.pruneExpired(now);

    const existing = this.completed.get(key);
    if (existing !== undefined) {
      this.completed.delete(key);
      this.completedBytes -= existing.bytes;
    }

    while (
      this.completed.size >= this.limits.maxEntries ||
      this.completedBytes + outcome.bytes > this.limits.maxTotalBytes
    ) {
      if (!this.evictOldest()) break;
    }
    this.completed.set(key, {
      key,
      program,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      hits: existing === undefined ? 0 : existing.hits + 1,
      bytes: outcome.bytes,
      durationMs,
      value: outcome.value,
      failed,
    });
    this.completedBytes += outcome.bytes;
    return true;
  }

  /** Drops the least recently used live entry. False when there is nothing left to drop. */
  private evictOldest(): boolean {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.completed) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return false;
    const entry = this.completed.get(oldestKey);
    this.completed.delete(oldestKey);
    if (entry !== undefined) {
      this.completedBytes -= entry.bytes;
      this.noteEviction("lru", entry.bytes);
    }
    return true;
  }

  private noteEviction(kind: "expired" | "lru", bytes: number): void {
    this.counters.evictions.count += 1;
    this.counters.evictions[kind] += 1;
    this.counters.evictions.bytes += bytes;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.completed) {
      if (now - entry.createdAt > this.limits.maxEntryAgeMs) {
        this.completed.delete(key);
        this.completedBytes -= entry.bytes;
        this.noteEviction("expired", entry.bytes);
      }
    }
  }

  /**
   * Drops every retained result at a boundary the fingerprint cannot see — a dependency
   * reinstall, a config change outside the watched roots, a workspace that has been rebased.
   *
   * In-flight runs are unregistered but NOT cancelled: a caller already waiting on one is owed
   * that run's result, and cancelling it would convert a shared answer into a hung agent.
   */
  invalidateAll(): number {
    this.invalidationGeneration += 1;
    const dropped = this.completed.size;
    this.completed.clear();
    this.completedBytes = 0;
    this.flights.clear();
    this.counters.invalidations.calls += 1;
    this.counters.invalidations.entries += dropped;
    return dropped;
  }

  /** Live state, for a caller that must be able to see that sharing happened. */
  stats(): ShareStats {
    let inFlightRuns = 0;
    let waiters = 0;
    for (const flights of this.flights.values()) {
      inFlightRuns += flights.length;
      for (const flight of flights) waiters += flight.waiters;
    }
    return {
      counters: structuredClone(this.counters),
      live: {
        entries: this.completed.size,
        bytes: this.completedBytes,
        inFlightKeys: this.flights.size,
        inFlightRuns,
        waiters,
      },
      limits: { ...this.limits },
      shareFailures: this.shareFailures,
    };
  }

  /** Clears retained results, in-flight registrations and counters. */
  reset(): void {
    this.invalidationGeneration += 1;
    this.completed.clear();
    this.flights.clear();
    this.completedBytes = 0;
    this.counters = {
      calls: 0,
      ran: 0,
      joined: 0,
      reused: 0,
      waiterCapHit: 0,
      noWait: 0,
      concurrencyCapHit: 0,
      waitTimedOut: 0,
      joinedFailureNotInherited: 0,
      joinedStaleNotInherited: 0,
      discardedTreeMovedDuringRun: 0,
      discardedInvalidatedDuringRun: 0,
      failuresNotRetained: 0,
      notRetainedByCaller: 0,
      errors: 0,
      byProgram: programTable(),
      refusals: refusalTable(),
      evictions: { count: 0, expired: 0, lru: 0, oversize: 0, bytes: 0 },
      waitedMs: 0,
      msAvoidedMs: 0,
      fingerprints: 0,
      invalidations: { calls: 0, entries: 0 },
    };
  }
}
