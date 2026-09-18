/**
 * Hierarchical memory: the unified three-tier store.
 *
 * This is the synthesis target of the port. Three tiers with different
 * lifetimes and different jobs:
 *
 *   - **Core** — bounded, always in the system prompt. The agent's identity,
 *     standing instructions, and current focus. Small by construction, because
 *     every token here is a token spent on every request for the session.
 *
 *   - **Archival** — persistent knowledge, retrieved on demand. Documents and
 *     their chunks, plus the knowledge graph built over them. Never injected
 *     wholesale; only what a query surfaces.
 *
 *   - **Recall** — the session's recent events, retrieved on demand and aged
 *     out on a schedule. What the agent just did and what the user just said.
 *
 * The tiering is the mechanism that makes the context budget hold: core is
 * bounded by a character cap, archival contributes only retrieved chunks
 * inside a token budget, and recall is bounded by both event count and token
 * count. A long session cannot flood the window, because the things that grow
 * with length are the tiers that are not injected by default.
 *
 * The overflow guard is the last line of defence and it is unconditional:
 * whatever the tiers produced, the final assembled context is truncated to the
 * token budget before it is returned. Every earlier stage is a best effort;
 * this one is the guarantee.
 */

import {
  ArchivalStore,
  type ArchivalQueryOptions,
  type ArchivalQueryResult,
} from "./archival-store.js";
import type { ChunkSizePreset, MemoryPreset } from "./presets.js";
import { DEFAULT_MEMORY_PRESET } from "./presets.js";
import {
  type ContextModeId,
  type ContextModeProfile,
  compactionThresholds,
  escalateContextMode,
  modeForUtilization,
  resolveContextMode,
} from "./context-mode.js";
import {
  type EntityNode,
  type KnowledgeGraphSnapshot,
  type RelationEdge,
  KnowledgeGraphStore,
} from "./knowledge-graph-store.js";
import {
  type RecallEvent,
  type RecallQueryOptions,
  type RecallQueryResult,
  RecallStore,
} from "./recall-store.js";
import { FloodGuard, type FloodGuardConfig } from "./eviction-policy.js";
import {
  pickByVectorSimilarity,
  pickByWeightedPolling,
  roundRobinMerge,
  vectorPickQuota,
} from "./retrieval-fuser.js";
import {
  apportionByWeight,
  availableChunkTokens,
  contextTokensFromUsage,
  estimateTokens,
  type UsageRecord,
} from "./token-math.js";
import { truncateListByTokenSize } from "./chunking.js";

/** Default flood-guard policy: a single greedy actor is throttled, not blinded. */
export const DEFAULT_FLOOD_GUARD: FloodGuardConfig = {
  windowMs: 60_000,
  softCapAfter: 20,
  blockAfter: 60,
};

/** Per-block token caps applied to assembled context sections. */
export interface ContextSectionBudget {
  core: number;
  entities: number;
  relations: number;
  chunks: number;
  total: number;
}

/** The assembled, budget-checked context for one request. */
export interface AssembledContext {
  /** Core memory text, always present. */
  core: string;
  /** Entity context lines, already inside the budget. */
  entities: string[];
  /** Relation context lines, already inside the budget. */
  relations: string[];
  /** Chunks, already inside the budget. */
  chunks: Array<{ chunkId: string; content: string; title: string }>;
  /** Recall events, already inside the budget. */
  recall: RecallEvent[];
  /** Per-section token accounting of the assembled result. */
  budget: Record<string, number>;
  /** Tokens of the assembled result. */
  tokens: number;
  /** Context window the result was fitted into. */
  contextWindow: number;
  /** Whether any section was trimmed to fit. */
  trimmed: boolean;
  /** Mode in force when the context was assembled. */
  mode: ContextModeId;
}

export interface HierarchicalMemoryOptions {
  preset?: MemoryPreset;
  contextWindow?: number;
  /** Flood-guard policy; pass `null` to disable the guard. */
  floodGuard?: FloodGuardConfig | null;
  /** Override the resolved context mode. */
  mode?: ContextModeId;
  /** Cosine similarity a chunk must beat for graph-driven chunk selection. */
  vectorPickThreshold?: number;
}

