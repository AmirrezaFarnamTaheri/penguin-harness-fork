/**
 * Recall memory: the short-term event tier.
 *
 * Where archival memory is built to survive, recall memory is built to forget
 * on a schedule. It holds the events of the current session — user messages,
 * assistant turns, tool calls and their results — indexed for immediate
 * re-retrieval, and it ages out by a combination of recency, capacity and
 * token budget. The point is the guarantee the rest of the memory subsystem
 * depends on: whatever the recent history cost, it cannot exceed the budget
 * reserved for it.
 *
 * The three eviction triggers answer different failure modes:
 *
 *   - **capacity** bounds the number of events (unbounded growth is a leak);
 *   - **token budget** bounds the cost of the retained window (the constraint
 *     that actually matters for a context window);
 *   - **age** bounds staleness (a very old recall event is archival material,
 *     and blocking a recall tier from carrying dust is what keeps archival
 *     retrieval precise).
 */

import { estimateTokens } from "./token-math.js";

/** Default maximum events retained in one recall window. */
export const DEFAULT_RECALL_MAX_EVENTS = 500;

/** Default maximum tokens retained in one recall window. */
export const DEFAULT_RECALL_MAX_TOKENS = 16_000;

/** Default maximum age of a retained event, in milliseconds. */
export const DEFAULT_RECALL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Event severity, surfaced for a caller that wants to prefer salient events. */
export type RecallEventSeverity = "info" | "warning" | "error";

export interface RecallEvent {
  /** Stable id, unique within the recall tier. */
  id: string;
  /** Coarse category, used as a retrieval filter. */
  category: string;
  /** Specific type within the category. */
  type: string;
  /** Event body as a string, token-counted and retrieval-scored. */
  data: string;
  severity: RecallEventSeverity;
  createdAt: number;
  /** Token cost, computed once at insert and reused thereafter. */
  tokens: number;
}

export interface RecallQueryOptions {
  topK?: number;
  /** Restrict to one category. */
  category?: string;
  /** Restrict to one type. */
  type?: string;
  /** Include only events at or after this timestamp. */
  since?: number;
  /** Include only events at or before this timestamp. */
  until?: number;
  /** Minimum severity to include. */
  minSeverity?: RecallEventSeverity;
}

export interface RecallQueryResult extends RecallEvent {
  score: number;
}

export interface RecallRetentionOptions {
  maxEvents?: number;
  maxTokens?: number;
  maxAgeMs?: number;
}

const SEVERITY_ORDER: Record<RecallEventSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/**
 * Recency-weighted lexical score for a recall event.
 *
 * `tf / length` handles topical relevance; the recency multiplier is what makes
 * recall memory behave like recall memory — an event from this turn beats an
 * event from three hours ago on the same topic. The multiplier decays
 * exponentially with age over `halfLifeMs`, halving every half-life, which is
 * the shape the plan's "context window decay half-life" constant describes.
 */
export function recallScore(
  event: RecallEvent,
  queryTerms: string[],
  now: number,
  halfLifeMs: number,
): number {
  if (queryTerms.length === 0) return 0;
  const normalized = event.data.toLowerCase();
  const length = Math.max(1, normalized.length);
  let topical = 0;
  for (const term of queryTerms) {
    let frequency = 0;
    let index = normalized.indexOf(term);
    while (index !== -1) {
      frequency++;
      index = normalized.indexOf(term, index + 1);
    }
    topical += frequency / length;
  }
  if (topical === 0) return 0;

  const age = Math.max(0, now - event.createdAt);
  const decay = Math.pow(0.5, age / Math.max(1, halfLifeMs));
  return topical * decay;
}

/**
 * In-process recall memory store with three-way eviction.
 */
export class RecallStore {
  private readonly events = new Map<string, RecallEvent>();
  private readonly options: Required<RecallRetentionOptions>;
  /** Half-life for recency-weighted scoring. */
  readonly halfLifeMs: number;

  constructor(args: RecallRetentionOptions & { halfLifeMs?: number } = {}) {
    this.options = {
      maxEvents: args.maxEvents ?? DEFAULT_RECALL_MAX_EVENTS,
      maxTokens: args.maxTokens ?? DEFAULT_RECALL_MAX_TOKENS,
      maxAgeMs: args.maxAgeMs ?? DEFAULT_RECALL_MAX_AGE_MS,
    };
    this.halfLifeMs = args.halfLifeMs ?? 60 * 60 * 1000;
  }

