/**
 * TruncatedToolOutputArchive — bounded, Session-scoped recovery for text that Environment cannot
 * place in the model-visible tool result because of maxOutputLength.
 *
 * The archive is deliberately not a second tool protocol, and this module is internal:
 * Environment constructs it from the generic `EnvironmentConfig.sessionScratchpadDir` rather
 * than taking a manager object through the public config surface. Environment returns the file
 * path in the same truncated tool result seen by the frontend and the model; the model can then
 * use the existing file tools to inspect it. Files live in the Session scratchpad and are removed
 * by the host's existing Session-deletion path together with the rest of that scratchpad.
 *
 * Files are written only after a call actually exceeds maxOutputLength. A capture retains at
 * most one file's budget while the tool is streaming, then writes one UTF-8 .log file with mode
 * 0600. Small archives are exact. If a single call exceeds the per-file budget, the file keeps
 * bounded head/tail windows with an explicit gap marker.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactCredentials } from "../internal/credential-redactor.js";
import type {
  NonessentialProducerId,
  PressureDecision,
  PressureSignal,
  WritePressureGate,
} from "../internal/write-pressure-policy.js";
import { READ_FILE_SCAN_CAP_BYTES } from "./tools/read-file.js";
import {
  createPruneFrontier,
  parsePruneFrontier,
  planPrune,
  serializePruneFrontier,
  type PruneFrontier,
} from "../internal/prune-frontier.js";

/**
 * Maximum stored bytes for one truncated tool call. One byte of headroom below read_file's
 * 8 MiB scan cap lets that tool perform its final zero-byte read and confirm EOF.
 */
export const TRUNCATED_TOOL_OUTPUT_FILE_LIMIT_BYTES = READ_FILE_SCAN_CAP_BYTES - 1;

const ARCHIVE_GAP_MARKER = "\n[archive middle truncated]\n";
const ARCHIVE_GAP_MARKER_BYTES = Buffer.byteLength(ARCHIVE_GAP_MARKER);

/**
 * New recall ids use 128 bits of the content digest. The prior 12-character format remains
 * readable so an id already shown to a model continues to work through its retention period.
 */
const RECALL_ID_HEX_LENGTH = 32;
const LEGACY_RECALL_ID_HEX_LENGTH = 12;

/** Suffix of a stored recall entry, distinct from the truncation archive's `.log` files. */
const RECALL_FILE_EXTENSION = ".out";

/** How many evictions the drop log keeps. Bounded, like everything else here. */
const RECALL_DROPPED_LOG_LIMIT = 32;

/**
 * Default bounds on the recall store.
 *
 * A recall entry exists so the model can recover text a summary dropped. That is worth little if
 * the entry itself has been evicted, so the defaults are generous relative to what one Session
 * produces (tens of compressed results, not hundreds) and still small on disk. The byte bound
 * is the one that matters on a shared machine: entries are full tool outputs, so an unbounded
 * count bound alone would still allow hundreds of megabytes.
 */
const RECALL_LIMITS: RecallLimits = {
  maxEntries: 200,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryAgeMs: 30 * 24 * 60 * 60 * 1000,
};

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let newlines = 0;
  for (const byte of data) if (byte === 0x0a) newlines += 1;
  return data[data.length - 1] === 0x0a ? newlines : newlines + 1;
}

function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type TruncatedToolOutputArchiveSaveResult =
  | {
      status: "saved";
      path: string;
      archiveTruncated: boolean;
      /** Disk-pressure warning that fired while admitting this write (I7.2); the write proceeded. */
      warning?: WritePressureWarning;
    }
  | { status: "failed"; code: string };

/**
 * A warning that fired while a nonessential write was admitted. Carried on the result so the
 * caller can show it — a warning nobody can observe is indistinguishable from a policy that
 * never ran. `freeBytes` is null when no valid measurement existed (never 0-as-unknown).
 */
export interface WritePressureWarning {
  signal: PressureSignal;
  reason: string;
  volumePath: string;
  freeBytes: number | null;
}

interface TruncatedToolOutputArchiveOptions {
  rootDir: string;
  /** Test-only override; production and public SDK composition use the fixed default. */
  fileLimitBytes?: number;
  /** Test-only overrides for the recall store's bounds; production uses RECALL_LIMITS. */
  recallLimits?: Partial<RecallLimits>;
  /** Test-only overrides for the truncation archive's bounds; production uses ARCHIVE_LIMITS. */
  archiveLimits?: Partial<ArchiveLimits>;
  /** Test-only clock, so age-bound eviction can be exercised without waiting a month. */
  now?: () => number;
  /**
   * Admission gate for this archive's own writes (I7.2). Omitted = no pressure policy, which is
   * the previous behavior exactly: the card's rollback is removing this injection. A gate that
   * blocks refuses the write *before* any filesystem mutation; a gate that warns lets the write
   * through and the warning rides back on the result.
   */
  writePressure?: WritePressureGate;
  /**
   * Where to persist the archive's prune frontier (B4.3). Omitted = in memory only: the frontier
   * still answers repeated blocked prunes within this process, and a restart re-enforces the bound
   * from the directory itself (which remains the authority). The archive root is deliberately not
   * used as a default: an existing E10.4 contract pins that directory to the `.log` files it writes.
   */
  pruneFrontierPath?: string;
}

