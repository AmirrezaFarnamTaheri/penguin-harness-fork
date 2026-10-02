/**
 * ACP resume — bounded replay, monotonic cursors and duplicate-safe reconnects.
 *
 * The transport in ./acp.js already gives a failed connection a second life
 * (`reattachTransport`), but it deliberately does NOT replay: it rejects the in-flight
 * requests of the previous generation and lets the caller decide what is safe to repeat.
 * This module is the caller's tool. It owns the *record stream*, which outlives individual
 * transports, so a reconnect converges either by bounded replay or by an explicit fresh
 * snapshot — never by silently continuing from wherever retention happens to start.
 *
 * ## Units and identity (the contract)
 *
 * - **Record**: one outbound JSON-RPC line. Replay is line-based, so a replayed batch is
 *   byte-for-byte what the peer would have received the first time.
 * - **`streamId`**: identity of the logical stream, chosen by the side that produces
 *   records and stable across transport replacements. A cursor is only ever valid against
 *   the stream that issued it; a cursor naming another stream is refused. That is also
 *   what keeps ACP cursors from being confused with any other cursor space — the cockpit's
 *   SSE cursor (E4) is a different space entirely, and there is no conversion between them.
 * - **`seq`**: 1-based, strictly increasing by exactly 1 per record, and NEVER reset for a
 *   new transport generation. The unit is records — not bytes, not milliseconds.
 * - **`generation`**: the transport epoch from `AcpConnection.reattachTransport()`. It is
 *   recorded per record for diagnostics (which socket carried it) and is deliberately NOT
 *   part of the cursor: the consumer's position in the stream must not depend on the socket
 *   that happened to deliver the bytes.
 *
 * ## Retention, acknowledgements and expiry
 *
 * The log retains at most `maxRecords` records and `maxBytes` UTF-8 bytes (defaults 512 and
 * 2 MiB). Acknowledged records are dropped immediately — an ack is processing evidence, so
 * re-sending them would only manufacture duplicates.
 *
 * Eviction of *unacknowledged* records is real loss, and it is never silent: the log counts
 * every evicted record (`droppedRecords`), remembers the highest seq it evicted
 * (`droppedBeforeSeq`), and answers any resume whose cursor fell at or below that watermark
 * with `fresh`/`expired`. The caller then asks for an authoritative snapshot instead of
 * receiving a suffix that would look continuous. A single record larger than `maxBytes` can
 * never be retained and is dropped the same way, at once.
 *
 * Ack timing belongs to the consumer: acknowledge once 64 records are pending or every
 * 250 ms, whichever comes first, and always immediately before a reconnect. Acks are
 * monotonic per stream — an ack that would regress the watermark, exceed the newest seq we
 * produced, or name another stream is refused without changing any state.
 *
 * ## Duplicate suppression
 *
 * A resume always replays from `max(cursor.seq, ackedSeq) + 1`, so acknowledged records are
 * never re-sent; how many were skipped for that reason is *reported* on the plan
 * (`skippedAcknowledged`) rather than silently absorbed. Records the consumer might have
 * received but never acknowledged are re-sent on purpose — a duplicate is cheap, a skipped
 * record is loss — and the consumer suppresses the exact duplicates it already delivered.
 *
 * The consumer's watermark only moves on contiguous delivery. A jump forward is reported as
 * `gap` and leaves the watermark where it was, so an ack can never claim processing of a
 * record that was never received; recovering from a gap is an explicit `resync` against an
 * authoritative position (a fresh snapshot), which refuses to regress.
 */

import { utf8Length } from "./acp.js";

/** A position in one ACP record stream: `streamId` scopes it, `seq` orders it. */
export interface AcpStreamCursor {
  readonly streamId: string;
  readonly seq: number;
}

/** One retained record, annotated with the transport generation that produced it. */
export interface AcpReplayRecord {
  readonly cursor: AcpStreamCursor;
  readonly generation: number;
  readonly line: string;
  readonly bytes: number;
}

/** Why a resume could not replay: the caller must obtain an authoritative snapshot. */
export type AcpResumeFreshReason =
  /** The consumer has no position yet (first attach). */
  | "no-cursor"
  /** The cursor belongs to a different stream; mixing streams is never allowed. */
  | "unknown-stream"
  /** The cursor is below the retention window: records between it and the window were evicted. */
  | "expired"
  /** The cursor is ahead of anything this log produced, or malformed. */
  | "unknown-cursor";

