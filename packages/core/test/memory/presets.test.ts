import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_CHUNK_BYTES } from "../../src/memory/chunking.js";
import {
  EMBEDDING_MODEL_CATALOG,
  embeddingModelById,
} from "../../src/memory/embedding-pipeline.js";
import {
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_SOURCE_IDS_PER_ENTITY,
} from "../../src/memory/knowledge-graph-store.js";
import {
  DEFAULT_RECALL_MAX_AGE_MS,
  DEFAULT_RECALL_MAX_EVENTS,
  DEFAULT_RECALL_MAX_TOKENS,
} from "../../src/memory/recall-store.js";
import {
  type ChunkSizePreset,
  CHUNK_SIZE_PRESETS,
  chunkSizePresetById,
  composeMemoryPreset,
  DEFAULT_MEMORY_PRESET,
  type MemoryPreset,
  type MemoryRetentionProfile,
  MEMORY_RETENTION_PROFILES,
  type RetrievalTopKPreset,
  RETRIEVAL_TOP_K_PRESETS,
  retentionProfileById,
  retrievalTopKPresetById,
} from "../../src/memory/presets.js";

const CHUNK_REQUIRED: (keyof ChunkSizePreset)[] = [
  "id",
  "label",
  "maxChunkBytes",
  "overlapTokens",
  "embeddingModelId",
];