/**
 * The two bounds the truncation archive is held to, per Session. The recall store below has its
 * own limits; these govern the `*.log` files that `commit` writes.
 */
export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

/**
 * Production bounds for the truncation archive (E10.4).
 *
 * Before this the archive had a per-call budget and nothing else, so a long conversation with N
 * oversized commands kept N files at up to 8 MiB each — hundreds of megabytes in one Session's
 * scratchpad, written by a feature whose only purpose is to let the model read back *recent*
 * output. The bounds are the same shape as the recall store's: 500 entries and 256 MiB, which is
 * generous for the head/tail windows a Session actually re-reads and finite on disk.
 */
export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 500,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** Why an archived file left the directory — reported so a vanished path is explainable. */
export type ArchiveDropReason = "capacity";

/** The three bounds the recall store is held to, and the two knobs that override them in tests. */
export interface RecallLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryAgeMs: number;
}

/** Why an entry left the store — reported so a vanished recall id is explainable. */
export type RecallDropReason = "expired";

interface RecallEntry {
  id: string;
  path: string;
  bytes: number;
  lines: number;
  createdAt: number;
  order: number;
  uses: number;
}

export type RecallSaveResult =
  | {
      status: "saved";
      id: string;
      path: string;
      bytes: number;
      reused: boolean;
      /** Disk-pressure warning that fired while admitting this write (I7.2); the write proceeded. */
      warning?: WritePressureWarning;
    }
  | { status: "failed"; code: string };

export type RecallResult =
  | { status: "ok"; id: string; path: string; text: string }
  | { status: "missing"; id: string }
  | { status: "dropped"; id: string };

/** Observable state of the truncation archive: its size, its bounds, and what it evicted. */
export interface ArchiveStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxTotalBytes: number;
  dropped: { name: string; reason: ArchiveDropReason; at: number }[];
}

/** Observable state of the recall store: its size, its bounds, and what it has evicted. */
export interface RecallStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryAgeMs: number;
  dropped: { id: string; reason: RecallDropReason; at: number }[];
}

/**
 * Copies one byte range into a dedicated Buffer. Using Buffer.subarray directly would retain
 * the source's entire backing ArrayBuffer, defeating the capture's memory bound.
 */
function copyBufferRange(buffer: Buffer, start: number, end: number): Buffer {
  const result = Buffer.alloc(Math.max(0, end - start));
  buffer.copy(result, 0, start, end);
  return result;
}

/**
 * Copies a UTF-8-safe Buffer prefix. Moving a cut inside a multi-byte code point back to its
 * leading byte excludes that partial character rather than writing U+FFFD.
 */
function utf8BufferPrefix(buffer: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0 || buffer.length === 0) return Buffer.alloc(0);
  if (buffer.length <= maxBytes) return copyBufferRange(buffer, 0, buffer.length);
  let cut = maxBytes;
  while (cut > 0 && (buffer[cut]! & 0xc0) === 0x80) cut -= 1;
  return copyBufferRange(buffer, 0, cut);
}

/** Copies a UTF-8-safe Buffer suffix whose encoded size does not exceed maxBytes. */
function utf8BufferSuffix(buffer: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0 || buffer.length === 0) return Buffer.alloc(0);
  if (buffer.length <= maxBytes) return copyBufferRange(buffer, 0, buffer.length);
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return copyBufferRange(buffer, start, buffer.length);
}

/**
 * Encodes only a bounded string prefix before applying the byte cap. One UTF-16 code unit
 * contributes at least one UTF-8 byte, so maxBytes (+ one paired surrogate) is sufficient to
 * find the complete prefix without ever encoding an unbounded input delta.
 */
function utf8Prefix(text: string, maxBytes: number): Buffer {
  if (maxBytes <= 0 || text.length === 0) return Buffer.alloc(0);
  let end = Math.min(text.length, maxBytes);
  if (
    end < text.length &&
    end > 0 &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end += 1;
  }
  return utf8BufferPrefix(Buffer.from(text.slice(0, end), "utf8"), maxBytes);
}

/** Encodes only a bounded string suffix, preserving a surrogate pair at the slice boundary. */
function utf8Suffix(text: string, maxBytes: number): Buffer {
  if (maxBytes <= 0 || text.length === 0) return Buffer.alloc(0);
  let start = Math.max(0, text.length - maxBytes);
  if (
    start > 0 &&
    text.charCodeAt(start) >= 0xdc00 &&
    text.charCodeAt(start) <= 0xdfff &&
    text.charCodeAt(start - 1) >= 0xd800 &&
    text.charCodeAt(start - 1) <= 0xdbff
  ) {
    start -= 1;
  }
  return utf8BufferSuffix(Buffer.from(text.slice(start), "utf8"), maxBytes);
}

/**
 * Redact only at the archive boundary, after the capture has bounded its memory and disk
 * window. A recognized credential shape is replaced before the file is persisted; if the
 * replacement makes the text exceed the cap, the same UTF-8-safe head/tail bound is restored.
 */
function redactArchive(data: Buffer, fileLimitBytes: number): Buffer {
  const redacted = Buffer.from(redactCredentials(data.toString("utf8")), "utf8");
  if (redacted.length <= fileLimitBytes) return redacted;
  const contentBudget = Math.max(0, fileLimitBytes - ARCHIVE_GAP_MARKER_BYTES);
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return Buffer.concat([
    utf8BufferPrefix(redacted, headBudget),
    Buffer.from(ARCHIVE_GAP_MARKER, "utf8"),
    utf8BufferSuffix(redacted, tailBudget),
  ]);
}

