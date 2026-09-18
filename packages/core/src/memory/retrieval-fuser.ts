/**
 * Retrieval fuser: merges ranked lists, allocates chunk quotas across retrieved
 * entities/relations, and reranks a merged context by term proximity.
 *
 * Four policies live here, each taken from a different baseline and each
 * answering a question the others cannot:
 *
 *   - **Reciprocal rank fusion** — "which chunks do two retrieval strategies
 *     agree on?" A vector index and a lexical index rank differently; fusion
 *     by rank rather than by score makes them comparable without calibrating
 *     their score scales to each other.
 *   - **Weighted polling** — "how do I split a chunk budget across N entities
 *     of unequal importance?" A linear gradient from the most to the least
 *     important, with leftover quota re-distributed in further passes.
 *   - **Vector similarity pick** — "of the chunks evidencing these entities,
 *     which actually resemble the query?" Occurrence count is a crude proxy;
 *     embedding similarity is the real signal, with a documented fallback to
 *     the weight policy when the vector store cannot serve the candidates.
 *   - **Proximity reranking** — "of the chunks that matched, which matched
 *     *well*?" A BM25-style score already rewards term frequency; proximity
 *     rewards terms appearing together, which is the difference between a
 *     chunk that mentions everything once and one that discusses the topic.
 */

import { cosineSimilarity } from "./similarity.js";
import { normalizeRerankResult } from "./embedding-pipeline.js";

/** Standard RRF damping constant. */
export const RRF_K = 60;

/** Character window within which two consecutive query terms count as adjacent. */
export const ADJACENT_PAIR_GAP_CHARS = 30;

/** Adjacent-pair count at which the phrase boost saturates. */
export const PHRASE_BOOST_SATURATION = 4;

/** Maximum phrase boost; deliberately below the proximity boost's ceiling. */
export const PHRASE_BOOST_MAX = 0.5;

/** Title-match boost for chunks whose content is code (names are high signal). */
export const TITLE_WEIGHT_CODE = 0.6;

/** Title-match boost for prose chunks (headings matter, but the body carries more). */
export const TITLE_WEIGHT_PROSE = 0.3;

/** Minimum term length to participate in proximity scoring. */
export const PROXIMITY_MIN_TERM_LENGTH = 2;

/** Cosine similarity a chunk must beat to be selected by vector similarity. */
export const DEFAULT_VECTOR_PICK_THRESHOLD = 0.2;

/**
 * Linear-gradient weighted polling over a shared chunk budget.
 *
 * `maxQuota` is the *total* number of chunks to hand out across every item, not
 * the first item's share. `minQuota` is a per-item floor the budget honours when
 * it can afford one for each item; the discretionary remainder is split on a
 * decreasing linear gradient, so the shares sum to the budget instead of
 * multiplying past it. Leftover quota — an item that had fewer chunks available
 * than its allocation — is re-distributed in single-chunk passes over the items
 * that still have unused chunks, which is what makes the allocation land on the
 * budget rather than shorting it because a well-ranked entity was thin on
 * evidence. A chunk that evidences two items still burns the lower item's slot
 * without being re-added, so the budget is a ceiling, not a guarantee.
 *
 * Input items carry their chunks pre-sorted by importance, so allocation order
 * is also preference order.
 */
export function pickByWeightedPolling(
  items: ReadonlyArray<{ sortedChunks: string[] }>,
  maxQuota: number,
  minQuota = 1,
): string[] {
  if (items.length === 0 || maxQuota <= 0) return [];

  const n = items.length;
  if (n === 1) return items[0]!.sortedChunks.slice(0, maxQuota);

  const expected = new Array<number>(n);
  if (maxQuota <= n * minQuota) {
    // The budget cannot afford the floor for every item, so hand out whole
    // chunks in importance order until it is spent rather than overselling.
    let remaining = maxQuota;
    for (let i = 0; i < n; i++) {
      const share = Math.min(remaining, Math.max(1, minQuota));
      expected[i] = share;
      remaining -= share;
    }
  } else {
    // `n - i` over the triangular total is a decreasing linear gradient whose
    // weights sum to 1. Largest-remainder rounding keeps the shares summing to
    // the discretionary budget exactly: naive `Math.round` per item can leave
    // the total a chunk or two over, which is the overshoot this policy exists
    // to prevent.
    const totalWeight = (n * (n + 1)) / 2;
    const discretionary = maxQuota - n * minQuota;
    const raw = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      raw[i] = discretionary * ((n - i) / totalWeight);
    }
    const shares = raw.map((value) => Math.floor(value));
    let remainder = discretionary - shares.reduce((sum, value) => sum + value, 0);
    const byFraction = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (let k = 0; k < remainder; k++) shares[byFraction[k]!.index]! += 1;
    for (let i = 0; i < n; i++) expected[i] = minQuota + shares[i]!;
  }

  const used = new Array<number>(n).fill(0);
  const selected: string[] = [];
  const seen = new Set<string>();
  let leftover = 0;

  const take = (index: number, count: number): void => {
    const chunks = items[index]!.sortedChunks;
    const already = used[index] ?? 0;
    const available = chunks.slice(already, already + count);
    for (const chunk of available) {
      if (!seen.has(chunk)) {
        seen.add(chunk);
        selected.push(chunk);
      }
    }
    used[index] = already + count;
  };

  for (let i = 0; i < n; i++) {
    const wanted = Math.min(expected[i]!, items[i]!.sortedChunks.length);
    take(i, wanted);
    leftover += Math.max(0, expected[i]! - wanted);
  }

  // Redistribute leftover quota one chunk at a time. Each pass walks the items
  // in importance order and takes a single chunk from the first one that still
  // has one, so the highest-ranked items absorb the slack first.
  for (let pass = 0; pass < leftover; pass++) {
    let allocated = false;
    for (let i = 0; i < n; i++) {
      if (used[i]! < items[i]!.sortedChunks.length) {
        take(i, 1);
        allocated = true;
        break;
      }
    }
    if (!allocated) break;
  }

  return selected;
}