describe("presets", () => {
  describe("CHUNK_SIZE_PRESETS", () => {
    it("ships the four chunk sizes", () => {
      expect(CHUNK_SIZE_PRESETS.map((preset) => preset.id)).toEqual([
        "fine-grained",
        "standard",
        "coarse",
        "monograph",
      ]);
    });

    it("gives every preset a complete record", () => {
      for (const preset of CHUNK_SIZE_PRESETS) {
        for (const field of CHUNK_REQUIRED) expect(field in preset).toBe(true);
        expect(preset.maxChunkBytes).toBeGreaterThan(0);
        expect(preset.overlapTokens).toBeGreaterThan(0);
      }
    });

    it("sizes standard to the default byte cap", () => {
      expect(chunkSizePresetById("standard")?.maxChunkBytes).toBe(DEFAULT_MAX_CHUNK_BYTES);
    });

    it("scales overlap proportionally with chunk size", () => {
      const overlaps = CHUNK_SIZE_PRESETS.map((preset) => preset.overlapTokens);
      const sizes = CHUNK_SIZE_PRESETS.map((preset) => preset.maxChunkBytes);
      expect(overlaps).toEqual([...overlaps].sort((a, b) => a - b));
      expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
      // Overlap stays a modest fraction of the chunk, never most of it.
      for (const preset of CHUNK_SIZE_PRESETS) {
        const ratio = (preset.overlapTokens * 4) / preset.maxChunkBytes;
        expect(ratio).toBeGreaterThan(0);
        expect(ratio).toBeLessThan(0.5);
      }
    });

    it("resolves every preset's recommended embedding model in the catalog", () => {
      for (const preset of CHUNK_SIZE_PRESETS) {
        expect(embeddingModelById(preset.embeddingModelId)).toBeDefined();
      }
    });

    it("looks up a preset by id and returns undefined for an unknown one", () => {
      expect(chunkSizePresetById("standard")).toBeDefined();
      expect(chunkSizePresetById("nope")).toBeUndefined();
    });
  });

  describe("RETRIEVAL_TOP_K_PRESETS", () => {
    it("ships the three retrieval depths", () => {
      expect(RETRIEVAL_TOP_K_PRESETS.map((preset) => preset.id)).toEqual([
        "fast",
        "standard",
        "deep",
      ]);
    });

    it("deepens every branch from fast to deep", () => {
      const fields: (keyof RetrievalTopKPreset)[] = [
        "entityTopK",
        "relationTopK",
        "chunkTopK",
        "relatedChunksPerItem",
      ];
      for (const field of fields) {
        const values = RETRIEVAL_TOP_K_PRESETS.map((preset) => preset[field] as number);
        expect(values).toEqual([...values].sort((a, b) => a - b));
      }
    });

    it("looks up a preset by id and returns undefined for an unknown one", () => {
      expect(retrievalTopKPresetById("deep")).toBeDefined();
      expect(retrievalTopKPresetById("nope")).toBeUndefined();
    });
  });

  describe("MEMORY_RETENTION_PROFILES", () => {
    it("ships the three retention profiles", () => {
      expect(MEMORY_RETENTION_PROFILES.map((profile) => profile.id)).toEqual([
        "persistent-brain",
        "ephemeral-session",
        "knowledge-archive",
      ]);
    });

    it("gives every profile a complete record with positive bounds", () => {
      const required: (keyof MemoryRetentionProfile)[] = [
        "id",
        "label",
        "description",
        "recallMaxEvents",
        "recallMaxTokens",
        "recallMaxAgeMs",
        "archivalMaxChunks",
        "graphMaxNodes",
        "maxSourceIdsPerEntity",
        "archivalPersists",
      ];
      for (const profile of MEMORY_RETENTION_PROFILES) {
        for (const field of required) expect(field in profile).toBe(true);
        expect(profile.recallMaxEvents).toBeGreaterThan(0);
        expect(profile.recallMaxTokens).toBeGreaterThan(0);
        expect(profile.archivalMaxChunks).toBeGreaterThan(0);
        expect(profile.graphMaxNodes).toBeGreaterThan(0);
        expect(profile.description.length).toBeGreaterThan(0);
      }
    });

    it("differs in what is kept, not merely how much", () => {
      const brain = retentionProfileById("persistent-brain");
      const ephemeral = retentionProfileById("ephemeral-session");
      const archive = retentionProfileById("knowledge-archive");
      expect(brain?.archivalPersists).toBe(true);
      expect(ephemeral?.archivalPersists).toBe(false);
      expect(archive?.archivalPersists).toBe(true);
      // The persistent brain trims recall hardest; the ephemeral cache keeps it.
      expect(brain?.recallMaxEvents).toBeLessThan(ephemeral?.recallMaxEvents ?? Infinity);
      // The archive is the biggest archival store by design.
      expect(archive?.archivalMaxChunks).toBeGreaterThan(brain?.archivalMaxChunks ?? 0);
    });

    it("sizes the persistent brain from the shipped graph defaults", () => {
      const brain = retentionProfileById("persistent-brain");
      expect(brain?.graphMaxNodes).toBe(DEFAULT_MAX_GRAPH_NODES);
      expect(brain?.maxSourceIdsPerEntity).toBe(DEFAULT_MAX_SOURCE_IDS_PER_ENTITY);
    });

    it("sizes the ephemeral session from the shipped recall defaults", () => {
      const ephemeral = retentionProfileById("ephemeral-session");
      expect(ephemeral?.recallMaxEvents).toBe(DEFAULT_RECALL_MAX_EVENTS);
      expect(ephemeral?.recallMaxTokens).toBe(DEFAULT_RECALL_MAX_TOKENS);
      expect(ephemeral?.recallMaxAgeMs).toBe(DEFAULT_RECALL_MAX_AGE_MS);
    });

    it("looks up a profile by id and returns undefined for an unknown one", () => {
      expect(retentionProfileById("nope")).toBeUndefined();
    });
  });

  describe("composeMemoryPreset", () => {
    it("composes a complete preset from explicit ids", () => {
      const preset = composeMemoryPreset({
        id: "mine",
        label: "Mine",
        chunkSizeId: "coarse",
        retrievalId: "deep",
        retentionId: "knowledge-archive",
        mode: "aggressive",
        embeddingModelId: "high-precision",
      });
      expect(preset).toMatchObject({ id: "mine", label: "Mine", mode: "aggressive" });
      expect(preset.chunkSize.id).toBe("coarse");
      expect(preset.retrieval.id).toBe("deep");
      expect(preset.retention.id).toBe("knowledge-archive");
      expect(preset.embeddingModel.id).toBe("high-precision");
    });

    it("fills every field from the catalog defaults when an id is unknown", () => {
      const preset = composeMemoryPreset({
        id: "fallback",
        label: "Fallback",
        chunkSizeId: "nope",
        retrievalId: "nope",
        retentionId: "nope",
        embeddingModelId: "nope",
        mode: "nope" as never,
      });
      expect(preset.chunkSize.id).toBe("standard");
      expect(preset.retrieval.id).toBe("standard");
      expect(preset.retention.id).toBe("persistent-brain");
      expect(preset.embeddingModel.id).toBe(EMBEDDING_MODEL_CATALOG[0]!.id);
    });

    it("defaults to the balanced mode and standard sizes", () => {
      const preset = composeMemoryPreset({ id: "d", label: "d" });
      expect(preset.mode).toBe("balanced");
      expect(preset.chunkSize.id).toBe("standard");
      expect(preset.retrieval.id).toBe("standard");
      expect(preset.retention.id).toBe("persistent-brain");
    });

    it("inherits the chunk size's recommended embedding model when none is given", () => {
      const coarse = composeMemoryPreset({
        id: "c",
        label: "c",
        chunkSizeId: "coarse",
      });
      expect(coarse.embeddingModel.id).toBe("balanced-medium");

      const monograph = composeMemoryPreset({
        id: "m",
        label: "m",
        chunkSizeId: "monograph",
      });
      expect(monograph.embeddingModel.id).toBe("high-precision");
    });

    it("yields a preset that satisfies the MemoryPreset shape", () => {
      const preset: MemoryPreset = composeMemoryPreset({ id: "s", label: "s" });
      expect(preset.chunkSize).toBe(chunkSizePresetById("standard"));
      expect(preset.embeddingModel).toBe(embeddingModelById("default-local"));
    });
  });

  describe("DEFAULT_MEMORY_PRESET", () => {
    it("is the shipped default bundle", () => {
      expect(DEFAULT_MEMORY_PRESET.id).toBe("default");
      expect(DEFAULT_MEMORY_PRESET.label).toBe("Default memory configuration");
      expect(DEFAULT_MEMORY_PRESET).toEqual(
        composeMemoryPreset({ id: "default", label: "Default memory configuration" }),
      );
    });
  });
});
