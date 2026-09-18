/**
 * Speculative rollback & commit ledger.
 *
 * When a drafted window is rejected at position i, every piece of state derived from
 * tokens i..γ is invalid: the draft's own autoregressive continuation, the KV cache
 * entries those tokens wrote, the stream's sequence length, and any downstream
 * telemetry that counted them. Production engines do this in `specUpdate` /
 * `advanceLinearCacheBlockTable` on the device; here the same invariants are held in
 * a token-level ledger so the bookkeeping can be exercised and verified without a GPU.
 *
 * The ledger is the single source of truth for "which tokens are committed". A
 * speculative suffix is only promoted into the committed prefix once the target has
 * verified it, and a rejection truncates the suffix back to the last verified
 * checkpoint — never into it.
 */

export interface RollbackSnapshot {
  /** Committed prefix length at the time of the snapshot. */
  readonly committedLength: number;
  /** Speculative suffix length pending verification. */
  readonly pendingLength: number;
  /** Highest position that has written cache state. */
  readonly cacheHighWaterMark: number;
  /** Monotonic epoch; bumps on every truncation so stale handles are detectable. */
  readonly epoch: number;
}

export interface TruncationRecord {
  /** Position rolled back to (exclusive end of the surviving prefix). */
  readonly rolledBackTo: number;
  /** Number of speculative tokens discarded. */
  readonly discardedTokens: number;
  /** Number of cache slots released. */
  readonly releasedCacheSlots: number;
  /** Epoch before the truncation. */
  readonly previousEpoch: number;
  /** Epoch after the truncation. */
  readonly epoch: number;
  /** Why the suffix was discarded. */
  readonly reason: "rejection" | "divergence" | "budget-exceeded" | "stream-cancelled";
}

/**
 * Token-level KV cache bookkeeping. Slots are written by speculative positions and
 * released wholesale on rollback — a partial release would leave the attention keys
 * of surviving tokens pointing at stale pages.
 */
export interface CacheSlotLedger {
  /** Slots currently reserved by speculative positions. */
  reserved: number;
  /** Total slots ever released by rollback (for leak detection). */
  releasedTotal: number;
  /** High-water mark of slot usage. */
  highWaterMark: number;
}

export class SpeculativeRollback {
  private committedTokens: number[] = [];
  private pendingTokens: number[] = [];
  private cacheHighWaterMark = 0;
  private epoch = 0;
  private readonly ledger: CacheSlotLedger = { reserved: 0, releasedTotal: 0, highWaterMark: 0 };
  private readonly truncations: TruncationRecord[] = [];
  private cancelled = false;

  /** Total tokens visible to a consumer: committed + optimistically shown pending. */
  get length(): number {
    return this.committedTokens.length + this.pendingTokens.length;
  }

  /** Tokens the target model has verified. */
  get committedLength(): number {
    return this.committedTokens.length;
  }

  /** Tokens awaiting verification. */
  get pendingLength(): number {
    return this.pendingTokens.length;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Monotonic version; a handle captured before a truncation is stale afterwards. */
  get currentEpoch(): number {
    return this.epoch;
  }

  snapshot(): RollbackSnapshot {
    return {
      committedLength: this.committedTokens.length,
      pendingLength: this.pendingTokens.length,
      cacheHighWaterMark: this.cacheHighWaterMark,
      epoch: this.epoch,
    };
  }

  /** Appends a speculative suffix produced by a draft round. */
  stagePending(tokenIds: readonly number[]): void {
    if (this.cancelled) throw new Error("Cannot stage pending tokens on a cancelled stream");
    this.pendingTokens.push(...tokenIds);
    this.ledger.reserved += tokenIds.length;
    this.ledger.highWaterMark = Math.max(this.ledger.highWaterMark, this.ledger.reserved);
    this.cacheHighWaterMark = this.length;
  }

  /**
   * Promotes a verified prefix of the pending suffix into the committed prefix.
   * `verifiedLength` counts accepted draft tokens; the bonus token the target emits
   * on full acceptance is appended by `appendCommitted` by the caller.
   */
  commit(verifiedLength: number): void {
    if (verifiedLength < 0) return;
    const take = Math.min(verifiedLength, this.pendingTokens.length);
    const promoted = this.pendingTokens.splice(0, take);
    this.committedTokens.push(...promoted);
    this.ledger.reserved = Math.max(0, this.ledger.reserved - take);
    this.cacheHighWaterMark = this.length;
  }

  /** Appends already-verified tokens directly (target-only fallback after rejection). */
  appendCommitted(tokenIds: readonly number[]): void {
    this.committedTokens.push(...tokenIds);
    this.cacheHighWaterMark = this.length;
  }

  /**
   * Discards the speculative suffix from `firstRejection` onward and rewinds the
   * cache to the last verified position. The committed prefix is never shortened —
   * verified tokens are immutable.
   *
   * @returns the truncation record, or null when there was nothing to discard
   */
  rollback(
    firstRejection: number,
    reason: TruncationRecord["reason"] = "rejection",
  ): TruncationRecord | null {
    const absolutePosition = this.committedTokens.length + firstRejection;
    const discardFrom = Math.max(
      this.committedTokens.length,
      Math.min(absolutePosition, this.length),
    );
    // Both counts are taken before the mutation: afterwards `this.length` already
    // describes the post-rollback state and the delta would read as zero.
    const discarded = this.length - discardFrom;
    const released = discarded;
    if (discarded <= 0) return null;

    const previousEpoch = this.epoch;
    this.pendingTokens = this.pendingTokens.slice(
      0,
      Math.max(0, discardFrom - this.committedTokens.length),
    );
    this.ledger.reserved = Math.max(0, this.ledger.reserved - released);
    this.ledger.releasedTotal += released;
    this.cacheHighWaterMark = this.length;
    this.epoch += 1;

    const record: TruncationRecord = {
      rolledBackTo: discardFrom,
      discardedTokens: discarded,
      releasedCacheSlots: released,
      previousEpoch,
      epoch: this.epoch,
      reason,
    };
    this.truncations.push(record);
    return record;
  }

  /** Full rewind of the unverified suffix (stream cancelled or budget exhausted). */
  rollbackAll(reason: TruncationRecord["reason"] = "stream-cancelled"): TruncationRecord | null {
    if (this.pendingTokens.length === 0) return null;
    // Position 0 of the pending window: everything staged and unverified goes away.
    // Passing the committed length here would discard only the tail past the prefix.
    return this.rollback(0, reason);
  }

  cancel(): void {
    this.rollbackAll("stream-cancelled");
    this.cancelled = true;
  }

  /** Surviving committed token ids. */
  committed(): number[] {
    return [...this.committedTokens];
  }

  /** The optimistic full sequence (committed + pending). */
  sequence(): number[] {
    return [...this.committedTokens, ...this.pendingTokens];
  }

  /** All truncations recorded on this stream, in order. */
  truncationHistory(): readonly TruncationRecord[] {
    return this.truncations;
  }

  /**
   * Leak check: every reserved slot must have been released by the time a stream
   * finishes. A positive balance means cache pages were orphaned by the speculative
   * path — the exact bug the device-side `specUpdate` bookkeeping exists to prevent.
   */
  cacheBalance(): { reserved: number; releasedTotal: number; leaked: number } {
    return {
      reserved: this.ledger.reserved,
      releasedTotal: this.ledger.releasedTotal,
      leaked: this.ledger.reserved,
    };
  }

  /**
   * Replays a checkpoint captured before a truncation and asserts it is still valid.
   * Returns false when the epoch has moved on, i.e. the snapshot describes state that
   * a rollback has since invalidated.
   */
  validateSnapshot(snapshot: RollbackSnapshot): boolean {
    if (snapshot.epoch !== this.epoch) return false;
    return (
      snapshot.committedLength === this.committedTokens.length &&
      snapshot.pendingLength === this.pendingTokens.length
    );
  }
}

/**
 * Multi-stream rollback coordinator. In a batched engine each stream has its own
 * suffix and its own acceptance length; a per-round rollback must be applied
 * stream-locally without disturbing neighbouring streams' page tables. This keeps
 * the per-stream ledgers and reports the batch-wide discard accounting.
 */
export class BatchRollbackCoordinator {
  private readonly streams = new Map<string, SpeculativeRollback>();

