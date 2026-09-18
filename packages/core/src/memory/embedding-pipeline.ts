/**
 * Embedding pipeline: the seam where a real embedding model plugs in, plus a
 * deterministic in-process implementation.
 *
 * The seam is the whole point. Nothing in the memory subsystem depends on an
 * embedding SDK or a hosted API — every store speaks `EmbeddingFunction`, and
 * the default implementation is a local, deterministic, keyless projection. A
 * real backend (a local model server, a hosted API) is supplied by
 * constructing the stores with a different `EmbeddingFunction`; no code below
 * this seam changes.
 *
 * The in-process embedding is *not* a semantic model and does not pretend to
 * be: it is a normalized, dimensionality-fixed hashing projection with
 * term-salted coordinates, which means identical text always yields the
 * identical vector and lexically related text lands nearby. That is enough to
 * exercise every retrieval path, every threshold, and every fusion rule with
 * tests that stay deterministic and offline.
 */

import { createHash } from "node:crypto";
import { normalize } from "./similarity.js";

/** Contract every embedding backend must satisfy. */
export interface EmbeddingFunction {
  /** Embed a batch of inputs; returns one vector per input, in order. */
  (inputs: readonly string[], context?: string): Promise<number[][]>;
  /** Dimensionality of the vectors this function produces. */
  readonly dimensions: number;
  /** Human-readable label, for catalog entries and telemetry. */
  readonly label: string;
}

/** A pluggable reranker: scores documents against a query, returns index/score. */
export interface RerankFunction {
  (
    query: string,
    documents: readonly string[],
    topN?: number,
  ): Promise<Array<{ index: number; relevanceScore: number }>>;
}

export interface EmbeddingModelCatalogEntry {
  /** Semantic platform id, never a vendor-prefixed identifier. */
  id: string;
  label: string;
  dimensions: number;
  /** Vector similarity threshold this model's space separates at. */
  cosineThreshold: number;
  /** Maximum input tokens the model accepts. */
  maxInputTokens: number;
}

/**
 * The embedded catalog of embedding models. Thresholds and dimensionalities are
 * properties of each model's embedding space, and are kept here so a store
 * does not guess at a cutoff that belongs to the model it is using.
 */
export const EMBEDDING_MODEL_CATALOG: readonly EmbeddingModelCatalogEntry[] = [
  {
    id: "default-local",
    label: "Local deterministic projection (offline)",
    dimensions: 256,
    cosineThreshold: 0.2,
    maxInputTokens: 8192,
  },
  {
    id: "balanced-medium",
    label: "Balanced retrieval, 1024 dimensions",
    dimensions: 1024,
    cosineThreshold: 0.3,
    maxInputTokens: 8192,
  },
  {
    id: "high-precision",
    label: "High-precision retrieval, 1536 dimensions",
    dimensions: 1536,
    cosineThreshold: 0.35,
    maxInputTokens: 8192,
  },
];

export function embeddingModelById(id: string): EmbeddingModelCatalogEntry | undefined {
  return EMBEDDING_MODEL_CATALOG.find((entry) => entry.id === id);
}

/**
 * Length-prefixed argument hashing.
 *
 * `"{len}:{arg}"` joined with no separator is ambiguous to collide for a
 * delimiter-less join — `("abc","x")` and `("ab","cx")` hash to the same value.
 * Length-prefixing makes every field boundary recoverable, so no two distinct
 * argument lists can collide, which is what makes a cache key trustworthy.
 * A sentinel delimiter cannot do this, because free-form query text can
 * contain any character.
 *
 * A single-argument call hashes the raw string, so content-derived ids stay
 * stable across upgrades.
 */
export function computeArgsHash(...args: readonly (string | number | boolean)[]): string {
  if (args.length <= 1) {
    return createHash("md5")
      .update(String(args[0] ?? ""))
      .digest("hex");
  }
  const encoded = args.map((arg) => `${String(arg).length}:${String(arg)}`).join("");
  return createHash("md5").update(encoded).digest("hex");
}

/** Content-derived id, prefixed by the kind of record it identifies. */
export function contentId(content: string, prefix = ""): string {
  return `${prefix}${computeArgsHash(content)}`;
}