/**
 * Vector-similarity chunk selection.
 *
 * Of the chunks that evidence the retrieved entities/relations, keep the
 * `quota` most similar to the query. Occurrence count — the weight policy's
 * currency — is a proxy for relevance; when embeddings are available they are
 * the better signal, and they also order the result the way the naive
 * retrieval path orders its own, so a merged context is not a lexical-then-
 * vector sandwich.
 *
 * Returns an empty list, never throws, when the vectors cannot be served. The
 * caller falls back to the weight policy; a retrieval path that cannot reach
 * its vector store must degrade, not fail the query.
 */
export function pickByVectorSimilarity(args: {
  queryVector: number[];
  candidates: string[];
  vectors: Map<string, number[]>;
  quota: number;
  threshold?: number;
}): string[] {
  const { queryVector, candidates, vectors, quota } = args;
  if (quota <= 0 || candidates.length === 0) return [];

  // A referenced chunk with no stored vector means the graph/text stores and
  // the vector store disagree. Aborting vector ranking here (rather than
  // scoring the survivors) is deliberate: the caller falls back to a policy
  // that does not need the vectors, instead of ranking a silently partial set.
  if (candidates.length !== vectors.size) return [];
  for (const candidate of candidates) {
    if (!vectors.has(candidate)) return [];
  }

  const scored: Array<{ id: string; similarity: number }> = [];
  for (const candidate of candidates) {
    const vector = vectors.get(candidate);
    if (!vector) continue;
    const similarity = cosineSimilarity(queryVector, vector);
    if (similarity > (args.threshold ?? DEFAULT_VECTOR_PICK_THRESHOLD)) {
      scored.push({ id: candidate, similarity });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
  return scored.slice(0, quota).map((entry) => entry.id);
}

/**
 * How many chunks the vector policy should consider: half the product of the
 * per-item quota and the item count. The halving is a deliberate discount —
 * items overlap heavily in their evidence, so the naive product over-allocates.
 */
export function vectorPickQuota(perItemQuota: number, itemCount: number): number {
  return Math.max(1, Math.floor((perItemQuota * itemCount) / 2));
}

/**
 * Interleave several chunk lists into one, deduplicating by id.
 *
 * Round-robin rather than concatenate: each source contributes its best chunk
 * before any source contributes its second, so a single source with many hits
 * cannot crowd out the others. Order within a source is preserved.
 */
export function roundRobinMerge<T extends { chunkId: string }>(
  sources: ReadonlyArray<ReadonlyArray<T>>,
): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  const longest = sources.reduce((max, list) => Math.max(max, list.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const source of sources) {
      const item = source[i];
      if (!item || seen.has(item.chunkId)) continue;
      seen.add(item.chunkId);
      merged.push(item);
    }
  }
  return merged;
}

/** All positions of `term` in `text`, ascending. */
export function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  if (term.length === 0) return positions;
  let index = text.indexOf(term);
  while (index !== -1) {
    positions.push(index);
    index = text.indexOf(term, index + 1);
  }
  return positions;
}

/**
 * Count matched adjacent pairs across consecutive query terms.
 *
 * For each consecutive term pair, each left position is paired with at most
 * one right position inside the gap window. Each right position is consumed
 * by at most one left, so `"foo foo bar"` counts 1 pair, not 2 — which is what
 * phrase-occurrence intent means, and stops a repeated token inflating a boost.
 */
