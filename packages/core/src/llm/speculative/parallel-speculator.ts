/**
 * Parallel speculative inference streams.
 *
 * Wires the draft-acceptance math, the rollback ledger and the throughput tracker
 * into a batched propose→verify→commit pipeline that mirrors the production engine's
 * phase split: draft proposal (cheap, possibly multiple tiers), target verification
 * (one forward for the whole window), then per-stream commit/rollback.
 *
 * No model weights and no network calls: the models are injected seams that supply
 * probability rows. What is real is everything around them — the verification math,
 * the per-stream rollback boundaries, the cache accounting and the throughput
 * attribution — so a real draft/target pair drops in by implementing two methods.
 *
 * Ported behaviour:
 * - fail-soft draft: a stream whose proposal fails is demoted to target-only
 *   decoding for the round instead of aborting the batch (the "speculative pilot"
 *   pattern: a failed speculation must not kill the serving loop);
 * - per-stream seeded uniforms for reproducible acceptance;
 * - draft-to-target vocabulary mapping when the draft vocabulary is a subset;
 * - forced acceptance for warm-up and known-trusted prompt-lookup streams.
 */

import {
  SeededRandom,
  draftQualityGate,
  expectedAcceptCount,
  verifyWindow,
  type ProbabilityRow,
  type DraftWindow,
  type TargetWindow,
  type VerificationMode,
} from "./draft-acceptance.js";
import { BatchRollbackCoordinator, SpeculativeRollback } from "./speculative-rollback.js";
import { TokenThroughputTracker, type RoundMetrics } from "./token-throughput-tracker.js";

/**
 * Seam for the draft model. Returns γ proposed tokens with the probability rows the
 * target will compare against. `pointMass: true` marks a greedy/argmax draft that
 * carries no distribution and therefore only supports the greedy acceptance rule.
 */
export interface DraftModel {
  propose(request: DraftRequest): Promise<DraftWindow> | DraftWindow;
}

/**
 * Seam for the target model. Verifies γ drafted tokens in one forward pass and
 * returns the target's own token ids and probability rows for each position plus one
 * bonus row. This is the expensive call; the whole point of speculation is that it
 * stays at one call per round.
 */
export interface TargetModel {
  verify(request: VerifyRequest): Promise<TargetWindow> | TargetWindow;
}

export interface DraftRequest {
  readonly streamId: string;
  /** Committed context tokens the draft continues from. */
  readonly context: readonly number[];
  /** Window size γ. */
  readonly windowSize: number;
  /** Sampling seed, fixed for reproducibility. */
  readonly seed: number;
}

export interface VerifyRequest {
  readonly streamId: string;
  readonly context: readonly number[];
  readonly draftTokens: readonly number[];
  readonly draftPointMass: boolean;
}

export type SpeculationFlavour =
  "none" | "vanilla" | "mtp" | "eagle" | "eagle3" | "deterministic" | "block-diffusion";

export interface ParallelSpeculatorOptions {
  /** Window size γ — drafted tokens per round. */
  readonly windowSize?: number;
  /** Hard ceiling on γ; adaptive sizing never exceeds this. */
  readonly maxWindowSize?: number;
  readonly mode?: VerificationMode;
  readonly flavour?: SpeculationFlavour;
  /** Draft-to-target vocabulary map when the draft vocabulary is a subset. */
  readonly draftToTargetMap?: readonly number[];
  /** Per-stream seeds are derived from this base plus the stream index. */
  readonly seedBase?: number;
  /**
   * Enables the contrastive quality gate: windows where the draft is not
   * plausibly aligned with the target are proposed at γ=0 (target-only round)
   * instead of burning a verification on a window certain to be rejected.
   */
  readonly enableQualityGate?: boolean;
  /** Plausibility threshold factor for the quality gate. */
  readonly plausibilityAlpha?: number;
  /** KL threshold for the quality gate. */
  readonly klBeta?: number;
  /** Below this predicted speedup a stream runs target-only. */
  readonly minSpeedup?: number;
  /** Rounds per stream before γ is re-sized from observed acceptance. */
  readonly adaptationInterval?: number;
  /** Marginal-expected-token floor used when shrinking γ. */
  readonly marginalFloor?: number;
  /** Latency budget for a verification round, nanoseconds. */
  readonly verifyLatencyBudgetNs?: number;
  /** Draft cost relative to target cost, for speedup accounting. */
  readonly draftCostWeight?: number;
  /** True during warm-up: all windows are force-accepted. */
  readonly warmUp?: boolean;
}