/**
 * One entry in core memory.
 */
export interface CoreMemoryEntry {
  /** Unique key within the core tier. */
  key: string;
  /** Display label. */
  label: string;
  /** Body text. */
  content: string;
  /** Whether the entry may be evicted automatically. */
  pinned: boolean;
  updatedAt: number;
}

/**
 * The unified memory store.
 */
export class HierarchicalMemoryStore {
  readonly preset: MemoryPreset;
  readonly contextWindow: number;
  readonly graph: KnowledgeGraphStore;
  readonly archival: ArchivalStore;
  readonly recall: RecallStore;
  readonly floodGuard: FloodGuard | null;
  private modeId: ContextModeId;
  private readonly vectorPickThreshold: number;
  private readonly core = new Map<string, CoreMemoryEntry>();

  constructor(args: HierarchicalMemoryOptions = {}) {
    this.preset = args.preset ?? DEFAULT_MEMORY_PRESET;
    this.contextWindow = args.contextWindow ?? 120_000;
    this.modeId = args.mode ?? this.preset.mode;
    this.vectorPickThreshold =
      args.vectorPickThreshold ?? this.preset.embeddingModel.cosineThreshold;
    this.graph = new KnowledgeGraphStore({
      maxNodes: this.preset.retention.graphMaxNodes,
    });
    this.archival = new ArchivalStore({
      cosineThreshold: this.preset.embeddingModel.cosineThreshold,
    });
    this.recall = new RecallStore({
      maxEvents: this.preset.retention.recallMaxEvents,
      maxTokens: this.preset.retention.recallMaxTokens,
      maxAgeMs: this.preset.retention.recallMaxAgeMs,
    });
    this.floodGuard =
      args.floodGuard === null ? null : new FloodGuard(args.floodGuard ?? DEFAULT_FLOOD_GUARD);
  }

  /** The resolved context mode profile currently in force. */
  get mode(): ContextModeProfile {
    return resolveContextMode(this.modeId);
  }

  /** Change the mode directly. */
  setMode(id: ContextModeId): void {
    this.modeId = id;
  }

  /** Number of core-memory entries. */
  coreSize(): number {
    return this.core.size;
  }

  /** Character cost of the core tier — the part injected into every request. */
  coreCharacters(): number {
    let total = 0;
    for (const entry of this.core.values()) total += entry.content.length;
    return total;
  }

  /** Set one core-memory entry, replacing any entry with the same key. */
  setCoreMemory(key: string, label: string, content: string, pinned = false): CoreMemoryEntry {
    const entry: CoreMemoryEntry = {
      key,
      label,
      content,
      pinned,
      updatedAt: Date.now(),
    };
    this.core.set(key, entry);
    return entry;
  }

  /** Remove one core-memory entry. */
  deleteCoreMemory(key: string): boolean {
    return this.core.delete(key);
  }

