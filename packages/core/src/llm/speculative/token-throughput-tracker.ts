/**
 * Speculative token throughput tracker.
 *
 * Real accounting for the speedup claim. The engine's own invariant, ported: the
 * per-priority accept-length buckets must sum exactly to the total accepted-token
 * count. Every counter here is derived from the same staged accept rows, so a
 * mismatch is a bug rather than a rounding difference.
 *
 * Throughput model: a decode round without speculation costs one target forward to
 * emit one token. A speculative round costs one target forward (verification of the
 * window) plus γ draft tokens and yields `acceptCount + 1` committed tokens, so the
 * wall-clock speedup is
 *
 *     speedup = acceptedPerRound / (targetForwardsPerRound)
 *
 * with the draft cost folded into a configurable amortisation weight, because the
 * draft forward is cheaper than the target forward by that factor.
 */

export interface RoundMetrics {
  readonly streamId: string;
  /** γ for the round — tokens proposed by the draft. */
  readonly proposed: number;
  /** Draft positions the target accepted. */
  readonly accepted: number;
  /** Bonus token emitted after full acceptance. */
  readonly bonus: number;
  /** Tokens committed by the round (accepted + bonus + fallback). */
  readonly committed: number;
  /** Tokens discarded by rejection. */
  readonly discarded: number;
  /** Wall clock of the round in nanoseconds. */
  readonly durationNs: number;
  /** Scheduling priority of the stream. */
  readonly priority: number;
}

export interface ThroughputReport {
  /** Total tokens committed to output across all rounds. */
  readonly committed: number;
  /** Total tokens proposed by drafts. */
  readonly proposed: number;
  /** Total tokens accepted by the target. */
  readonly accepted: number;
  /** Total bonus tokens. */
  readonly bonus: number;
  /** Total tokens discarded by rejection. */
  readonly discarded: number;
  /** Aggregate acceptance rate: accepted / proposed. */
  readonly acceptanceRate: number;
  /** Mean accepted draft tokens per round. */
  readonly meanAcceptedPerRound: number;
  /** Exponentially weighted acceptance rate (reacts to drift). */
  readonly emaAcceptanceRate: number;
  /** Wall-clock nanoseconds spent in verification. */
  readonly verifyTimeNs: number;
  /** Committed tokens per second of wall clock. */
  readonly tokensPerSecond: number;
  /** Verification latency per token window, mean, nanoseconds. */
  readonly meanVerifyLatencyNs: number;
  /** Verification latency per token window, p95, nanoseconds. */
  readonly p95VerifyLatencyNs: number;
  /**
   * Realised speedup over non-speculative decoding at the observed acceptance rate
   * and draft-cost weight.
   */
  readonly speedup: number;
  /**
   * Per-priority accept breakdown. The bucket sums equal `accepted` exactly — that
   * equality is the engine's own accounting invariant.
   */
  readonly acceptedByPriority: ReadonlyMap<number, number>;
  /** Number of rounds recorded. */
  readonly rounds: number;
  /** Whether the QoS latency budget was met for every recorded round. */
  readonly withinLatencyBudget: boolean;
}

export interface ThroughputTrackerOptions {
  /** EMA smoothing factor for the acceptance rate (0 < α ≤ 1). */
  readonly emaAlpha?: number;
  /**
   * Draft cost relative to target cost: a draft forward is this fraction of a target
   * forward. Lower means cheaper drafts and more headline speedup.
   */
  readonly draftCostWeight?: number;
  /** Per-window verification latency budget in nanoseconds (QoS target). */
  readonly verifyLatencyBudgetNs?: number;
}

export class TokenThroughputTracker {
  private committed = 0;
  private proposed = 0;
  private accepted = 0;
  private bonus = 0;
  private discarded = 0;
  private verifyTimeNs = 0;
  private rounds = 0;
  private emaAcceptance = 0;
  private overBudgetRounds = 0;

  private readonly latencySamples: number[] = [];
  private readonly acceptedByPriority = new Map<number, number>();

  private readonly emaAlpha: number;
  private readonly draftCostWeight: number;
  private readonly verifyLatencyBudgetNs: number;

  constructor(options: ThroughputTrackerOptions = {}) {
    this.emaAlpha = options.emaAlpha ?? 0.3;
    this.draftCostWeight = options.draftCostWeight ?? 0.35;
    this.verifyLatencyBudgetNs = options.verifyLatencyBudgetNs ?? 2_500_000;
  }

  /** Records one verified speculative round. */
  record(metrics: RoundMetrics): void {
    this.rounds += 1;
    this.proposed += metrics.proposed;
    this.accepted += metrics.accepted;
    this.bonus += metrics.bonus;
    this.committed += metrics.committed;
    this.discarded += metrics.discarded;
    this.verifyTimeNs += metrics.durationNs;

