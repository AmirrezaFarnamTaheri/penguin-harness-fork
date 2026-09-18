/**
 * Archival memory: the persistent knowledge tier.
 *
 * This is the tier that survives across sessions. A document is parsed into
 * chunks, each chunk is embedded and indexed twice — once in the vector index
 * for semantic recall, once in a lexical index for exact-term recall — and the
 * chunks are retrievable either way. Dual indexing is not redundant: semantic
 * recall finds "documents about caching" and lexical recall finds "the place
 * `redisClient` was defined", and a query that is an identifier or an error
 * string is a lexical query no matter how good the embedding model is.
 *
 * The lexical scorer is an in-process term-scoring function, not a full-text
 * index dependency. It implements the same ranking idea — term frequency
 * against document length, with stopword damping — at a fidelity high enough
 * to unit-test every retrieval path without a database.
 */

import { chunkMarkdown, chunkPlainText, type Chunk } from "./chunking.js";
import {
  contentId,
  deduplicatingEmbedding,
  type EmbeddingFunction,
  localEmbeddingFunction,
} from "./embedding-pipeline.js";
import { extractProximityTerms, proximityBoost, reciprocalRankFusion } from "./retrieval-fuser.js";
import { InProcessVectorStore } from "./vector-store.js";

/** Stopwords that match everywhere and dilute lexical scoring. */
export const ARCHIVAL_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "way",
  "who",
  "did",
  "get",
  "got",
  "let",
  "say",
  "she",
  "too",
  "use",
  "will",
  "with",
  "this",
  "that",
  "from",
  "they",
  "been",
  "have",
  "many",
  "some",
  "them",
  "than",
  "each",
  "make",
  "like",
  "just",
  "over",
  "such",
  "take",
  "into",
  "year",
  "your",
  "good",
  "could",
  "would",
  "about",
  "which",
  "their",
  "there",
  "other",
  "after",
  "should",
  "through",
  "also",
  "more",
  "most",
  "only",
  "very",
  "when",
  "what",
  "then",
  "these",
  "those",
  "being",
  "does",
  "done",
  "both",
  "same",
  "still",
  "while",
  "where",
  "here",
  "were",
  "much",
  "update",
  "updates",
  "updated",
  "deps",
  "dev",
  "tests",
  "test",
  "add",
  "added",
  "fix",
  "fixed",
  "run",
  "running",
  "using",
]);

/** Source kind, used as a retrieval filter and a telemetry label. */
export type ArchivalSourceKind = "document" | "note" | "code" | "conversation" | "reference";

export interface ArchivalChunk {
  chunkId: string;
  documentId: string;
  source: string;
  sourceKind: ArchivalSourceKind;
  title: string;
  content: string;
  hasCode: boolean;
  order: number;
  createdAt: number;
}

export interface IngestOptions {
  sourceKind?: ArchivalSourceKind;
  /** Override the chunk byte cap for this document. */
  maxChunkBytes?: number;
  /** Treat the input as plain text rather than Markdown. */
  plainText?: boolean;
  /** Lines per chunk when chunking plain text. */
  linesPerChunk?: number;
}

export interface ArchivalQueryOptions {
  topK?: number;
  /** Minimum cosine similarity for the semantic branch. */
  semanticThreshold?: number;
  /** Run the lexical branch as well as the semantic one and fuse the ranks. */
  lexical?: boolean;
  /** Restrict results to one source label. */
  source?: string;
  /** Restrict results to one source kind. */
  sourceKind?: ArchivalSourceKind;
  /** Rerank the fused results by term proximity. */
  proximity?: boolean;
  /** Override the extracted proximity terms. */
  terms?: string[];
}

export interface ArchivalQueryResult extends ArchivalChunk {
  similarity: number;
  fusedScore?: number;
  matchLayer: "semantic" | "lexical" | "fused";
}

/**
 * Term scoring in the absence of a full-text index.
 *
 * `tf / length` rewards documents that are *about* the term rather than merely
 * long, which is the length-normalization idea behind BM25. Stopwords are
 * dropped from the query so they cannot dominate, falling back to the raw
 * terms when a query is *only* stopwords (a one-word stopword query still
 * deserves an answer). A document matching no terms scores 0 and is excluded.
 */
export function lexicalScore(
  document: string,
  queryTerms: string[],
  stopwords: Set<string> = ARCHIVAL_STOPWORDS,
): number {
  if (queryTerms.length === 0) return 0;
  const meaningful = queryTerms.filter((term) => !stopwords.has(term));
  const terms = meaningful.length > 0 ? meaningful : queryTerms;

  const normalized = document.toLowerCase();
  const length = Math.max(1, normalized.length);
  let score = 0;
  for (const term of terms) {
    let frequency = 0;
    let index = normalized.indexOf(term);
    while (index !== -1) {
      frequency++;
      index = normalized.indexOf(term, index + 1);
    }
    score += frequency / length;
  }
  return score;
}

