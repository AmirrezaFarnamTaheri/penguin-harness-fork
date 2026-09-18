/**
 * Document chunking and token-budget truncation.
 *
 * Two strategies are fused here, because they fail in opposite ways:
 *
 *   - **Structure-preserving chunking** splits Markdown at headings and keeps
 *     fenced code blocks whole. Code is where a naive splitter does the most
 *     damage — a block cut across its fence loses its language tag and its
 *     closing marker, and the two halves each look like malformed prose.
 *   - **Token-budget truncation** trims a *retrieved* context down to a hard
 *     token budget, keeping whole items only. It never half-cuts an item,
 *     because a partially rendered entity record is worse than an omitted one.
 *
 * Byte caps are enforced by walking Unicode code points (`for...of`), never by
 * slicing the UTF-16 string — slicing mid-surrogate produces a lone high
 * surrogate that `JSON.stringify` emits as invalid JSON.
 */

import { estimateTokens } from "./token-math.js";

/** Default hard byte cap on one persisted chunk. */
export const DEFAULT_MAX_CHUNK_BYTES = 4096;

/** First-line characters promoted to a chunk's title. */
export const CHUNK_TITLE_MAX_CHARS = 80;

/**
 * Preferred break position when byte-splitting an oversized single line: only
 * fall back to a whitespace boundary past this fraction of the slice, so the
 * search for one does not waste the byte budget.
 */
export const WHITESPACE_BREAK_RATIO = 0.5;

/** Heading levels honoured by the Markdown chunker. */
const HEADING_PATTERN = /^(#{1,4})\s+(.+)$/;

/** Fenced-code opening (or closing) line. */
const FENCE_PATTERN = /^(`{3,})(.*)?$/;

/** Horizontal-rule separator, also treated as a section boundary. */
const RULE_PATTERN = /^[-_*]{3,}\s*$/;

export interface Chunk {
  /** Display title, built from the enclosing heading path. */
  title: string;
  /** Chunk body. */
  content: string;
  /** Whether the chunk contains a fenced code block. */
  hasCode: boolean;
  /** Zero-based ordinal of this chunk within the document. */
  order: number;
}

/**
 * UTF-8 byte length without Node's `Buffer`, so the same code runs in a browser
 * bundle. `TextEncoder` is the platform-standard way to get there.
 */
export function byteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

const TEXT_ENCODER = new TextEncoder();

/**
 * The largest prefix of `text` whose UTF-8 encoding is at most `maxBytes`
 * bytes, walking by code point so multibyte sequences (CJK) and surrogate
 * pairs (emoji) are never cut mid-character.
 *
 * Guarantees forward progress: if even the first code point is wider than the
 * budget it is still emitted whole (a 1–4 byte overshoot beats an infinite
 * loop).
 */
export function byteCappedPrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;

  let prefix = "";
  let used = 0;
  for (const char of text) {
    const cost = byteLength(char);
    if (used + cost > maxBytes) break;
    prefix += char;
    used += cost;
  }
  return prefix.length > 0 ? prefix : ([...text][0] ?? "");
}

/**
 * Longest prefix no longer than `maxChars` UTF-16 code units, backed off by one
 * unit when the cut would split a surrogate pair. Use this instead of bare
 * `slice(0, n)` whenever the result is JSON-encoded for a strict consumer: a
 * lone high surrogate serializes to invalid JSON.
 */
export function charSafePrefix(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function buildTitle(headingStack: Array<{ level: number; text: string }>, leaf: string): string {
  const parts = [...headingStack.map((entry) => entry.text)];
  if (leaf && !parts.includes(leaf)) parts.push(leaf);
  const title = parts.filter((part) => part.length > 0).join(" / ");
  return title.length > CHUNK_TITLE_MAX_CHARS
    ? title.slice(0, CHUNK_TITLE_MAX_CHARS)
    : title || "Untitled";
}

/**
 * Split Markdown into chunks along heading structure, keeping fenced code
 * blocks intact and every chunk within `maxChunkBytes`.
 *
 * Oversized sections are sub-split at paragraph boundaries (blank lines); a
 * section with one paragraph is emitted whole rather than being shredded, on
 * the grounds that an over-long chunk is more useful than a fragmented one.
 */
export function chunkMarkdown(text: string, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = text.split("\n");
  const headingStack: Array<{ level: number; text: string }> = [];
  let currentContent: string[] = [];
  let currentHeading = "";
  let order = 0;

  const push = (content: string, title: string): void => {
    chunks.push({
      title,
      content,
      hasCode: /```/.test(content),
      order: order++,
    });
  };

  const flush = (): void => {
    const joined = currentContent.join("\n").trim();
    currentContent = [];
    if (joined.length === 0) return;

    const title = buildTitle(headingStack, currentHeading);
    if (byteLength(joined) <= maxChunkBytes) {
      push(joined, title);
      return;
    }

    const paragraphs = joined.split(/\n\n+/);
    let accumulator: string[] = [];
    let partIndex = 1;

    const flushAccumulator = (): void => {
      if (accumulator.length === 0) return;
      const part = accumulator.join("\n\n").trim();
      if (part.length === 0) {
        accumulator = [];
        return;
      }
      push(part, paragraphs.length > 1 ? `${title} (${partIndex})` : title);
      partIndex++;
      accumulator = [];
    };

    for (const paragraph of paragraphs) {
      accumulator.push(paragraph);
      if (byteLength(accumulator.join("\n\n")) > maxChunkBytes && accumulator.length > 1) {
        const overflow = accumulator.pop();
        flushAccumulator();
        if (overflow !== undefined) accumulator = [overflow];
      }
    }
    flushAccumulator();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (RULE_PATTERN.test(line)) {
      flush();
      i++;
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: heading[2]!.trim() });
      currentHeading = heading[2]!.trim();
      currentContent.push(line);
      i++;
      continue;
    }

    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const block: string[] = [line];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        block.push(next);
        i++;
        if (next.trim() === marker) break;
      }
      currentContent.push(...block);
      continue;
    }

    currentContent.push(line);
    i++;
  }
  flush();

  return chunks;
}

