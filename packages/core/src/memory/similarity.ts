/**
 * Vector similarity primitives.
 *
 * Ported from the graph-RAG baseline's `cosine_similarity`, which is careful
 * about the two cases that make a naive `dot / (norm*norm)` produce `NaN` and
 * poison a whole ranked list:
 *
 *   - a zero vector is defined to be orthogonal to everything (similarity 0),
 *     instead of `0/0 = NaN`;
 *   - a non-finite norm or dot product (overflow on a large vector, or a
 *     malformed embedding from a backend) also collapses to 0 rather than
 *     propagating `Infinity`/`NaN` into a sort.
 *
 * Everything here is pure arithmetic over `number[]`, so the stores built on
 * it stay dependency-free and unit-testable without any vector database.
 *
 * Normalized dot product: for vectors already on the unit sphere, cosine
 * similarity degenerates to a plain dot product. Retrieval paths normalize
 * once at insert time and then take the cheap path at query time; the guard
 * is still applied, because a backend that returns an un-normalized "normalized"
 * vector must not silently produce `Infinity`.
 */

/**
 * Euclidean (L2) norm. Returns 0 for an empty vector rather than NaN.
 */
export function l2Norm(vector: readonly number[]): number {
  let sum = 0;
  for (const component of vector) {
    sum += component * component;
  }
  return Math.sqrt(sum);
}

/**
 * Dot product of two equal-length vectors. Mismatched lengths score 0 — a
 * dimensionality collision between an old embedding and a new model is a
 * retrieval failure, not a crash.
 */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/**
 * Cosine similarity in [-1, 1]. Zero vectors and any non-finite intermediate
 * value score exactly 0.0.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const dot = dotProduct(a, b);
  const denom = l2Norm(a) * l2Norm(b);
  if (denom === 0 || !Number.isFinite(denom) || !Number.isFinite(dot)) {
    return 0.0;
  }
  const similarity = dot / denom;
  // A rounding artifact can push a nearly-parallel pair a hair above 1.
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Scale a vector onto the unit sphere; the zero vector is returned untouched
 * (it has no direction, and normalizing it would yield `NaN`).
 */
export function normalize(vector: readonly number[]): number[] {
  const norm = l2Norm(vector);
  if (norm === 0 || !Number.isFinite(norm)) return [...vector];
  return vector.map((component) => component / norm);
}

/**
 * Whether `similarity` clears a retrieval threshold. The threshold semantics
 * are "strictly greater than", matching the vector stores' `cosine_better_than_threshold`.
 */
export function passesThreshold(similarity: number, threshold: number): boolean {
  return Number.isFinite(similarity) && similarity > threshold;
}

/**
 * Rank `candidates` by similarity to `query` and keep the top `k`.
 *
 * Ties are broken by insertion order (a stable `sort` keeps the first-seen
 * candidate ahead), which is what makes retrieval deterministic across runs —
 * an important property for the snapshot tests and for cache-hit stability.
 */
export function topBySimilarity<T>(
  query: readonly number[],
  candidates: readonly T[],
  embedding: (candidate: T) => readonly number[],
  k: number,
  threshold = 0,
): Array<T & { similarity: number }> {
  if (k <= 0) return [];
  const scored = candidates.map((candidate) => {
    const similarity = cosineSimilarity(query, embedding(candidate));
    return { candidate, similarity };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored
    .filter((entry) => passesThreshold(entry.similarity, threshold))
    .slice(0, k)
    .map((entry) => ({ ...entry.candidate, similarity: entry.similarity }));
}
