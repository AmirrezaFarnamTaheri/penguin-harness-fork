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

  /** Charges a phase for work performed. */
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
    const tokens = spend.tokens ?? (spend.text ? this.estimateTokens(spend.text) : 0);
    const papers = spend.papers ?? 0;
    const verifications = spend.verifications ?? 0;
    const duration = spend.durationNs ?? 0;

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
    return Math.max(0, this.maxTokens - this.tokens);
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

  canSpendTokens(tokens: number): boolean {
    return this.tokens + tokens <= this.maxTokens;
  }

  elapsed(): number {
    return nowNs() - this.startedAt;
  }

  /** Resets the ledger for a fresh task, keeping the configured limits. */
  reset(): void {
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
    };
  }

  get maxAttempts(): number {
    return this.maxRetries;
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

/** Character-heuristic token estimate; callers with a real estimator should inject it. */
export function defaultTokenEstimate(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
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
