/**
 * A bounded, per-project log of the cockpit's broadcast envelopes, with a monotonic cursor.
 *
 * Why this exists. The cockpit stream is fire-and-forget: a `swarm_event`, a `key_fleet_update`
 * or a `directive_dispatched` is serialized once and pushed to whoever happens to be connected.
 * A client that drops therefore loses exactly those messages, and the REST snapshot it refetches
 * on reconnect cannot put them back — the snapshot carries current STATE (agents, mailboxes, key
 * health, the turn replay) and no event history. So the alert feed and the handoff timeline, which
 * are built only from deltas, quietly lose whatever happened during the gap. That is the drift
 * this log exists to close.
 *
 * The bound is the design, not a safety net bolted on afterwards. Replaying from a cursor with
 * no bound is a memory leak with a different name: a session that stays up for a day would
 * accumulate every envelope it ever broadcast. So the log holds at most
 * {@link COCKPIT_EVENT_LOG_CAP} envelopes and at most {@link COCKPIT_EVENT_LOG_MAX_CHARS} of
 * serialized text, whichever binds first, and evicts from the oldest. A client whose cursor has
 * fallen out of that window is told it fell out — `since()` reports a gap rather than a truncated
 * answer — and the transport answers it with a fresh snapshot plus an explicit "you missed N"
 * message. The failure mode at the bound is therefore "the UI says it is behind", never "the UI
 * shows a stale tree and calls it live".
 *
 * ## Durability
 *
 * The same reasoning applies across a process restart, which is why the log can be backed by a
 * file ({@link CockpitEventLogOptions.file}, wired by the transport to
 * `<projectDir>/{@link COCKPIT_EVENT_LOG_FILE}`). Without it, every restart rotates the
 * generation and every reconnecting client is told `stream_generation_changed` — honest, but a
 * replay window that dies with the process is barely a window.
 *
 * The file is a header line plus one JSON line per envelope, appended with a single `write(2)`
 * per publish (the trace writer's rule, for the same reason: a split write can leave a torn
 * line). A crash therefore costs at most the in-flight line, and restore drops an unterminated
 * tail rather than guessing at it. The generation lives in the header, so a restart keeps the
 * stream identity and clients resume across it. `persistedSeq` is the durability
 * acknowledgement: it only ever names a seq that is on disk, so a caller that needs to know
 * which cursor survives a restart reads that, not `cursor`.
 *
 * The file must stay a *contiguous* run of sequence numbers, because restore refuses to walk
 * across a hole (a hole is a stretch of history it cannot honestly serve). Two things can
 * punch one: a crash that leaves a torn tail, and a failed write whose envelope is never
 * retried in place. Both are handled the same way — the file is marked as needing a rewrite
 * and the next successful publish replaces it wholesale (header + retained tail + the
 * in-flight envelope) instead of appending behind the damage. Restore may therefore begin at
 * a seq greater than 1 (after a compaction wrote only the retained window); the first line it
 * can read is the window's base, and cursors older than that are reported as a gap.
 *
 * The append-only file is compacted (atomically, via a temp file and a rename) once it grows
 * past {@link COCKPIT_EVENT_LOG_COMPACT_AT_BYTES}, so durability does not trade a memory bound
 * for an unbounded file. A persistence failure never stops the live stream — envelopes still
 * reach connected clients and `since()` still replays from memory — but it freezes
 * `persistedSeq` and is reported through {@link CockpitEventLogOptions.onPersistError} once per
 * failure burst, so "we are durable again" is also a transition the host can observe.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum envelopes retained per project, across all clients of that project. */
export const COCKPIT_EVENT_LOG_CAP = 512;

/**
 * Maximum retained serialized text per project. A cap on count alone is not a memory bound:
 * a swarm event carrying a large tool output can be orders of magnitude bigger than a
 * key-fleet update, so 512 of the wrong envelopes is a very different number of bytes than
 * 512 of the right ones. The byte budget is what actually keeps the log small; the count
 * budget exists so a project with thousands of tiny updates still cannot hold thousands of
 * entries.
 */