/** The producer's answer to a resume request. */
export type AcpResumePlan =
  | {
      readonly kind: "replay";
      readonly streamId: string;
      /** The position replay starts after; `records` are exactly `from + 1 .. newestSeq`. */
      readonly from: number;
      readonly records: readonly AcpReplayRecord[];
      /** Records below the cursor that were skipped because the consumer already acked them. */
      readonly skippedAcknowledged: number;
    }
  | {
      readonly kind: "fresh";
      readonly streamId: string;
      readonly reason: AcpResumeFreshReason;
      readonly acknowledgedThrough: number;
      readonly droppedRecords: number;
    };

/** Default record-count retention bound. */
export const ACP_REPLAY_MAX_RECORDS = 512;
/** Default byte retention bound (UTF-8 bytes of the retained lines). */
export const ACP_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** The consumer acknowledges at least this often, in records. */
export const ACP_ACK_EVERY_RECORDS = 64;
/** The consumer also acknowledges on this interval, so a quiet stream still advances. */
export const ACP_ACK_INTERVAL_MS = 250;
/** Reconnect ladder: base delay before attempt 1. */
export const ACP_RECONNECT_BASE_MS = 1_000;
/** Reconnect ladder: ceiling, jitter included. */
export const ACP_RECONNECT_MAX_MS = 30_000;

export interface AcpReplayLogOptions {
  streamId: string;
  /** Maximum retained records; must be a positive safe integer. */
  maxRecords?: number;
  /** Maximum retained bytes; must be a positive safe integer. */
  maxBytes?: number;
}

function requirePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function isCursor(value: unknown): value is AcpStreamCursor {
  if (value === null || typeof value !== "object") return false;
  const cursor = value as { streamId?: unknown; seq?: unknown };
  return (
    typeof cursor.streamId === "string" &&
    typeof cursor.seq === "number" &&
    Number.isSafeInteger(cursor.seq) &&
    cursor.seq >= 0
  );
}

/**
 * Producer side: retains the tail of one record stream, tracks the consumer's
 * acknowledgement, and answers resume requests with either a bounded replay or an explicit
 * fresh-snapshot request.
 */
export class AcpReplayLog {
  readonly streamId: string;
  readonly maxRecords: number;
  readonly maxBytes: number;

  private readonly records: AcpReplayRecord[] = [];
  private retainedByteCount = 0;
  private nextSeq = 1;
  private acked = 0;
  private evicted = 0;
  private evictedThrough = 0;

  constructor(options: AcpReplayLogOptions) {
    this.streamId = options.streamId;
    this.maxRecords = requirePositiveInteger(
      options.maxRecords,
      ACP_REPLAY_MAX_RECORDS,
      "maxRecords",
    );
    this.maxBytes = requirePositiveInteger(options.maxBytes, ACP_REPLAY_MAX_BYTES, "maxBytes");
  }

  /** Highest seq produced so far; 0 before the first record. */
  get newestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Highest seq the consumer has acknowledged; 0 before the first ack. */
  get ackedSeq(): number {
    return this.acked;
  }

  /** Lowest seq still retained, or null when nothing is retained. */
  get oldestRetainedSeq(): number | null {
    return this.records[0]?.cursor.seq ?? null;
  }

  get retainedRecords(): number {
    return this.records.length;
  }

  get retainedBytes(): number {
    return this.retainedByteCount;
  }

  /** Unacknowledged records evicted to stay inside the bounds — real, counted loss. */
  get droppedRecords(): number {
    return this.evicted;
  }

  /** Highest evicted seq; a resume at or below it cannot be served. */
  get droppedBeforeSeq(): number {
    return this.evictedThrough;
  }

  /**
   * Appends one record and returns its cursor. `retained: false` means the record was
   * larger than `maxBytes` (or retention could not hold it) and will therefore never be
   * replayable — it is dropped immediately and counted, not buffered and forgotten.
   */
  append(line: string, generation = 1): { cursor: AcpStreamCursor; retained: boolean } {
    const seq = this.nextSeq++;
    const cursor: AcpStreamCursor = { streamId: this.streamId, seq };
    const bytes = utf8Length(line);

    if (bytes > this.maxBytes) {
      // Cannot be retained at all: drop it now so `resume` reports the loss instead of
      // handing the consumer a suffix across a hole.
      this.evicted += 1;
      this.evictedThrough = seq;
      return { cursor, retained: false };
    }

    this.records.push({ cursor, generation, line, bytes });
    this.retainedByteCount += bytes;
    this.evictToBounds();
    return { cursor, retained: this.records.at(-1)?.cursor.seq === seq };
  }

