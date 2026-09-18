/**
 * Presets: named, ready-to-use configurations for the memory subsystem.
 *
 * Presets exist so a caller does not have to assemble a coherent
 * configuration from scattered constants. Each one is a complete, validated
 * bundle — chunk sizes, retrieval depths, embedding model, retention bounds —
 * sized for a real workload, and each carries the reason it is sized that way.
 *
 * The chunk-size presets are the part most likely to be tuned by hand, and
 * they follow one rule: overlap is a fraction of the chunk size, so a smaller
 * chunk gets a proportionally smaller overlap. A fixed overlap on a small
 * chunk would duplicate most of the chunk into its neighbour.
 */

import type { ContextModeId } from "./context-mode.js";
import type { EmbeddingModelCatalogEntry } from "./embedding-pipeline.js";
import { EMBEDDING_MODEL_CATALOG, embeddingModelById } from "./embedding-pipeline.js";
import { DEFAULT_MAX_CHUNK_BYTES } from "./chunking.js";
import {
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_SOURCE_IDS_PER_ENTITY,
} from "./knowledge-graph-store.js";
import {
  DEFAULT_RECALL_MAX_AGE_MS,
  DEFAULT_RECALL_MAX_EVENTS,
  DEFAULT_RECALL_MAX_TOKENS,
} from "./recall-store.js";

/** Chunk-size preset: how a document is cut before embedding. */
export interface ChunkSizePreset {
  id: string;
  label: string;
  maxChunkBytes: number;
  overlapTokens: number;
  /** Recommended embedding model for this chunk size. */
  embeddingModelId: string;
}

export const CHUNK_SIZE_PRESETS: readonly ChunkSizePreset[] = [
  {
    id: "fine-grained",
    label: "Fine-grained (code, API references)",
    // Small chunks keep a function or a reference entry intact and stop a long
    // file from diluting BM25-style length normalization.
    maxChunkBytes: 2_048,
    overlapTokens: 64,
    embeddingModelId: "default-local",
  },
  {
    id: "standard",
    label: "Standard (documentation, notes)",
    maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
    overlapTokens: 128,
    embeddingModelId: "default-local",
  },
  {
    id: "coarse",
    label: "Coarse (long-form prose, reports)",
    // Larger chunks keep an argument intact; the bigger overlap compensates for
    // the higher chance a relevant sentence straddles a boundary.
    maxChunkBytes: 8_192,
    overlapTokens: 256,
    embeddingModelId: "balanced-medium",
  },
  {
    id: "monograph",
    label: "Monograph (whole-section context)",
    maxChunkBytes: 16_384,
    overlapTokens: 384,
    embeddingModelId: "high-precision",
  },
];

export function chunkSizePresetById(id: string): ChunkSizePreset | undefined {
  return CHUNK_SIZE_PRESETS.find((preset) => preset.id === id);
}

/** Retrieval top-k presets: how deep each retrieval branch reaches. */
export interface RetrievalTopKPreset {
  id: string;
  label: string;
  entityTopK: number;
  relationTopK: number;
  chunkTopK: number;
  relatedChunksPerItem: number;
}

export const RETRIEVAL_TOP_K_PRESETS: readonly RetrievalTopKPreset[] = [
  {
    id: "fast",
    label: "Fast (interactive latency target)",
    entityTopK: 10,
    relationTopK: 10,
    chunkTopK: 8,
    relatedChunksPerItem: 3,
  },
  {
    id: "standard",
    label: "Standard (balanced recall and latency)",
    entityTopK: 40,
    relationTopK: 40,
    chunkTopK: 20,
    relatedChunksPerItem: 5,
  },
  {
    id: "deep",
    label: "Deep (maximum recall)",
    entityTopK: 80,
    relationTopK: 80,
    chunkTopK: 40,
    relatedChunksPerItem: 8,
  },
];

export function retrievalTopKPresetById(id: string): RetrievalTopKPreset | undefined {
  return RETRIEVAL_TOP_K_PRESETS.find((preset) => preset.id === id);
}

/**
 * Memory retention profile: how each tier of the hierarchy is bounded.
 *
 * The three profiles are the plan's named retention configurations, and they
 * differ in *what is kept*, not merely in how much: a persistent brain keeps
 * archival material indefinitely and trims recall hard, because its value is
 * cross-session knowledge; an ephemeral cache keeps recall and drops archival,
 * because nothing outlives the session.
 */
