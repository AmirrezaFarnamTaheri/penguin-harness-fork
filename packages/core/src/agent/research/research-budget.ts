/**
 * Research budget.
 *
 * Bounded resource accounting for a deep-research loop: papers fetched, tokens spent,
 * citations held, verification attempts, and wall clock. Every phase draws against the
 * same ledger and every phase reports what it consumed, so an over-budget run can be
 * explained by phase rather than only in aggregate.
 *
 * The retry policy is the ported shape of a production agent loop: a bounded number of
 * attempts, exponential backoff with jitter, and a predicate that decides which
 * failures are worth retrying at all — connection and transient-provider errors are,
 * a malformed request is not.
 */

import { approximateTokens } from "../../llm/context-limits.js";

export interface ResearchBudgetOptions {
  /** Maximum papers to retrieve for one research task (plan: 25+ for synthesis). */
  readonly maxPapers?: number;
  /** Maximum total tokens the loop may spend. */
  readonly maxTokens?: number;
  /** Maximum claims to verify. */
  readonly maxVerifications?: number;
  /** Wall-clock budget in nanoseconds (plan QoS: 12s for a 25+ paper synthesis). */
  readonly maxDurationNs?: number;
  /** Maximum citations a synthesis may cite. */
  readonly maxCitations?: number;
  /** Maximum depth of hypothesis expansion. */
  readonly maxDepth?: number;
  /** Retry attempts for a transient failure. */
  readonly maxRetries?: number;
  /** Exponential backoff base, nanoseconds. */
  readonly backoffBaseNs?: number;
  /** Exponential backoff ceiling, nanoseconds. */
  readonly backoffMaxNs?: number;
  /** Jitter fraction applied to each backoff delay (0 disables jitter). */
  readonly jitter?: number;
  /** Token estimator override (the core package's `approximateTokens` fits here). */
  readonly estimateTokens?: (text: string) => number;
}

/** Opaque identity for one admitted unit of work. Pass it back exactly once to settle/release. */
export interface ResearchReservation {
  readonly id: number;
  readonly tokens: number;
}

export interface PhaseSpend {
  readonly phase: ResearchPhase;
  readonly papers: number;
  readonly tokens: number;
  readonly verifications: number;
  readonly durationNs: number;
  readonly attempts: number;
}

export type ResearchPhase =
  | "planning"
  | "searching"
  | "fetching"
  | "parsing"
  | "extracting"
  | "verifying"
  | "synthesizing"
  | "reporting";

export interface BudgetReport {
  /** Tokens spent so far. */
  readonly tokens: number;
  /** Papers retrieved. */
  readonly papers: number;
  /** Verification attempts. */
  readonly verifications: number;
  /** Elapsed wall clock, nanoseconds. */
  readonly elapsedNs: number;
  /** Per-phase spend. */
  readonly phases: ReadonlyMap<ResearchPhase, PhaseSpend>;
  /** Which limits are exhausted. */
  readonly exhausted: ReadonlyArray<keyof ResearchBudgetOptions>;
  /** Fraction of the token budget consumed. */
  readonly tokenBudgetUsed: number;
  /** Fraction of the paper budget consumed. */
  readonly paperBudgetUsed: number;
  /** Fraction of the time budget consumed. */
  readonly timeBudgetUsed: number;
  /** Total retry attempts across all phases. */
  readonly retries: number;
  /** Charges refused for carrying an unusable token figure (see {@link ResearchBudget.charge}). */
  readonly rejectedCharges: number;
  /**
   * Tokens charged by a prior `reset` for reservations that never settled. Unconfirmed spend,
   * reported separately from `tokens`.
   */
  readonly abandonedTokens: number;
}

/**
 * A bounded ledger. `charge` is the only mutating entry point; every read derives from
 * the recorded spend, so the report can never disagree with the books.
 */
export class ResearchBudget {
  private tokens = 0;
  private papers = 0;
  private verifications = 0;
  private startedAt: number;
  private retries = 0;
  private readonly phases = new Map<ResearchPhase, PhaseSpend>();
  /**
   * Tokens reserved by work that has been admitted but has not reported yet.
   *
   * The ledger charges AFTER the fact, which is the same hole a naive spend ceiling has: a phase
   * costs nothing until it finishes, so with two verifications in flight the budget admits both
   * and then discovers it has overrun. Reserving at admission is what makes `remainingTokens`
   * mean "what may I still afford" rather than "what have I already paid for".
   */
  private reservedTokens = 0;
  private nextReservationId = 1;
  private readonly reservations = new Map<ResearchReservation, number>();
  /**
   * Charges refused because their token figure was not a usable count (negative, `NaN`, or
   * infinite). Counted rather than swallowed: a refused charge leaves the books unchanged, so
   * without this counter a provider that started reporting `NaN` would look exactly like a run
   * that simply did less work.
   */
  private rejectedCharges = 0;
  /**
   * Tokens charged by `reset` for reservations that were still outstanding when the previous task
   * ended. The charge is real (the work was admitted) but unconfirmed, so it is held apart from
   * `tokens` rather than folded in — a report can then distinguish confirmed spend from spend this
   * ledger had to assume on the previous task's behalf.
   */
  private abandonedTokens = 0;