export interface StreamState {
  readonly id: string;
  readonly priority: number;
  windowSize: number;
  acceptanceRate: number;
  rounds: number;
  speculative: boolean;
}

export interface RoundOutcome {
  readonly streamId: string;
  readonly committed: number[];
  readonly acceptCount: number;
  readonly allAccepted: boolean;
  /** γ actually proposed this round (0 means a target-only round). */
  readonly proposed: number;
  readonly durationNs: number;
  readonly demoted: boolean;
  readonly termination: string;
}

export class ParallelSpeculator {
  private readonly draft: DraftModel;
  private readonly target: TargetModel;
  private readonly coordinator = new BatchRollbackCoordinator();
  private readonly tracker: TokenThroughputTracker;
  private readonly streams = new Map<string, StreamState>();
  /**
   * Last verified target distribution per stream. The quality gate runs *before*
   * verification, so it can only compare the draft's proposal against the target's
   * most recent known distribution — comparing the draft against itself would always
   * report zero divergence and gate nothing.
   */
  private lastTargetRow = new Map<string, ProbabilityRow>();

  private readonly windowSize: number;
  private readonly maxWindowSize: number;
  private readonly mode: VerificationMode;
  private readonly flavour: SpeculationFlavour;
  private readonly d2t?: readonly number[];
  private readonly seedBase: number;
  private readonly qualityGate: boolean;
  private readonly alpha: number;
  private readonly beta: number;
  private readonly minSpeedup: number;
  private readonly adaptationInterval: number;
  private readonly marginalFloor: number;
  private readonly warmUp: boolean;

  constructor(draft: DraftModel, target: TargetModel, options: ParallelSpeculatorOptions = {}) {
    this.draft = draft;
    this.target = target;
    this.windowSize = options.windowSize ?? 4;
    this.maxWindowSize = options.maxWindowSize ?? Math.max(this.windowSize, 8);
    this.mode = options.mode ?? "stochastic";
    this.flavour = options.flavour ?? "vanilla";
    this.d2t = options.draftToTargetMap;
    this.seedBase = options.seedBase ?? 0x9e37_79b9;
    this.qualityGate = options.enableQualityGate ?? true;
    this.alpha = options.plausibilityAlpha ?? 0.2;
    this.beta = options.klBeta ?? 0.4;
    this.minSpeedup = options.minSpeedup ?? 1.05;
    this.adaptationInterval = options.adaptationInterval ?? 8;
    this.marginalFloor = options.marginalFloor ?? 0.25;
    this.warmUp = options.warmUp ?? false;
    this.tracker = new TokenThroughputTracker({
      draftCostWeight: options.draftCostWeight ?? 0.35,
      verifyLatencyBudgetNs: options.verifyLatencyBudgetNs ?? 2_500_000,
    });
  }

  get throughput(): TokenThroughputTracker {
    return this.tracker;
  }

  rollbackFor(streamId: string): SpeculativeRollback | undefined {
    return this.coordinator.get(streamId);
  }

  /** Registers a stream, creating its rollback ledger. */
  openStream(streamId: string, priority = 0, context: readonly number[] = []): SpeculativeRollback {
    const stream = this.coordinator.register(streamId);
    if (context.length > 0) stream.appendCommitted(context);
    this.streams.set(streamId, {
      id: streamId,
      priority,
      windowSize: this.windowSize,
      acceptanceRate: 0,
      rounds: 0,
      speculative: this.flavour !== "none",
    });
    return stream;
  }

