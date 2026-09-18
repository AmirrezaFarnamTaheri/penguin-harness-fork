/**
 * Context mode: a switchable retrieval profile.
 *
 * One agent does not want one retrieval posture. A coding session wants few,
 * high-precision chunks and reranking on; an exploratory research session wants
 * a wide candidate pool and a bigger token budget; a session already near its
 * context ceiling wants everything trimmed. The mode is the single dial that
 * moves all of those settings together, so a caller changes one thing instead
 * of twelve — and so a budget under pressure can be *escalated automatically*
 * rather than waiting for the overflow to happen.
 *
 * Modes are data, not code paths: every consumer reads the same resolved
 * profile, and a new mode is a new entry rather than a new branch in every
 * store.
 */

export type ContextModeId = "aggressive" | "balanced" | "conservative" | "minimal";

/**
 * A resolved retrieval profile. Every field has a default in `balanced`, and
 * the other modes are expressed as deltas from it, which keeps the table
 * readable and makes the differences auditable at a glance.
 */
export interface ContextModeProfile {
  id: ContextModeId;
  label: string;
  /** Vector candidates requested from each index. */
  topK: number;
  /** Chunks kept after fusion and reranking. */
  chunkTopK: number;
  /** Tokens allocated to entity context. */
  maxEntityTokens: number;
  /** Tokens allocated to relation context. */
  maxRelationTokens: number;
  /** Total context budget for one retrieval response. */
  maxTotalTokens: number;
  /** Minimum cosine similarity to keep a candidate. */
  cosineThreshold: number;
  /** Whether proximity reranking runs. */
  rerank: boolean;
  /** Whether the lexical branch runs alongside the semantic one. */
  lexical: boolean;
  /** Events retained in recall memory. */
  recallMaxEvents: number;
  /** Tokens retained in recall memory. */
  recallMaxTokens: number;
  /** Chunk byte cap. */
  maxChunkBytes: number;
  /** Fraction of the context window at which compaction triggers. */
  compactionThresholdRatio: number;
  /** Sliding-window eviction fraction when compaction runs. */
  slidingWindowRatio: number;
}

/**
 * The mode table. `balanced` is the reference profile; the others are described
 * relative to it in the comments so the intent of each dial survives review.
 */
export const CONTEXT_MODES: Readonly<Record<ContextModeId, ContextModeProfile>> = Object.freeze({
  // Wide net, precise ranking: more candidates, both retrieval branches,
  // reranking on, and a larger budget to hold the result.
  aggressive: {
    id: "aggressive",
    label: "Aggressive retrieval",
    topK: 60,
    chunkTopK: 30,
    maxEntityTokens: 8_000,
    maxRelationTokens: 10_000,
    maxTotalTokens: 40_000,
    cosineThreshold: 0.2,
    rerank: true,
    lexical: true,
    recallMaxEvents: 800,
    recallMaxTokens: 24_000,
    maxChunkBytes: 6_144,
    compactionThresholdRatio: 0.85,
    slidingWindowRatio: 0.4,
  },
  // The default: every dial at its shipped default value.
  balanced: {
    id: "balanced",
    label: "Balanced retrieval",
    topK: 40,
    chunkTopK: 20,
    maxEntityTokens: 6_000,
    maxRelationTokens: 8_000,
    maxTotalTokens: 30_000,
    cosineThreshold: 0.2,
    rerank: true,
    lexical: true,
    recallMaxEvents: 500,
    recallMaxTokens: 16_000,
    maxChunkBytes: 4_096,
    compactionThresholdRatio: 0.8,
    slidingWindowRatio: 0.3,
  },
  // Tight budget under pressure: fewer candidates, higher bar, smaller
  // budget — precision over coverage, because there is no room for coverage.
  conservative: {
    id: "conservative",
    label: "Conservative retrieval",
    topK: 25,
    chunkTopK: 12,
    maxEntityTokens: 4_000,
    maxRelationTokens: 5_000,
    maxTotalTokens: 20_000,
    cosineThreshold: 0.35,
    rerank: true,
    lexical: true,
    recallMaxEvents: 300,
    recallMaxTokens: 10_000,
    maxChunkBytes: 3_072,
    compactionThresholdRatio: 0.7,
    slidingWindowRatio: 0.25,
  },
  // Survival mode: the context window is nearly full. Reranking and the
  // lexical branch stay on (they cost little and protect precision), but the
  // candidate pool and every budget are cut to the bone.
  minimal: {
    id: "minimal",
    label: "Minimal retrieval",
    topK: 12,
    chunkTopK: 6,
    maxEntityTokens: 2_000,
    maxRelationTokens: 3_000,
    maxTotalTokens: 12_000,
    cosineThreshold: 0.45,
    rerank: true,
    lexical: true,
    recallMaxEvents: 150,
    recallMaxTokens: 6_000,
    maxChunkBytes: 2_048,
    compactionThresholdRatio: 0.6,
    slidingWindowRatio: 0.2,
  },
});

/** The profile a mode resolves to; `balanced` for an unknown id. */
export function resolveContextMode(id: ContextModeId | string): ContextModeProfile {
  return CONTEXT_MODES[id as ContextModeId] ?? CONTEXT_MODES.balanced;
}

/**
 * Escalate one mode to a more conservative one.
 *
 * The escalation ladder is strict — a mode can only go *down* in appetite —
 * because this is the automatic response to context pressure, and an
 * escalation that widened the budget would be the bug it is meant to fix.
 */
export function escalateContextMode(id: ContextModeId): ContextModeId {
  switch (id) {
    case "aggressive":
      return "balanced";
    case "balanced":
      return "conservative";
    case "conservative":
    case "minimal":
      return "minimal";
  }
}

/**
 * Choose a mode for a current utilization ratio (`used / contextWindow`).
 *
 * This is the automatic half of the zero-overflow contract: as the window
 * fills, the retrieval profile tightens before the window is exhausted. The
 * thresholds are deliberately below the compaction trigger, so a mode change
 * is the *first* response and compaction the second.
 */
export function modeForUtilization(ratio: number): ContextModeId {
  if (ratio >= 0.85) return "minimal";
  if (ratio >= 0.7) return "conservative";
  if (ratio >= 0.5) return "balanced";
  return "aggressive";
}

/**
 * Effective thresholds derived from a profile: the token count at which
 * compaction should begin, and the target a compaction should reach.
 *
 * The target is `(1 - slidingWindowRatio) * contextWindow`, so a 0.3 ratio
 * means "evict roughly the oldest 30% and keep 70%". Both are clamped to be
 * sane for a small window: a target at or below the minimum context window
 * would leave nothing worth keeping.
 */
export function compactionThresholds(
  profile: ContextModeProfile,
  contextWindow: number,
): {
  trigger: number;
  target: number;
} {
  const trigger = Math.floor(contextWindow * profile.compactionThresholdRatio);
  const target = Math.max(
    Math.min(contextWindow, 30_000),
    Math.floor(contextWindow * (1 - profile.slidingWindowRatio)),
  );
  return { trigger, target };
}

/**
 * Whether a utilization ratio indicates pressure, i.e. the point at which the
 * mode should be reconsidered. Separated from `modeForUtilization` so a caller
 * can cheaply poll without committing to a change.
 */
export function isUnderPressure(ratio: number): boolean {
  return ratio >= 0.5;
}
