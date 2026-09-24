import { randomUUID, createHash } from "node:crypto";

export type TurnStatus = "queued" | "running" | "completed" | "interrupted" | "failed";

export function isTerminalStatus(status: TurnStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

export interface Envelope {
  schemaVersion: number;
  sessionId: string;
  turnId: string;
  seq: number;
  kind: "turn_status" | "text" | "reasoning" | "tool_dispatch" | "tool_result" | "turn_done";
  status: TurnStatus;
  createdAt: number;
  itemId?: string;
  attemptId?: string;
  runtimeEpoch?: string;
  submissionId?: string;
  payload?: unknown;
  transcriptRevision?: number;
  transcriptDigest?: string;
}

export interface TerminalSummary {
  turnId: string;
  terminalSeq: number;
  status: TurnStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome?: string;
  transcriptRevision?: number;
  transcriptDigest?: string;
}

export interface ReplayView {
  events: Envelope[];
  floorSeq: number;
  latestSeq: number;
  nextAfterSeq: number;
  hasMore: boolean;
  resetRequired: boolean;
  transcriptRevision?: number;
  transcriptDigest?: string;
}

export interface PendingProjection {
  turnId: string;
  status: TurnStatus;
  events: Envelope[];
}

export interface TurnLedgerMetrics {
  rawEvents: number;
  streamRecords: number;
  replayEvents: number;
  replayResets: number;
  compactions: number;
  acknowledgedTurns: number;
  /**
   * Appends that landed while `records` was already past `maxRecords`. Zero while the ledger
   * honors its bound; each append past the bound adds one. It is a count of overflow *events*,
   * not a high-water mark — `trimRecords` deliberately keeps the records a lagging projection
   * still needs, so this is the size of that deliberate overshoot, and it drops back toward
   * zero as `compact` drains them.
   */
  overflowEvents: number;
}

export interface TurnLedgerOptions {
  maxReplayPageSize?: number;
  maxRecords?: number;
  maxSummaries?: number;
}

/**
 * TurnLedger manages an in-memory, ordered lifecycle ledger for turns and events within an active session.
 * Note: TurnLedger is retained in process memory for the lifetime of the session/runtime; it provides sequence
 * allocation, bounded paged replay, terminal summaries, and projection acknowledgement during process execution,
 * but does not persist across process restarts unless serialized to an external store.
 */
export class TurnLedger {
  public static readonly SCHEMA_VERSION = 2;

  public readonly sessionId: string;
  private readonly maxReplayPageSize: number;
  private readonly maxRecords: number;
  private readonly maxSummaries: number;

  private nextSeq = 1;
  private activeTurnId: string | null = null;
  private currentStatus: TurnStatus = "queued";
  private isTerminal = false;
  private turnStartSeq = 0;
  private turnStartedAt = 0;

  private records: Envelope[] = [];
  private summaries: TerminalSummary[] = [];
  private projectionAcks = new Map<string, number>();
  private compactedThroughSeq = 0;
  private projectionCommittedThroughSeq = 0;

  private transcriptRevision = 0;
  private transcriptDigest = "";
  private runtimeEpoch = "";
  private submissionId = "";

  public readonly metrics: TurnLedgerMetrics = {
    rawEvents: 0,
    streamRecords: 0,
    replayEvents: 0,
    replayResets: 0,
    compactions: 0,
    acknowledgedTurns: 0,
    overflowEvents: 0,
  };

  constructor(sessionId: string, options: TurnLedgerOptions = {}) {
    this.sessionId = sessionId;
    this.maxReplayPageSize = Math.max(1, options.maxReplayPageSize ?? 512);
    this.maxRecords = Math.max(1, options.maxRecords ?? 5000);
    this.maxSummaries = Math.max(1, options.maxSummaries ?? 1000);
  }

  public begin(submissionId = "", runtimeEpoch = ""): string {
    if (this.activeTurnId !== null && !this.isTerminal) {
      throw new Error(`Turn '${this.activeTurnId}' is still active and not in terminal state`);
    }

    const turnId = `turn-${randomUUID().slice(0, 12)}`;
    this.activeTurnId = turnId;
    this.currentStatus = "queued";
    this.isTerminal = false;
    this.turnStartSeq = this.nextSeq;
    this.turnStartedAt = Date.now();
    this.submissionId = submissionId;
    this.runtimeEpoch = runtimeEpoch;

    return turnId;
  }

  public getActiveTurnId(): string | null {
    return this.isTerminal ? null : this.activeTurnId;
  }

  public getStatus(): TurnStatus {
    return this.currentStatus;
  }

  public getLatestSequence(): number {
    return this.nextSeq === 1 ? 0 : this.nextSeq - 1;
  }

  public setTranscriptSnapshot(revision: number, digest?: string): void {
    this.transcriptRevision = revision;
    this.transcriptDigest =
      digest ?? createHash("sha256").update(String(revision)).digest("hex").slice(0, 16);
  }

  public append(
    kind: Envelope["kind"],
    payload?: unknown,
    newStatus?: TurnStatus,
    itemId?: string,
    attemptId?: string,
  ): Envelope {
    if (!this.activeTurnId) {
      throw new Error("Cannot append event when no turn is active");
    }
    if (this.isTerminal) {
      throw new Error(`Cannot append to completed turn '${this.activeTurnId}'`);
    }

    const targetStatus = newStatus ?? this.currentStatus;
    this.validateStatusTransition(this.currentStatus, targetStatus);
    this.currentStatus = targetStatus;

    const seq = this.nextSeq++;
    const now = Date.now();

    const env: Envelope = {
      schemaVersion: TurnLedger.SCHEMA_VERSION,
      sessionId: this.sessionId,
      turnId: this.activeTurnId,
      seq,
      kind,
      status: this.currentStatus,
      createdAt: now,
      itemId,
      attemptId,
      runtimeEpoch: this.runtimeEpoch,
      submissionId: this.submissionId,
      payload,
      transcriptRevision: this.transcriptRevision,
      transcriptDigest: this.transcriptDigest,
    };

    this.records.push(env);
    this.metrics.rawEvents++;

    if (kind === "text" || kind === "reasoning") {
      this.metrics.streamRecords++;
    }

    // Bound in-memory records to prevent heap leaks during long-running sessions.
    this.trimRecords();

    if (isTerminalStatus(this.currentStatus)) {
      this.isTerminal = true;
      const durationMs = Math.max(0, now - this.turnStartedAt);
      this.summaries.push({
        turnId: this.activeTurnId,
        terminalSeq: seq,
        status: this.currentStatus,
        startedAt: this.turnStartedAt,
        finishedAt: now,
        durationMs,
        outcome: typeof payload === "string" ? payload : undefined,
        transcriptRevision: this.transcriptRevision,
        transcriptDigest: this.transcriptDigest,
      });
      if (this.summaries.length > this.maxSummaries) {
        this.summaries.splice(0, this.summaries.length - this.maxSummaries);
      }
    }

    return env;
  }

  public acknowledgeProjection(turnId: string): void {
    const summary = this.summaries.find((s) => s.turnId === turnId);
    if (!summary) {
      throw new Error(`Turn '${turnId}' does not have a durable terminal record`);
    }

    if (!this.projectionAcks.has(turnId)) {
      this.metrics.acknowledgedTurns++;
    }
    this.projectionAcks.set(turnId, summary.terminalSeq);
    this.advanceProjectionWatermark();
  }

  /**
   * Advance the projection watermark only through a contiguous prefix of acknowledged turns.
   * A later turn may be projected before an earlier one; that gap must keep the earlier replay
   * records durable until the lagging projection catches up.
   */
  private advanceProjectionWatermark(): void {
    let watermark = this.compactedThroughSeq;

    for (const summary of this.summaries) {
      if (summary.terminalSeq <= watermark) {
        continue;
      }
      const acknowledgedSeq = this.projectionAcks.get(summary.turnId);
      if (acknowledgedSeq === undefined || acknowledgedSeq < summary.terminalSeq) {
        break;
      }
      watermark = summary.terminalSeq;
    }

    if (watermark > this.projectionCommittedThroughSeq) {
      this.projectionCommittedThroughSeq = watermark;
    }
  }

  public pendingProjections(): PendingProjection[] {
    const out: PendingProjection[] = [];
    const grouped = new Map<string, Envelope[]>();

    for (const rec of this.records) {
      const arr = grouped.get(rec.turnId) ?? [];
      arr.push(rec);
      grouped.set(rec.turnId, arr);
    }

    for (const [turnId, events] of grouped) {
      const last = events[events.length - 1];
      if (!last || !isTerminalStatus(last.status)) {
        continue;
      }
      const ackSeq = this.projectionAcks.get(turnId);
      if (ackSeq !== undefined && ackSeq >= last.seq) {
        continue;
      }
      out.push({
        turnId,
        status: last.status,
        events: [...events],
      });
    }

    return out;
  }

  public replay(afterSeq: number): ReplayView {
    const latest = this.getLatestSequence();
    const floor = this.records[0]?.seq ?? this.compactedThroughSeq + 1;
    const resetRequired = afterSeq < this.compactedThroughSeq || afterSeq > latest;

    if (resetRequired) {
      this.metrics.replayResets++;
    }

    const effectiveAfter = resetRequired ? this.compactedThroughSeq : afterSeq;
    const events: Envelope[] = [];
    let nextAfterSeq = effectiveAfter;

    for (const rec of this.records) {
      if (rec.seq <= effectiveAfter) {
        continue;
      }
      if (events.length >= this.maxReplayPageSize) {
        break;
      }
      events.push(rec);
      nextAfterSeq = rec.seq;
    }

    this.metrics.replayEvents += events.length;

    return {
      events,
      floorSeq: floor,
      latestSeq: latest,
      nextAfterSeq,
      hasMore: nextAfterSeq < latest,
      resetRequired,
      transcriptRevision: this.transcriptRevision,
      transcriptDigest: this.transcriptDigest,
    };
  }

  /**
   * Bound the raw record buffer. Eviction is gated on projection acknowledgment: a turn the
   * projection has not acknowledged yet must stay in `records`, because `pendingProjections`
   * rebuilds its view from `records` and the projection watermark advances only across a
   * contiguous acknowledged prefix. Splicing the oldest records blindly orphans such turns —
   * they can never be replayed and the watermark stalls at the gap, so the ledger keeps the
   * overflow rather than lose replay data it has not yet delivered. The overshoot is counted
   * in `metrics.overflowEvents` so a bound that has silently stopped being honored is visible
   * from the outside instead of only inferable from replay length.
   */
  private trimRecords(): void {
    if (this.records.length <= this.maxRecords) return;

    this.metrics.overflowEvents++;
    if (this.projectionCommittedThroughSeq > this.compactedThroughSeq) {
      this.compact(this.projectionCommittedThroughSeq);
    }
    // Anything still past the bound belongs to turns the projection has not caught up with;
    // refuse to evict past the acknowledged watermark.
  }

  /** Drop acknowledgment records the committed watermark has already absorbed. */
  private pruneStaleAcks(): void {
    for (const [turnId, ackSeq] of this.projectionAcks) {
      if (ackSeq <= this.compactedThroughSeq) this.projectionAcks.delete(turnId);
    }
  }

  /**
   * Compacts raw event history up through throughSeq.
   * Discards intermediate stream deltas only for a contiguous prefix of fully acknowledged turns.
   */
  public compact(throughSeq: number): void {
    if (throughSeq <= this.compactedThroughSeq) {
      return;
    }

    const safeLimit = Math.min(throughSeq, this.projectionCommittedThroughSeq);
    if (safeLimit <= this.compactedThroughSeq) {
      return;
    }

    this.records = this.records.filter((rec) => rec.seq > safeLimit);
    this.compactedThroughSeq = safeLimit;
    this.pruneStaleAcks();
    this.metrics.compactions++;
  }

  public getSummaries(): TerminalSummary[] {
    return [...this.summaries];
  }

  private validateStatusTransition(current: TurnStatus, next: TurnStatus): void {
    if (current === next) {
      return;
    }
    if (isTerminalStatus(current)) {
      throw new Error(`Illegal turn status transition from terminal '${current}' to '${next}'`);
    }
    if (current === "queued" && next !== "running" && !isTerminalStatus(next)) {
      throw new Error(`Illegal transition from 'queued' to '${next}'`);
    }
  }
}