  register(streamId: string): SpeculativeRollback {
    let stream = this.streams.get(streamId);
    if (!stream) {
      stream = new SpeculativeRollback();
      this.streams.set(streamId, stream);
    }
    return stream;
  }

  get(streamId: string): SpeculativeRollback | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Drops a stream's ledger. Called after the stream is closed and its pending suffix
   * rolled back: leaving the ledger behind would make `get`/`leakReport` account for a
   * stream that no longer exists, and a later re-registration would silently reuse the
   * old ledger's committed prefix.
   */
  forget(streamId: string): void {
    this.streams.delete(streamId);
  }

  /** Applies one round of per-stream acceptance lengths, returning batch accounting. */
  applyRound(
    results: ReadonlyArray<{
      streamId: string;
      acceptedLength: number;
      firstRejection: number;
      allAccepted: boolean;
      bonusToken?: number;
      committedTokens?: number[];
    }>,
  ): {
    readonly committedTotal: number;
    readonly discardedTotal: number;
    readonly releasedSlots: number;
    readonly rolledBackStreams: number;
  } {
    let committedTotal = 0;
    let discardedTotal = 0;
    let releasedSlots = 0;
    let rolledBackStreams = 0;

    for (const result of results) {
      const stream = this.streams.get(result.streamId);
      if (!stream) continue;

      if (result.allAccepted) {
        // Full acceptance: promote the window, then the target's bonus token.
        stream.commit(result.acceptedLength);
        if (result.bonusToken !== undefined && result.bonusToken >= 0)
          stream.appendCommitted([result.bonusToken]);
        committedTotal +=
          result.acceptedLength +
          (result.bonusToken !== undefined && result.bonusToken >= 0 ? 1 : 0);
        continue;
      }

      // Partial acceptance: the unverified suffix must be discarded *before* the
      // accepted prefix is promoted, because the rollback position is measured from
      // the start of the pending window — committing first would shift the window and
      // undercount what was discarded.
      const record = stream.rollback(result.firstRejection);
      if (record) {
        discardedTotal += record.discardedTokens;
        releasedSlots += record.releasedCacheSlots;
        rolledBackStreams += 1;
      }
      if (result.acceptedLength > 0) stream.commit(result.acceptedLength);
      const fallback = result.committedTokens ?? [];
      if (fallback.length > 0) stream.appendCommitted(fallback);
      committedTotal += result.acceptedLength + fallback.length;
    }

    return { committedTotal, discardedTotal, releasedSlots, rolledBackStreams };
  }

  /**
   * Batch-wide leak check: asserts every stream released all speculative cache slots.
   * Used as the invariant that a round leaves no orphaned pages.
   */
  leakReport(): { streams: number; leaked: number; clean: boolean } {
    let leaked = 0;
    for (const stream of this.streams.values()) {
      leaked += stream.cacheBalance().leaked;
    }
    return { streams: this.streams.size, leaked, clean: leaked === 0 };
  }
}