  /** All core-memory entries, ordered by key for deterministic output. */
  coreMemoryEntries(): CoreMemoryEntry[] {
    return [...this.core.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Rendered core memory: one labelled block per entry. */
  coreMemoryText(): string {
    return this.coreMemoryEntries()
      .map((entry) => `[${entry.label}]\n${entry.content}`)
      .join("\n\n");
  }

  /**
   * Record a session event into recall memory, applying the tier's retention
   * bounds. An `agentKey` partitions the flood guard per agent-context so
   * concurrent subagents do not consume one another's budget.
   */
  async recordEvent(
    id: string,
    category: string,
    type: string,
    data: string,
    severity: "info" | "warning" | "error" = "info",
    agentKey = "default",
  ): Promise<RecallEvent> {
    const decision = this.floodGuard?.record(`event:${agentKey}`);
    if (decision?.blocked) {
      return {
        id,
        category,
        type,
        data: "[event dropped: recall tier under flood guard]",
        severity: "warning",
        createdAt: Date.now(),
        tokens: 8,
      };
    }
    return this.recall.record(id, category, type, data, severity);
  }

  /**
   * Ingest a document into the archival tier and extract entities and
   * relations from it into the knowledge graph.
   *
   * Entity extraction here is structural, not linguistic: headings and
   * emphasized definitions become entities, and co-occurring entities within
   * one section become relations. That is enough to exercise and to reason
   * about the graph, and the extraction seam is where a real extractor plugs
   * in — the store's retrieval paths do not care how the graph was populated.
   */
  async ingestDocument(
    source: string,
    text: string,
    options: { sourceKind?: "document" | "note" | "code" | "conversation" | "reference" } = {},
  ): Promise<{
    documentId: string;
    chunkCount: number;
    entityCount: number;
    relationCount: number;
  }> {
    const ingested = await this.archival.ingest(source, text, {
      sourceKind: options.sourceKind,
      maxChunkBytes: this.preset.chunkSize.maxChunkBytes,
    });

    let entityCount = 0;
    let relationCount = 0;
    const sections = this.extractSections(text);
    for (const section of sections) {
      const names: string[] = [];
      for (const name of section.names) {
        const node = await this.graph.upsertEntity({
          entityName: name,
          entityType: "concept",
          descriptions: [section.heading],
          sourceIds: [ingested.documentId],
          filePath: source,
        });
        if (node) {
          names.push(node.entityName);
          entityCount++;
        }
      }
      // Co-occurrence within one section is the weakest possible relation
      // signal, which is why its weight is 1 and it is always mergeable.
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          await this.graph.upsertRelation({
            source: names[i]!,
            target: names[j]!,
            descriptions: [`co-occur in "${section.heading}"`],
            sourceIds: [ingested.documentId],
            weight: 1,
            filePath: source,
          });
          relationCount++;
        }
      }
    }

    return {
      documentId: ingested.documentId,
      chunkCount: ingested.chunkCount,
      entityCount,
      relationCount,
    };
  }

