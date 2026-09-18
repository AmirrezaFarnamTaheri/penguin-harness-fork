/**
 * Knowledge graph store: entities, relations, and the chunks that evidence them.
 *
 * This is the low level of the dual-level retrieval model. An entity is a node
 * carrying a normalized name, a type, a set of description fragments, and the
 * ids of the chunks it was extracted from. A relation is a canonical
 * undirected edge carrying the same. Retrieval then walks from a vector-similar
 * entity or relation to the chunks that mention it — so a document is found
 * either directly (vector search over chunks) or through the graph (an entity
 * the query names, plus the passages that entity appears in).
 *
 * Concurrency note: `upsert` is structured so the read-modify-write of a node
 * or edge happens inside one call. A caller that wants multi-write isolation
 * must serialize upserts; the store does not take a lock, because in-process
 * single-writer access is the expected pattern.
 */

import { contentId } from "./embedding-pipeline.js";

/** Separator between stored chunk ids inside an entity's `sourceId` field. */
export const GRAPH_FIELD_SEP = "<SEP>";

/** Maximum nodes a graph is allowed to reach before the oldest are retired. */
export const DEFAULT_MAX_GRAPH_NODES = 1000;

/** Maximum characters in a normalized entity name. */
export const DEFAULT_ENTITY_NAME_MAX_LENGTH = 256;

/** Maximum UTF-8 bytes in a normalized entity name (CJK names are short but wide). */
export const DEFAULT_ENTITY_NAME_MAX_BYTES = 512;

/** Maximum entities a single extraction pass may contribute. */
export const DEFAULT_MAX_EXTRACTION_ENTITIES = 40;

/** Maximum source chunk ids recorded per entity or relation. */
export const DEFAULT_MAX_SOURCE_IDS_PER_ENTITY = 200;

