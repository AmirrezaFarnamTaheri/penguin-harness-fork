export type DelaySource = "header" | "structured" | "text";

export interface ParsedDelay {
  rawMs: number;
  source: DelaySource;
  bufferedMs: number;
}

const MAX_NESTING_DEPTH = 8;
const MAX_VISITED_NODES = 256;
const MAX_PROVIDER_DELAY_MS = 60_000;
const HEADER_BUFFER_MS = 200;
const TEXT_BUFFER_MS = 1000;
const STRUCTURED_DELAY_KEYS = new Set(["retrydelay", "retryafter"]);

function withBuffer(rawMs: number, source: DelaySource): ParsedDelay | null {
  if (!Number.isFinite(rawMs) || rawMs <= 0) return null;
  const roundedMs = Math.round(rawMs);
  if (!Number.isSafeInteger(roundedMs) || roundedMs <= 0) return null;

  const bufferMs = source === "text" ? TEXT_BUFFER_MS : HEADER_BUFFER_MS;
  return {
    rawMs: roundedMs,
    source,
    bufferedMs: Math.min(MAX_PROVIDER_DELAY_MS, roundedMs + bufferMs),
  };
}

/** Parse the HTTP Retry-After seconds or HTTP-date form. Invalid and expired values are absent. */
export function parseRetryAfter(value?: string): ParsedDelay | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return withBuffer(Number(trimmed) * 1000, "header");
  }

  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? withBuffer(dateMs - Date.now(), "header") : null;
}

const DURATION_TOKEN =
  /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?=\d|[\s,.;)]|$)/gi;

function unitToMs(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === "d" || normalized.startsWith("day")) return 86_400_000;
  if (normalized === "h" || normalized.startsWith("hr") || normalized.startsWith("hour"))
    return 3_600_000;
  if (normalized === "m" || normalized.startsWith("min")) return 60_000;
  if (normalized === "ms" || normalized.startsWith("msec") || normalized.startsWith("millisecond"))
    return 1;
  return 1000;
}

function durationMs(text: string, requireOnlyDuration: boolean): number | null {
  const tokens = [...text.matchAll(DURATION_TOKEN)];
  for (let start = 0; start < tokens.length; start += 1) {
    const first = tokens[start]!;
    const firstIndex = first.index;
    if (firstIndex === undefined) continue;
    if (requireOnlyDuration && text.slice(0, firstIndex).trim() !== "") continue;

    let totalMs = 0;
    let previousEnd = firstIndex;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const tokenIndex = token.index;
      if (tokenIndex === undefined) break;
      const gap = text.slice(previousEnd, tokenIndex);
      if (index !== start && !/^[\s,]*$/.test(gap)) break;
      const amount = Number(token[1]);
      totalMs += amount * unitToMs(token[2]!);
      previousEnd = tokenIndex + token[0].length;
    }

    if (requireOnlyDuration && text.slice(previousEnd).trim() !== "") continue;
    if (Number.isFinite(totalMs) && totalMs > 0) return totalMs;
  }
  return null;
}

/** Parse a compound duration such as 1h16m0.667s from provider error text. */
export function parseTextDelay(text: string): ParsedDelay | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const rawMs = durationMs(text, false);
  return rawMs === null ? null : withBuffer(rawMs, "text");
}