  /** Section split for structural entity extraction: heading + emphasized terms. */
  private extractSections(text: string): Array<{ heading: string; names: string[] }> {
    const lines = text.split("\n");
    const sections: Array<{ heading: string; names: string[] }> = [];
    let current: { heading: string; names: string[] } | null = null;
    for (const line of lines) {
      const heading = /^#{1,4}\s+(.+)$/.exec(line);
      if (heading) {
        if (current) sections.push(current);
        current = { heading: heading[1]!.trim(), names: [] };
        continue;
      }
      if (!current) {
        current = { heading: sourceTitle(text), names: [] };
      }
      for (const match of line.matchAll(/`{2}([^`]{2,80})`{2}/g)) {
        const name = match[1]?.trim();
        if (name) current.names.push(name);
      }
      for (const match of line.matchAll(/\*\*([^*]{2,80})\*\*/g)) {
        const name = match[1]?.trim();
        if (name) current.names.push(name);
      }
      for (const match of line.matchAll(/\[([^\]]{2,80})\]\(/g)) {
        const name = match[1]?.trim();
        if (name) current.names.push(name);
      }
    }
    if (current) sections.push(current);
    return sections.map((section) => ({
      heading: section.heading,
      names: dedupe(section.names).slice(0, 20),
    }));
  }

  /**
   * Retrieve from the archival tier, through both the vector index and the
   * knowledge graph, and fuse what they return.
   *
   * The graph branch is what makes this dual-level: a query names an entity, the
   * graph finds it, and the chunks that evidence it come back even when their
   * embeddings did not resemble the query. Chunks from both branches are
   * selected by vector similarity where the vectors exist, with a documented
   * fallback to weighted polling when they do not.
   */
  async retrieve(
    query: string,
    options: ArchivalQueryOptions = {},
  ): Promise<{
    chunks: ArchivalQueryResult[];
    entities: EntityNode[];
    relations: Array<RelationEdge & { rank: number }>;
    mode: ContextModeProfile;
    graphSelected: boolean;
  }> {
    const mode = this.mode;
    const guardDecision = this.floodGuard?.record(`retrieve:${query.slice(0, 64)}`);
    const capped =
      guardDecision !== undefined && guardDecision.softCapped && !guardDecision.blocked;
    if (guardDecision?.blocked) {
      return { chunks: [], entities: [], relations: [], mode, graphSelected: false };
    }

    const topK = capped ? 1 : (options.topK ?? mode.chunkTopK);
    const entityTopK = this.preset.retrieval.entityTopK;

    // Branch 1: direct chunk retrieval.
    const direct = await this.archival.query(query, {
      ...options,
      topK,
      lexical: options.lexical ?? mode.lexical,
      proximity: options.proximity ?? mode.rerank,
      semanticThreshold: options.semanticThreshold ?? mode.cosineThreshold,
    });

    // Branch 2: the graph. Find entities the query names, then the chunks that
    // evidence them. This is the path that answers a query about a concept
    // whose name appears verbatim in a document the vector index scored low.
    const entities = await this.entitiesForQuery(query, entityTopK);
    const entityNames = entities.map((node) => node.entityName);
    const relations = await this.graph.relationsForEntities(entityNames);

    const candidateChunkIds: string[] = [];
    for (const node of entities) {
      candidateChunkIds.push(...node.sourceIds);
    }
    const uniqueChunkIds = dedupe(candidateChunkIds);
    const graphChunks = (await this.archival.getByIds(uniqueChunkIds)).map((chunk) => ({
      ...chunk,
      similarity: 0,
      matchLayer: "fused" as const,
    }));

    const { chunks: selected, byVector } = await this.selectChunks(
      query,
      graphChunks,
      entityNames.length,
    );
    const graphResults: ArchivalQueryResult[] = selected.map((chunk) => ({
      ...chunk,
      similarity: 0,
      matchLayer: "fused",
    }));

    const merged = roundRobinMerge([
      direct.map((chunk) => ({ chunkId: chunk.chunkId, chunk })),
      graphResults.map((chunk) => ({ chunkId: chunk.chunkId, chunk })),
    ]).map((entry) => entry.chunk);

    return {
      chunks: merged.slice(0, Math.max(topK * 2, 2)),
      entities,
      relations,
      mode,
      graphSelected: byVector,
    };
  }

  /**
   * Select chunks evidencing the retrieved entities, by vector similarity when
   * the vectors exist and by weighted polling otherwise.
   *
   * Returns `byVector` so a caller can tell which policy ran: a graph-selected
   * chunk set is ordered like a vector query, and a weight-selected one is
   * ordered by entity importance — the two are not interchangeable downstream.
   */
  private async selectChunks(
    query: string,
    chunks: ArchivalQueryResult[],
    itemCount: number,
  ): Promise<{ chunks: ArchivalQueryResult[]; byVector: boolean }> {
    if (chunks.length === 0) return { chunks: [], byVector: false };
    const perItem = this.preset.retrieval.relatedChunksPerItem;
    const ids = chunks.map((chunk) => chunk.chunkId);
    const vectors = await this.archival.vectorsByIds(ids);
    const queryVector = await this.archival.embedQuery(query);

    const byVector = pickByVectorSimilarity({
      queryVector,
      candidates: ids,
      vectors,
      quota: vectorPickQuota(perItem, itemCount),
      threshold: this.vectorPickThreshold,
    });
    if (byVector.length > 0) {
      const wanted = new Set(byVector);
      return {
        chunks: chunks.filter((chunk) => wanted.has(chunk.chunkId)),
        byVector: true,
      };
    }

    // Fallback: linear-gradient allocation across the items that sourced the
    // chunks, when the vector store could not serve them. Each chunk list is a
    // single bucket here because the chunks have already been de-duplicated
    // across entities; the gradient still bounds the total to the quota.
    const polled = pickByWeightedPolling(
      [{ sortedChunks: ids }],
      Math.max(1, perItem * Math.max(1, itemCount)),
    );
    const wanted = new Set(polled);
    return {
      chunks: chunks.filter((chunk) => wanted.has(chunk.chunkId)),
      byVector: false,
    };
  }

  /**
   * Entities ranked by lexical overlap with the query, then alphabetically.
   *
   * The graph has no vector index of its own in this configuration, so the
   * query is matched against entity names lexically. Ties break on name so the
   * result is deterministic, which matters for cache stability.
   */
  private async entitiesForQuery(query: string, topK: number): Promise<EntityNode[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 2);
    if (terms.length === 0) return [];

    const scored = this.graph
      .entityNames()
      .map((name) => {
        const lower = name.toLowerCase();
        let overlap = 0;
        for (const term of terms) {
          if (lower.includes(term)) overlap++;
        }
        return { name, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap || a.name.localeCompare(b.name));

    const wanted = scored
      .filter((entry) => entry.overlap > 0)
      .slice(0, topK)
      .map((entry) => entry.name);
    const batch = await this.graph.getNodesBatch(wanted);
    return wanted
      .map((name) => batch.get(name))
      .filter((node): node is EntityNode => node !== undefined);
  }

  /** Recall retrieval, delegating to the recall tier. */
  recallQuery(query: string, options: RecallQueryOptions = {}): Promise<RecallQueryResult[]> {
    return this.recall.query(query, options);
  }

  /** The most recent recall events, oldest first. */
  recentRecall(count: number): Promise<RecallEvent[]> {
    return this.recall.recent(count);
  }

  /**
   * Decide the mode for the current utilization and escalate if the window is
   * under pressure. Automatic escalation never *widens* the profile, so it is
   * safe to call on every turn.
   */
  adjustModeForUtilization(usedTokens: number): ContextModeId {
    const ratio = usedTokens / Math.max(1, this.contextWindow);
    const wanted = modeForUtilization(ratio);
    const current = resolveContextMode(this.modeId);
    // Only escalate: a hand-set mode may be more conservative than the ratio
    // implies, and that choice must survive an automatic pass.
    if (modeRank(wanted) > modeRank(this.modeId)) {
      this.modeId = wanted;
      return wanted;
    }
    return this.modeId;
  }

  /** Compaction trigger and target for the current mode and window. */
  compactionThresholds() {
    return compactionThresholds(this.mode, this.contextWindow);
  }

  /**
   * Token accounting of a measured usage record, for the anchor that drives
   * utilization decisions. Present-but-empty usage is not an anchor.
   */
  usageTokens(usage: UsageRecord): number {
    return contextTokensFromUsage(usage) ?? 0;
  }

  /**
   * Assemble the full context for a request and guarantee it fits the budget.
   *
   * Every section is truncated to its share of the budget, then the whole is
   * re-checked and, if it is still over, trimmed from the least valuable
   * section downward. The recall tier is dropped first (it is the most
   * replaceable — the same events are still in the transcript), then chunks,
   * then relations. Core is never dropped: an agent without its identity
   * instructions is not a trim, it is a different agent.
   */
  async assemble(args: {
    query: string;
    systemPromptTokens?: number;
    recallCount?: number;
    retrievalOptions?: ArchivalQueryOptions;
  }): Promise<AssembledContext> {
    const mode = this.mode;
    const totalBudget = Math.min(mode.maxTotalTokens, this.contextWindow);
    const systemPromptTokens = args.systemPromptTokens ?? 0;
    const queryTokens = estimateTokens(args.query);
    const chunkAllowance = availableChunkTokens({
      maxTotalTokens: totalBudget,
      systemPromptTokens,
      queryTokens,
    });

    const sections: ContextSectionBudget = {
      core: 0,
      entities: mode.maxEntityTokens,
      relations: mode.maxRelationTokens,
      chunks: Math.max(0, chunkAllowance),
      total: totalBudget,
    };

    const core = this.coreMemoryText();
    const coreTokens = estimateTokens(core);
    sections.core = coreTokens;
    // The core tier may be truncated by the final overflow guarantee; the
    // assembled context reports what was actually emitted, not what was read.
    let assembledCore = core;

    const retrieval = await this.retrieve(args.query, args.retrievalOptions);
    const entityLines = retrieval.entities.map((node) => {
      const description = node.descriptions[0] ?? node.entityType;
      return `${node.entityName} (${node.entityType}): ${description}`;
    });
    const relationLines = retrieval.relations.map(
      (relation) =>
        `${relation.endpoints[0]} ↔ ${relation.endpoints[1]} (weight ${relation.weight})`,
    );

    const entityBudget = Math.max(0, sections.entities);
    const relationBudget = Math.max(0, sections.relations);
    const entities = truncateListByTokenSize(entityLines, (line) => line, "\n", entityBudget);
    const relations = truncateListByTokenSize(relationLines, (line) => line, "\n", relationBudget);

    const chunks = truncateListByTokenSize(
      retrieval.chunks,
      (chunk) => chunk.content,
      "\n",
      sections.chunks,
    ).map((chunk) => ({
      chunkId: chunk.chunkId,
      content: chunk.content,
      title: chunk.title,
    }));

    const recall = await this.recentRecall(args.recallCount ?? 8);
    const recallBudget = Math.max(0, this.preset.retention.recallMaxTokens);
    const trimmedRecall = truncateListByTokenSize(
      recall,
      (event) => event.data,
      "\n",
      recallBudget,
    );

    let budget: Record<string, number> = {
      core: coreTokens,
      entities: estimateTokens(entities.join("\n")),
      relations: estimateTokens(relations.join("\n")),
      chunks: estimateTokens(chunks.map((chunk) => chunk.content).join("\n")),
      recall: estimateTokens(trimmedRecall.map((event) => event.data).join("\n")),
    };

    let tokens = sum(Object.values(budget));
    let trimmed = false;

    // Final, unconditional guarantee: if the assembled context still does not
    // fit (section budgets that sum past the total, or a core tier that grew),
    // drop sections from least to most valuable until it does.
    for (const section of ["recall", "chunks", "relations"] as const) {
      if (tokens <= totalBudget) break;
      budget = { ...budget, [section]: 0 };
      if (section === "recall") trimmedRecall.length = 0;
      if (section === "chunks") chunks.length = 0;
      if (section === "relations") relations.length = 0;
      tokens = sum(Object.values(budget));
      trimmed = true;
    }

    if (tokens > totalBudget) {
      // Core alone is over budget. Truncate the core text rather than drop it:
      // an agent without its identity instructions is a different agent, so the
      // head of the core tier is kept and the tail is cut. The section is
      // re-counted from the truncated text so the accounting stays truthful.
      const allowedChars = totalBudget * 4;
      const truncated = core.slice(0, allowedChars);
      assembledCore = truncated;
      budget = { ...budget, core: estimateTokens(truncated) };
      tokens = sum(Object.values(budget));
      trimmed = true;
    }

    return {
      core: assembledCore,
      entities,
      relations,
      chunks,
      recall: trimmedRecall,
      budget: apportionByWeight(
        Object.entries(budget).map(([key, value]) => ({ key, tokens: value })),
        tokens,
      ),
      tokens,
      contextWindow: this.contextWindow,
      trimmed,
      mode: this.modeId,
    };
  }

  /** Escalate the mode one step; returns the new mode id. */
  escalateMode(): ContextModeId {
    this.modeId = escalateContextMode(this.modeId);
    return this.modeId;
  }
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function dedupe<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function sourceTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0);
  return (firstLine ?? "Untitled").replace(/^#+\s*/, "").slice(0, 80);
}

function modeRank(id: ContextModeId): number {
  return { aggressive: 0, balanced: 1, conservative: 2, minimal: 3 }[id] ?? 1;
}

export { escalateContextMode, resolveContextMode, compactionThresholds };
export type { ChunkSizePreset, MemoryPreset };