  /**
   * Advances the acknowledgement watermark and drops the records it covers. Returns false —
   * changing nothing — for an ack naming another stream, a position we never produced, or
   * one that would regress the watermark.
   */
  acknowledge(cursor: AcpStreamCursor): boolean {
    if (!isCursor(cursor) || cursor.streamId !== this.streamId) return false;
    if (cursor.seq > this.newestSeq || cursor.seq <= this.acked) return false;
    this.acked = cursor.seq;
    while (this.records.length > 0 && this.records[0]!.cursor.seq <= this.acked) {
      this.retainedByteCount -= this.records.shift()!.bytes;
    }
    return true;
  }

  /**
   * Answers a resume request. `null` means "first attach" and yields `fresh`/`no-cursor`;
   * anything the caller passes must be one of this log's own cursors, or the request is
   * refused rather than approximated.
   */
  resume(from: AcpStreamCursor | null): AcpResumePlan {
    if (from === null) return this.fresh("no-cursor");
    if (!isCursor(from)) return this.fresh("unknown-cursor");
    if (from.streamId !== this.streamId) return this.fresh("unknown-stream");
    if (from.seq > this.newestSeq) return this.fresh("unknown-cursor");

    // A cursor behind the ack is legitimate: the ack is processing evidence, so those
    // records are skipped as duplicates and the skip is reported.
    const skippedAcknowledged = Math.max(0, this.acked - from.seq);
    const startAfter = Math.max(from.seq, this.acked);
    // Loss inside the window is expiry, even when the cursor itself is still above the ack.
    if (startAfter < this.evictedThrough) return this.fresh("expired");

    const records = this.records.filter((record) => record.cursor.seq > startAfter);
    return {
      kind: "replay",
      streamId: this.streamId,
      from: startAfter,
      records,
      skippedAcknowledged,
    };
  }

  private fresh(reason: AcpResumeFreshReason): AcpResumePlan {
    return {
      kind: "fresh",
      streamId: this.streamId,
      reason,
      acknowledgedThrough: this.acked,
      droppedRecords: this.evicted,
    };
  }

  private evictToBounds(): void {
    while (this.records.length > this.maxRecords || this.retainedByteCount > this.maxBytes) {
      const evicted = this.records.shift();
      if (!evicted) return;
      this.retainedByteCount -= evicted.bytes;
      this.evicted += 1;
      this.evictedThrough = evicted.cursor.seq;
    }
  }
}

/** What happened to one record handed to the consumer. */
export type AcpDeliveryOutcome =
  /** Contiguous with what was delivered before (or the first record). */
  | "accepted"
  /** Already delivered: suppressed, watermark unchanged. */
  | "duplicate"
  /** Ahead of the watermark by more than one: records were lost; resync is required. */
  | "gap"
  /** Belongs to another stream. */
  | "foreign";

export interface AcpResumeConsumerOptions {
  /** Ack at least every N delivered records (default {@link ACP_ACK_EVERY_RECORDS}). */
  ackEveryRecords?: number;
  /** Ack on this interval too (default {@link ACP_ACK_INTERVAL_MS}); 0 disables the timer. */
  ackIntervalMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Consumer side: tracks the position in one stream, suppresses duplicates, refuses to
 * advance across a gap, and decides when to acknowledge.
 */
export class AcpResumeConsumer {
  readonly streamId: string;
  readonly ackEveryRecords: number;
  readonly ackIntervalMs: number;

  private readonly now: () => number;
  private delivered = 0;
  private acked = 0;
  private lastAckAt: number;

  constructor(streamId: string, options: AcpResumeConsumerOptions = {}) {
    this.streamId = streamId;
    this.ackEveryRecords = requirePositiveInteger(
      options.ackEveryRecords,
      ACP_ACK_EVERY_RECORDS,
      "ackEveryRecords",
    );
    const interval = options.ackIntervalMs ?? ACP_ACK_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 0) {
      throw new RangeError("ackIntervalMs must be a non-negative safe integer");
    }
    this.ackIntervalMs = interval;
    this.now = options.now ?? (() => Date.now());
    this.lastAckAt = this.now();
  }

  /** Highest seq delivered so far; 0 before the first record. */
  get deliveredSeq(): number {
    return this.delivered;
  }

  /** Highest seq acknowledged so far. */
  get ackedSeq(): number {
    return this.acked;
  }

  /** Delivered-but-unacknowledged records. */
  get pendingRecords(): number {
    return this.delivered - this.acked;
  }