function parseStructuredValue(value: unknown): ParsedDelay | null {
  if (typeof value === "number") return withBuffer(value * 1000, "structured");

  if (typeof value === "string") {
    const trimmed = value.trim();
    const parsedDuration = durationMs(trimmed, true) ?? durationMs(trimmed, false);
    if (parsedDuration !== null) return withBuffer(parsedDuration, "structured");
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return withBuffer(Number(trimmed) * 1000, "structured");
    }
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  let seconds: unknown;
  let nanos: unknown;
  try {
    seconds = record.seconds;
    nanos = record.nanos;
  } catch {
    return null;
  }
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const nanosValue = typeof nanos === "number" && Number.isFinite(nanos) ? nanos : 0;
  return withBuffer(seconds * 1000 + nanosValue / 1_000_000, "structured");
}

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function safeRead(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

/** Walk provider response/error objects to find a retryDelay or retryAfter field. */
export function parseStructuredDelay(body: unknown): ParsedDelay | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;

  while (queue.length > 0 && visited < MAX_VISITED_NODES) {
    const current = queue.shift()!;
    if (!current.value || typeof current.value !== "object") continue;
    const object = current.value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    visited += 1;

    const record = current.value as Record<string, unknown>;
    const keys = safeKeys(object);
    for (const key of keys) {
      const child = safeRead(record, key);
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (STRUCTURED_DELAY_KEYS.has(normalized)) {
        const parsed = parseStructuredValue(child);
        if (parsed) return parsed;
      }
      if (current.depth < MAX_NESTING_DEPTH && child && typeof child === "object") {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function headerText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readHeaderBag(value: unknown): string | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  const candidate = value as { get?: unknown };
  let getter: unknown;
  try {
    getter = candidate.get;
  } catch {
    getter = undefined;
  }
  if (typeof getter === "function") {
    try {
      const found = headerText(getter.call(value, "retry-after"));
      if (found !== null) return found;
    } catch {
      // A provider-specific headers wrapper may throw for unsupported access patterns.
    }
  }

  const record = value as Record<string, unknown>;
  for (const key of safeKeys(value as object)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, "") !== "retryafter") continue;
    const found = headerText(safeRead(record, key));
    if (found !== null) return found;
  }
  return null;
}

function findHeader(input: unknown): string | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;

  while (queue.length > 0 && visited < MAX_VISITED_NODES) {
    const current = queue.shift()!;
    if (!current.value || typeof current.value !== "object") continue;
    const object = current.value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    visited += 1;

    const record = current.value as Record<string, unknown>;
    const headers = safeRead(record, "headers");
    if (headers !== undefined) {
      const found = readHeaderBag(headers);
      if (found !== null) return found;
    }
    const directHeader = readHeaderBag(current.value);
    if (directHeader !== null) return directHeader;

    if (current.depth >= MAX_NESTING_DEPTH) continue;
    const children = new Set<unknown>();
    for (const key of ["response", "cause", "error", "data", "body"]) {
      const child = safeRead(record, key);
      if (child && typeof child === "object") children.add(child);
    }
    for (const key of safeKeys(object)) {
      const child = safeRead(record, key);
      if (child && typeof child === "object") children.add(child);
    }
    for (const child of children) queue.push({ value: child, depth: current.depth + 1 });
  }
  return null;
}

function collectProviderText(input: unknown): string {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  const parts: string[] = [];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_VISITED_NODES) {
    const current = queue.shift()!;
    if (typeof current.value === "string") {
      parts.push(current.value);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const object = current.value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    visited += 1;

    if (current.value instanceof Error) {
      parts.push(current.value.name, current.value.message);
      const cause = safeRead(current.value as unknown as Record<string, unknown>, "cause");
      if (cause && typeof cause === "object" && current.depth < MAX_NESTING_DEPTH) {
        queue.push({ value: cause, depth: current.depth + 1 });
      } else if (typeof cause === "string") {
        parts.push(cause);
      }
    }

    if (Array.isArray(current.value)) {
      if (current.depth < MAX_NESTING_DEPTH) {
        for (const item of current.value) queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    const record = current.value as Record<string, unknown>;
    for (const key of safeKeys(object)) {
      const child = safeRead(record, key);
      if (typeof child === "string") parts.push(child);
      else if (child && typeof child === "object" && current.depth < MAX_NESTING_DEPTH) {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return parts.join("\n");
}

function retryAfterFromText(text: string): string | null {
  const match = /\bretry[-_ ]after\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/i.exec(text);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/** Resolve a provider hint using header > structured body > human-readable text precedence. */
export function parseProviderDelay(input: unknown): ParsedDelay | null {
  const headerValue = findHeader(input) ?? retryAfterFromText(collectProviderText(input));
  const headerDelay = parseRetryAfter(headerValue ?? undefined);
  if (headerDelay) return headerDelay;

  const structuredDelay = parseStructuredDelay(input);
  if (structuredDelay) return structuredDelay;

  return parseTextDelay(collectProviderText(input));
}

/** Short provider hints (at most five seconds after buffering) may bypass the retry ladder. */
export function graceWindow(delay: ParsedDelay): boolean {
  return (
    Number.isFinite(delay.rawMs) &&
    delay.rawMs > 0 &&
    Number.isFinite(delay.bufferedMs) &&
    delay.bufferedMs > 0 &&
    delay.bufferedMs <= 5000
  );
}