export const COCKPIT_EVENT_LOG_MAX_BYTES = 512 * 1024;
/** @deprecated The cap is measured in UTF-8 bytes; use COCKPIT_EVENT_LOG_MAX_BYTES. */
export const COCKPIT_EVENT_LOG_MAX_CHARS = COCKPIT_EVENT_LOG_MAX_BYTES;

/** File name of the durable tail inside a project directory. */
export const COCKPIT_EVENT_LOG_FILE = "cockpit-stream.jsonl";

/** On-disk format version; a file carrying another version is not adopted as this stream. */
export const COCKPIT_EVENT_LOG_FILE_VERSION = 1;

/**
 * Compaction threshold for the append-only file, in bytes. Well above the in-memory budget so
 * compaction is rare (the retained tail is ≤ {@link COCKPIT_EVENT_LOG_MAX_BYTES}), and well
 * below anything that would make the file a problem of its own.
 */
export const COCKPIT_EVENT_LOG_COMPACT_AT_BYTES = COCKPIT_EVENT_LOG_MAX_BYTES * 4;

/**
 * The filesystem operations the durable log needs, injectable so a test can present a failing
 * disk without a special-cased build. Only synchronous operations: persistence order must equal
 * publish order, and the acknowledgement (`persistedSeq`) is meaningful only if the write has
 * already happened when `publish` returns.
 */
export interface CockpitEventLogDisk {
  /** Reads the whole file, or returns null when it does not exist. Throws for other failures. */
  read(file: string): string | null;
  /** Appends text as a single write, creating the file (mode 0600) and its directory. */
  append(file: string, text: string): void;
  /** Atomically replaces the file's contents (temp file + rename). */
  replace(file: string, text: string): void;
}

export const nodeCockpitEventLogDisk: CockpitEventLogDisk = {
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  append(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, "a", 0o600);
    try {
      const buffer = Buffer.from(text, "utf8");
      let offset = 0;
      while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset);
    } finally {
      fs.closeSync(fd);
    }
  },
  replace(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
  },
};

export interface CockpitEventLogOptions {
  /** Absolute durable file path. Omitted = memory-only (tests, one-shot runtimes). */
  file?: string;
  /** Injected filesystem; defaults to {@link nodeCockpitEventLogDisk}. */
  disk?: CockpitEventLogDisk;
  /** Called on the first persistence failure of a burst, and again after a success. */
  onPersistError?: (error: Error) => void;
}

/** One retained envelope: its sequence number and the exact bytes that were broadcast. */
export interface CockpitLogEntry {
  seq: number;
  payload: string;
}

/**
 * What a reconnecting client asked for, and what it can be told.
 *
 * `gap` is the important field. It is never `false` while the answer is merely partial, and
 * it is not an error: it means "your cursor is older than anything I still hold, so I am not
 * going to pretend a partial answer is complete". The caller answers a gap with a full
 * snapshot, which is a different and clearly-labelled kind of message.
 */
export interface CockpitReplay {
  /** Envelopes the client missed, in order. Empty when `gap` is true. */
  entries: CockpitLogEntry[];
  /** True when the client's cursor predates everything still retained. */
  gap: boolean;
  /**
   * How many envelopes the client missed, or null when the count is not knowable (a cursor
   * from a previous process — the number of events between two processes is not a number this
   * server can state honestly).
   */
  missed: number | null;
  /** The cursor to resume from after applying `entries`. */
  cursor: number;
}

export class CockpitEventLog {
  /** Distinguishes cursors from a previous process or reaped runtime. */
  private currentGeneration: string = randomUUID();
  /** Sequence of the next envelope to be published. Starts at 1 so 0 can mean "never seen any". */
  private nextSeq = 1;
  private entries: CockpitLogEntry[] = [];
  private chars = 0;
  private bytes = 0;