/**
 * Flattened cache key: `{namespace}:{kind}:{hash}`. Namespacing by namespace
 * and kind is what keeps an extraction cache entry from colliding with a query
 * cache entry built from the same text.
 */
export function cacheKey(namespace: string, kind: string, hash: string): string {
  return `${namespace}:${kind}:${hash}`;
}

/**
 * A stable document id for a structured content list.
 *
 * Structural shape participates in the id, not just concatenated text: two
 * documents whose blocks happen to concatenate to the same string but differ
 * in block boundaries get distinct ids, which keeps a re-parsed document from
 * aliasing an unrelated one.
 */
export function contentListDocumentId(blocks: ReadonlyArray<Record<string, unknown>>): string {
  const shape = blocks
    .map((block) => {
      const type = String(block["type"] ?? "unknown");
      const fields = Object.keys(block)
        .filter((key) => key !== "type")
        .sort()
        .map((key) => `${key}:${typeof block[key]}`)
        .join(",");
      return `${type}{${fields}}`;
    })
    .join("|");
  return computeArgsHash(shape);
}

/**
 * The offline default embedding.
 *
 * Deterministic by construction: each term is hashed into a coordinate set,
 * and a fixed salt scatters terms across the whole space so two distinct terms
 * rarely share a coordinate. Repeated text accumulates on the same coordinates,
 * which gives lexically related inputs a non-zero cosine similarity, and
 * stopword-like terms are damped so they cannot dominate the vector.
 */
export const localEmbeddingFunction: EmbeddingFunction = Object.assign(
  async (inputs: readonly string[], _context?: string): Promise<number[][]> => {
    return inputs.map((input) => localEmbeddingVector(input, 256));
  },
  { dimensions: 256, label: "Local deterministic projection (offline)" },
);

const DAMPED_TERMS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "are",
  "for",
  "on",
  "that",
  "this",
  "with",
  "as",
  "at",
  "by",
  "it",
  "be",
  "was",
  "from",
]);

/** Compute one offline embedding vector. Exported for direct testing. */
export function localEmbeddingVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
  for (const term of terms) {
    const weight = DAMPED_TERMS.has(term) ? 0.25 : 1;
    const digest = createHash("sha256").update(term).digest();
    for (let i = 0; i < digest.length; i += 2) {
      const coordinate = (digest[i]! * 256 + (digest[i + 1] ?? 0)) % dimensions;
      const sign = (digest[i]! & 1) === 0 ? 1 : -1;
      vector[coordinate] = (vector[coordinate] ?? 0) + sign * weight;
    }
  }
  return normalize(vector);
}

/**
 * Wrap an embedding function so repeated inputs in one batch are embedded once.
 *
 * Distinct texts are still embedded; only exact duplicates within the batch are
 * memoized. Long documents often repeat a heading or a boilerplate line dozens
 * of times, and embedding each copy is pure cost with an identical result.
 */
export function deduplicatingEmbedding(embed: EmbeddingFunction): EmbeddingFunction {
  const wrapped = async (inputs: readonly string[], context?: string): Promise<number[][]> => {
    const memo = new Map<string, number[]>();
    const pending: string[] = [];
    for (const input of inputs) {
      if (!memo.has(input)) {
        memo.set(input, []);
        pending.push(input);
      }
    }
    if (pending.length > 0) {
      const vectors = await embed(pending, context);
      pending.forEach((input, index) => {
        memo.set(input, vectors[index] ?? []);
      });
    }
    return inputs.map((input) => memo.get(input) ?? []);
  };
  return Object.assign(wrapped, {
    dimensions: embed.dimensions,
    label: embed.label,
  });
}

/**
 * Rerank result validation. Providers, proxies and custom rerankers return
 * mixed shapes; centralizing the check keeps score aggregation and the final
 * query boundary consistent. A result that fails validation is dropped rather
 * than trusted: an out-of-range index or a non-finite score must not reorder
 * the context.
 */
export function normalizeRerankResult(
  result: unknown,
  maxIndex: number,
): { index: number; relevanceScore: number } | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;

  const index = record["index"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return null;
  }
  if (index >= maxIndex) return null;

  const score = record["relevanceScore"];
  if (typeof score !== "number" || !Number.isFinite(score)) return null;

  return { index, relevanceScore: score };
}