/**
 * Archival memory store: document ingestion plus dual-index retrieval.
 */
export class ArchivalStore {
  private readonly chunks = new Map<string, ArchivalChunk>();
  private readonly documents = new Map<string, { documentId: string; chunkIds: string[] }>();
  private readonly vectorStore: InProcessVectorStore;
  private readonly embedding: EmbeddingFunction;
  private readonly stopwords: Set<string>;

  constructor(
    args: {
      embedding?: EmbeddingFunction;
      cosineThreshold?: number;
      stopwords?: Set<string>;
    } = {},
  ) {
    this.embedding = deduplicatingEmbedding(args.embedding ?? localEmbeddingFunction);
    this.stopwords = args.stopwords ?? ARCHIVAL_STOPWORDS;
    this.vectorStore = new InProcessVectorStore({
      label: "archival-chunks",
      // The store only needs a query-time projection; ingest supplies real
      // vectors through `upsert`, so the sync fallback here is never reached.
      embedding: () => [],
      dimensions: this.embedding.dimensions,
      cosineBetterThanThreshold: args.cosineThreshold ?? 0.2,
    });
  }

  /** Number of stored chunks. */
  size(): number {
    return this.chunks.size;
  }

  /** Number of ingested documents. */
  documentCount(): number {
    return this.documents.size;
  }

  /** Whether a document with this source label has been ingested. */
  hasDocument(source: string): boolean {
    return this.documents.has(source);
  }

  /**
   * Ingest a document: chunk it, embed each chunk, index it in both stores.
   *
   * Re-ingesting the same source replaces it, so a changed document does not
   * leave orphan chunks behind. The document id is content-derived, which makes
   * an unchanged re-ingest observable as a no-op rather than as a duplicate —
   * and the chunk ids the ingestion produced are returned, because the graph
   * stores them as its evidence and cannot derive them from a document id.
   */
  async ingest(
    source: string,
    text: string,
    options: IngestOptions = {},
  ): Promise<{
    documentId: string;
    chunkCount: number;
    /** Chunk ids created for this document, in document order. */
    chunkIds: string[];
    /** Whether the source was already indexed with byte-identical content. */
    unchanged: boolean;
  }> {
    const documentId = contentId(`${source}\n${text}`, "doc:");
    const existing = this.documents.get(source);
    if (existing !== undefined && existing.documentId === documentId) {
      // Nothing to do: the index already holds this exact document, and
      // re-chunking and re-embedding it would produce identical records.
      return {
        documentId,
        chunkCount: existing.chunkIds.length,
        chunkIds: [...existing.chunkIds],
        unchanged: true,
      };
    }

    // Build the replacement before retiring the old version. Chunking and
    // embedding are the calls that can fail — a downed embedding service is the
    // realistic one — and deleting the source first would make a failed rebuild
    // destroy the last good copy. Everything below mutates state only after the
    // replacement is fully formed, so a failure leaves the previous version
    // intact and queryable.
    const chunks: Chunk[] = options.plainText
      ? chunkPlainText(text, options.maxChunkBytes, options.linesPerChunk ?? 40)
      : chunkMarkdown(text, options.maxChunkBytes);

    const vectors = await this.embedding(chunks.map((chunk) => chunk.content));

    const records = chunks.map((chunk, index) => ({
      id: contentId(`${documentId}:${chunk.order}`, "chunk:"),
      vector: vectors[index] ?? [],
      payload: {} as Record<string, unknown>,
    }));
    await this.vectorStore.upsert(records);

    // Swap. The new chunk ids differ from the old ones (the document id is
    // content-derived, so a changed document hashes to new ids), and the old
    // chunks are gone before the new ones are indexed by source, so the
    // replacement never deletes itself.
    if (existing !== undefined) await this.deleteDocument(source);

    const createdAt = Date.now();
    const chunkIds = records.map((record) => record.id);
    records.forEach((record, index) => {
      const chunk = chunks[index]!;
      this.chunks.set(record.id, {
        chunkId: record.id,
        documentId,
        source,
        sourceKind: options.sourceKind ?? "document",
        title: chunk.title,
        content: chunk.content,
        hasCode: chunk.hasCode,
        order: chunk.order,
        createdAt,
      });
    });

    this.documents.set(source, { documentId, chunkIds });
    return { documentId, chunkCount: chunkIds.length, chunkIds, unchanged: false };
  }