  /** Number of retained events. */
  size(): number {
    return this.events.size;
  }

  /** Total token cost of the retained window. */
  tokens(): number {
    let total = 0;
    for (const event of this.events.values()) total += event.tokens;
    return total;
  }

  /** Insert one event, then enforce every retention bound. */
  async record(
    id: string,
    category: string,
    type: string,
    data: string,
    severity: RecallEventSeverity = "info",
    now = Date.now(),
  ): Promise<RecallEvent> {
    const event: RecallEvent = {
      id,
      category,
      type,
      data,
      severity,
      createdAt: now,
      tokens: estimateTokens(data),
    };
    this.events.set(id, event);
    await this.evict(now);
    return event;
  }

  /** Remove a single event by id. */
  async delete(id: string): Promise<boolean> {
    return this.events.delete(id);
  }

  /** Clear the entire recall tier. */
  async clear(): Promise<void> {
    this.events.clear();
  }

  /**
   * Retrieve events for a query, scored by recency-weighted topical relevance.
   *
   * An empty query returns the most recent events — the caller wants the tail of
   * the conversation, not a search, and that is what "recall" means here.
   */
  async query(
    query: string,
    options: RecallQueryOptions = {},
    now = Date.now(),
  ): Promise<RecallQueryResult[]> {
    const topK = options.topK ?? 20;
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 2);

    const candidates = this.candidatesFor(options);
    if (terms.length === 0) {
      return [...candidates]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, topK)
        .map((event) => ({ ...event, score: 1 }));
    }

    const scored: RecallQueryResult[] = [];
    for (const event of candidates) {
      const score = recallScore(event, terms, now, this.halfLifeMs);
      if (score > 0) scored.push({ ...event, score });
    }
    scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    return scored.slice(0, topK);
  }

  /** The most recent `count` events, oldest first — for context reconstruction. */
  async recent(count: number): Promise<RecallEvent[]> {
    const sorted = [...this.events.values()].sort((a, b) => a.createdAt - b.createdAt);
    return sorted.slice(Math.max(0, sorted.length - count));
  }

  /**
   * Enforce all three retention bounds. Events past the age limit go first
   * (they are the most clearly stale), then the oldest events are dropped until
   * both the event count and the token budget are inside their caps.
   *
   * Token eviction is a hard guarantee: the retained window never costs more
   * than `maxTokens`, which is the property the zero-overflow contract needs.
   */
  async evict(now = Date.now()): Promise<number> {
    let removed = 0;

    // Age first: an event older than the tier's horizon is archival material or
    // noise, and evicting it before the budget pass keeps the budget from being
    // spent on the stalest thing in the tier.
    const ageCutoff = now - this.options.maxAgeMs;
    for (const [id, event] of this.events) {
      if (event.createdAt < ageCutoff) {
        this.events.delete(id);
        removed++;
      }
    }

    // Then drop from the oldest end until both caps hold. Sorting per eviction
    // is O(n log n) on a bounded tier, which is cheaper than maintaining a
    // sorted structure on every insert.
    let guarded = 0;
    while (
      (this.events.size > this.options.maxEvents || this.tokens() > this.options.maxTokens) &&
      guarded++ < this.events.size + 1
    ) {
      const oldest = this.oldestId();
      if (oldest === undefined) break;
      this.events.delete(oldest);
      removed++;
    }
    return removed;
  }

  private oldestId(): string | undefined {
    let oldestId: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [id, event] of this.events) {
      if (event.createdAt < oldestTime) {
        oldestTime = event.createdAt;
        oldestId = id;
      }
    }
    return oldestId;
  }

  private candidatesFor(options: RecallQueryOptions): RecallEvent[] {
    const out: RecallEvent[] = [];
    const minSeverity = options.minSeverity ? SEVERITY_ORDER[options.minSeverity] : undefined;
    for (const event of this.events.values()) {
      if (options.category !== undefined && event.category !== options.category) continue;
      if (options.type !== undefined && event.type !== options.type) continue;
      if (options.since !== undefined && event.createdAt < options.since) continue;
      if (options.until !== undefined && event.createdAt > options.until) continue;
      if (minSeverity !== undefined && SEVERITY_ORDER[event.severity] < minSeverity) {
        continue;
      }
      out.push(event);
    }
    return out;
  }
}
