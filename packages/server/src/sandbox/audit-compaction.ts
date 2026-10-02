/**
 * I6 — compact audit payloads: structure, correlation and integrity, never bodies.
 *
 * The audit log is a signed record of *what happened*, not a copy of what was said. Its standing
 * invariant (upheld by the I1-era signing test) is that a tool call's arguments never appear in this
 * file. Before this module that invariant was kept by storing only hashes, which left no way to
 * record the shape of an event; after it, a payload is reduced to a bounded **structural digest**:
 * field names, value types, sizes and content hashes, with the correlation identifiers kept
 * verbatim. An argument value cannot leak by construction, because values are not stored at all.
 *
 * Order of operations, which is the whole point:
 *
 * 1. **Redact first** — the shared I1 redactors run on the raw value before any length is measured
 *    or hashed, so a truncated body cannot leave the visible half of a credential and a digest can
 *    never be an oracle over unredacted bytes:
 *    - objects/arrays → `redactTraceRecord` (structural: sensitive field names, credential patterns,
 *      e-mail masking; returns a copy, never mutates the caller's object);
 *    - a field named `headers` whose value is a header map → `redactSessionHeaders`, preserving I1's
 *      14-name allowlist and failing closed for every other header name — allowlisted protocol values
 *      are kept because the allowlist exists precisely to permit that;
 *    - `Error` values → `sanitizeErrorForLog` (name/message/code/cause chain, already redacted and
 *      bounded by I1) and kept verbatim: an error message is correlation, not a body;
 *    - bare strings → `redactCredentials` + `maskEmail`.
 * 2. **Digest the bodies** — a value under a correlation field name (`type`, `name`, `status`,
 *    `tool_call_id`, `origin`, …) is kept when short; every other scalar becomes
 *    `{"<digest>": {type, bytes, sha256}}`, and objects/arrays are walked so the stored JSON mirrors
 *    the payload's shape. An over-deep or over-wide node becomes a **structural summary**
 *    (`{"<structure>": {type, keys|count, bytes}}`) that names shape and size but never values.
 * 3. **Byte ceiling** — the serialized UTF-8 form is measured and, if still over the ceiling, the
 *    longest remaining strings are shortened (longest first, path order for ties) and then the
 *    largest subtrees are summarized, deterministically. Truncation is always on a UTF-8 code-point
 *    boundary, so a multibyte value cannot produce a replacement character.
 * 4. **Integrity over the stored form** — `auditStoredPayloadHash`/`auditStoredPayloadSignature`
 *    cover the exact serialized bytes of the redacted, compacted payload, so verification proves
 *    what is on disk, not what once was in memory.
 *
 * Every digest, shortening and omission is reported (`shortenedPaths`, `omittedPaths`, `truncated`)
 * so a reader can never mistake a summary for the complete payload.
 */
import { createHash, createHmac } from "node:crypto";
import {
  redactCredentials,
  redactSessionHeaders,
  redactTraceRecord,
  sanitizeErrorForLog,
  maskEmail,
} from "@prismshadow/penguin-core";

/** Ceiling for the serialized compact details of one event. */
export const AUDIT_DETAILS_MAX_BYTES = 2048;
/** Longest string kept verbatim inside the details. */
export const AUDIT_DETAILS_MAX_STRING_CHARS = 256;
/** Deepest object/array nesting kept; deeper nodes become structural summaries. */
export const AUDIT_DETAILS_MAX_DEPTH = 4;
/** Most children kept per node; wider nodes become structural summaries. */
export const AUDIT_DETAILS_MAX_CHILDREN = 24;
/** Key under which a structural summary is stored in place of an over-bound value. */
export const AUDIT_STRUCTURE_KEY = "<structure>";
/** Suffix appended to a shortened string. */
export const AUDIT_TRUNCATED_SUFFIX = "…[truncated]";
/** Key under which an omitted body value is stored as a size-and-hash digest. */
export const AUDIT_DIGEST_KEY = "<digest>";
/** Hex characters of the content hash kept in a digest (full hash is unnecessary at this size). */
export const AUDIT_DIGEST_HEX_CHARS = 16;
/** Longest verbatim correlation value kept; longer ones are digested like any other body. */
export const AUDIT_VERBATIM_MAX_BYTES = 512;

export interface CompactedAuditDetails {
  /** Redacted, bounded, JSON-serializable structural digest of the payload. */
  readonly value: unknown;
  /** UTF-8 bytes of `JSON.stringify(value)`. */
  readonly bytes: number;
  /**
   * True when the stored details are *not* the complete payload — any value omitted as a body
   * digest, any string shortened, any subtree summarized. A reader may never treat the details as
   * whole when this is set, and it is set for every ordinary tool call.
   */
  readonly truncated: boolean;
  /** Dot-paths whose stored strings were shortened by the byte ceiling. */
  readonly shortenedPaths: readonly string[];
  /** Dot-paths whose values were replaced by a digest or a structural summary. */
  readonly omittedPaths: readonly string[];
}