  /** Remove a document and every chunk that belonged to it. */
  async deleteDocument(source: string): Promise<number> {
    if (!this.documents.has(source)) return 0;
    const ids: string[] = [];
    for (const [id, chunk] of this.chunks) {
      if (chunk.source === source) ids.push(id);
    }
    for (const id of ids) this.chunks.delete(id);
    await this.vectorStore.delete(ids);
    this.documents.delete(source);
    return ids.length;
  }

  /**
   * Retrieve chunks for a query. The semantic branch is always run; the lexical
   * branch runs when requested, and the two are fused by reciprocal rank so a
   * chunk both branches liked wins over one only one did.
   */
  async query(query: string, options: ArchivalQueryOptions = {}): Promise<ArchivalQueryResult[]> {
    const topK = options.topK ?? 20;
    const candidates = this.candidatesFor(options);
    if (candidates.size === 0) return [];

    const [queryVector] = await this.embedding([query], "archival-query");

    // The source filter narrows the pool *before* the semantic top-K, not after.
    // The vector store ranks every chunk in the store regardless of scope, so
    // asking it for the globally-nearest `topK` first and then dropping the
    // non-matching ones can starve a scoped query: if another source's chunks
    // hold every one of the top slots, this source's real matches never make the
    // cut and the query returns empty despite having valid matches. The filter
    // is pushed into the store query itself, so the top-K is taken over the
    // scoped pool. The `candidates` check below is kept as the guarantee for a
    // backend that ignores the optional filter.
    const semantic: ArchivalQueryResult[] = [];
    const semanticResults = await this.vectorStore.query(query, {
      topK,
      threshold: options.semanticThreshold,
      queryVector,
      ids: new Set([...candidates].map((chunk) => chunk.chunkId)),
    });
    for (const result of semanticResults) {
      const chunk = this.chunks.get(result.id);
      if (!chunk || !candidates.has(chunk)) continue;
      semantic.push({
        ...chunk,
        similarity: result.similarity,
        matchLayer: "semantic",
      });
    }

    if (!options.lexical) {
      return semantic.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
    }

    const terms = extractProximityTerms(query, this.stopwords);
    const lexical: ArchivalQueryResult[] = [];
    for (const chunk of candidates.values()) {
      const score = lexicalScore(chunk.content, terms, this.stopwords);
      if (score > 0) {
        lexical.push({ ...chunk, similarity: 0, matchLayer: "lexical" });
      }
    }
    lexical.sort(
      (a, b) =>
        lexicalScore(b.content, terms, this.stopwords) -
        lexicalScore(a.content, terms, this.stopwords),
    );

    const fused = reciprocalRankFusion(
      [semantic, lexical.slice(0, topK * 2)],
      (item) => item.chunkId,
      topK,
    );
    if (!options.proximity) return fused;

    const termsForProximity = options.terms ?? terms;
    return fused
      .map((item) => ({
        item,
        boost: proximityBoost({
          query,
          title: item.title,
          content: item.content,
          isCode: item.hasCode,
          stopwords: this.stopwords,
          options: { terms: termsForProximity },
        }),
      }))
      .sort((a, b) => b.boost - a.boost || (b.item.fusedScore ?? 0) - (a.item.fusedScore ?? 0))
      .map((entry) => entry.item);
  }

  /** Fetch stored chunks by id, in the order requested. */
  async getByIds(chunkIds: string[]): Promise<ArchivalChunk[]> {
    return chunkIds
      .map((id) => this.chunks.get(id))
      .filter((chunk): chunk is ArchivalChunk => chunk !== undefined);
  }

  /**
   * Vectors for the given chunk ids, for a caller that wants to re-rank them
   * against a query itself. Missing ids are simply absent from the map.
   */
  async vectorsByIds(chunkIds: string[]): Promise<Map<string, number[]>> {
    return this.vectorStore.getVectorsByIds(chunkIds);
  }

  /** Embed a query string in this store's space, for a caller ranking chunks itself. */
  async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.embedding([query], "archival-query");
    if (!vector) {
      throw new Error("embedding pipeline returned no vector for the query");
    }
    return vector;
  }

  private candidatesFor(options: ArchivalQueryOptions): Set<ArchivalChunk> {
    const out = new Set<ArchivalChunk>();
    for (const chunk of this.chunks.values()) {
      if (options.source !== undefined && chunk.source !== options.source) continue;
      if (options.sourceKind !== undefined && chunk.sourceKind !== options.sourceKind) {
        continue;
      }
      out.add(chunk);
    }
    return out;
  }
}