  /** Runs one propose→verify→commit round for a single stream. */
  async runRound(streamId: string): Promise<RoundOutcome> {
    const stream = this.streams.get(streamId);
    const ledger = this.coordinator.get(streamId);
    if (!stream || !ledger) throw new Error(`Unknown speculative stream: ${streamId}`);

    const started = nowNs();
    const seed = this.seedBase + hash(streamId) + stream.rounds;
    const context = ledger.committed();
    let demoted = false;
    let proposed = 0;
    let termination = "target-only";

    // Phase 1 — propose. A failed proposal demotes the stream, never aborts the batch.
    let draft: DraftWindow;
    try {
      draft = await this.draft.propose({
        streamId,
        context,
        windowSize: stream.windowSize,
        seed,
      });
    } catch {
      draft = { tokenIds: [], probs: [], pointMass: true };
      demoted = true;
    }

    // Quality gate: skip verification for windows the draft cannot plausibly serve.
    // The gate is *contrastive* — it needs a target distribution to compare the draft
    // against, and before verification the only one available is the previous round's.
    // On the first round there is nothing to compare against, so the window proposes.
    // Comparing the draft against itself would report KL ≈ 0 and gate nothing.
    if (!demoted && this.qualityGate && draft.probs[0] && !draft.pointMass) {
      const previousTargetRow = this.lastTargetRow.get(streamId);
      if (previousTargetRow) {
        const quality = draftQualityGate(previousTargetRow, draft.probs[0], this.alpha, this.beta);
        if (!quality.propose) {
          draft = { tokenIds: [], probs: [], pointMass: true };
          demoted = true;
          termination = "quality-gate-skip";
        }
      }
    }

    if (draft.tokenIds.length === 0) {
      // Target-only round: one token, no speculation.
      const target = await this.target.verify({
        streamId,
        context,
        draftTokens: [],
        draftPointMass: true,
      });
      const token = target.tokenIds[0] ?? -1;
      if (token >= 0) ledger.appendCommitted([token]);
      // Even a target-only round reveals the target's distribution, which the next
      // round's quality gate can contrast the draft against.
      const targetRow = target.probs[0];
      if (targetRow) this.lastTargetRow.set(streamId, targetRow);
      this.tracker.record({
        streamId,
        proposed: 0,
        accepted: 0,
        bonus: 0,
        committed: token >= 0 ? 1 : 0,
        discarded: 0,
        durationNs: nowNs() - started,
        priority: stream.priority,
      });
      stream.rounds += 1;
      return {
        streamId,
        committed: token >= 0 ? [token] : [],
        acceptCount: 0,
        allAccepted: false,
        proposed: 0,
        durationNs: nowNs() - started,
        demoted,
        termination: demoted ? termination : "target-only",
      };
    }

    proposed = draft.tokenIds.length;
    ledger.stagePending(draft.tokenIds);

    // Phase 2 — verify: one target forward for the whole window.
    let target: TargetWindow;
    try {
      target = await this.target.verify({
        streamId,
        context,
        draftTokens: draft.tokenIds,
        draftPointMass: draft.pointMass,
      });
    } catch (error) {
      // A verification failure must not leak the staged suffix.
      ledger.rollbackAll("budget-exceeded");
      stream.rounds += 1;
      return {
        streamId,
        committed: [],
        acceptCount: 0,
        allAccepted: false,
        proposed,
        durationNs: nowNs() - started,
        demoted: true,
        termination: `verify-failed: ${describe(error)}`,
      };
    }

    // Phase 3 — commit / rollback with the real acceptance math.
    const result = verifyWindow(draft, target, {
      mode: this.mode,
      seed,
      draftToTargetMap: this.d2t,
      forceAccept: this.warmUp,
    });
    // Record the target's distribution at the window head so the *next* round's
    // quality gate has something real to contrast its draft against.
    const verifiedRow = target.probs[0];
    if (verifiedRow) this.lastTargetRow.set(streamId, verifiedRow);

    // The rejection position is measured from the head of the pending window, so the
    // unverified suffix must be discarded *before* the accepted prefix is promoted —
    // committing first shrinks the window, the rejection position then overshoots its
    // end, nothing is discarded and the rejected tail stays reserved, which the leak
    // check would (correctly) flag as an orphaned cache page.
    ledger.rollback(result.firstRejection);
    ledger.commit(result.acceptCount);

    // Exactly one continuation token follows a partial acceptance: the target's own
    // token under greedy verification, or a draw from the residual distribution under
    // stochastic verification. Dropping the residual draw would break the guarantee
    // that speculative decoding reproduces the target model's output distribution.
    if (result.allAccepted) {
      const bonus = target.tokenIds[draft.tokenIds.length] ?? -1;
      if (bonus >= 0) ledger.appendCommitted([bonus]);
    } else {
      const continuation = result.tokenIds[result.acceptCount] ?? -1;
      if (continuation >= 0) ledger.appendCommitted([continuation]);
    }

    const rate = result.acceptCount / Math.max(1, proposed);
    stream.rounds += 1;
    stream.acceptanceRate = stream.rounds === 1 ? rate : 0.3 * rate + 0.7 * stream.acceptanceRate;
    if (stream.rounds % this.adaptationInterval === 0) this.adaptWindow(stream);

    const committed = ledger.committed().slice(context.length);
    this.tracker.record({
      streamId,
      proposed,
      accepted: result.acceptCount,
      bonus: result.allAccepted ? 1 : 0,
      committed: result.tokenIds.length,
      discarded: proposed - result.acceptCount,
      durationNs: nowNs() - started,
      priority: stream.priority,
    });

    return {
      streamId,
      committed,
      acceptCount: result.acceptCount,
      allAccepted: result.allAccepted,
      proposed,
      durationNs: nowNs() - started,
      demoted,
      termination: result.termination,
    };
  }