  private readonly file: string | null;
  private readonly disk: CockpitEventLogDisk;
  private readonly onPersistError: ((error: Error) => void) | undefined;
  /** Highest seq known to be on disk (the durability acknowledgement); 0 when nothing is. */
  private durable = 0;
  /** On-disk size so far, so compaction is a counter check rather than a stat per publish. */
  private fileBytes = 0;
  /** False until a matching header exists on disk (a foreign file is replaced, not appended to). */
  private headerWritten: boolean;
  /** True when the file is known to be torn, contaminated or holey; the next write replaces it. */
  private fileNeedsRewrite: boolean;
  private persistErrors = 0;
  private persistErrorReported = false;

  constructor(options: CockpitEventLogOptions = {}) {
    this.file = options.file ?? null;
    this.disk = options.disk ?? nodeCockpitEventLogDisk;
    this.onPersistError = options.onPersistError;
    this.headerWritten = this.file === null;
    this.fileNeedsRewrite = false;
    if (this.file !== null) this.restore();
  }

  /** The most recently published sequence number; 0 before anything has been published. */
  get cursor(): number {
    return this.nextSeq - 1;
  }

  /** Highest seq that survives a restart; 0 when nothing durable has been written yet. */
  get durableCursor(): number {
    return this.durable;
  }

  /** Persistence failures observed (each burst counted by its first failure). */
  get persistenceErrors(): number {
    return this.persistErrors;
  }

  /** Absolute durable file path, or null for a memory-only log. */
  get filePath(): string | null {
    return this.file;
  }

  get generation(): string {
    return this.currentGeneration;
  }

  /** Retained envelope count. Exposed for the bound assertions in the tests. */
  get size(): number {
    return this.entries.length;
  }

  /** Retained serialized characters. Exposed for the bound assertions in the tests. */
  get retainedChars(): number {
    return this.chars;
  }

  /** Retained payload size measured in UTF-8 bytes, the unit used by the memory bound. */
  get retainedBytes(): number {
    return this.bytes;
  }

  /**
   * Records one envelope and returns its sequence number. The caller stamps that number onto
   * the broadcast message, so every client learns the cursor from the traffic it already
   * receives — there is no separate subscription to keep in sync, and a client that was
   * connected the whole time has a correct cursor for free.
   *
   * An envelope larger than the whole byte budget is published (the caller always broadcasts
   * it) but is NOT retained: keeping it would evict everything else and still overflow. Such a
   * client will simply be told it fell out of the window, which is the honest answer.
   */
  publish(payload: string): number {
    const seq = this.nextSeq++;
    this.retain(seq, payload);
    this.persist(seq, payload);
    return seq;
  }

  /** Builds and retains the exact stamped envelope that live clients will receive. */
  publishStamped(makePayload: (seq: number) => string): CockpitLogEntry {
    const seq = this.nextSeq++;
    const payload = makePayload(seq);
    this.retain(seq, payload);
    this.persist(seq, payload);
    return { seq, payload };
  }

  private retain(seq: number, payload: string): void {
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (payloadBytes <= COCKPIT_EVENT_LOG_MAX_BYTES) {
      this.entries.push({ seq, payload });
      this.chars += payload.length;
      this.bytes += payloadBytes;
      // Evict from the oldest until both bounds hold. `while`, not `if`: a single large
      // envelope added to an already-full log can need several evictions to get back under
      // the byte budget.
      while (
        this.entries.length > COCKPIT_EVENT_LOG_CAP ||
        this.bytes > COCKPIT_EVENT_LOG_MAX_BYTES
      ) {
        const dropped = this.entries.shift();
        if (dropped === undefined) break;
        this.chars -= dropped.payload.length;
        this.bytes -= Buffer.byteLength(dropped.payload, "utf8");
      }
    }
  }