  readonly maxPapers: number;
  readonly maxTokens: number;
  readonly maxVerifications: number;
  readonly maxDurationNs: number;
  readonly maxCitations: number;
  readonly maxDepth: number;
  private readonly maxRetries: number;
  private readonly backoffBaseNs: number;
  private readonly backoffMaxNs: number;
  private readonly jitter: number;
  private readonly estimateTokens: (text: string) => number;

  constructor(options: ResearchBudgetOptions = {}) {
    this.maxPapers = options.maxPapers ?? 32;
    this.maxTokens = options.maxTokens ?? 1_200_000;
    this.maxVerifications = options.maxVerifications ?? 96;
    this.maxDurationNs = options.maxDurationNs ?? 12_000_000_000;
    this.maxCitations = options.maxCitations ?? 40;
    this.maxDepth = options.maxDepth ?? 3;
    this.maxRetries = options.maxRetries ?? 4;
    this.backoffBaseNs = options.backoffBaseNs ?? 4_000_000;
    this.backoffMaxNs = options.backoffMaxNs ?? 60_000_000;
    this.jitter = options.jitter ?? 0.25;
    this.estimateTokens = options.estimateTokens ?? defaultTokenEstimate;
    this.startedAt = nowNs();
  }

  /**
   * A charge from a phase, with every field held to the ledger's own arithmetic.
   *
   * `tokens` arrives from a provider's usage report, and a provider report is not a promise about
   * its own fields: negative, `NaN` and `Infinity` all reach this function in practice, and each
   * one used to corrupt the books rather than being refused. A negative charge *refunds* tokens
   * that were never there, so a phase could hand back more than it spent and leave `remainingTokens`
   * above the whole budget; a single `NaN` made every later figure `NaN` silently, because
   * `NaN <= maxTokens` is false, so the ledger reported "over budget" for a run that had spent
   * nothing, and `report()` divided `NaN` into its fractions. None of those announce themselves.
   *
   * So the same rule as `reserve` applies here: a value that is not a usable, non-negative,
   * finite count is **not** a charge, and it is not silently zero either — it is reported through
   * {@link BudgetReport.rejectedCharges} so a run whose accounting went wrong is visible instead of
   * quietly correct-looking. A refused charge leaves the books as they were, which is the direction
   * that cannot under-report spend: the caller keeps whatever it had already charged.
   */
  charge(
    phase: ResearchPhase,
    spend: {
      tokens?: number;
      text?: string;
      papers?: number;
      verifications?: number;
      durationNs?: number;
    },
  ): void {
    const usable = (value: number | undefined): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

    const claimed = spend.tokens ?? (spend.text ? this.estimateTokens(spend.text) : 0);
    const tokens = usable(claimed);
    const papers = usable(spend.papers) ?? 0;
    const verifications = usable(spend.verifications) ?? 0;
    const duration = usable(spend.durationNs) ?? 0;
    if (tokens === undefined) {
      this.rejectedCharges += 1;
      return;
    }

    this.tokens += tokens;
    this.papers += papers;
    this.verifications += verifications;
    const previous = this.phases.get(phase);
    this.phases.set(phase, {
      phase,
      papers: (previous?.papers ?? 0) + papers,
      tokens: (previous?.tokens ?? 0) + tokens,
      verifications: (previous?.verifications ?? 0) + verifications,
      durationNs: (previous?.durationNs ?? 0) + duration,
      attempts: (previous?.attempts ?? 0) + 1,
    });
  }

  /** Records a retry attempt for a phase and returns the delay to wait. */
  nextBackoff(phase: ResearchPhase, attempt: number): number {
    this.retries += 1;
    this.charge(phase, { durationNs: 0 });
    const exponent = Math.max(0, Math.min(attempt, 16));
    let delay = this.backoffBaseNs * 2 ** exponent;
    delay = Math.min(delay, this.backoffMaxNs);
    if (this.jitter > 0) {
      const span = delay * this.jitter;
      delay = Math.max(0, delay - span + pseudoRandom(this.retries, attempt) * span * 2);
    }
    return Math.round(delay);
  }