/**
 * One bounded capture. Each capture independently enforces the per-file memory and disk limit.
 */
export class TruncatedToolOutputCapture {
  private exactChunks: Buffer[] = [];
  private exactBytes = 0;
  private head: Buffer = Buffer.alloc(0);
  /** Fixed-capacity ring storage for the rolling UTF-8 tail after promotion. */
  private tail: Buffer = Buffer.alloc(0);
  private tailStart = 0;
  private tailLength = 0;
  private archiveTruncated = false;
  private settled = false;
  /** A streamed JS string may split one UTF-16 surrogate pair across deltas. */
  private pendingHighSurrogate = "";

  constructor(
    private readonly owner: TruncatedToolOutputArchive,
    private readonly fileLimitBytes: number,
  ) {}

  /** Appends the exact text delta produced by the tool before Environment truncates it. */
  append(text: string): void {
    if (this.settled || text.length === 0) return;
    if (this.pendingHighSurrogate) {
      const pending = this.pendingHighSurrogate;
      this.pendingHighSurrogate = "";
      const first = text.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) {
        // Join only the actual pair, not the whole new delta: concatenating a one-character
        // pending surrogate with an arbitrarily large delta would create an unbounded copy.
        this.appendStable(pending + text.slice(0, 1));
        text = text.slice(1);
        if (text.length === 0) return;
      } else {
        // The pending high surrogate is now known to be lone. Keep the current delta untouched:
        // its own final high surrogate may still pair with the following delta.
        this.appendStable(pending);
      }
    }
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length === 0) return;
    this.appendStable(text);
  }

  private appendStable(text: string): void {
    const chunkBytes = Buffer.byteLength(text, "utf8");

    if (!this.archiveTruncated) {
      if (this.exactBytes + chunkBytes <= this.fileLimitBytes) {
        // Keep this encoding inside the accepted branch. Moving Buffer.from above the size
        // guard would allocate an unbounded Buffer for one huge delta before rejecting it.
        // append() also guarantees no chunk boundary can split a still-pairable surrogate:
        // paired halves are joined first, while confirmed lone surrogates intentionally encode
        // as U+FFFD (guarded by the cross-delta Unicode test).
        this.exactChunks.push(Buffer.from(text, "utf8"));
        this.exactBytes += chunkBytes;
        return;
      }
      this.archiveTruncated = true;
      this.promoteToHeadTail(text, chunkBytes);
      return;
    }

    this.appendTail(text, chunkBytes);
  }

  /** Replaces the capture basis (used only by the compatibility full-message tool path). */
  replace(text: string): void {
    if (this.settled) return;
    this.exactChunks = [];
    this.exactBytes = 0;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.tailStart = 0;
    this.tailLength = 0;
    this.archiveTruncated = false;
    this.pendingHighSurrogate = "";
    this.append(text);
  }

  /** Writes this single-use capture to the Session archive directory. */
  async save(toolName: string, toolCallId: string): Promise<TruncatedToolOutputArchiveSaveResult> {
    if (this.settled) return { status: "failed", code: "ALREADY_SAVED" };
    if (this.pendingHighSurrogate) {
      const pending = this.pendingHighSurrogate;
      this.pendingHighSurrogate = "";
      // A truly lone high surrogate has no direct UTF-8 representation; Node's UTF-8 encoder
      // serializes it as U+FFFD, which is the same behavior writeFile(text, "utf8") would use.
      this.appendStable(pending);
    }
    this.settled = true;
    const data = this.serialized();
    return this.owner.commit(toolName, toolCallId, data, this.archiveTruncated);
  }

  /**
   * The exact text this capture holds, or null once it has promoted to bounded head/tail windows.
   *
   * This is what makes the capture reusable as a *compression* buffer rather than only a
   * last-resort archive: a caller that needs the whole text (to classify it, or to store it for
   * recall) gets it here, and a capture that already gave up on holding everything says so
   * instead of returning a lossy string that looks complete.
   */
  text(): string | null {
    if (this.settled || this.archiveTruncated) return null;
    return this.exactChunks.map((chunk) => chunk.toString("utf8")).join("");
  }

  /**
   * The rolling tail this capture kept after promoting to head/tail windows; "" before promotion.
   * Exposed so a caller that has to fall back to truncation can re-bound the *whole* tool text to
   * its own (much smaller) visible budget, instead of shipping a window sized by this file's
   * 8 MiB archive limit.
   */
  tailText(): string {
    return this.serializedTail().toString("utf8");
  }

  /** The retained head this capture kept after promoting; "" before promotion. */
  headText(): string {
    return this.head.toString("utf8");
  }

  /** Discards an unfinished in-memory capture without writing a file. */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
  }

  private promoteToHeadTail(text: string, chunkBytes: number): void {
    const contentBudget = Math.max(0, this.fileLimitBytes - ARCHIVE_GAP_MARKER_BYTES);
    const headBudget = Math.floor(contentBudget / 2);
    const tailBudget = contentBudget - headBudget;
    const exact = Buffer.concat(this.exactChunks);

    this.head =
      this.exactBytes >= headBudget
        ? utf8BufferPrefix(exact, headBudget)
        : Buffer.concat([exact, utf8Prefix(text, headBudget - this.exactBytes)]);
    const initialTail =
      chunkBytes >= tailBudget
        ? utf8Suffix(text, tailBudget)
        : Buffer.concat([
            utf8BufferSuffix(exact, tailBudget - chunkBytes),
            Buffer.from(text, "utf8"),
          ]);
    this.resetTail(initialTail, tailBudget);
    this.exactChunks = [];
    this.exactBytes = 0;
  }

  /**
   * Appends one stable delta to the rolling tail without rebuilding the retained window.
   * Encoding remains below the tail budget: a delta at least that large takes the bounded
   * string-suffix path instead of allocating a Buffer for the whole delta.
   */
  private appendTail(text: string, chunkBytes: number): void {
    const tailBudget = this.tailBudget();
    if (tailBudget <= 0) {
      this.resetTail(Buffer.alloc(0), 0);
      return;
    }
    if (chunkBytes >= tailBudget) {
      this.resetTail(utf8Suffix(text, tailBudget), tailBudget);
      return;
    }

    const chunk = Buffer.from(text, "utf8");
    const overflow = Math.max(0, this.tailLength + chunk.length - tailBudget);
    this.tailStart = (this.tailStart + overflow) % tailBudget;
    const nextLength = Math.min(tailBudget, this.tailLength + chunk.length);
    const writeStart = (this.tailStart + nextLength - chunk.length) % tailBudget;
    const firstLength = Math.min(chunk.length, tailBudget - writeStart);
    chunk.copy(this.tail, writeStart, 0, firstLength);
    if (firstLength < chunk.length) {
      chunk.copy(this.tail, 0, firstLength);
    }
    this.tailLength = nextLength;
  }

  /** Reinitializes the rolling tail from one already-bounded, code-point-aligned suffix. */
  private resetTail(buffer: Buffer, tailBudget: number): void {
    if (tailBudget <= 0) {
      this.tail = Buffer.alloc(0);
      this.tailStart = 0;
      this.tailLength = 0;
      return;
    }
    this.tail = Buffer.allocUnsafe(tailBudget);
    buffer.copy(this.tail);
    this.tailStart = 0;
    this.tailLength = buffer.length;
  }

  private tailBudget(): number {
    const contentBudget = Math.max(0, this.fileLimitBytes - ARCHIVE_GAP_MARKER_BYTES);
    return contentBudget - Math.floor(contentBudget / 2);
  }

  /** Copies the logical ring suffix once, dropping a leading partial UTF-8 code point. */
  private serializedTail(): Buffer {
    if (this.tailLength === 0) return Buffer.alloc(0);
    const capacity = this.tail.length;
    let skip = 0;
    while (
      skip < this.tailLength &&
      (this.tail[(this.tailStart + skip) % capacity]! & 0xc0) === 0x80
    ) {
      skip += 1;
    }
    const length = this.tailLength - skip;
    const result = Buffer.allocUnsafe(length);
    const readStart = (this.tailStart + skip) % capacity;
    const firstLength = Math.min(length, capacity - readStart);
    this.tail.copy(result, 0, readStart, readStart + firstLength);
    if (firstLength < length) {
      this.tail.copy(result, firstLength, 0, length - firstLength);
    }
    return result;
  }

  private serialized(): Buffer {
    if (!this.archiveTruncated) return Buffer.concat(this.exactChunks);
    return Buffer.concat([
      this.head,
      Buffer.from(ARCHIVE_GAP_MARKER, "utf8"),
      this.serializedTail(),
    ]);
  }
}

