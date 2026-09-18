/**
 * Speculative draft acceptance — modified rejection sampling.
 *
 * Ports the exact verification contract implemented by the reference model of a
 * production speculative-decoding engine (rtp-llm's `referenceRejectionSampling`):
 *
 *   accept(u, q, p)  ⟺  u·p < q                 P(accept) = min(1, q/p)
 *   resample at i    ∝  max(0, q_i − p_i)        relu-diff residual, inverse-CDF
 *   greedy           :  accept ⟺ tokens equal, else emit target token directly
 *   all accepted     :  emit the target bonus token, accepted = γ + 1
 *
 * where `q` is the *target* model's probability of the drafted token and `p` is the
 * *draft* model's. The plan's Tier-5 formula p = min(1, P_target / P_draft) is the
 * same quantity; it is computed here in log space where it is numerically stable.
 *
 * No model weights are involved: this module consumes probability rows and emits
 * acceptance decisions, which is the whole of the correctness-critical seam. A draft
 * quality gate derived from contrastive decoding (plausibility threshold + KL gate)
 * is included because whether a window is worth proposing at all is part of the
 * acceptance decision.
 *
 * Dependency-free: a seeded PRNG is used so acceptance sequences are reproducible,
 * matching the seeded-generator override the ported engine uses for deterministic
 * acceptance.
 */

/** Probability row over a vocabulary. Index == token id. */
export type ProbabilityRow = readonly number[];

export interface DraftWindow {
  /** Draft token ids for one speculative window, length γ (`proposeStep`). */
  readonly tokenIds: readonly number[];
  /**
   * Draft probabilities for each proposed position. `pointMass === true` allows a
   * degenerate draft (greedy/argmax) that supplies no distribution, in which case
   * only the greedy acceptance rule applies.
   */
  readonly probs: readonly ProbabilityRow[];
  readonly pointMass: boolean;
}

export interface TargetWindow {
  /**
   * Target token ids for the γ proposed positions plus one verification row. The
   * last row is the "bonus" token the target would emit after the window.
   */
  readonly tokenIds: readonly number[];
  /** Target probability rows, length γ + 1. */
  readonly probs: readonly ProbabilityRow[];
}

export type VerificationMode = "stochastic" | "greedy";

export interface VerificationResult {
  /** Tokens committed by this round: accepted draft tokens, then the fallback/bonus. */
  readonly tokenIds: number[];
  /** Number of draft positions accepted (0..γ). Result length is acceptCount + 1. */
  readonly acceptCount: number;
  /** Whether every drafted position was accepted (bonus token emitted). */
  readonly allAccepted: boolean;
  /** First rejected position, or γ when nothing was rejected. */
  readonly firstRejection: number;
  /** Per-position acceptance probabilities actually realised this round. */
  readonly acceptanceProbabilities: number[];
  /** Residual sampling outcome when a stochastic rejection occurred, else -1. */
  readonly resampledTokenId: number;
  /** Reason the round ended where it did. */
  readonly termination: "accepted-all" | "rejected-stochastic" | "rejected-greedy" | "empty-window";
}

/**
 * Seeded PRNG (mulberry32) — deterministic, full-period 32-bit. Used so that a given
 * seed reproduces an acceptance sequence exactly, which is how the ported engine's
 * per-stream random_seed override keeps speculative decoding reproducible.
 */
export class SeededRandom {
  private state: number;

  constructor(seed = 0x1d2b_4a37) {
    // Any nonzero 32-bit seed; zero is coerced to the default to keep full period.
    this.state = seed === 0 ? 0x1d2b_4a37 : seed >>> 0;
  }

