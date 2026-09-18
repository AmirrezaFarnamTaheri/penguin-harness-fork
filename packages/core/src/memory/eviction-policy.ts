/**
 * Eviction policies and memory-tree constraints.
 *
 * Two different problems share this module, and they are kept apart because
 * confusing them produces the wrong system:
 *
 *   - **Eviction** decides which *records* a bounded store drops when it is
 *     full. LRU is the answer for a cache; token-aware eviction is the answer
 *     for anything that participates in a context budget, because the unit a
 *     store is bounded in is tokens, not records.
 *
 *   - **Constraints** decide whether a memory *tree* is well-formed: depth,
 *     per-file character caps, and a cap on the core memory a system prompt is
 *     built from. A tree that violates these is not "full", it is misshapen —
 *     a 200KB topic file in a system prompt is a prompt-injection and
 *     budget-blowing problem, not a capacity problem — so the answer is to
 *     report it, not to silently drop it.
 */

/**
 * A least-recently-used cache with a capacity in records.
 *
 * Access order is maintained on both `get` and `set`, and eviction removes the
 * least recently accessed entry. An entry read but not written is still
 * promoted, which is what makes an item that is merely *queried* frequently
 * survive — the right behaviour when "used" means "retrieved".
 */
export class LruCache<V> {
  private readonly capacity: number;
  private readonly entries = new Map<string, V>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    // Re-insert at the tail so a read counts as a use. `Map` preserves
    // insertion order, so deleting and re-adding is the promotion.
    this.entries.delete(key);
    this.entries.set(key, value as V);
    return value as V;
  }

  /**
   * Set `key` and, when the capacity is exceeded, evict the least recently used
   * entry. Returns the evicted key when one was dropped, so a caller can
   * propagate the removal to a backing store.
   */
  set(key: string, value: V): string | undefined {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    return this.evict();
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  *[Symbol.iterator](): Iterator<[string, V]> {
    for (const entry of this.entries) yield entry;
  }

  private evict(): string | undefined {
    if (this.entries.size <= this.capacity) return undefined;
    const oldest = this.entries.keys().next().value;
    if (oldest === undefined) return undefined;
    this.entries.delete(oldest);
    return oldest;
  }
}

/** An item that carries its own token cost, for token-aware eviction. */
export interface TokenBudgeted {
  id: string;
  tokens: number;
}

/**
 * Drop the cheapest items from a budgeted set until it fits `maxTokens`.
 *
 * Cheapest-first is the choice, not oldest-first: in a token budget the unit
 * of value is tokens-per-slot, and evicting a 100-token item to keep a
 * 4000-token one preserves more information per token of budget. Items with
 * equal cost fall back to insertion order, so the eviction is deterministic.
 *
 * Returns the ids removed, in removal order.
 */
export function evictToTokenBudget<T extends TokenBudgeted>(
  items: readonly T[],
  maxTokens: number,
): string[] {
  if (maxTokens <= 0) return items.map((item) => item.id);

  const ordered = [...items].map((item, index) => ({ item, index }));
  ordered.sort((a, b) => a.item.tokens - b.item.tokens || a.index - b.index);

  let total = 0;
  const removed: string[] = [];
  for (const entry of ordered) {
    if (total + entry.item.tokens <= maxTokens) {
      total += entry.item.tokens;
    } else {
      removed.push(entry.item.id);
    }
  }
  return removed;
}

/**
 * Keep the `keepCount` most valuable items, valuing each by `valueOf`.
 *
 * Used when a store must shrink to a record count and the records are not
 * interchangeable — e.g. keeping the highest-weight entities in a graph that
 * has hit its node ceiling.
 */
export function keepMostValuable<T>(
  items: readonly T[],
  keepCount: number,
  valueOf: (item: T) => number,
): { keep: T[]; drop: T[] } {
  if (keepCount >= items.length) return { keep: [...items], drop: [] };
  if (keepCount <= 0) return { keep: [], drop: [...items] };

  const indexed = items.map((item, index) => ({ item, index }));
  indexed.sort((a, b) => valueOf(b.item) - valueOf(a.item) || a.index - b.index);
  const winners = indexed.slice(0, keepCount);
  const losers = indexed.slice(keepCount);
  winners.sort((a, b) => a.index - b.index);
  return {
    keep: winners.map((entry) => entry.item),
    drop: losers.map((entry) => entry.item),
  };
}