export class TruncatedToolOutputArchive {
  private readonly rootDir: string;
  private readonly fileLimitBytes: number;
  /** The prune frontier: what the last pass decided, so a repeat does not re-decide it (B4.3). */
  private pruneFrontier: PruneFrontier = createPruneFrontier();
  private pruneFrontierLoaded = false;

  /** Recall entries live in their own subdirectory so eviction can only unlink this store's files. */
  private readonly recallRootDir: string;
  private readonly recallIndex = new Map<string, RecallEntry>();
  private recallSequence = 0;
  private readonly recallDropped: { id: string; reason: RecallDropReason; at: number }[] = [];
  private recallSaveTail: Promise<void> = Promise.resolve();
  private readonly recallLimits: RecallLimits;
  private readonly now: () => number;
  private readonly archiveLimits: ArchiveLimits;
  private readonly pruneFrontierPath: string | undefined;
  /** The I7.2 admission gate for this store's own writes; undefined = no pressure policy. */
  private readonly writePressure: WritePressureGate | undefined;
  /** Serializes capacity checks with their writes, like the recall store (E10.4). */
  private archiveSaveTail: Promise<void> = Promise.resolve();
  /** Bounded log of files the capacity bound removed (newest last). */
  private readonly archiveDropped: { name: string; reason: ArchiveDropReason; at: number }[] = [];

  constructor(opts: TruncatedToolOutputArchiveOptions) {
    // The explicit gap marker is part of every bounded head/tail archive, so even internal
    // test overrides must leave enough room for it; production stays just below 8 MiB.
    this.fileLimitBytes = Math.max(
      ARCHIVE_GAP_MARKER_BYTES,
      opts.fileLimitBytes ?? TRUNCATED_TOOL_OUTPUT_FILE_LIMIT_BYTES,
    );
    this.rootDir = opts.rootDir;
    this.recallRootDir = path.join(opts.rootDir, "recall");
    this.writePressure = opts.writePressure;
    this.recallLimits = { ...RECALL_LIMITS, ...opts.recallLimits };
    this.archiveLimits = { ...ARCHIVE_LIMITS, ...opts.archiveLimits };
    this.pruneFrontierPath = opts.pruneFrontierPath;
    this.now = opts.now ?? Date.now;
  }