export interface AuditCompactionLimits {
  maxBytes?: number;
  maxStringChars?: number;
  maxDepth?: number;
  maxChildren?: number;
}

interface Bounds {
  maxBytes: number;
  maxStringChars: number;
  maxDepth: number;
  maxChildren: number;
}

/**
 * Field names whose *values* are correlation metadata and are kept (redacted, and only when short),
 * not digested: what the event was, what it acted on, and how it ended. Everything else — arguments,
 * outputs, prompts, bodies — is stored as a size-and-hash digest only.
 */
export const AUDIT_VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "kind",
  "phase",
  "sequence",
  "role",
  "name",
  "toolcallid",
  "callid",
  "id",
  "status",
  "stopreason",
  "decision",
  "outcome",
  "mode",
  "version",
  "provider",
  "model",
  "modelid",
  "reason",
  "origin",
  "sessionid",
  "agentid",
  "projectid",
]);

/** Normalizes a field name for the verbatim allowlist (case, `_` and `-` insensitive). */
function isVerbatimField(key: string): boolean {
  return AUDIT_VERBATIM_FIELDS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

/** Shortens a string to `maxBytes` UTF-8 bytes without splitting a code point. */
/** Shortens a string to `maxBytes` UTF-8 bytes without splitting a code point. */
function shortenToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
  // `toString` on a sliced buffer replaces a partial trailing code point with U+FFFD; drop it so the
  // stored form is always valid text, then re-check the size (a dropped code point can only shrink).
  let shortened = buffer.toString("utf8").replace(/\uFFFD+$/u, "");
  while (Buffer.byteLength(shortened, "utf8") > maxBytes) {
    shortened = shortened.slice(0, -1);
  }
  return shortened;
}

function summarize(value: unknown): Record<string, unknown> {
  const bytes = Buffer.byteLength(safeJson(value), "utf8");
  if (Array.isArray(value)) {
    return { type: "array", count: value.length, bytes };
  }
  if (value !== null && typeof value === "object") {
    return { type: "object", keys: Object.keys(value as Record<string, unknown>), bytes };
  }
  return { type: typeof value, bytes };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    // A circular or otherwise unserializable value has no faithful summary; say so by type only.
    return JSON.stringify({ [AUDIT_STRUCTURE_KEY]: { type: typeof value } });
  }
}

/** True for a `{ name: string }` map, the shape a header block has. */
function isHeaderMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string" || typeof entry === "number" || entry === null,
    )
  );
}

/** Depth at which the pre-redaction walk stops descending. */
const PREPASS_MAX_DEPTH = 12;
/** Nodes the pre-redaction walk will visit before it gives up and summarizes the rest. */
const PREPASS_MAX_NODES = 2000;
/** Marker stored in place of a reference that was already seen (a cycle). */
export const AUDIT_CIRCULAR_MARKER = "[circular]";
/**
 * Wrapper key holding a sanitized `Error` while the value passes through the structural redactor.
 * The redactor blanks non-enumerable objects, so an Error has to become a plain object before it
 * gets there; the wrapper is what lets the summarizer recognize it again and keep it verbatim.
 */
export const AUDIT_ERROR_KEY = "<error>";

interface PreparedValue {
  value: unknown;
  omittedPaths: string[];
}

/** True for a header-map value under a `headers` key (checked before recursing). */
function isHeaderEntry(key: string | undefined, value: unknown): value is Record<string, unknown> {
  return key !== undefined && key.toLowerCase() === "headers" && isHeaderMap(value);
}

/**
 * Normalizes a value into something the shared redactor can always handle, in one place:
 *
 * - **cycles** — `redactTraceRecord` recurses by value, so a self-referencing object overflows the
 *   stack and the audit event is lost entirely. A repeated reference is replaced by a marker.
 * - **depth and node count** — a value deep or wide enough to make redaction itself expensive is
 *   replaced by a summary, and the path is reported as omitted.
 *
 * `Error` instances are deliberately left in place: their own properties are not enumerable, so the
 * redactor would turn them into `{}` and lose the one thing worth keeping. The summarizer converts
 * each one through `sanitizeErrorForLog`, which redacts and bounds it itself.
 *
 * This runs *before* redaction, which is safe: it only ever removes or marks content, so the
 * "redact before shrinking" order still holds for everything that survives.
 */
