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
 */

import { randomUUID } from "node:crypto";

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
  private currentGeneration = randomUUID();
  /** Sequence of the next envelope to be published. Starts at 1 so 0 can mean "never seen any". */
  private nextSeq = 1;
  private entries: CockpitLogEntry[] = [];
  private chars = 0;
  private bytes = 0;

  /** The most recently published sequence number; 0 before anything has been published. */
  get cursor(): number {
    return this.nextSeq - 1;
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
    return seq;
  }

  /** Builds and retains the exact stamped envelope that live clients will receive. */
  publishStamped(makePayload: (seq: number) => string): CockpitLogEntry {
    const seq = this.nextSeq++;
    const payload = makePayload(seq);
    this.retain(seq, payload);
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
  }
}