export interface EntityNode {
  id: string;
  entityName: string;
  entityType: string;
  /** Description fragments; stored as a list so merges deduplicate rather than append. */
  descriptions: string[];
  /** Chunk ids this entity was extracted from, `<SEP>`-joined when rendered. */
  sourceIds: string[];
  filePath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RelationEdge {
  id: string;
  /** Canonical endpoint pair, sorted — an edge has no direction. */
  endpoints: [string, string];
  descriptions: string[];
  sourceIds: string[];
  /** Aggregate strength, accumulated on merge. */
  weight: number;
  filePath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GraphNodeDegree {
  entityName: string;
  /** Number of edges touching this node. */
  degree: number;
}

export interface KnowledgeGraphSnapshot {
  entityCount: number;
  relationCount: number;
  maxNodes: number;
}

/**
 * Normalize an entity name: collapse whitespace, strip surrounding quotes, and
 * enforce the length and byte ceilings. Names are the join key of the whole
 * graph, so two spellings of one entity must not become two nodes.
 */
export function normalizeEntityName(
  name: string,
  maxLength = DEFAULT_ENTITY_NAME_MAX_LENGTH,
  maxBytes = DEFAULT_ENTITY_NAME_MAX_BYTES,
): string {
  let normalized = (name ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (normalized.length > maxLength) normalized = normalized.slice(0, maxLength);
  let bytes = byteLength(normalized);
  while (bytes > maxBytes && normalized.length > 0) {
    normalized = normalized.slice(0, -1);
    bytes = byteLength(normalized);
  }
  return normalized;
}

function byteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}
const TEXT_ENCODER = new TextEncoder();

/**
 * Canonical, direction-independent key of an edge, so `A→B` and `B→A` resolve
 * to the same relation. Levenshtein-grade care is not needed here: the key is
 * a plain sorted pair.
 */
export function relationKey(a: string, b: string): [string, string] {
  const x = normalizeEntityName(a);
  const y = normalizeEntityName(b);
  return x <= y ? [x, y] : [y, x];
}

/** Split a stored `<SEP>`-joined id field back into a list, dropping empties. */
export function splitGraphField(joined: string | undefined): string[] {
  if (!joined) return [];
  return joined
    .split(GRAPH_FIELD_SEP)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Join a list of ids back into the stored `<SEP>` form. */
export function joinGraphField(ids: readonly string[]): string {
  return ids.filter((id) => id.length > 0).join(GRAPH_FIELD_SEP);
}

/**
 * Merge stored and newly-extracted description fragments, dropping duplicates.
 *
 * Two phases, deliberately. Stored fragments are added first and their count
 * is captured, then new fragments. That boundary is what accurate merge
 * accounting depends on: collapsing both phases into one dedup pass loses the
 * distinction between "already known" and "newly learned". Deduplicating
 * across both phases — not just within the new batch — is what stops a
 * re-extraction pass from appending the same fragment on every run and
 * unbounded growth of a node.
 */
export function mergeDescriptions(
  stored: readonly string[],
  added: readonly string[],
): { fragments: string[]; storedFragmentCount: number } {
  const combined: string[] = [];
  const seen = new Set<string>();

  const add = (descriptions: readonly string[]): void => {
    for (const description of descriptions) {
      const candidate = description.trim();
      if (candidate.length === 0) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      combined.push(candidate);
    }
  };

  add(stored);
  const storedFragmentCount = combined.length;
  add(added);
  return { fragments: combined, storedFragmentCount };
}

/** Cap a source-id list, keeping the first `limit` (earliest evidence first). */
export function capSourceIds(
  sourceIds: readonly string[],
  limit = DEFAULT_MAX_SOURCE_IDS_PER_ENTITY,
): string[] {
  return sourceIds.slice(0, Math.max(0, limit));
}

export interface UpsertEntityInput {
  entityName: string;
  entityType?: string;
  descriptions?: string[];
  sourceIds?: string[];
  filePath?: string;
}

export interface UpsertRelationInput {
  source: string;
  target: string;
  descriptions?: string[];
  sourceIds?: string[];
  weight?: number;
  filePath?: string;
}

/**
 * In-process knowledge graph store.
 */
export class KnowledgeGraphStore {
  private readonly nodes = new Map<string, EntityNode>();
  private readonly edges = new Map<string, RelationEdge>();
  readonly maxNodes: number;

  constructor(args: { maxNodes?: number } = {}) {
    this.maxNodes = args.maxNodes ?? DEFAULT_MAX_GRAPH_NODES;
  }

  /** Number of stored entities. */
  entityCount(): number {
    return this.nodes.size;
  }

  /** Number of stored relations. */
  relationCount(): number {
    return this.edges.size;
  }

  /**
   * Every stored entity name. Enumerating is O(n) over the node table and is
   * the intended way for a caller to rank candidates itself; it is *not* a
   * retrieval path, and a graph at its node ceiling makes this a large array.
   */
  entityNames(): string[] {
    return [...this.nodes.keys()];
  }

  /** Every stored relation, as canonical endpoint pairs. */
  relationPairs(): Array<[string, string]> {
    return [...this.edges.values()].map((edge) => [...edge.endpoints] as [string, string]);
  }

  snapshot(): KnowledgeGraphSnapshot {
    return {
      entityCount: this.nodes.size,
      relationCount: this.edges.size,
      maxNodes: this.maxNodes,
    };
  }

  hasEntity(entityName: string): boolean {
    return this.nodes.has(normalizeEntityName(entityName));
  }

  getEntity(entityName: string): EntityNode | undefined {
    return this.nodes.get(normalizeEntityName(entityName));
  }

  /**
   * Insert or merge an entity. Merging accumulates descriptions (deduplicated)
   * and source ids (deduplicated, capped), which is what makes a re-ingest of
   * an unchanged document a no-op instead of a duplicate generator.
   */
  async upsertEntity(input: UpsertEntityInput): Promise<EntityNode> {
    const name = normalizeEntityName(input.entityName);
    if (name.length === 0) throw new Error("Entity name is empty after normalization");

    const now = Date.now();
    const existing = this.nodes.get(name);
    const descriptions = mergeDescriptions(existing?.descriptions ?? [], input.descriptions ?? []);
    const sourceIds = capSourceIds(
      dedupe([...(existing?.sourceIds ?? []), ...(input.sourceIds ?? [])]),
    );

    const node: EntityNode = {
      id: existing?.id ?? contentId(name, "entity:"),
      entityName: name,
      entityType: input.entityType ?? existing?.entityType ?? "UNKNOWN",
      descriptions: descriptions.fragments,
      sourceIds,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.nodes.set(name, node);
    this.evictIfFull();
    return node;
  }

  /**
   * Insert or merge a relation. Endpoints are canonicalized, so the same pair
   * extracted in either order resolves to one edge whose weight accumulates.
   */
  async upsertRelation(input: UpsertRelationInput): Promise<RelationEdge> {
    const [a, b] = relationKey(input.source, input.target);
    if (a.length === 0 || b.length === 0 || a === b) {
      throw new Error("A relation needs two distinct endpoints");
    }
    const key = joinGraphField([a, b]);
    const now = Date.now();
    const existing = this.edges.get(key);
    const descriptions = mergeDescriptions(existing?.descriptions ?? [], input.descriptions ?? []);
    const sourceIds = capSourceIds(
      dedupe([...(existing?.sourceIds ?? []), ...(input.sourceIds ?? [])]),
    );
    const addedWeight = typeof input.weight === "number" && input.weight > 0 ? input.weight : 1;

    const edge: RelationEdge = {
      id: existing?.id ?? contentId(key, "relation:"),
      endpoints: [a, b],
      descriptions: descriptions.fragments,
      sourceIds,
      weight: (existing?.weight ?? 0) + addedWeight,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.edges.set(key, edge);
    return edge;
  }

  /** Batch endpoint: fetch several nodes at once. */
  async getNodesBatch(names: string[]): Promise<Map<string, EntityNode>> {
    const out = new Map<string, EntityNode>();
    for (const name of names) {
      const node = this.getEntity(name);
      if (node) out.set(node.entityName, node);
    }
    return out;
  }

  /** Batch endpoint: degree of each named node. */
  async nodeDegreesBatch(names: string[]): Promise<Map<string, number>> {
    const wanted = new Set(names.map((name) => normalizeEntityName(name)));
    const degrees = new Map<string, number>();
    for (const edge of this.edges.values()) {
      for (const endpoint of edge.endpoints) {
        if (wanted.has(endpoint)) {
          degrees.set(endpoint, (degrees.get(endpoint) ?? 0) + 1);
        }
      }
    }
    return degrees;
  }

  /** Batch endpoint: every edge touching any of the named nodes, deduplicated. */
  async getNodesEdgesBatch(names: string[]): Promise<Map<string, string[][]>> {
    const wanted = new Set(names.map((name) => normalizeEntityName(name)));
    const out = new Map<string, string[][]>();
    for (const edge of this.edges.values()) {
      for (const endpoint of edge.endpoints) {
        if (wanted.has(endpoint)) {
          const list = out.get(endpoint) ?? [];
          if (
            !list.some((pair) => pair[0] === edge.endpoints[0] && pair[1] === edge.endpoints[1])
          ) {
            list.push([...edge.endpoints]);
          }
          out.set(endpoint, list);
        }
      }
    }
    return out;
  }

  /** All edges between the given endpoint pairs. */
  async getEdgesBatch(pairs: ReadonlyArray<[string, string]>): Promise<Map<string, RelationEdge>> {
    const out = new Map<string, RelationEdge>();
    for (const pair of pairs) {
      const [a, b] = relationKey(pair[0], pair[1]);
      const edge = this.edges.get(joinGraphField([a, b]));
      if (edge) out.set(joinGraphField([a, b]), edge);
    }
    return out;
  }

  /**
   * Relations sorted by `rank` (endpoint degree) then `weight`. Degree is the
   * connectivity proxy the retrieval model uses as a relevance prior: a relation
   * joining two well-connected entities is more likely to be a load-bearing fact
   * than one joining two leaves.
   */
  async relationsForEntities(
    entityNames: string[],
  ): Promise<Array<RelationEdge & { rank: number }>> {
    const adjacency = await this.getNodesEdgesBatch(entityNames);
    const pairs: [string, string][] = [];
    const seen = new Set<string>();
    for (const list of adjacency.values()) {
      for (const pair of list) {
        const key = joinGraphField(pair);
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push(pair as [string, string]);
        }
      }
    }
    const degrees = await this.nodeDegreesBatch(entityNames);
    const edges = await this.getEdgesBatch(pairs);

    const ranked: Array<RelationEdge & { rank: number }> = [];
    for (const pair of pairs) {
      const edge = edges.get(joinGraphField(pair));
      if (!edge) continue;
      const rank = edge.endpoints.reduce((sum, endpoint) => sum + (degrees.get(endpoint) ?? 0), 0);
      ranked.push({ ...edge, rank });
    }
    ranked.sort((a, b) => b.rank - a.rank || b.weight - a.weight);
    return ranked;
  }

  /**
   * Entities touched by the given relations, in first-seen order. Retrieval
   * walks this way when a relation matched the query but its endpoints did not.
   */
  async entitiesForRelations(relations: ReadonlyArray<RelationEdge>): Promise<EntityNode[]> {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const relation of relations) {
      for (const endpoint of relation.endpoints) {
        if (!seen.has(endpoint)) {
          seen.add(endpoint);
          names.push(endpoint);
        }
      }
    }
    const batch = await this.getNodesBatch(names);
    return names
      .map((name) => batch.get(name))
      .filter((node): node is EntityNode => node !== undefined);
  }

  /** Remove an entity and every edge that touched it. */
  async deleteEntity(entityName: string): Promise<number> {
    const name = normalizeEntityName(entityName);
    this.nodes.delete(name);
    let removed = 0;
    for (const [key, edge] of this.edges) {
      if (edge.endpoints.includes(name)) {
        this.edges.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Remove a relation; its endpoints are left alone. */
  async deleteRelation(source: string, target: string): Promise<boolean> {
    const [a, b] = relationKey(source, target);
    return this.edges.delete(joinGraphField([a, b]));
  }

  /**
   * Retire the least-recently-updated node when the graph is at capacity. A
   * graph that grows without bound degrades both retrieval quality and the
   * token cost of a context build; eviction by `updatedAt` keeps the
   * recently-evidenced entities.
   */
  private evictIfFull(): void {
    while (this.nodes.size > this.maxNodes) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, node] of this.nodes) {
        if (node.updatedAt < oldestTime) {
          oldestTime = node.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.nodes.delete(oldestKey);
      for (const [key, edge] of this.edges) {
        if (edge.endpoints.includes(oldestKey)) this.edges.delete(key);
      }
    }
  }
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