function prepareForRedaction(raw: unknown): PreparedValue {
  const omittedPaths: string[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): unknown => {
    if (value instanceof Error) return { [AUDIT_ERROR_KEY]: sanitizeErrorForLog(value) };
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) {
      omittedPaths.push(path);
      return AUDIT_CIRCULAR_MARKER;
    }
    if (depth >= PREPASS_MAX_DEPTH || nodes >= PREPASS_MAX_NODES) {
      omittedPaths.push(path);
      return { [AUDIT_STRUCTURE_KEY]: summarize(value) };
    }
    seen.add(value);
    nodes += 1;
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        visit(entry, path === "" ? String(index) : `${path}.${index}`, depth + 1),
      );
    }
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = visit(child, path === "" ? key : `${path}.${key}`, depth + 1);
    }
    return copy;
  };
  return { value: visit(raw, "", 0), omittedPaths };
}

/** Redacts an arbitrary audit value with the shared I1 redactors. Never mutates the input. */
export function redactAuditValue(raw: unknown): unknown {
  if (raw instanceof Error) return sanitizeErrorForLog(raw);
  if (typeof raw === "string") return maskEmail(redactCredentials(raw));
  if (raw === null || typeof raw !== "object") return raw;
  return redactTraceRecord(prepareForRedaction(raw).value);
}

/**
 * Redacts a payload, then reduces it to a bounded structural digest (see the module header).
 * Exported for callers that need the pieces separately; the recorder stores `value`.
 */