  /** Starts one independently bounded capture; the directory remains lazy until save(). */
  startCapture(): TruncatedToolOutputCapture {
    return new TruncatedToolOutputCapture(this, this.fileLimitBytes);
  }

  /**
   * Internal commit path used by TruncatedToolOutputCapture.
   *
   * Serialized and capacity-checked (E10.4): the per-Session bound is enforced against the
   * directory's actual contents, so it holds across concurrent calls and across a process
   * restart, and the oldest files go first. A capture that cannot be admitted at all is refused
   * with `ARCHIVE_FULL` and evidence on stderr rather than written outside the bound.
   */
  async commit(
    toolName: string,
    toolCallId: string,
    data: Buffer,
    archiveTruncated: boolean,
  ): Promise<TruncatedToolOutputArchiveSaveResult> {
    const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "tool";
    const idHash = createHash("sha256").update(toolCallId).digest("hex").slice(0, 16);
    const filePath = path.join(this.rootDir, `${safeToolName}-${idHash}.log`);
    const previous = this.archiveSaveTail;
    let release!: () => void;
    this.archiveSaveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // Admitted before the first filesystem call: a refused write must not create the directory,
    // touch the ledger or leave a partial file for the next reader to trip over.
    const admission = await this.admitWrite("tool-output-archive", toolCallId);
    if (admission.blocked) return { status: "failed", code: "PRESSURE_BLOCKED" };
    try {
      // Create shared Session ancestors with their existing/default policy, then apply the
      // archive's private directory mode only to the archive directory itself.
      await mkdir(path.dirname(this.rootDir), { recursive: true });
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const payload = redactArchive(data, this.fileLimitBytes);
      if (!(await this.makeRoomFor(payload.length))) {
        process.stderr.write(
          `[penguin] tool "${toolName}" truncated output archive is at capacity ` +
            `(${this.archiveLimits.maxEntries} entries / ${this.archiveLimits.maxTotalBytes} bytes).\n`,
        );
        return { status: "failed", code: "ARCHIVE_FULL" };
      }
      await writeFile(filePath, payload, {
        flag: "wx",
        mode: 0o600,
      });
      return {
        status: "saved",
        path: filePath,
        archiveTruncated,
        ...(admission.warning ? { warning: admission.warning } : {}),
      };
    } catch (err) {
      const rawCode = (err as { code?: unknown }).code;
      const code = typeof rawCode === "string" ? rawCode : "UNKNOWN";
      process.stderr.write(
        `[penguin] tool "${toolName}" truncated output archive write failed (${code}).\n`,
      );
      return { status: "failed", code };
    } finally {
      release();
    }
  }

  /**
   * Evicts oldest-first until one more file of `pendingBytes` fits inside both bounds, and
   * reports whether it now fits. The directory listing — not an in-memory index — is the
   * authority, so a restart re-enforces the bound over files written by an earlier process, and
   * only regular `*.log` files this class writes are candidates: the `recall/` subdirectory and
   * anything else in the Session scratchpad are never touched.
   */
  private async makeRoomFor(pendingBytes: number): Promise<boolean> {
    // A requirement larger than the whole budget cannot fit at any level of pruning, and the
    // frontier remembers that decision per directory state — so a repeated oversized capture is
    // refused without listing or stat-ing anything (B4.3).
    if (
      this.pruneFrontier.blockedAtRequiredBytes !== null &&
      pendingBytes >= this.pruneFrontier.blockedAtRequiredBytes
    ) {
      const cached = planPrune({
        directoryMtimeMs: this.pruneFrontier.directoryMtimeMs,
        requiredBytes: pendingBytes,
        limits: this.archiveLimits,
        frontier: this.pruneFrontier,
      });
      if (cached.decision === "cached-blocked") {
        this.pruneFrontier = cached.frontier;
        await this.persistPruneFrontier();
        return false;
      }
    }
    await this.loadPruneFrontier();
    const directoryMtimeMs = await lstat(this.rootDir)
      .then((info) => info.mtimeMs)
      .catch(() => null);
    const entries: { name: string; path: string; bytes: number; mtimeMs: number }[] = [];
    const listing = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const dirent of listing) {
      if (!dirent.isFile() || !dirent.name.endsWith(".log")) continue;
      const filePath = path.join(this.rootDir, dirent.name);
      const info = await lstat(filePath).catch(() => null);
      // A symlink is not something this class writes, and following one would make eviction a
      // way to delete files outside the archive. Skip anything that is not a plain file.
      if (info === null || !info.isFile() || info.isSymbolicLink()) continue;
      entries.push({ name: dirent.name, path: filePath, bytes: info.size, mtimeMs: info.mtimeMs });
    }
    const plan = planPrune({
      directoryMtimeMs,
      requiredBytes: pendingBytes,
      limits: this.archiveLimits,
      entries: entries.map(({ name, bytes, mtimeMs }) => ({ name, bytes, mtimeMs })),
      // The recall store keeps its own documented lifetime and lives in its own subdirectory; the
      // frontier records this so a future pruner cannot reconsider those entries either.
      keepNames: [],
      frontier: this.pruneFrontier,
    });
    this.pruneFrontier = plan.frontier;
    if (plan.decision === "blocked" || plan.decision === "cached-blocked") {
      await this.persistPruneFrontier();
      return false;
    }
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    let removed = 0;
    for (const name of plan.drops) {
      const entry = byName.get(name);
      if (entry === undefined) continue;
      try {
        await unlink(entry.path);
      } catch (error) {
        // Only ENOENT means another writer (or the host's Session deletion) already removed the
        // file, in which case the bound is served and the entry counts as dropped. Anything else
        // -- EACCES, EPERM, EBUSY -- leaves the file on disk, so counting it would lower
        // `totalBytes`/`count` for a file that is still there and let `makeRoomFor` report room
        // that does not exist, and the drop log would name a file a reader can still open.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      removed += 1;
      this.archiveDropped.push({ name: entry.name, reason: "capacity", at: this.now() });
      while (this.archiveDropped.length > RECALL_DROPPED_LOG_LIMIT) this.archiveDropped.shift();
    }
    await this.persistPruneFrontier();
    // Room exists only if the plan's drops actually happened. A file the operating system would
    // not let go of is still consuming the bound, so reporting "made room" would let the caller
    // write past `maxEntries`/`maxTotalBytes` while the drop log named a file that is still there.
    return plan.decision === "fits" || removed === plan.drops.length;
  }