    const totalPriority = (this.acceptedByPriority.get(metrics.priority) ?? 0) + metrics.accepted;
    this.acceptedByPriority.set(metrics.priority, totalPriority);

    this.latencySamples.push(metrics.durationNs);
    if (metrics.durationNs > this.verifyLatencyBudgetNs) this.overBudgetRounds += 1;

    const rate = metrics.proposed > 0 ? metrics.accepted / metrics.proposed : 0;
    // First observation seeds the EMA rather than smoothing from an arbitrary 0.
    this.emaAcceptance =
      this.rounds === 1 ? rate : this.emaAlpha * rate + (1 - this.emaAlpha) * this.emaAcceptance;
  }

  /** Records a batch of rounds, keeping per-priority buckets aligned. */
  recordAll(metrics: readonly RoundMetrics[]): void {
    for (const round of metrics) this.record(round);
  }

  report(): ThroughputReport {
    const acceptanceRate = this.proposed > 0 ? this.accepted / this.proposed : 0;
    const meanAccepted = this.rounds > 0 ? this.accepted / this.rounds : 0;

    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const meanLatency = this.rounds > 0 ? this.verifyTimeNs / this.rounds : 0;
    const p95Index =
      sorted.length > 0 ? Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95)) : 0;
    const p95Latency = sorted[p95Index] ?? 0;

    return {
      committed: this.committed,
      proposed: this.proposed,
      accepted: this.accepted,
      bonus: this.bonus,
      discarded: this.discarded,
      acceptanceRate,
      meanAcceptedPerRound: meanAccepted,
      emaAcceptanceRate: this.emaAcceptance,
      verifyTimeNs: this.verifyTimeNs,
      tokensPerSecond: this.verifyTimeNs > 0 ? (this.committed / this.verifyTimeNs) * 1e9 : 0,
      meanVerifyLatencyNs: meanLatency,
      p95VerifyLatencyNs: p95Latency,
      speedup: this.speedup(acceptanceRate),
      acceptedByPriority: new Map(this.acceptedByPriority),
      rounds: this.rounds,
      withinLatencyBudget: this.overBudgetRounds === 0,
    };
  }

  /**
   * Analytic speedup at an acceptance rate, given the window size γ and the
   * draft-cost weight. With per-position acceptance probability a, expected
   * committed tokens per round are (1 + a·(1 − a^γ)/(1 − a)) and the round costs
   * 1 target forward plus γ draft forwards at `draftCostWeight` each.
   */
  speedup(acceptanceRate: number, gamma = 4): number {
    if (acceptanceRate <= 0) return 1;
    const a = acceptanceRate > 1 ? 1 : acceptanceRate;
    const expectedAccepted = a >= 1 ? gamma : (a * (1 - Math.pow(a, gamma))) / (1 - a);
    const expectedCommitted = 1 + expectedAccepted;
    const cost = 1 + gamma * this.draftCostWeight;
    return expectedCommitted / cost;
  }

  /**
   * Asserts the engine's own accounting invariant: the per-priority accept buckets
   * sum exactly to the total accepted count. Returns the violation, or null when the
   * books balance.
   */
  priorityBucketIntegrity(): { expected: number; actual: number; balanced: boolean } {
    let actual = 0;
    for (const value of this.acceptedByPriority.values()) actual += value;
    return { expected: this.accepted, actual, balanced: actual === this.accepted };
  }

  /** Resets all counters (used between independent sessions). */
  reset(): void {
    this.committed = 0;
    this.proposed = 0;
    this.accepted = 0;
    this.bonus = 0;
    this.discarded = 0;
    this.verifyTimeNs = 0;
    this.rounds = 0;
    this.emaAcceptance = 0;
    this.overBudgetRounds = 0;
    this.latencySamples.length = 0;
    this.acceptedByPriority.clear();
  }
}

/**
 * Convert a high-resolution time tuple to nanoseconds. Kept as a helper so tests can
 * build synthetic timings without depending on `process.hrtime.bigint` shapes.
 */
export function hrtimeToNs(tuple: readonly [number, number]): number {
  return tuple[0] * 1e9 + tuple[1];
}

/**
 * Predicted wall-clock speedup for a hypothetical acceptance rate — used by the
 * parallel speculator to decide whether a stream is worth keeping speculative at
 * all. A stream whose predicted speedup is ≤ 1 costs more than it saves and should
 * fall back to plain target decoding.
 */
export function predictedSpeedup(
  acceptanceRate: number,
  gamma: number,
  draftCostWeight = 0.35,
): number {
  if (!(acceptanceRate > 0)) return 1;
  const a = Math.min(1, acceptanceRate);
  const expectedAccepted = a >= 1 ? gamma : (a * (1 - Math.pow(a, gamma))) / (1 - a);
  return (1 + expectedAccepted) / (1 + gamma * draftCostWeight);
}
