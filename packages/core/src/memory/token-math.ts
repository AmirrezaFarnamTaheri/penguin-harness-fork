/**
 * Token-budget arithmetic.
 *
 * Every context-window-overflow guarantee in the memory subsystem bottoms out
 * in this module: how many tokens a string costs, how many a retrieved context
 * costs, and how a fixed token budget is shared between the components that
 * compete for it.
 *
 * No tokenizer dependency. The 4-chars-per-token ratio is deliberately
 * conservative for English and Markdown, and it keeps the whole budgeting
 * path synchronous and dependency-free — the same tradeoff the baseline agent
 * CLI made for its subagent startup guard.
 */

/** Conservative chars-per-token ratio for English / Markdown prose. */
export const CHARS_PER_TOKEN = 4;

/** Fixed cost of one inline image, in tokens (4800 chars / 4). */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/** Overhead charged per message for role framing and separators. */
export const MESSAGE_OVERHEAD_TOKENS = 10;

/**
 * Per-message reserved headroom when a model's measured usage is used as the
 * context anchor: the provider's number describes the request it saw, and the
 * next request carries a little more framing than that.
 */
export const USAGE_ANCHOR_BUFFER_TOKENS = 0;

/** Minimum context window any agent may be configured to use. */
export const MIN_CONTEXT_WINDOW_TOKENS = 30_000;

/**
 * Default total token budget for one retrieval response: system prompt + query
 * + entities + relations + chunks. The budget the graph-RAG baseline ships.
 */
export const DEFAULT_MAX_TOTAL_TOKENS = 30_000;
export const DEFAULT_MAX_ENTITY_TOKENS = 6_000;
export const DEFAULT_MAX_RELATION_TOKENS = 8_000;

/** Headroom reserved for the reference list and framing when sizing a chunk budget. */
export const CONTEXT_BUFFER_TOKENS = 200;

/**
 * Estimate the token cost of a string. Rounding up is intentional: the budget
 * must never be exceeded, so an underestimate is the dangerous direction.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN);
}

/**
 * Estimate the token cost of a message list, charging each message for its
 * content, its role label, and fixed framing overhead.
 */
export function estimateMessagesTokens(
  messages: ReadonlyArray<{ role: string; content: string }>,
): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content ?? "").length + (message.role ?? "").length;
    chars += MESSAGE_OVERHEAD_TOKENS * CHARS_PER_TOKEN;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Token cost of an inline image block. */
export function imageTokens(count = 1): number {
  return count * IMAGE_TOKEN_ESTIMATE;
}

/**
 * A usage record as a model provider reports it. Every field is optional
 * because providers populate different subsets.
 */
export interface UsageRecord {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Reduce a provider usage record to the number of tokens the *context*
 * occupied, or `undefined` when the record carries no usable signal.
 *
 * `totalTokens` wins when present. Otherwise the context is reconstructed as
 * input + output + cacheRead + cacheWrite — cache hits are billed against the
 * context too, so omitting them would undercount a warm session. A record that
 * is present but all-zero returns `undefined` rather than 0, so a synthetic
 * placeholder message can never become a false anchor reporting an empty
 * context.
 */
export function contextTokensFromUsage(usage: UsageRecord): number | undefined {
  const total = positiveFinite(usage.totalTokens);
  if (total !== undefined) return total;

  const present = usage.input ?? usage.output ?? usage.cacheRead ?? usage.cacheWrite;
  if (present === undefined) return undefined;

  const tokens =
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return tokens > 0 ? tokens : undefined;
}

/**
 * A context estimate: the anchored number, plus the pieces it was built from
 * so a caller can report which side of a compaction boundary the tokens came
 * from.
 */
export interface ContextTokenEstimate {
  /** Best available token count for the live context. */
  tokens: number;
  /** Tokens contributed by the most recent usage anchor; 0 when unanchored. */
  usageTokens: number;
  /** Tokens in messages emitted after the usage anchor. */
  trailingTokens: number;
  /** Index of the anchoring message, or null when the estimate is fully semantic. */
  lastUsageIndex: number | null;
}

/**
 * Parse a human-written token budget: `200000`, `200k`, `1m`, with thousands
 * separators and underscores tolerated. Returns `null` for anything that is not
 * a positive integer token count.
 */
export function parseTokenBudgetValue(raw: string): number | null {
  const trimmed = raw.trim().replace(/_/g, "").replace(/,/g, "");
  const match = /^(\d+)([kKmM]?)$/.exec(trimmed);
  if (!match) return null;
  const base = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(base) || base <= 0) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const value = base * multiplier;
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Largest-remainder apportionment: distribute `total` whole tokens across
 * `weights` in proportion to each weight, with every unit accounted for.
 *
 * Quotas are floored, and the leftover units go to the largest fractional
 * remainders. This is what keeps a context-usage breakdown summing to exactly
 * the reported total — naive rounding leaves a few tokens unattributed, which
 * reads as a leak in a budget gauge.
 */
export function apportionByWeight(
  weights: ReadonlyArray<{ key: string; tokens: number }>,
  total: number,
): Record<string, number> {
  const safeTotal = Math.max(0, Math.floor(total));
  const out: Record<string, number> = {};
  if (weights.length === 0 || safeTotal <= 0) {
    for (const { key } of weights) out[key] = 0;
    return out;
  }

  let weightTotal = 0;
  for (const { tokens } of weights) {
    weightTotal += Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  }
  if (weightTotal <= 0) {
    for (const { key } of weights) out[key] = 0;
    return out;
  }

  const remainders: Array<{ key: string; remainder: number }> = [];
  for (const { key, tokens } of weights) {
    const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    const exact = (safe / weightTotal) * safeTotal;
    const floor = Math.floor(exact);
    out[key] = floor;
    remainders.push({ key, remainder: exact - floor });
  }

  let remaining = safeTotal - sum(Object.values(out));
  remainders.sort((a, b) => b.remainder - a.remainder);
  for (const { key } of remainders) {
    if (remaining <= 0) break;
    out[key] = (out[key] ?? 0) + 1;
    remaining--;
  }
  return out;
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * The chunk token budget left out of a total after the fixed costs are paid:
 *
 *     available = maxTotal - (systemPrompt + query + buffer)
 *
 * The buffer covers the reference list and framing the template will add. When
 * the fixed costs already exceed the total the result is negative rather than
 * clamped to 0, so a caller can distinguish "no room" from "a little room".
 */
export function availableChunkTokens(args: {
  maxTotalTokens: number;
  systemPromptTokens: number;
  queryTokens: number;
  bufferTokens?: number;
}): number {
  const buffer = args.bufferTokens ?? CONTEXT_BUFFER_TOKENS;
  return args.maxTotalTokens - args.systemPromptTokens - args.queryTokens - buffer;
}