/**
 * A rolling-window call counter, bucketed per key.
 *
 * The guard that makes a retrieval-happy agent unable to flood its own context
 * window: each key gets an independent window and counter, so concurrent
 * subagents do not consume one another's budget, while a single greedy actor
 * is still throttled exactly as hard. The window resets when it elapses, so a
 * throttled actor is never permanently blocked — it is blocked until its own
 * window rolls over.
 *
 * Soft cap trims results rather than refusing the call; hard cap refuses it.
 * Separating them keeps a busy agent *slower* rather than *blind*.
 */
export interface FloodGuardConfig {
  /** Rolling window length in ms. */
  windowMs: number;
  /** Past this count in the window, results taper to one per query. */
  softCapAfter: number;
  /** Past this count in the window, the call is hard-blocked. */
  blockAfter: number;
}

export interface FloodDecision {
  /** This key's call count inside its current window (1-based). */
  count: number;
  /** Window start timestamp (ms) for this key. */
  windowStart: number;
  /** True past `blockAfter` — the caller must refuse. */
  blocked: boolean;
  /** True past `softCapAfter` — the caller trims to one result. */
  softCapped: boolean;
}

interface FloodBucket {
  count: number;
  windowStart: number;
}

export class FloodGuard {
  private readonly config: FloodGuardConfig;
  private readonly buckets = new Map<string, FloodBucket>();
  private readonly maxKeys: number;

  constructor(config: FloodGuardConfig, maxKeys = 4096) {
    this.config = config;
    this.maxKeys = Math.max(1, Math.floor(maxKeys));
  }