export interface MemoryRetentionProfile {
  id: string;
  label: string;
  description: string;
  recallMaxEvents: number;
  recallMaxTokens: number;
  recallMaxAgeMs: number;
  archivalMaxChunks: number;
  graphMaxNodes: number;
  maxSourceIdsPerEntity: number;
  /** Whether archival content persists beyond the session. */
  archivalPersists: boolean;
}

export const MEMORY_RETENTION_PROFILES: readonly MemoryRetentionProfile[] = [
  {
    id: "persistent-brain",
    label: "Persistent project brain",
    description:
      "Cross-session knowledge: archival material is kept indefinitely and the graph grows to its ceiling; recall is trimmed, because the point is what survives the session.",
    recallMaxEvents: 300,
    recallMaxTokens: 8_000,
    recallMaxAgeMs: 4 * 60 * 60 * 1000,
    archivalMaxChunks: 100_000,
    graphMaxNodes: DEFAULT_MAX_GRAPH_NODES,
    maxSourceIdsPerEntity: DEFAULT_MAX_SOURCE_IDS_PER_ENTITY,
    archivalPersists: true,
  },
  {
    id: "ephemeral-session",
    label: "Ephemeral session cache",
    description:
      "One session only: recall is generous and archival is bounded and non-persistent, so nothing outlives the session that created it.",
    recallMaxEvents: DEFAULT_RECALL_MAX_EVENTS,
    recallMaxTokens: DEFAULT_RECALL_MAX_TOKENS,
    recallMaxAgeMs: DEFAULT_RECALL_MAX_AGE_MS,
    archivalMaxChunks: 5_000,
    graphMaxNodes: 300,
    maxSourceIdsPerEntity: 64,
    archivalPersists: false,
  },
  {
    id: "knowledge-archive",
    label: "Knowledge base archive",
    description:
      "A curated reference store: archival is unbounded in intent and recall is minimal, because this profile exists to answer from indexed knowledge rather than conversation.",
    recallMaxEvents: 100,
    recallMaxTokens: 4_000,
    recallMaxAgeMs: 60 * 60 * 1000,
    archivalMaxChunks: 1_000_000,
    graphMaxNodes: 5_000,
    maxSourceIdsPerEntity: DEFAULT_MAX_SOURCE_IDS_PER_ENTITY,
    archivalPersists: true,
  },
];

export function retentionProfileById(id: string): MemoryRetentionProfile | undefined {
  return MEMORY_RETENTION_PROFILES.find((profile) => profile.id === id);
}

/**
 * A complete memory configuration: one choice from each preset family, plus
 * the mode that tunes them at runtime.
 */
export interface MemoryPreset {
  id: string;
  label: string;
  chunkSize: ChunkSizePreset;
  retrieval: RetrievalTopKPreset;
  retention: MemoryRetentionProfile;
  mode: ContextModeId;
  embeddingModel: EmbeddingModelCatalogEntry;
}

/**
 * Compose a preset from the ids of its parts, filling every field from the
 * catalog defaults when an id is unknown. Never throws: an unknown id is a
 * configuration mistake, and the right response is a working fallback and a
 * caller-visible difference, not a startup failure.
 */
export function composeMemoryPreset(args: {
  id: string;
  label: string;
  chunkSizeId?: string;
  retrievalId?: string;
  retentionId?: string;
  mode?: ContextModeId;
  embeddingModelId?: string;
}): MemoryPreset {
  const chunkSize = chunkSizePresetById(args.chunkSizeId ?? "standard") ?? CHUNK_SIZE_PRESETS[1]!;
  const retrieval =
    retrievalTopKPresetById(args.retrievalId ?? "standard") ?? RETRIEVAL_TOP_K_PRESETS[1]!;
  const retention =
    retentionProfileById(args.retentionId ?? "persistent-brain") ?? MEMORY_RETENTION_PROFILES[0]!;
  const embeddingModel =
    embeddingModelById(args.embeddingModelId ?? chunkSize.embeddingModelId) ??
    EMBEDDING_MODEL_CATALOG[0]!;
  return {
    id: args.id,
    label: args.label,
    chunkSize,
    retrieval,
    retention,
    mode: args.mode ?? "balanced",
    embeddingModel,
  };
}

/** The shipped default preset, for callers that want one sensible bundle. */
export const DEFAULT_MEMORY_PRESET: MemoryPreset = composeMemoryPreset({
  id: "default",
  label: "Default memory configuration",
});