  /** Loads a persisted frontier once; a missing or corrupt one is simply a fresh frontier. */
  private async loadPruneFrontier(): Promise<void> {
    if (this.pruneFrontierLoaded || this.pruneFrontierPath === undefined) return;
    this.pruneFrontierLoaded = true;
    const text = await readFile(this.pruneFrontierPath, "utf8").catch(() => null);
    this.pruneFrontier = parsePruneFrontier(text);
  }

  /** Persists the frontier when a path was configured; a failed write is not fatal to a prune. */
  private async persistPruneFrontier(): Promise<void> {
    if (this.pruneFrontierPath === undefined) return;
    await mkdir(path.dirname(this.pruneFrontierPath), { recursive: true, mode: 0o700 }).catch(
      () => undefined,
    );
    await writeFile(this.pruneFrontierPath, serializePruneFrontier(this.pruneFrontier), {
      mode: 0o600,
    }).catch(() => undefined);
  }

  /** Observable state of the truncation archive: what it holds, its bounds, what it evicted. */
  async archiveStats(): Promise<ArchiveStats> {
    await this.archiveSaveTail;
    const listing = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    let entries = 0;
    let bytes = 0;
    for (const dirent of listing) {
      if (!dirent.isFile() || !dirent.name.endsWith(".log")) continue;
      const info = await lstat(path.join(this.rootDir, dirent.name)).catch(() => null);
      if (info === null || !info.isFile() || info.isSymbolicLink()) continue;
      entries += 1;
      bytes += info.size;
    }
    return {
      entries,
      bytes,
      maxEntries: this.archiveLimits.maxEntries,
      maxTotalBytes: this.archiveLimits.maxTotalBytes,
      dropped: [...this.archiveDropped],
    };
  }

  /**
   * Asks the gate, if one is configured, whether this write may proceed.
   *
   * A gate that throws becomes a warning with no measurement rather than a refusal: the policy
   * must not lose a write because its own probe misbehaved, and it must not claim a measurement
   * it does not have. `blocked` is true only for a decision that is actually a block, so an
   * unavailable probe can never refuse a write (I7.2). Nothing here reads tool arguments — the
   * identity is the caller's own tool call id.
   */
  private async admitWrite(
    producerId: NonessentialProducerId,
    toolCallId: string,
  ): Promise<{ blocked: boolean; warning: WritePressureWarning | null }> {
    if (this.writePressure === undefined) return { blocked: false, warning: null };
    let decision: PressureDecision;
    try {
      decision = await this.writePressure.admit({ producerId, toolCallId });
    } catch (err) {
      return {
        blocked: false,
        warning: {
          signal: "write_pressure_probe_unavailable",
          reason: `the write-pressure gate threw: ${err instanceof Error ? err.message : String(err)}`,
          volumePath: "",
          freeBytes: null,
        },
      };
    }
    if (decision.action === "block") return { blocked: true, warning: null };
    if (decision.action === "warn" && decision.signal !== null) {
      return {
        blocked: false,
        warning: {
          signal: decision.signal,
          reason: decision.reason,
          volumePath: decision.volumePath,
          freeBytes: decision.freeBytes,
        },
      };
    }
    return { blocked: false, warning: null };
  }

  // -------------------------------------------------------------------------
  // Recall store
  //
  // A compressed tool result is only defensible if the model can recover its source. The stored
  // text is credential-redacted, and the result carries an opaque id that the Session-scoped
  // `recall_output` tool can page through without exposing this archive's filesystem path.
  //
  // It is built on the archive above rather than beside it: same Session scratchpad, same
  // credential redaction, same private file modes, same removal by the host's Session-deletion
  // path. What it adds is what the truncation path never needed — a content-addressed id, a
  // registry, and hard bounds.
  // -------------------------------------------------------------------------