  /**
   * Runs one round across all streams. Proposals are issued concurrently — the draft
   * forwards are independent per stream — while verification is batched by the target
   * seam. The round outcomes are returned in registration order so callers can rely
   * on a stable stream ordering.
   */
  async runBatchRound(): Promise<RoundOutcome[]> {
    const ids = [...this.streams.keys()];
    const outcomes = new Map<string, RoundOutcome>();
    const pending = ids.map((id) => this.runRound(id).then((outcome) => outcomes.set(id, outcome)));
    await Promise.all(pending);
    return ids.map((id) => outcomes.get(id)!);
  }

  /** Committed output for a stream so far. */
  output(streamId: string): number[] {
    return this.coordinator.get(streamId)?.committed() ?? [];
  }

  /** Adapts γ from the observed acceptance rate, bounded by the configured ceiling. */
  private adaptWindow(stream: StreamState): void {
    const rate = stream.acceptanceRate;
    if (rate >= 0.95) {
      stream.windowSize = Math.min(this.maxWindowSize, stream.windowSize + 1);
      return;
    }
    if (rate < 0.5) {
      stream.windowSize = Math.max(1, Math.floor(stream.windowSize / 2));
      return;
    }
    // Solve for the largest γ whose marginal expected token still clears the floor.
    let gamma = 1;
    for (let position = 1; position < this.maxWindowSize; position++) {
      if (Math.pow(rate, position + 1) < this.marginalFloor) break;
      gamma = position + 1;
    }
    stream.windowSize = Math.max(1, Math.min(this.maxWindowSize, gamma));
  }

  /** Shuts a stream down, releasing all speculative state. */
  closeStream(streamId: string): void {
    this.coordinator.get(streamId)?.cancel();
    this.streams.delete(streamId);
    // The ledger and the cached target row must go too, otherwise `rollbackFor` keeps
    // reporting a stream that no longer exists and the next `openStream` would inherit
    // a stale quality-gate baseline.
    this.coordinator.forget(streamId);
    this.lastTargetRow.delete(streamId);
  }

  /** Batch-wide cache leak check after a round. */
  leaks(): { streams: number; leaked: number; clean: boolean } {
    return this.coordinator.leakReport();
  }
}

export interface BatchSummary {
  readonly rounds: number;
  readonly committed: number;
  readonly proposed: number;
  readonly acceptanceRate: number;
  readonly speedup: number;
  readonly withinLatencyBudget: boolean;
  readonly leaks: number;
}

/** Convenience: run `rounds` rounds over `count` synthetic streams and summarise. */
export async function runSynthetic(
  draft: DraftModel,
  target: TargetModel,
  rounds: number,
  count = 1,
  options?: ParallelSpeculatorOptions,
): Promise<{ summary: BatchSummary; speculator: ParallelSpeculator }> {
  const speculator = new ParallelSpeculator(draft, target, options);
  for (let i = 0; i < count; i++) speculator.openStream(`stream-${i}`, i % 3);
  for (let r = 0; r < rounds; r++) await speculator.runBatchRound();

  const report = speculator.throughput.report();
  const leaks = speculator.leaks();
  return {
    speculator,
    summary: {
      rounds: report.rounds,
      committed: report.committed,
      proposed: report.proposed,
      acceptanceRate: report.acceptanceRate,
      speedup: report.speedup,
      withinLatencyBudget: report.withinLatencyBudget,
      leaks: leaks.leaked,
    },
  };
}

function nowNs(): number {
  if (typeof process !== "undefined" && typeof process.hrtime?.bigint === "function") {
    return Number(process.hrtime.bigint());
  }
  return Date.now() * 1e6;
}

/** Deterministic string hash (FNV-1a) so per-stream seeds are stable across runs. */
function hash(value: string): number {
  let h = 0x811c_9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  return h >>> 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

/** Re-exported so callers can build uniform streams without a crypto dependency. */
export { SeededRandom, expectedAcceptCount };
export type { ProbabilityRow, RoundMetrics };
