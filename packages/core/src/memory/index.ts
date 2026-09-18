/**
 * Hierarchical memory — the RAG / context-memory subsystem.
 *
 * Public surface of the subsystem. `HierarchicalMemoryStore` is the composed entry point: it
 * owns the three tiers (core / recall / archival) plus the knowledge graph, assembles a
 * token-budgeted context, and retracts stale graph evidence on re-ingest. The individual stores
 * and helpers are exported for a host that wants to compose them itself.
 *
 * - `HierarchicalMemoryStore` — the three-tier store and context assembler.
 * - `ArchivalStore` / `RecallStore` / `KnowledgeGraphStore` — the tiers, separately usable.
 * - `InProcessVectorStore` + `localEmbeddingFunction` — dependency-free vector retrieval.
 * - `chunkMarkdown` / `chunkPlainText` — the chunkers archival storage switches between.
 * - `resolveContextMode` / `escalateContextMode` — the utilization-driven mode machine that
 *   sizes the assembled context.
 * - `composeMemoryPreset` / `MEMORY_RETENTION_PROFILES` — the retention presets the tiers read.
 *
 * Published through the package root and the `./memory` subpath (see tsup.config.ts); the
 * subpath bundles it without the rest of the SDK.
 */

// The composed store and its options.
export { HierarchicalMemoryStore } from "./hierarchical-memory-store.js";
export type {
  AssembledContext,
  ContextSectionBudget,
  CoreMemoryEntry,
  HierarchicalMemoryOptions,
} from "./hierarchical-memory-store.js";

// The tiers.
export { ArchivalStore } from "./archival-store.js";
export type {
  ArchivalChunk,
  ArchivalQueryOptions,
  ArchivalQueryResult,
  ArchivalSourceKind,
  IngestOptions,
} from "./archival-store.js";

export { RecallStore } from "./recall-store.js";

export { KnowledgeGraphStore } from "./knowledge-graph-store.js";
export type {
  GraphNodeDegree,
  KnowledgeGraphSnapshot,
  EntityNode,
  RelationEdge,
  UpsertEntityInput,
  UpsertRelationInput,
} from "./knowledge-graph-store.js";

// Vector retrieval without a native dependency.
export { InProcessVectorStore } from "./vector-store.js";
export {
  localEmbeddingFunction,
  localEmbeddingVector,
  deduplicatingEmbedding,
  embeddingModelById,
  EMBEDDING_MODEL_CATALOG,
} from "./embedding-pipeline.js";
export type {
  EmbeddingFunction,
  EmbeddingModelCatalogEntry,
  RerankFunction,
} from "./embedding-pipeline.js";

// Chunking.
export {
  chunkMarkdown,
  chunkPlainText,
  splitByTokenLimit,
  truncateListByTokenSize,
  charSafePrefix,
  byteCappedPrefix,
} from "./chunking.js";
export type { Chunk } from "./chunking.js";

// Context modes: the utilization-driven sizing machine.
export {
  resolveContextMode,
  escalateContextMode,
  modeForUtilization,
  compactionThresholds,
  isUnderPressure,
  CONTEXT_MODES,
} from "./context-mode.js";
export type { ContextModeId, ContextModeProfile } from "./context-mode.js";

// Presets and retention.
export {
  composeMemoryPreset,
  chunkSizePresetById,
  retrievalTopKPresetById,
  retentionProfileById,
  CHUNK_SIZE_PRESETS,
  RETRIEVAL_TOP_K_PRESETS,
  MEMORY_RETENTION_PROFILES,
  DEFAULT_MEMORY_PRESET,
} from "./presets.js";
export type {
  ChunkSizePreset,
  MemoryPreset,
  MemoryRetentionProfile,
  RetrievalTopKPreset,
} from "./presets.js";

// Eviction and flood control.
export {
  evictToTokenBudget,
  keepMostValuable,
  FloodGuard,
  LruCache,
  DEFAULT_MEMORY_CONSTRAINTS,
} from "./eviction-policy.js";
export type {
  FloodDecision,
  FloodGuardConfig,
  MemoryConstraintsConfig,
  TokenBudgeted,
} from "./eviction-policy.js";

// Retrieval fusion and similarity.
export {
  reciprocalRankFusion,
  fuseAndRerank,
  applyRerank,
  pickByVectorSimilarity,
} from "./retrieval-fuser.js";
export { cosineSimilarity } from "./similarity.js";

// Token math and content identity.
export {
  contextTokensFromUsage,
  parseTokenBudgetValue,
  availableChunkTokens,
  CHARS_PER_TOKEN,
} from "./token-math.js";
export type { ContextTokenEstimate } from "./token-math.js";
export {
  computeArgsHash,
  contentId,
  cacheKey,
  contentListDocumentId,
} from "./embedding-pipeline.js";