  /** Whether a failure of this kind is worth retrying. */
  shouldRetry(error: unknown): boolean {
    const message = describe(error).toLowerCase();
    return [
      "connection error",
      "server disconnected",
      "eof occurred",
      "timeout",
      "timed out",
      "event loop is closed",
      "socket",
      "temporarily unavailable",
      "too many requests",
      "rate limit",
      "service unavailable",
      "bad gateway",
    ].some((cue) => message.includes(cue));
  }

  get remainingPapers(): number {
    return Math.max(0, this.maxPapers - this.papers);
  }

  get remainingTokens(): number {
    // Reserved tokens count against what is left: they are committed, just not yet measured.
    return Math.max(0, this.maxTokens - this.tokens - this.reservedTokens);
  }

  /** Tokens admitted but not yet reported. */
  get reservedTokenCount(): number {
    return this.reservedTokens;
  }

  /** Tokens charged so far, excluding anything still reserved. */
  get tokensSpent(): number {
    return this.tokens;
  }

  /**
   * Unconfirmed tokens charged by a previous `reset` for reservations that never settled. Added to
   * {@link tokensSpent} to get everything this ledger has committed, kept separate to show which
   * part of it is a measurement.
   */
  get abandonedTokenCount(): number {
    return this.abandonedTokens;
  }

  /**
   * Reserves an estimate for work about to start, so a second concurrent call sees the first
   * one's cost. Returns false — and reserves nothing — when the estimate does not fit, which is
   * the caller's signal to decline the work rather than start it and overrun.
   */
  reserve(estimateTokens: number): ResearchReservation | null {
    if (!Number.isFinite(estimateTokens) || estimateTokens < 0) return null;
    if (this.tokens + this.reservedTokens + estimateTokens > this.maxTokens) return null;
    this.reservedTokens += estimateTokens;
    const reservation = Object.freeze({ id: this.nextReservationId++, tokens: estimateTokens });
    this.reservations.set(reservation, estimateTokens);
    return reservation;
  }

  /**
   * What a piece of text is expected to cost, measured with the SAME estimator `charge` uses.
   *
   * A reservation is only meaningful if it is the figure the work will actually be charged at.
   * An invented per-unit constant is not: it is wrong by an order of magnitude on a small budget
   * and refuses real work the ledger could easily have paid for. The caller knows what it is
   * about to process, so it measures that.
   */
  estimate(text: string): number {
    return Math.max(1, this.estimateTokens(text));
  }

  /**
   * Converts a reservation into real spend. A reservation may be settled at most once: a phase
   * that reports twice (a replayed event, a retry double-counting itself) must not inflate the
   * books, and must not leave the reservation stranded.
   */
  settleReservation(
    reservation: ResearchReservation,
    actual: {
      tokens?: number;
      text?: string;
      phase?: ResearchPhase;
    } = {},
  ): boolean {
    const reservedTokens = this.reservations.get(reservation);
    if (reservedTokens === undefined) return false;
    this.reservations.delete(reservation);
    this.reservedTokens -= reservedTokens;
    if (actual.phase !== undefined) {
      this.charge(actual.phase, actual);
    } else if (actual.tokens !== undefined || actual.text !== undefined) {
      this.charge("verifying", actual);
    }
    return true;
  }

  /** Releases a reservation for work that never ran: declined, aborted, or skipped. */
  releaseReservation(reservation: ResearchReservation): boolean {
    const reservedTokens = this.reservations.get(reservation);
    if (reservedTokens === undefined) return false;
    this.reservations.delete(reservation);
    this.reservedTokens -= reservedTokens;
    return true;
  }

  get remainingTimeNs(): number {
    return Math.max(0, this.maxDurationNs - this.elapsed());
  }

  canFetch(papers = 1): boolean {
    return this.papers + papers <= this.maxPapers && this.elapsed() < this.maxDurationNs;
  }

  canVerify(count = 1): boolean {
    return (
      this.verifications + count <= this.maxVerifications && this.elapsed() < this.maxDurationNs
    );
  }

  /**
   * Whether `tokens` more may be charged, counting what is already reserved.
   *
   * Reserved tokens are deducted here for the same reason `remainingTokens` deducts them: a
   * caller asking this question right before dispatching a request is asking "may I still afford
   * it", and work admitted but not yet reported has already consumed the money. Leaving
   * `reservedTokens` out made this the one optimistic path left in the class — the reservation
   * machinery existed, `remainingTokens` honoured it, and the predicate a caller would naturally
   * reach for did not, so two concurrent verifications both passed a check that only the first
   * should have. The unreserved version is what the `reserve` guard was added to fix, so it could
   * not stay.
   */
  canSpendTokens(tokens: number): boolean {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return false;
    return this.tokens + this.reservedTokens + tokens <= this.maxTokens;
  }