export function compactAuditDetails(
  raw: unknown,
  limits: AuditCompactionLimits = {},
): CompactedAuditDetails {
  const bounds: Bounds = {
    maxBytes: limits.maxBytes ?? AUDIT_DETAILS_MAX_BYTES,
    maxStringChars: limits.maxStringChars ?? AUDIT_DETAILS_MAX_STRING_CHARS,
    maxDepth: limits.maxDepth ?? AUDIT_DETAILS_MAX_DEPTH,
    maxChildren: limits.maxChildren ?? AUDIT_DETAILS_MAX_CHILDREN,
  };
  const shortenedPaths: string[] = [];
  const omittedPaths: string[] = [];

  const shorten = (text: string, path: string): string => {
    const limit = bounds.maxStringChars;
    if (text.length <= limit && Buffer.byteLength(text, "utf8") <= limit * 4) return text;
    const cut = shortenToBytes(text, Math.min(limit, Buffer.byteLength(text, "utf8")));
    if (cut === text) return text;
    shortenedPaths.push(path);
    return `${cut}${AUDIT_TRUNCATED_SUFFIX}`;
  };

  /**
   * Keeps a correlation field's value: redacted through the shared redactor, then any string inside
   * it shortened by the ceiling rules. Digests never appear here — this is the path that makes a
   * receipt readable ("tool_call", "completed", the tool name) without keeping a body.
   */
  const keepVerbatim = (
    value: unknown,
    path: string,
    shortenString: (text: string, path: string) => string,
  ): unknown => {
    const redacted = redactTraceRecord(value);
    if (typeof redacted === "string") return shortenString(redacted, path);
    if (redacted === null || typeof redacted !== "object") return redacted;
    if (Array.isArray(redacted)) {
      return redacted.map((entry, index) =>
        typeof entry === "string"
          ? shortenString(entry, path === "" ? String(index) : `${path}.${index}`)
          : entry,
      );
    }
    return Object.fromEntries(
      Object.entries(redacted as Record<string, unknown>).map(([name, entry]) => [
        name,
        typeof entry === "string"
          ? shortenString(entry, path === "" ? name : `${path}.${name}`)
          : entry,
      ]),
    );
  };

  /** A body value: size and hash only. This is the only representation of a non-correlation value. */
  const digest = (text: string, path: string): Record<string, unknown> => {
    omittedPaths.push(path);
    return {
      [AUDIT_DIGEST_KEY]: {
        type: "string",
        bytes: Buffer.byteLength(text, "utf8"),
        sha256: createHash("sha256").update(text).digest("hex").slice(0, AUDIT_DIGEST_HEX_CHARS),
      },
    };
  };

  const visit = (value: unknown, path: string, depth: number, key: string | undefined): unknown => {
    // Errors are correlation: name, message, code and cause chain, already redacted and bounded by
    // sanitizeErrorForLog before they reach here.
    // Errors never reach here as Error instances: `prepareForRedaction` wraps each one (root
    // included) so it survives the structural redactor. The wrapper is what carries the sanitized
    // name/message/code/cause chain back out, verbatim.
    if (value !== null && typeof value === "object" && AUDIT_ERROR_KEY in value) {
      // A nested error the pre-pass sanitized: name/message/code/cause are correlation, and I1 has
      // already redacted and bounded them, so they are stored as they are.
      return (value as Record<string, unknown>)[AUDIT_ERROR_KEY];
    }
    // Correlation fields keep their (short) values: what the event was, on what, and how it ended.
    if (
      key !== undefined &&
      isVerbatimField(key) &&
      Buffer.byteLength(safeJson(value), "utf8") <= AUDIT_VERBATIM_MAX_BYTES
    ) {
      return keepVerbatim(value, path, shorten);
    }
    if (typeof value === "string") return digest(value, path);
    if (value === null || typeof value !== "object") return value;
    // Header blocks keep I1's allowlist contract: an unknown vendor header fails closed, and the
    // 14 allowlisted protocol values stay readable because that allowlist exists to permit it.
    if (isHeaderEntry(key, value)) {
      const redacted = redactSessionHeaders(value as Record<string, string>);
      const bounded: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(redacted)) {
        bounded[name] = shorten(entry, path === "" ? name : `${path}.${name}`);
      }
      return bounded;
    }
    const isArray = Array.isArray(value);
    const entries = isArray
      ? (value as unknown[]).map((entry, index) => [String(index), entry] as const)
      : Object.entries(value as Record<string, unknown>);
    if (depth >= bounds.maxDepth || entries.length > bounds.maxChildren) {
      omittedPaths.push(path);
      return { [AUDIT_STRUCTURE_KEY]: summarize(value) };
    }
    const result: Record<string, unknown> | unknown[] = isArray ? [] : {};
    for (const [name, child] of entries) {
      const childPath = path === "" ? name : `${path}.${name}`;
      const visited = visit(child, childPath, depth + 1, name);
      if (isArray) (result as unknown[]).push(visited);
      else (result as Record<string, unknown>)[name] = visited;
    }
    return result;
  };

  const prepared = prepareForRedaction(raw);
  const value = visit(redactAuditValue(prepared.value), "", 0, undefined);
  omittedPaths.push(...prepared.omittedPaths);

  // Byte ceiling. Strings are shortened longest-first (deterministic: equal lengths keep traversal
  // order), and only when no string is left to shorten are whole subtrees replaced by summaries.
  let current: unknown = value;
  let bytes = Buffer.byteLength(safeJson(current), "utf8");
  // Bounded rounds as well as a progress check: a string that is already nothing but the truncation
  // suffix cannot be shortened further, and without the `>=` guard the loop would spin on it.
  for (let round = 0; bytes > bounds.maxBytes && round < 64; round += 1) {
    const leaves: Array<{ path: string[]; length: number }> = [];
    const collect = (node: unknown, path: string[]): void => {
      if (typeof node === "string") {
        leaves.push({ path, length: node.length });
        return;
      }
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node))
        node.forEach((entry, index) => collect(entry, [...path, String(index)]));
      else for (const [name, child] of Object.entries(node)) collect(child, [...path, name]);
    };
    collect(current, []);
    const longest = leaves.sort((left, right) => right.length - left.length)[0];
    if (longest === undefined) break;
    const target = longest.path.reduce<unknown>(
      (node, segment) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      current,
    );
    if (typeof target !== "string" || target.length === 0) break;
    // A partial cut is not a cut: shorten below the current size and re-measure each round.
    const nextLength = Math.max(0, Math.floor(target.length / 2));
    const shortenedText = `${shortenToBytes(target, nextLength)}${AUDIT_TRUNCATED_SUFFIX}`;
    if (shortenedText.length >= target.length) break; // no progress left: stop, do not spin
    const parent = longest.path
      .slice(0, -1)
      .reduce<unknown>(
        (node, segment) =>
          node !== null && typeof node === "object"
            ? (node as Record<string, unknown>)[segment]
            : undefined,
        current,
      );
    if (parent === undefined) break;
    (parent as Record<string, unknown>)[longest.path[longest.path.length - 1]!] = shortenedText;
    const pathText = longest.path.join(".");
    if (!shortenedPaths.includes(pathText)) shortenedPaths.push(pathText);
    bytes = Buffer.byteLength(safeJson(current), "utf8");
  }
  if (bytes > bounds.maxBytes) {
    // Only reachable with pathological key names: keep the shape, drop the content.
    omittedPaths.push("");
    current = { [AUDIT_STRUCTURE_KEY]: summarize(current) };
    bytes = Buffer.byteLength(safeJson(current), "utf8");
  }

  const uniqueShortened = [...new Set(shortenedPaths)];
  const uniqueOmitted = [...new Set(omittedPaths)];
  return {
    value: current,
    bytes,
    truncated: uniqueShortened.length > 0 || uniqueOmitted.length > 0,
    shortenedPaths: uniqueShortened,
    omittedPaths: uniqueOmitted,
  };
}

/** SHA-256 over the exact serialized form of a *stored* (redacted, compacted) payload. */
export function auditStoredPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** HMAC-SHA256 over a stored payload's hash, with the audit signing key. */
export function auditStoredPayloadSignature(payload: unknown, secret: string): string {
  return createHmac("sha256", secret).update(auditStoredPayloadHash(payload)).digest("hex");
}