/**
 * Split plain text (no heading structure to respect) into byte-capped chunks,
 * accumulating lines and flushing at the cap. A single line longer than the cap
 * is broken at a whitespace boundary when one sits past
 * `WHITESPACE_BREAK_RATIO` of the slice, and otherwise cut at the byte cap.
 */
export function chunkPlainText(
  text: string,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
  linesPerChunk = 40,
): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let accumulator: string[] = [];
  let order = 0;

  const flush = (): void => {
    if (accumulator.length === 0) return;
    const content = accumulator.join("\n").trim();
    if (content.length > 0) {
      chunks.push({
        title: content.split("\n")[0]?.slice(0, CHUNK_TITLE_MAX_CHARS) || "Untitled",
        content,
        hasCode: /```/.test(content),
        order: order++,
      });
    }
    accumulator = [];
  };

  for (const line of lines) {
    if (byteLength(line) > maxChunkBytes) {
      flush();
      let remaining = line;
      while (remaining.length > 0) {
        let slice = byteCappedPrefix(remaining, maxChunkBytes);
        if (slice.length < remaining.length) {
          const breakPoint = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"));
          if (breakPoint > slice.length * WHITESPACE_BREAK_RATIO) {
            slice = slice.slice(0, breakPoint);
          }
        }
        chunks.push({
          title: slice.slice(0, CHUNK_TITLE_MAX_CHARS),
          content: slice,
          hasCode: false,
          order: order++,
        });
        remaining = remaining.slice(slice.length);
      }
      continue;
    }

    accumulator.push(line);
    const overflow =
      (byteLength(accumulator.join("\n")) > maxChunkBytes && accumulator.length > 1) ||
      accumulator.length > linesPerChunk;
    if (overflow) {
      const carried = accumulator.pop();
      flush();
      if (carried !== undefined) accumulator = [carried];
    }
  }
  flush();

  return chunks;
}

/**
 * Split `text` into token-sized pieces with `overlapTokens` of carry-over
 * between consecutive pieces, so a fact straddling a boundary stays intact in
 * at least one chunk. Zero overlap is allowed for exact-fit use cases.
 */
export function splitByTokenLimit(text: string, maxTokens: number, overlapTokens = 0): string[] {
  if (maxTokens <= 0 || text.length === 0) return [];
  const maxChars = maxTokens * 4;
  const overlapChars = Math.min(overlapTokens * 4, Math.max(0, maxChars - 1));

  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    pieces.push(text.slice(cursor, end));
    if (end >= text.length) break;
    cursor = end - overlapChars;
    if (cursor < 0) cursor = 0;
  }
  return pieces;
}

/**
 * Truncate a list of items so the joined serialization fits `maxTokens`,
 * keeping only whole leading items.
 *
 * The separator's own cost is counted (a per-item-only count silently misses
 * it), and a partial item is never emitted: the result is always "the first K
 * complete items", never a half-rendered one.
 *
 * `key` must serialize exactly what the caller will render downstream —
 * truncating on a fuller shape than the one later serialized reintroduces the
 * undercount this exists to prevent.
 */
export function truncateListByTokenSize<T>(
  items: readonly T[],
  key: (item: T) => string,
  separator: string,
  maxTokens: number,
): T[] {
  if (maxTokens <= 0 || items.length === 0) return [];

  const rendered = items.map(key);
  let joined = rendered.join(separator);
  while (estimateTokens(joined) > maxTokens) {
    rendered.pop();
    if (rendered.length === 0) return [];
    joined = rendered.join(separator);
  }
  return items.slice(0, rendered.length);
}

/**
 * Truncate a rendered string to `maxChars`, keeping head and tail and marking
 * the dropped middle. Head/tail fractions are configurable; defaults keep 30%
 * at each end. Dropping the middle is the right cut for a conversation
 * transcript, where the opening (the request) and the end (the latest work)
 * matter more than the middle.
 */
export function middleTruncate(
  text: string,
  maxChars: number,
  headFraction = 0.3,
  tailFraction = 0.3,
): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;

  const headLength = Math.max(0, Math.floor(maxChars * headFraction));
  let tailLength = Math.max(0, Math.floor(maxChars * tailFraction));
  if (headLength + tailLength > maxChars) tailLength = Math.max(0, maxChars - headLength);

  const head = text.slice(0, headLength);
  const tail = tailLength > 0 ? text.slice(-tailLength) : "";
  const dropped = Math.max(0, text.length - (head.length + tail.length));
  return `${head}\n[truncated: dropped ${dropped} middle chars to fit the context budget]\n${tail}`;
}