  elapsed(): number {
    return nowNs() - this.startedAt;
  }

  /**
   * Resets the ledger for a fresh task, keeping the configured limits.
   *
   * Outstanding reservations are **settled at their reserved amount**, not dropped. The work behind
   * them was admitted and may well have run, so charging the reservation is the only figure this
   * class holds for it; releasing them instead would hand a fresh task a budget that the previous
   * one had already promised away, and when those in-flight calls later settled they would charge
   * the *new* task's books — work from task A landing in task B's totals. The amount is visible
   * through {@link BudgetReport.abandonedTokens} so a run that reset with calls in flight is
   * distinguishable from one that did not.
   */
  reset(): void {
    this.abandonedTokens += this.reservedTokens;
    this.reservedTokens = 0;
    this.reservations.clear();
    this.tokens = 0;
    this.papers = 0;
    this.verifications = 0;
    this.retries = 0;
    this.phases.clear();
    this.startedAt = nowNs();
  }

  report(): BudgetReport {
    const elapsed = this.elapsed();
    const exhausted: Array<keyof ResearchBudgetOptions> = [];
    if (this.papers >= this.maxPapers) exhausted.push("maxPapers");
    if (this.tokens >= this.maxTokens) exhausted.push("maxTokens");
    if (this.verifications >= this.maxVerifications) exhausted.push("maxVerifications");
    if (elapsed >= this.maxDurationNs) exhausted.push("maxDurationNs");

    return {
      tokens: this.tokens,
      papers: this.papers,
      verifications: this.verifications,
      elapsedNs: elapsed,
      phases: this.phases,
      exhausted,
      tokenBudgetUsed: this.maxTokens > 0 ? this.tokens / this.maxTokens : 0,
      paperBudgetUsed: this.maxPapers > 0 ? this.papers / this.maxPapers : 0,
      timeBudgetUsed: this.maxDurationNs > 0 ? elapsed / this.maxDurationNs : 0,
      retries: this.retries,
      rejectedCharges: this.rejectedCharges,
      abandonedTokens: this.abandonedTokens,
    };
  }

  get maxAttempts(): number {
    return this.maxRetries + 1;
  }
}

/**
 * Deterministic pseudo-random in [0, 1) from two integers. Jitter must be reproducible:
 * a retry schedule that differs between runs makes timing-dependent failures
 * impossible to reproduce.
 */
function pseudoRandom(seed: number, salt: number): number {
  let value = (seed * 0x9e37_79b9 + salt * 0x85eb_ca6b) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_296;
}

/**
 * Character-heuristic token estimate, delegating to the one implementation the request path uses
 * (`llm/context-limits.ts`) instead of repeating the ascii/4 + wide-character loop here.
 *
 * The copy was byte-for-byte equivalent, which is exactly why it was a hazard: a ledger that must
 * agree with the per-request output clamp is only as trustworthy as the single definition they
 * share, and two identical-looking counters in two subsystems drift the first time either is
 * tuned. Callers may still inject their own estimator, which stays the escape hatch for a budget
 * that knows its text better than a character heuristic does.
 */
export function defaultTokenEstimate(text: string): number {
  if (!text) return 0;
  return approximateTokens(text);
}

function nowNs(): number {
  if (typeof process !== "undefined" && typeof process.hrtime?.bigint === "function") {
    return Number(process.hrtime.bigint());
  }
  return Date.now() * 1e6;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

/**
 * Runs an operation with the budget's retry policy. The predicate gates which failures
 * are retried; the budget charges each attempt and decides the delay. Propagates the
 * last error once attempts are exhausted or the error is not retryable.
 */
export async function withRetry<T>(
  budget: ResearchBudget,
  phase: ResearchPhase,
  operation: (attempt: number) => Promise<T> | T,
): Promise<T> {
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < budget.maxAttempts; attempt++) {
    try {
      const result = await operation(attempt);
      return result;
    } catch (error) {
      lastError = error;
      if (!budget.shouldRetry(error) || attempt === budget.maxAttempts - 1) break;
      const delay = budget.nextBackoff(phase, attempt);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(describe(lastError));
}

function sleep(ns: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.ceil(ns / 1e6))));
}

/**
 * Admission control for a citation list: drops the least-influential citations until
 * the list fits the budget, so a synthesis never exceeds its citation ceiling.
 */
export function trimCitations(
  citations: ReadonlyArray<{ id: string; influence: number }>,
  maxCitations: number,
): string[] {
  return [...citations]
    .sort((a, b) => b.influence - a.influence)
    .slice(0, Math.max(0, maxCitations))
    .map((entry) => entry.id);
}
