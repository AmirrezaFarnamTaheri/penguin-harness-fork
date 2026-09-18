/**
 * Vector store abstraction and an in-process implementation.
 *
 * The interface is the stable contract the memory subsystem depends on; the
 * in-process store is the default backend, modelled entirely in memory with no
 * vector-database client. A persistent or hosted backend is supplied by
 * implementing `VectorStore` — nothing above this seam changes.
 *
 * `cosineBetterThanThreshold` is part of the contract rather than a caller
 * constant because a threshold is a property of an embedding space: two models
 * with the same dimensionality can separate at different similarities, and a
 * store is the thing that knows which one it was built with.
 */

import { cosineSimilarity, l2Norm, normalize, passesThreshold } from "./similarity.js";
export { reciprocalRankFusion } from "./retrieval-fuser.js";

/** A record as stored in the vector index. */
export interface VectorRecord {
  /** Stable id, content-derived. */
  id: string;
  /** Vector in the store's embedding space. */
  vector: number[];
  /** Original payload, returned to retrieval verbatim. */
  payload: Record<string, unknown>;
}

export interface VectorQueryOptions {
  /** Maximum results to return. */
  topK: number;
  /** Minimum cosine similarity to keep a result. */
  threshold?: number;
  /** Pre-computed query vector, to avoid re-embedding a query used twice. */
  queryVector?: number[];
}

export interface VectorQueryResult {
  id: string;
  similarity: number;
  payload: Record<string, unknown>;
}

/**
 * The vector-store contract. Every method is async because a real backend is
 * a network or filesystem call; the in-process implementation just never is.
 */
export interface VectorStore {
  readonly label: string;
  readonly dimensions: number;
  /** Similarity a candidate must beat to count as a match in this space. */
  readonly cosineBetterThanThreshold: number;
  upsert(records: VectorRecord[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  query(query: string, options: VectorQueryOptions): Promise<VectorQueryResult[]>;
  getByIds(ids: string[]): Promise<VectorRecord[]>;
  getVectorsByIds(ids: string[]): Promise<Map<string, number[]>>;
  size(): number;
}

/**
 * In-process vector store with a pluggable embedding function.
 *
 * Vectors are normalized at insert time so the query-time comparison is a
 * cheap dot product on the unit sphere; the full cosine is still computed at
 * query time so a payload vector that was somehow not normalized cannot
 * produce an inflated score.
 */
export class InProcessVectorStore implements VectorStore {
  readonly label: string;
  readonly dimensions: number;
  readonly cosineBetterThanThreshold: number;
  private readonly records = new Map<string, VectorRecord>();

  constructor(args: {
    label: string;
    embedding: (input: string) => number[];
    dimensions?: number;
    cosineBetterThanThreshold?: number;
  }) {
    this.label = args.label;
    this.dimensions = args.dimensions ?? 256;
    this.cosineBetterThanThreshold = args.cosineBetterThanThreshold ?? 0.2;
    this.embed = args.embedding;
  }

  private readonly embed: (input: string) => number[];

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      if (record.vector.length !== this.dimensions) {
        throw new Error(
          `${this.label}: vector length ${record.vector.length} does not match store dimensionality ${this.dimensions}`,
        );
      }
      const normalized = l2Norm(record.vector) === 1 ? record.vector : normalize(record.vector);
      this.records.set(record.id, { ...record, vector: normalized });
    }
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async query(query: string, options: VectorQueryOptions): Promise<VectorQueryResult[]> {
    const queryVector = options.queryVector ?? this.embed(query);
    const threshold = options.threshold ?? this.cosineBetterThanThreshold;
    if (queryVector.length !== this.dimensions) return [];

    const scored: VectorQueryResult[] = [];
    for (const record of this.records.values()) {
      const similarity = cosineSimilarity(queryVector, record.vector);
      if (!passesThreshold(similarity, threshold)) continue;
      scored.push({
        id: record.id,
        similarity,
        payload: record.payload,
      });
    }
    scored.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
    return scored.slice(0, Math.max(0, options.topK));
  }

  async getByIds(ids: string[]): Promise<VectorRecord[]> {
    return ids
      .map((id) => this.records.get(id))
      .filter((record): record is VectorRecord => record !== undefined);
  }

  async getVectorsByIds(ids: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (const id of ids) {
      const record = this.records.get(id);
      if (record) out.set(id, record.vector);
    }
    return out;
  }

  size(): number {
    return this.records.size;
  }
}