export function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap = ADJACENT_PAIR_GAP_CHARS,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  let total = 0;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i]!;
    const right = positionLists[i + 1]!;
    const leftLength = terms[i]!.length;
    let j = 0;
    for (const position of left) {
      const minStart = position + leftLength;
      const maxStart = minStart + gap;
      while (j < right.length && right[j]! < minStart) j++;
      if (j < right.length && right[j]! <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/**
 * Minimum window covering at least one position from each list, by sweep line:
 * repeatedly advance the pointer sitting at the current minimum and record the
 * span it produced.
 *
 * The span, not the frequency, is the signal. A long document with one tight
 * occurrence outranks a short document with several loose ones, which is the
 * right trade for relevance — a document that discusses the topic once, well,
 * is more on-topic than one that scatters the terms.
 */
export function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Number.POSITIVE_INFINITY;
  if (positionLists.length === 1) return 0;
  if (positionLists.some((list) => list.length === 0)) {
    return Number.POSITIVE_INFINITY;
  }

  const pointers = new Array<number>(positionLists.length).fill(0);
  let minSpan = Number.POSITIVE_INFINITY;

  for (;;) {
    let currentMin = Number.POSITIVE_INFINITY;
    let currentMax = Number.NEGATIVE_INFINITY;
    let minIndex = 0;
    for (let i = 0; i < positionLists.length; i++) {
      const value = positionLists[i]![pointers[i]!]!;
      if (value < currentMin) {
        currentMin = value;
        minIndex = i;
      }
      if (value > currentMax) currentMax = value;
    }
    const span = currentMax - currentMin;
    if (span < minSpan) minSpan = span;
    pointers[minIndex] = (pointers[minIndex] ?? 0) + 1;
    if (pointers[minIndex]! >= positionLists[minIndex]!.length) break;
  }
  return minSpan;
}

export interface ProximityRerankOptions {
  /** Override the extracted terms entirely (used when the query was rewritten). */
  terms?: string[];
}

/**
 * Proximity reranking boost for one document.
 *
 *   boost = titleBoost + proximityBoost + phraseBoost
 *
 * `titleBoost` rewards query terms in the title, weighted by whether the chunk
 * is code (function and class names are high signal) or prose. `proximityBoost`
 * is `1 / (1 + minSpan / length)` — tight matches in long documents still win,
 * because the span is normalized by document length. `phraseBoost` saturates
 * at `PHRASE_BOOST_SATURATION` adjacent pairs and is capped below the proximity
 * ceiling, so frequency can promote but never outrank locality.
 *
 * Terms shorter than `PROXIMITY_MIN_TERM_LENGTH` are dropped, and stopwords are
 * expected to be filtered by the caller; matching them everywhere would
 * inflate the boost of irrelevant chunks.
 */
export function proximityBoost(args: {
  query: string;
  title: string;
  content: string;
  isCode: boolean;
  stopwords?: Set<string>;
  options?: ProximityRerankOptions;
}): number {
  const terms = args.options?.terms ?? extractProximityTerms(args.query, args.stopwords);
  if (terms.length === 0) return 0;

  const titleLower = args.title.toLowerCase();
  const titleHits = terms.filter((term) => titleLower.includes(term)).length;
  const titleWeight = args.isCode ? TITLE_WEIGHT_CODE : TITLE_WEIGHT_PROSE;
  const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

  if (terms.length < 2) return titleBoost;

  const contentLower = args.content.toLowerCase();
  const positions = terms.map((term) => findAllPositions(contentLower, term));
  if (positions.some((list) => list.length === 0)) return titleBoost;

  const minSpan = findMinSpan(positions);
  if (!Number.isFinite(minSpan)) return titleBoost;
  const proximityBoost = 1 / (1 + minSpan / Math.max(args.content.length, 1));

  const adjacentPairs = countAdjacentPairs(positions, terms);
  const phraseBoost = PHRASE_BOOST_MAX * Math.min(1, adjacentPairs / PHRASE_BOOST_SATURATION);

  return titleBoost + proximityBoost + phraseBoost;
}

/** Lowercased query terms long enough to carry proximity signal. */
export function extractProximityTerms(query: string, stopwords?: Set<string>): string[] {
  const all = (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= PROXIMITY_MIN_TERM_LENGTH);
  const filtered = all.filter((term) => !(stopwords?.has(term) ?? false));
  return filtered.length > 0 ? filtered : all;
}

/**
 * The `rerankScore` given to a document the reranker never scored. Unscoed
 * documents keep their place at the end of the list rather than being dropped,
 * so a reranker that returns a partial list shrinks the context by less than it
 * was asked to.
 */
export const UNSCORED_RERANK_SCORE = 0;

/**
 * Apply a reranker to a retrieved set, keeping original order for anything
 * the reranker did not score. Invalid results are dropped rather than trusted:
 * an out-of-range index or non-finite score must never reorder the context.
 * Unscoed documents follow the scored ones in their original order, so a
 * partial rerank degrades to "ranked first, rest as retrieved" instead of
 * silently truncating the set.
 */
export async function applyRerank<T>(
  query: string,
  documents: readonly T[],
  rerank: (
    query: string,
    documents: readonly T[],
  ) => Promise<Array<{ index: number; relevanceScore: number }>>,
  topN?: number,
): Promise<Array<T & { rerankScore: number }>> {
  if (documents.length === 0) return [];
  const results = await rerank(query, documents);
  const ranked: Array<T & { rerankScore: number }> = [];
  const used = new Set<number>();
  for (const raw of results) {
    const result = normalizeRerankResult(raw, documents.length);
    if (!result) continue;
    if (used.has(result.index)) continue;
    used.add(result.index);
    ranked.push({ ...documents[result.index]!, rerankScore: result.relevanceScore });
  }
  if (used.size < documents.length) {
    for (let index = 0; index < documents.length; index++) {
      if (used.has(index)) continue;
      ranked.push({ ...documents[index]!, rerankScore: UNSCORED_RERANK_SCORE });
    }
  }
  return topN !== undefined ? ranked.slice(0, topN) : ranked;
}

/**
 * Fuse then rerank: RRF over any number of ranked candidate lists, optional
 * proximity reranking of the fused top-N, and an optional model reranker as
 * the final authority. Proximity and rerank are independent: a reranker is
 * applied to the fused list whether or not proximity is configured, and the
 * fused order stands on its own when neither is. The query handed to the
 * reranker comes from `proximity.query`, and is the empty string when proximity
 * is not configured.
 */
export async function fuseAndRerank<T extends { chunkId: string }>(args: {
  candidateLists: ReadonlyArray<ReadonlyArray<T>>;
  topN: number;
  proximity?: {
    query: string;
    titleOf: (item: T) => string;
    contentOf: (item: T) => string;
    isCode: (item: T) => boolean;
    stopwords?: Set<string>;
  };
  rerank?: (
    query: string,
    documents: readonly T[],
  ) => Promise<Array<{ index: number; relevanceScore: number }>>;
}): Promise<Array<T & { fusedScore: number; rerankScore?: number }>> {
  const fused = reciprocalRankFusion(args.candidateLists, (item) => item.chunkId, args.topN);
  if (!args.proximity && !args.rerank) return fused;

  // Proximity reranking reorders the fused top-N. Without it the fused order
  // stands, and the reranker — when one is configured — applies to whichever
  // list survived, so an explicit rerank callback is never silently skipped.
  const query = args.proximity?.query ?? "";
  const ranked = args.proximity ? proximityReorder(fused, args.proximity) : fused;
  if (!args.rerank) return ranked;
  return applyRerank(query, ranked, args.rerank, args.topN);
}

/** Reorder a fused list by proximity boost, fused score breaking ties. */
function proximityReorder<T extends { chunkId: string }>(
  fused: ReadonlyArray<T & { fusedScore: number }>,
  proximity: {
    query: string;
    titleOf: (item: T) => string;
    contentOf: (item: T) => string;
    isCode: (item: T) => boolean;
    stopwords?: Set<string>;
  },
): Array<T & { fusedScore: number }> {
  const boostOf = new Map<string, number>();
  for (const item of fused) {
    boostOf.set(
      item.chunkId,
      proximityBoost({
        query: proximity.query,
        title: proximity.titleOf(item),
        content: proximity.contentOf(item),
        isCode: proximity.isCode(item),
        stopwords: proximity.stopwords,
      }),
    );
  }
  return [...fused].sort((a, b) => {
    const delta = (boostOf.get(b.chunkId) ?? 0) - (boostOf.get(a.chunkId) ?? 0);
    return delta !== 0 ? delta : b.fusedScore - a.fusedScore;
  });
}

/**
 * Reciprocal rank fusion over keyed lists. Exported from the vector-store
 * implementation's home so callers that fuse raw records do not need to
 * construct a store to reach it.
 */
export function reciprocalRankFusion<T>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  keyOf: (item: T) => string,
  topN: number,
  k = RRF_K,
): Array<T & { fusedScore: number }> {
  if (topN <= 0) return [];
  const aggregate = new Map<string, { item: T; score: number; bestRank: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (item === undefined) continue;
      const key = keyOf(item);
      const contribution = 1 / (k + rank + 1);
      const existing = aggregate.get(key);
      if (existing) {
        existing.score += contribution;
        existing.bestRank = Math.min(existing.bestRank, rank);
      } else {
        aggregate.set(key, { item, score: contribution, bestRank: rank });
      }
    }
  }

  return Array.from(aggregate.values())
    .sort((a, b) => b.score - a.score || a.bestRank - b.bestRank)
    .slice(0, topN)
    .map((entry) => ({ ...entry.item, fusedScore: entry.score }));
}