  /** Distinct keys currently tracked. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Record one call for `key` at time `now` and return the throttle decision.
   */
  record(key: string, now = Date.now()): FloodDecision {
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > this.config.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(key, bucket);
      this.evictIfNeeded();
    }
    bucket.count++;
    return {
      count: bucket.count,
      windowStart: bucket.windowStart,
      blocked: bucket.count > this.config.blockAfter,
      softCapped: bucket.count > this.config.softCapAfter,
    };
  }

  /**
   * Hard ceiling on tracked keys. A host that mints unbounded distinct agent ids
   * must be able to grow this map without limit; when the ceiling is hit the
   * oldest-window bucket is dropped, and that actor simply gets a fresh window
   * on its next call. Fails open — never manufactures a false block.
   */
  private evictIfNeeded(): void {
    if (this.buckets.size <= this.maxKeys) return;
    let oldestKey: string | undefined;
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < oldestStart) {
        oldestStart = bucket.windowStart;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

// ── Memory-tree constraints ───────────────────────────────────────────────

export interface MemoryFileCharacterLimit {
  /** Repo-relative glob; the first match wins, and `null` leaves files uncapped. */
  pattern: string;
  maxCharacters: number | null;
}

export interface MemoryConstraintsConfig {
  version: 1;
  /** Maximum directories between the root and a memory file. */
  maxDepth?: number;
  /** Default per-file character cap. */
  maxFileCharacters?: number;
  /** Cap on all root-level Markdown loaded into a system prompt. */
  maxCoreMemoryCharacters?: number;
  /** Ordered glob overrides; the first match wins. */
  fileCharacterLimits?: MemoryFileCharacterLimit[];
}

/** The shipped defaults: shallow tree, modest files, bounded core memory. */
export const DEFAULT_MEMORY_CONSTRAINTS: Readonly<MemoryConstraintsConfig> = Object.freeze({
  version: 1,
  maxDepth: 2,
  maxFileCharacters: 20_000,
  maxCoreMemoryCharacters: 65_536,
});

/**
 * Translate a path glob into a regular expression.
 *
 * A single star is any non-separator run, a question mark is one non-separator
 * character, and a double star is either "any directories" (double-star-slash)
 * or "anything". Other regex metacharacters are escaped, so a file name
 * containing a plus or an open parenthesis matches literally. The result is
 * anchored at both ends so `foo.md` cannot match `prefix/foo.md` unless the
 * glob says so.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        if (pattern.charAt(index + 2) === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("^$.*+?()[]{}|\\".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

/** Resolve a file's character limit: the first matching glob override, else the default. */
export function characterLimitFor(
  path: string,
  config: MemoryConstraintsConfig,
): { limit: number | null | undefined; source: string } {
  for (const override of config.fileCharacterLimits ?? []) {
    if (globToRegExp(override.pattern).test(path)) {
      return { limit: override.maxCharacters, source: `glob '${override.pattern}'` };
    }
  }
  return { limit: config.maxFileCharacters, source: "maxFileCharacters" };
}

/** Depth of a path: the number of directory separators it descends. */
export function pathDepth(path: string): number {
  return path.split("/").length - 1;
}

export interface MemoryTreeViolation {
  path: string;
  message: string;
}

export interface MemoryTreeReader {
  listFiles(): Promise<Array<{ path: string; mode: string }>>;
  readFile(path: string): Promise<Uint8Array | null>;
  /** Optional streaming character count, avoiding buffering large blobs. */
  countCharacters?(path: string): Promise<number>;
}

/**
 * Validate a memory tree against a constraint config.
 *
 * Returns one violation per problem, so a caller can report everything wrong at
 * once instead of fixing one file and re-running. Depth and per-file caps are
 * checked per file, and the core-memory cap is accumulated and checked once at
 * the end, because it is a property of the *set* of root-level files rather
 * than of any one of them.
 */
export async function validateMemoryTreeConstraints(
  reader: MemoryTreeReader,
  config: MemoryConstraintsConfig,
): Promise<MemoryTreeViolation[]> {
  const violations: MemoryTreeViolation[] = [];
  const files = (await reader.listFiles()).filter((file) => file.path.endsWith(".md"));
  const paths = new Set(files.map((file) => file.path));

  if (config.maxDepth !== undefined) {
    for (const { path } of files) {
      const depth = pathDepth(path);
      if (depth > config.maxDepth) {
        violations.push({
          path,
          message: `depth ${depth} exceeds maxDepth ${config.maxDepth}`,
        });
      }
    }
  }

  let coreCharacters = 0;
  for (const { path, mode } of files) {
    if (!mode.startsWith("100")) {
      violations.push({ path, message: "memory Markdown must be a regular file" });
      continue;
    }
    const resolved = characterLimitFor(path, config);
    const limit = resolved.limit;
    const countsTowardCore = config.maxCoreMemoryCharacters !== undefined && !path.includes("/");
    if ((limit === null || limit === undefined) && !countsTowardCore) continue;

    let characters = 0;
    if (reader.countCharacters) {
      characters = await reader.countCharacters(path);
    } else {
      const bytes = await reader.readFile(path);
      if (bytes === null) {
        violations.push({ path, message: "listed memory file is missing" });
        continue;
      }
      characters = decodeUtf8Length(bytes);
    }
    if (countsTowardCore) coreCharacters += characters;
    if (limit !== undefined && limit !== null && characters > limit) {
      violations.push({
        path,
        message: `${characters} characters exceeds ${limit} from ${resolved.source}`,
      });
    }
  }

  if (
    config.maxCoreMemoryCharacters !== undefined &&
    coreCharacters > config.maxCoreMemoryCharacters
  ) {
    violations.push({
      path: "core memory",
      message: `${coreCharacters} characters exceeds ${config.maxCoreMemoryCharacters} from maxCoreMemoryCharacters`,
    });
  }
  return violations;
}

/** Character count of a UTF-8 byte buffer, without buffering into a string. */
function decodeUtf8Length(bytes: Uint8Array): number {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let count = 0;
  for (const _character of decoder.decode(bytes)) count++;
  return count;
}
