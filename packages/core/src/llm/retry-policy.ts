import type { ParsedDelay } from "./retry-delay.js";

export interface RetryFailure {
  /** Opaque identity scoped to this request; never pass a credential or provider secret. */
  accountId?: string;
  rateLimited: boolean;
  /** Earliest eligibility when every account is cooling down. */
  poolUnavailableForMs?: number;
  delay?: ParsedDelay;
  cancelled?: boolean;
}

export type RetryDecision =
  | { kind: "stop"; reason: "cancelled" | "exhausted" }
  | { kind: "retry"; delayMs: number; mode: "rotate" | "same_account" | "wait" };

export function maxRetryAttempts(poolSize: number): number {
  if (!Number.isSafeInteger(poolSize) || poolSize < 0) throw new RangeError("Invalid pool size");
  return poolSize <= 1 ? 3 : Math.min(12, Math.max(4, poolSize * 2));
}

/** One instance owns all attempts and grace receipts for one request, including partial retries. */
export class PoolRetryPolicy {
  readonly maxAttempts: number;
  private attempts = 0;
  private readonly graceAccounts = new Set<string>();
  private decision?: RetryDecision;
  private cancelled = false;

  constructor(
    private readonly poolSize: number,
    ceiling = maxRetryAttempts(poolSize),
  ) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1)
      throw new RangeError("Invalid retry ceiling");
    this.maxAttempts = Math.min(maxRetryAttempts(poolSize), ceiling);
  }

  get attemptsMade(): number {
    return this.attempts;
  }

  /** Claim an attempt immediately before sending. Exhaustion cannot be reset by streamed content. */
  startAttempt(): number | null {
    if (this.cancelled || this.attempts >= this.maxAttempts) return null;
    this.decision = undefined;
    return ++this.attempts;
  }

  /** Repeated reads return the same plan, so countdown and sleep cannot consume grace twice. */
  afterFailure(failure: RetryFailure): RetryDecision {
    if (failure.cancelled) this.cancelled = true;
    if (this.cancelled) return { kind: "stop", reason: "cancelled" };
    if (this.attempts < 1) throw new Error("An attempt must start before failure is planned");
    if (this.attempts >= this.maxAttempts) return { kind: "stop", reason: "exhausted" };
    if (this.decision) return this.decision;

    const delay = failure.delay?.bufferedMs;
    const providerMs =
      typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : undefined;
    let plan: RetryDecision;
    if (
      failure.poolUnavailableForMs !== undefined &&
      failure.poolUnavailableForMs > 0 &&
      Number.isFinite(failure.poolUnavailableForMs)
    ) {
      if (
        providerMs !== undefined &&
        providerMs <= 5000 &&
        failure.poolUnavailableForMs <= providerMs &&
        failure.accountId &&
        !this.graceAccounts.has(failure.accountId)
      ) {
        this.graceAccounts.add(failure.accountId);
        plan = { kind: "retry", mode: "same_account", delayMs: providerMs };
      } else {
        plan = {
          kind: "retry",
          mode: "wait",
          delayMs: Math.min(failure.poolUnavailableForMs, 60_000),
        };
      }
    } else if (this.poolSize > 1 && this.attempts < this.poolSize) {
      plan = { kind: "retry", mode: "rotate", delayMs: 50 };
    } else if (providerMs !== undefined) {
      if (providerMs <= 5000 && failure.accountId && !this.graceAccounts.has(failure.accountId)) {
        this.graceAccounts.add(failure.accountId);
        plan = { kind: "retry", mode: "same_account", delayMs: providerMs };
      } else if (providerMs > 5000 && this.poolSize > 2) {
        plan = { kind: "retry", mode: "rotate", delayMs: 50 };
      } else {
        plan = {
          kind: "retry",
          mode: "wait",
          delayMs: Math.min(
            providerMs,
            this.poolSize <= 1 && failure.rateLimited ? 10_000 : 12_000,
          ),
        };
      }
    } else if (this.poolSize <= 1 && failure.rateLimited) {
      plan = { kind: "retry", mode: "wait", delayMs: Math.min(3000 * this.attempts, 10_000) };
    } else {
      plan = {
        kind: "retry",
        mode: "wait",
        delayMs: Math.min(2000 * Math.max(1, this.attempts - this.poolSize + 1), 5000),
      };
    }
    this.decision = plan;
    return plan;
  }
}