  /** The cursor to hand to the producer on reconnect, or null before the first record. */
  get lastDelivered(): AcpStreamCursor | null {
    return this.delivered === 0 ? null : { streamId: this.streamId, seq: this.delivered };
  }

  /**
   * Accepts one delivered record. A jump forward is a gap and does NOT move the watermark:
   * acknowledging past a record that was never received would manufacture evidence.
   */
  receive(cursor: AcpStreamCursor): AcpDeliveryOutcome {
    if (!isCursor(cursor) || cursor.streamId !== this.streamId) return "foreign";
    if (cursor.seq <= this.delivered) return "duplicate";
    if (cursor.seq > this.delivered + 1) return "gap";
    this.delivered = cursor.seq;
    return "accepted";
  }

  /**
   * Adopts an authoritative position (after a fresh snapshot). Refuses a foreign stream and
   * refuses to regress, so a stale snapshot cannot rewind the consumer into replaying
   * records it has already processed.
   */
  resync(cursor: AcpStreamCursor): boolean {
    if (!isCursor(cursor) || cursor.streamId !== this.streamId) return false;
    if (cursor.seq < this.delivered) return false;
    this.delivered = cursor.seq;
    this.acked = cursor.seq;
    this.lastAckAt = this.now();
    return true;
  }

  /** Acknowledges everything delivered, unconditionally. Returns the cursor sent, if any. */
  acknowledge(): AcpStreamCursor | null {
    if (this.delivered <= this.acked) return null;
    const cursor: AcpStreamCursor = { streamId: this.streamId, seq: this.delivered };
    this.acked = this.delivered;
    this.lastAckAt = this.now();
    return cursor;
  }

  /**
   * Applies the ack policy: N pending records or the interval elapsed, whichever comes
   * first. Returns the cursor to send, or null while neither condition holds.
   */
  maybeAcknowledge(now = this.now()): AcpStreamCursor | null {
    if (this.delivered <= this.acked) return null;
    if (this.pendingRecords < this.ackEveryRecords) {
      if (this.ackIntervalMs <= 0 || now - this.lastAckAt < this.ackIntervalMs) return null;
    }
    return this.acknowledge();
  }
}

/**
 * What the UI surface needs to render after a reconnect. Mapped from the producer's plan
 * (or from the consumer's own gap observation) so the two never disagree about whether a
 * number is knowable:
 *
 * - `behind` carries a count ONLY when a replay actually delivered that many records;
 * - `resync` means an authoritative snapshot is loading and no count is shown at all,
 *   because a gap's true size is unknowable to this side (dropped and acked records are
 *   indistinguishable in the tail we can see) — inventing one is the failure this type
 *   exists to prevent;
 * - `live` means nothing is missing.
 */
export type AcpResumeBanner =
  | { readonly state: "live" }
  | { readonly state: "behind"; readonly eventsBehind: number }
  | { readonly state: "resync" };

/** Maps a resume plan, or the consumer's `gap` outcome, onto the banner state. */
export function acpResumeBanner(input: AcpResumePlan | { kind: "gap" }): AcpResumeBanner {
  if (input.kind === "fresh" || input.kind === "gap") return { state: "resync" };
  return input.records.length === 0
    ? { state: "live" }
    : { state: "behind", eventsBehind: input.records.length };
}

/**
 * Delay before ACP reconnect attempt N (1-based), mirroring the repository's reconnect
 * ladder (`reconnectDelayMs` in engine/context-engine.ts): `min(base × 2^(N−1), max)` plus
 * a seed-derived jitter of up to 50%, re-clamped to the ceiling so total patience does not
 * drift. The mixing is the same FNV-style integer mix, and the seed is a counter rather than
 * a clock so two consumers with different seeds spread out while one consumer's ladder
 * stays reproducible in tests.
 *
 * It is mirrored rather than imported because this file is part of the zero-dependency
 * kernel subpath: pulling in the engine would drag the SDK into every browser bundle that
 * wants the transport. The formula is the shared contract; keep the two in step.
 */
export function acpReconnectDelayMs(attempt: number, seed = 0): number {
  const ladder = Math.min(
    ACP_RECONNECT_BASE_MS * 2 ** (Math.max(1, attempt) - 1),
    ACP_RECONNECT_MAX_MS,
  );
  const mixed = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(attempt, 0xc2b2ae35)) >>> 0;
  const jitter = (mixed % 1000) / 1000; // 0 .. 0.999
  return Math.min(ACP_RECONNECT_MAX_MS, Math.round(ladder * (1 + 0.5 * jitter)));
}