  /**
   * Stores `text` as a recallable entry and returns the id the model can quote.
   *
   * The id is content-addressed (the first 32 hex chars of the stored, redacted UTF-8 text's
   * SHA-256), so duplicate visible output reuses one entry without fingerprinting the secret
   * source text. Writes land in a
   * `recall/` subdirectory so eviction can only ever unlink files this store created — the
   * truncation archive's own files, written by `commit`, are never touched by it.
   */
  async saveRecallEntry(
    toolName: string,
    text: string,
    /** The boundary's identity for this write (the tool call id); an override is scoped to it. */
    writeId = "",
  ): Promise<RecallSaveResult> {
    // Environment can finish multiple tool calls concurrently. Serialize capacity checks with
    // their writes so every accepted id is accounted for before another call reserves space.
    const previous = this.recallSaveTail;
    let release!: () => void;
    this.recallSaveTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.saveRecallEntryExclusive(toolName, text, writeId);
    } finally {
      release();
    }
  }

  private async saveRecallEntryExclusive(
    _toolName: string,
    text: string,
    writeId: string,
  ): Promise<RecallSaveResult> {
    await this.loadRecallFiles();
    await this.enforceRecallBounds();
    // Before the id is derived and before anything is written: a block here means the entry is
    // not stored at all, and the caller falls back to the honest bounded answer. Nothing on the
    // destination volume changes, including the store's own index.
    const admission = await this.admitWrite("recall-store", writeId);
    if (admission.blocked) return { status: "failed", code: "PRESSURE_BLOCKED" };
    if (!isWellFormedUtf16(text)) return { status: "failed", code: "INVALID_UTF8" };
    const data = Buffer.from(text, "utf8");
    if (data.length > this.fileLimitBytes) return { status: "failed", code: "ENTRY_TOO_LARGE" };
    const redacted = Buffer.from(redactCredentials(text), "utf8");
    if (redacted.length > this.fileLimitBytes) {
      return { status: "failed", code: "ENTRY_TOO_LARGE" };
    }
    // Derive ids from the persisted representation so the handle itself does not fingerprint
    // the unredacted secret text that the archive intentionally refuses to retain.
    const key = createHash("sha256").update(redacted).digest("hex");
    const id = key.slice(0, RECALL_ID_HEX_LENGTH);
    const existing = this.recallIndex.get(id);
    if (existing !== undefined) {
      // Already stored (identical redacted text): reuse the entry, do not rewrite
      // it or reset its age, so a repeated command cannot keep a stale entry alive forever.
      existing.uses += 1;
      return {
        status: "saved",
        id,
        path: existing.path,
        bytes: existing.bytes,
        reused: true,
        ...(admission.warning ? { warning: admission.warning } : {}),
      };
    }

    // An issued id is promised to remain usable until its age expiry (or Session deletion).
    // If the bounded store is full, refuse this new save rather than evicting an earlier id.
    let storedBytes = 0;
    for (const entry of this.recallIndex.values()) storedBytes += entry.bytes;
    if (
      this.recallIndex.size >= this.recallLimits.maxEntries ||
      storedBytes + redacted.length > this.recallLimits.maxTotalBytes
    ) {
      return { status: "failed", code: "LIMIT_REACHED" };
    }

    const filePath = path.join(this.recallRootDir, `${id}${RECALL_FILE_EXTENSION}`);
    try {
      await mkdir(this.recallRootDir, { recursive: true, mode: 0o700 });
      await writeFile(filePath, redacted, { flag: "wx", mode: 0o600 });
    } catch (err) {
      const rawCode = (err as { code?: unknown }).code;
      if (rawCode === "EEXIST") {
        // Another Environment for the same Session may have stored this deterministic id.
        // Never trust an id collision as a content match: verify the bytes before indexing it.
        const info = await lstat(filePath).catch(() => null);
        if (info === null || !info.isFile() || info.isSymbolicLink()) {
          return { status: "failed", code: "INVALID_ENTRY" };
        }
        const prior = await readFile(filePath).catch(() => null);
        if (prior === null || !prior.equals(redacted)) {
          return { status: "failed", code: "ID_COLLISION" };
        }
        this.recallIndex.set(id, {
          id,
          path: filePath,
          bytes: redacted.length,
          lines: countLines(redacted),
          createdAt: info.mtimeMs,
          order: ++this.recallSequence,
          uses: 1,
        });
        await this.enforceRecallBounds();
        if (!this.recallIndex.has(id)) return { status: "failed", code: "EXPIRED" };
        return {
          status: "saved",
          id,
          path: filePath,
          bytes: redacted.length,
          reused: true,
          ...(admission.warning ? { warning: admission.warning } : {}),
        };
      }
      const code = typeof rawCode === "string" ? rawCode : "UNKNOWN";
      process.stderr.write(`[penguin] tool output recall write failed (${code}).\n`);
      return { status: "failed", code };
    }

    this.recallIndex.set(id, {
      id,
      path: filePath,
      bytes: redacted.length,
      lines: countLines(redacted),
      createdAt: this.now(),
      order: ++this.recallSequence,
      uses: 1,
    });
    await this.enforceRecallBounds();
    if (!this.recallIndex.has(id)) return { status: "failed", code: "EXPIRED" };
    return {
      status: "saved",
      id,
      path: filePath,
      bytes: redacted.length,
      reused: false,
      ...(admission.warning ? { warning: admission.warning } : {}),
    };
  }

  /**
   * Returns the stored text for a recall id, byte for byte as it was written.
   *
   * "As it was written" is the precise claim: entries are credential-redacted at rest, so a
   * recalled output matches the compressed result except where a recognised secret shape was
   * replaced by `<redacted>`. That difference is deliberate — the same redaction the truncation
   * archive has always applied — and it is the only reason recall is not a literal identity.
   */
  async recall(id: string): Promise<RecallResult> {
    const wanted = id.trim().toLowerCase();
    if (
      !new RegExp(
        `^(?:[a-f0-9]{${LEGACY_RECALL_ID_HEX_LENGTH}}|[a-f0-9]{${RECALL_ID_HEX_LENGTH}})$`,
      ).test(wanted)
    ) {
      return { status: "missing", id: "" };
    }
    await this.loadRecallFiles();
    await this.enforceRecallBounds();
    const entry = this.recallIndex.get(wanted);
    if (entry === undefined) {
      // The drop log is a bounded ring, so this scan is bounded too. Reporting "dropped" rather
      // than "missing" is the difference between "it aged out" and "it was never stored".
      return this.recallDropped.some((entry) => entry.id === wanted)
        ? { status: "dropped", id: wanted }
        : { status: "missing", id: wanted };
    }
    try {
      const info = await lstat(entry.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
        this.recallIndex.delete(entry.id);
        return { status: "missing", id: entry.id };
      }
      const data = await readFile(entry.path);
      if (
        wanted.length === RECALL_ID_HEX_LENGTH &&
        createHash("sha256").update(data).digest("hex").slice(0, RECALL_ID_HEX_LENGTH) !== wanted
      ) {
        this.recallIndex.delete(entry.id);
        await unlink(entry.path).catch(() => undefined);
        return { status: "missing", id: entry.id };
      }
      entry.uses += 1;
      return { status: "ok", id: entry.id, path: entry.path, text: data.toString("utf8") };
    } catch {
      // The file went away underneath us (host cleanup, external removal). Forget the entry
      // rather than leaving a registry that points at nothing.
      this.recallIndex.delete(entry.id);
      return { status: "missing", id: entry.id };
    }
  }

  /** One-line description of a stored entry for the model-visible note. */
  recallDescriptor(id: string): { path: string; lines: number; bytes: number } | null {
    const entry = this.recallIndex.get(id);
    if (entry === undefined) return null;
    return { path: entry.path, lines: entry.lines, bytes: entry.bytes };
  }

  /**
   * Bounds and drop log for the recall store, for diagnostics and for the tests that prove the
   * store cannot grow without limit. Capacity refuses new entries; only expired entries are
   * removed automatically, so an issued id remains usable until its advertised expiry.
   */
  recallStats(): RecallStats {
    let bytes = 0;
    for (const entry of this.recallIndex.values()) bytes += entry.bytes;
    return {
      entries: this.recallIndex.size,
      bytes,
      maxEntries: this.recallLimits.maxEntries,
      maxTotalBytes: this.recallLimits.maxTotalBytes,
      maxEntryAgeMs: this.recallLimits.maxEntryAgeMs,
      dropped: [...this.recallDropped],
    };
  }

  /** Load persisted same-Session entries so ids survive an Environment/process restart. */
  private async loadRecallFiles(): Promise<void> {
    const names = await readdir(this.recallRootDir).catch((err: unknown) => {
      return (err as { code?: unknown }).code === "ENOENT" ? [] : null;
    });
    if (names === null) return;
    const validName = new RegExp(
      `^([a-f0-9]{${LEGACY_RECALL_ID_HEX_LENGTH}}|[a-f0-9]{${RECALL_ID_HEX_LENGTH}})\\${RECALL_FILE_EXTENSION}$`,
    );
    for (const name of names) {
      const match = validName.exec(name);
      if (!match) continue;
      const id = match[1]!;
      if (this.recallIndex.has(id)) continue;
      const filePath = path.join(this.recallRootDir, name);
      const info = await lstat(filePath).catch(() => null);
      if (info === null || !info.isFile() || info.isSymbolicLink()) continue;
      const entry: RecallEntry = {
        id,
        path: filePath,
        bytes: info.size,
        lines: 0,
        createdAt: info.mtimeMs,
        order: ++this.recallSequence,
        uses: 0,
      };
      if (this.now() - entry.createdAt > this.recallLimits.maxEntryAgeMs) {
        await unlink(filePath).catch(() => undefined);
        this.recallDropped.push({ id, reason: "expired", at: this.now() });
        while (this.recallDropped.length > RECALL_DROPPED_LOG_LIMIT) this.recallDropped.shift();
        continue;
      }
      this.recallIndex.set(id, entry);
    }
  }

  /** Expiry is the only automatic removal policy; capacity rejects new saves instead. */
  private async enforceRecallBounds(): Promise<void> {
    const now = this.now();
    for (const entry of this.recallIndex.values()) {
      if (now - entry.createdAt <= this.recallLimits.maxEntryAgeMs) continue;
      this.recallIndex.delete(entry.id);
      this.recallDropped.push({ id: entry.id, reason: "expired", at: now });
      await unlink(entry.path).catch(() => {
        // The index entry is already gone, so an unlink failure leaves at most one orphan file
        // that the host's Session-deletion path still removes. Nothing here should throw.
      });
    }
    while (this.recallDropped.length > RECALL_DROPPED_LOG_LIMIT) this.recallDropped.shift();
  }
}