  /**
   * What a client holding `clientSeq` missed.
   *
   * A cursor that is not a safe non-negative integer, or one from the future (a client whose
   * cursor belongs to a server that has since restarted, or a client that guessed), is treated
   * as a gap rather than clamped. Clamping a future cursor to 0 would replay the whole window
   * to a client that did not ask for it; clamping a garbage cursor would answer a question
   * with a plausible-looking lie. Both are worse than saying "take a fresh snapshot".
   */
  since(clientSeq: unknown): CockpitReplay {
    const cursor = this.cursor;
    if (typeof clientSeq !== "number" || !Number.isSafeInteger(clientSeq) || clientSeq < 0) {
      return { entries: [], gap: true, missed: null, cursor };
    }
    if (clientSeq > cursor) {
      // The cursor belongs to another log generation (or was guessed). A fresh snapshot is
      // required; treating it as current would hide every event until this log catches up.
      return { entries: [], gap: true, missed: null, cursor };
    }
    if (clientSeq === cursor) {
      return { entries: [], gap: false, missed: 0, cursor };
    }
    const oldest = this.entries[0]?.seq;
    // The client missed at least one envelope, and the oldest we still hold is the first one
    // we could give them. If its sequence is beyond what the client already saw, the window
    // has rolled past their cursor.
    if (oldest === undefined || oldest > clientSeq + 1) {
      return { entries: [], gap: true, missed: null, cursor };
    }
    return {
      entries: this.entries.filter((entry) => entry.seq > clientSeq),
      gap: false,
      missed: cursor - clientSeq,
      cursor,
    };
  }

  /** Drops everything and restarts the sequence. Used by the runtime reap and by tests. */
  reset(): void {
    this.currentGeneration = randomUUID();
    this.nextSeq = 1;
    this.entries = [];
    this.chars = 0;
    this.bytes = 0;
    this.durable = 0;
    if (this.file === null) return;
    // A deliberate reset must also be what a restart sees, or the next process would adopt the
    // discarded stream and hand out cursors from a history this instance already disowned.
    const header = this.headerLine();
    try {
      this.disk.replace(this.file, header);
      this.headerWritten = true;
      this.fileNeedsRewrite = false;
      this.fileBytes = Buffer.byteLength(header, "utf8");
      this.onPersistSuccess();
    } catch (error) {
      this.headerWritten = false;
      this.reportPersistFailure(error);
    }
  }

  private headerLine(): string {
    return `${JSON.stringify({
      type: "cockpit_stream_header",
      version: COCKPIT_EVENT_LOG_FILE_VERSION,
      generation: this.currentGeneration,
    })}\n`;
  }

  /**
   * Adopts a durable tail written by an earlier process (same version and header generation).
   * A foreign, truncated or non-contiguous file is not adopted: the log starts fresh and the
   * next publish replaces the file, so a restart can never serve a cursor from a history it
   * cannot actually recreate.
   */
  private restore(): void {
    const file = this.file;
    if (file === null) return;
    let raw: string | null;
    try {
      raw = this.disk.read(file);
    } catch (error) {
      this.reportPersistFailure(error);
      return;
    }
    if (raw === null || raw.length === 0) return;

    // A file that was fully written ends with a newline, so `split` leaves a trailing empty
    // string; anything in the last slot — empty or a partial line — is not a complete record.
    // Dropping it is what makes a crash mid-append cost at most the in-flight envelope: the
    // torn line is not adopted, and the file is marked for a rewrite so the next append cannot
    // run into the stump and fuse two records into one unparseable line.
    const complete = raw.endsWith("\n");
    const lines = raw.split("\n").slice(0, -1);
    const header = parseDurableHeader(lines[0]);
    if (header === null) return;

    this.currentGeneration = header;
    this.headerWritten = true;
    this.fileNeedsRewrite = !complete;
    // The walk anchors on whatever the first entry line is, not on seq 1: after a compaction
    // the file legitimately begins at the oldest retained seq, and that window is still a valid
    // resume point (a client older than it will be told it is outside the window).
    let expected: number | null = null;
    for (const line of lines.slice(1)) {
      const entry = parseDurableEntry(line);
      // Contiguity is required: a missing seq means the file is not this stream's uninterrupted
      // history, and resuming from it would silently skip whatever is missing.
      if (entry === null || (expected !== null && entry.seq !== expected)) {
        // There is a usable prefix followed by junk or a hole; keep the prefix and plan to
        // repair the file, or the next append would write behind the damage.
        this.fileNeedsRewrite = true;
        break;
      }
      expected = entry.seq + 1;
      this.retain(entry.seq, entry.payload);
    }
    this.nextSeq = expected ?? 1;

    this.durable = this.nextSeq - 1;
    // Count only the complete prefix: the torn remainder is not part of the file's future.
    const usable = complete ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
    this.fileBytes = Buffer.byteLength(usable, "utf8");
  }