  /** Uniform in [0, 1) with 2^-32 resolution. */
  next(): number {
    let t = (this.state += 0x6d2b_79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform in [0, 1) for a specific slot without consuming the stream. */
  static at(seed: number, slot: number): number {
    const rng = new SeededRandom(seed);
    let value = 0;
    for (let i = 0; i <= slot; i++) value = rng.next();
    return value;
  }
}

const LOG_EPSILON = 1e-12;

/**
 * Acceptance probability min(1, P_target/P_draft) of one token, in nats of log ratio.
 * Returns 0 (log 1) when the draft is a point mass and the tokens agree — a greedy
 * draft is accepted with certainty on agreement; -Infinity on disagreement means
 * "cannot be accepted" and forces the fallback path.
 */
export function logAcceptanceRatio(
  targetProb: number,
  draftProb: number,
  mode: VerificationMode,
  targetTokenId: number,
  draftTokenId: number,
): number {
  if (mode === "greedy") return targetTokenId === draftTokenId ? 0 : -Infinity;

  if (draftProb <= LOG_EPSILON) return targetProb > LOG_EPSILON ? Number.POSITIVE_INFINITY : 0;
  if (targetProb <= LOG_EPSILON) return -Infinity;
  return Math.log(targetProb) - Math.log(draftProb);
}

/** Numeric acceptance probability, clamped to [0, 1]. */
export function acceptanceProbability(
  targetProb: number,
  draftProb: number,
  mode: VerificationMode,
  targetTokenId: number,
  draftTokenId: number,
): number {
  const logRatio = logAcceptanceRatio(targetProb, draftProb, mode, targetTokenId, draftTokenId);
  if (logRatio === Number.POSITIVE_INFINITY) return 1;
  if (logRatio === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(1, Math.exp(logRatio));
}

/**
 * Inverse-CDF sample from the residual distribution ∝ max(0, q − p).
 *
 * When a drafted token is rejected stochastically, the correct continuation is *not*
 * the target's argmax: it is a draw from the distribution whose density is the
 * positive part of the target-minus-draft difference. This makes speculative
 * decoding produce exactly the same output distribution as the target model alone —
 * the property that makes the speedup free of quality loss.
 *
 * Returns -1 if the residual is empty (target ⊆ draft support), in which case the
 * caller must fall back to the target's own argmax.
 */
export function sampleResidual(
  targetProbs: ProbabilityRow,
  draftProbs: ProbabilityRow | undefined,
  uniform: number,
): number {
  const width = targetProbs.length;
  const residual = new Array<number>(width);
  let sum = 0;

  for (let tokenId = 0; tokenId < width; tokenId++) {
    const q = targetProbs[tokenId] ?? 0;
    const p = draftProbs?.[tokenId] ?? 0;
    const difference = q - p;
    const value = difference > 0 ? difference : 0;
    residual[tokenId] = value;
    sum += value;
  }

  if (!(sum > 0)) return -1;

  const threshold = uniform * sum;
  let aggregate = 0;
  for (let tokenId = 0; tokenId < width; tokenId++) {
    const value = residual[tokenId] ?? 0;
    aggregate += value;
    if (value > 0 && aggregate > threshold) return tokenId;
  }
  return width - 1;
}

export interface VerifyOptions {
  readonly mode?: VerificationMode;
  /** Seed for the uniform samples; fixed seed ⇒ deterministic acceptance. */
  readonly seed?: number;
  /** Explicit uniforms (length ≥ γ + 1), taking precedence over the seed. */
  readonly uniforms?: readonly number[];
  /**
   * Draft-to-target vocabulary mapping. When the draft vocabulary is a subset, draft
   * probability rows must be padded into target-vocabulary width before comparison;
   * the map indexes a draft id to its target id.
   */
  readonly draftToTargetMap?: readonly number[];
  /**
   * Accept every drafted token plus the target bonus token unconditionally. This is
   * the "forced acceptance" override the ported engine exposes for warm-up and for
   * streams whose draft is known-trusted (e.g. prompt-lookup matches).
   */
  readonly forceAccept?: boolean;
}

/**
 * Verifies one speculative window against target probabilities.
 *
 * @param draft the γ drafted tokens with their probabilities
 * @param target γ + 1 target token ids with their probability rows
 */
export function verifyWindow(
  draft: DraftWindow,
  target: TargetWindow,
  options: VerifyOptions = {},
): VerificationResult {
  const gamma = draft.tokenIds.length;
  const mode = options.mode ?? "stochastic";
  const uniforms =
    options.uniforms && options.uniforms.length >= gamma + 1
      ? options.uniforms
      : Array.from({ length: gamma + 1 }, (_, slot) =>
          SeededRandom.at(options.seed ?? 0x1d2b_4a37, slot),
        );

  if (gamma === 0) {
    const bonus = target.tokenIds[0] ?? -1;
    return {
      tokenIds: bonus >= 0 ? [bonus] : [],
      acceptCount: 0,
      allAccepted: true,
      firstRejection: 0,
      acceptanceProbabilities: [],
      resampledTokenId: -1,
      termination: "empty-window",
    };
  }

  if (options.forceAccept) {
    const bonus = target.tokenIds[gamma] ?? -1;
    return {
      tokenIds: [...draft.tokenIds, bonus].filter((id) => id >= 0),
      acceptCount: gamma,
      allAccepted: true,
      firstRejection: gamma,
      acceptanceProbabilities: draft.tokenIds.map(() => 1),
      resampledTokenId: -1,
      termination: "accepted-all",
    };
  }

  const d2t = options.draftToTargetMap;
  const mapDraft = (id: number): number => (d2t ? (d2t[id] ?? id) : id);
  const padRow = (row: ProbabilityRow | undefined, width: number): ProbabilityRow => {
    if (!row) return new Array<number>(width).fill(0);
    if (row.length === width) return row;
    const padded = new Array<number>(width).fill(0);
    if (d2t) {
      for (let draftId = 0; draftId < row.length; draftId++)
        padded[d2t[draftId] ?? draftId] = row[draftId] ?? 0;
    } else {
      for (let i = 0; i < Math.min(row.length, width); i++) padded[i] = row[i] ?? 0;
    }
    return padded;
  };

  const targetWidth = target.probs[0]?.length ?? 0;
  const tokenIds: number[] = [];
  const probabilities: number[] = [];
  let firstRejection = gamma;
  let directTargetFallback = false;
  let resampledTokenId = -1;
  let position = 0;

  for (; position < gamma; position++) {
    const draftId = draft.tokenIds[position] ?? -1;
    const targetId = target.tokenIds[position] ?? -1;
    const draftRow = padRow(draft.probs[position], targetWidth);
    const targetRow = padRow(target.probs[position], targetWidth);
    const comparedDraftId = mapDraft(draftId);

    const q = targetRow[comparedDraftId] ?? 0;
    const p = draft.pointMass ? 1 : (draftRow[draftId] ?? 0);
    const u = uniforms[position] ?? 0;

    if (mode === "greedy") {
      if (targetId === comparedDraftId) {
        tokenIds.push(draftId);
        probabilities.push(1);
      } else {
        // Greedy verification already holds the exact target token; no residual draw.
        tokenIds.push(targetId);
        probabilities.push(0);
        directTargetFallback = true;
        firstRejection = position;
        break;
      }
    } else {
      const probability = acceptanceProbability(q, p, "stochastic", targetId, comparedDraftId);
      probabilities.push(probability);
      if (u * p < q) {
        tokenIds.push(draftId);
      } else {
        firstRejection = position;
        break;
      }
    }
  }

  const acceptCount = position;
  const allAccepted = position >= gamma;

  if (allAccepted) {
    // The whole window was accepted: the target's bonus token is emitted for free.
    const bonus = target.tokenIds[gamma] ?? -1;
    if (bonus >= 0) tokenIds.push(bonus);
    return {
      tokenIds,
      acceptCount: gamma,
      allAccepted: true,
      firstRejection: gamma,
      acceptanceProbabilities: probabilities,
      resampledTokenId: -1,
      termination: "accepted-all",
    };
  }

  if (directTargetFallback) {
    return {
      tokenIds,
      acceptCount,
      allAccepted: false,
      firstRejection,
      acceptanceProbabilities: probabilities,
      resampledTokenId: -1,
      termination: "rejected-greedy",
    };
  }

  // Stochastic rejection: draw the continuation from the residual distribution.
  const residualDraftRow = draft.pointMass ? undefined : draft.probs[firstRejection];
  resampledTokenId = sampleResidual(
    padRow(target.probs[firstRejection], targetWidth),
    padRow(residualDraftRow, targetWidth),
    uniforms[Math.min(firstRejection + 1, gamma)] ?? 0,
  );
  if (resampledTokenId < 0) resampledTokenId = target.tokenIds[firstRejection] ?? -1;
  if (resampledTokenId >= 0) tokenIds.push(resampledTokenId);

  return {
    tokenIds,
    acceptCount,
    allAccepted: false,
    firstRejection,
    acceptanceProbabilities: probabilities,
    resampledTokenId,
    termination: "rejected-stochastic",
  };
}

/**
 * Expected acceptance length of a window — E[acceptCount]. Useful for budgeting and
 * for deciding whether a window is worth proposing. Computed from the per-position
 * acceptance probabilities, which are independent conditional on the draft.
 */
export function expectedAcceptCount(
  draft: DraftWindow,
  target: TargetWindow,
  mode: VerificationMode = "stochastic",
): number {
  const gamma = Math.min(draft.tokenIds.length, target.tokenIds.length);
  let expected = 0;
  for (let position = 0; position < gamma; position++) {
    const draftRow = draft.probs[position];
    const targetRow = target.probs[position];
    if (!draftRow || !targetRow) break;
    const draftId = draft.tokenIds[position] ?? -1;
    const targetId = target.tokenIds[position] ?? -1;
    expected += acceptanceProbability(
      targetRow[draftId] ?? 0,
      draft.pointMass ? 1 : (draftRow[draftId] ?? 0),
      mode,
      targetId,
      draftId,
    );
  }
  return expected;
}

/**
 * Contrastive draft-quality gate (derived from contrastive distributional sampling).
 * A window is worth proposing only where the draft model is *plausibly aligned* with
 * the target but *meaningfully divergent*: the plausibility mask keeps the proposal
 * in the target's high-probability support, and the KL gate rejects windows where the
 * draft merely mirrors the target (nothing speculative to gain) or is incoherent.
 *
 * @param alpha plausibility threshold factor — keep tokens with P_E ≥ α·max(P_E)
 * @param beta  KL divergence threshold — only propose where KL(P_A ‖ P_E) ≥ β
 */
export interface DraftQualityReport {
  readonly plausibleTokenIds: number[];
  readonly klDivergence: number;
  readonly contrastiveWeights: number[];
  readonly propose: boolean;
}

export function draftQualityGate(
  targetProbs: ProbabilityRow,
  draftProbs: ProbabilityRow,
  alpha = 0.2,
  beta = 0.4,
): DraftQualityReport {
  const width = Math.min(targetProbs.length, draftProbs.length);
  const epsilon = 1e-12;

  let maxTarget = 0;
  for (let i = 0; i < width; i++) maxTarget = Math.max(maxTarget, targetProbs[i] ?? 0);
  const plausibilityThreshold = alpha * maxTarget;

  const plausibleTokenIds: number[] = [];
  const contrastiveLogScores: number[] = [];
  let kl = 0;

  for (let i = 0; i < width; i++) {
    const pE = (targetProbs[i] ?? 0) + epsilon;
    const pA = (draftProbs[i] ?? 0) + epsilon;
    kl += pA * Math.log(pA / pE);
    if ((targetProbs[i] ?? 0) >= plausibilityThreshold) {
      plausibleTokenIds.push(i);
      contrastiveLogScores.push(Math.log(pE) - Math.log(pA));
    }
  }

  // softmax over the contrastive scores, restricted to the plausible support
  let maxScore = Number.NEGATIVE_INFINITY;
  for (const score of contrastiveLogScores) maxScore = Math.max(maxScore, score);
  const exponentials = contrastiveLogScores.map((score) => Math.exp(score - maxScore));
  const denominator = exponentials.reduce((sum, value) => sum + value, 0);
  const contrastiveWeights =
    denominator > 0 ? exponentials.map((value) => value / denominator) : [];

  return {
    plausibleTokenIds,
    klDivergence: kl,
    contrastiveWeights,
    propose: plausibleTokenIds.length > 0 && kl >= beta,
  };
}

/**
 * Draft-window acceptance budget: the throughput-optimal γ given an acceptance rate.
 * With per-position acceptance probability a, expected accepted tokens are
 * Σ_{i<γ} a^i·a and the round costs one target verification regardless of γ, so the
 * speedup per round is E[accepted]/1 and γ should only be raised while marginal gain
 * exceeds the draft cost. Returns the largest γ whose marginal expected token is
 * still above `marginalFloor`.
 */
export function optimalWindowSize(
  acceptanceRate: number,
  maxGamma: number,
  marginalFloor = 0.25,
): number {
  if (!(acceptanceRate > 0) || !(acceptanceRate < 1)) return acceptanceRate >= 1 ? maxGamma : 1;
  let gamma = 1;
  for (let position = 1; position < maxGamma; position++) {
    // Marginal expected tokens contributed by adding position `position`.
    const marginal = Math.pow(acceptanceRate, position + 1);
    if (marginal < marginalFloor) break;
    gamma = position + 1;
  }
  return gamma;
}