  /**
   * Writes one envelope. The fast path is an append; the repair/compaction path replaces the
   * file with header + retained tail + this envelope (atomically, via temp file and rename).
   * Failure is contained: the live stream and the in-memory replay keep working, `durableCursor`
   * simply stops advancing, and the host is told once per burst.
   */
  private persist(seq: number, payload: string): void {
    const file = this.file;
    if (file === null) return;
    const line = `${JSON.stringify({ seq, payload })}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    try {
      if (!this.headerWritten || this.fileNeedsRewrite) {
        // A file we did not adopt (absent, foreign version, corrupt), or one we know carries a
        // torn tail/a hole, is replaced wholesale: appending in either case would produce a
        // file whose sequence numbers do not read back as an uninterrupted run.
        this.rewriteTail(seq, line);
      } else if (this.fileBytes + lineBytes > COCKPIT_EVENT_LOG_COMPACT_AT_BYTES) {
        this.rewriteTail(seq, line);
      } else {
        this.disk.append(file, line);
        this.fileBytes += lineBytes;
      }
      this.durable = seq;
      this.onPersistSuccess();
    } catch (error) {
      // The failed write may have left the file short, torn, or holding a partial record, and
      // this envelope was not acknowledged. Whatever the next successful publish is, it must
      // rewrite rather than append, or the hole would look like a contiguous history.
      this.fileNeedsRewrite = true;
      this.reportPersistFailure(error);
    }
  }

  /**
   * Replaces the file with header + retained tail + the in-flight envelope. The envelope is
   * taken from `line` only when it is absent from the retained tail — an envelope too large to
   * retain is never in `entries`, but its sequence number must still exist on disk or restore
   * would stop one before it and call that the end of the stream.
   */
  private rewriteTail(seq: number, line: string): void {
    const file = this.file;
    if (file === null) return;
    const retained = this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const newest = this.entries[this.entries.length - 1]?.seq;
    const body = `${this.headerLine()}${retained}${newest === seq ? "" : line}`;
    this.disk.replace(file, body);
    this.headerWritten = true;
    this.fileNeedsRewrite = false;
    this.fileBytes = Buffer.byteLength(body, "utf8");
  }

  private onPersistSuccess(): void {
    // A success ends the burst, so the next failure is reported again instead of being
    // swallowed as "the same one as before".
    this.persistErrorReported = false;
  }

  private reportPersistFailure(error: unknown): void {
    this.persistErrors += 1;
    if (this.persistErrorReported) return;
    this.persistErrorReported = true;
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.onPersistError?.(normalized);
    } catch {
      // A failing reporter must not take the log down with it: this runs from inside error paths.
    }
  }
}

function parseDurableHeader(line: string | undefined): string | null {
  try {
    const parsed = JSON.parse(line ?? "") as {
      type?: unknown;
      version?: unknown;
      generation?: unknown;
    };
    if (parsed?.type !== "cockpit_stream_header") return null;
    if (parsed.version !== COCKPIT_EVENT_LOG_FILE_VERSION) return null;
    return typeof parsed.generation === "string" && parsed.generation.length > 0
      ? parsed.generation
      : null;
  } catch {
    return null;
  }
}

function parseDurableEntry(line: string): CockpitLogEntry | null {
  try {
    const parsed = JSON.parse(line) as { seq?: unknown; payload?: unknown };
    if (typeof parsed?.seq !== "number" || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1) {
      return null;
    }
    if (typeof parsed.payload !== "string") return null;
    return { seq: parsed.seq, payload: parsed.payload };
  } catch {
    return null;
  }
}
