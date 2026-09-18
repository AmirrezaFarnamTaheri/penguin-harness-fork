/**
 * Ordered, replayable event stream for one autonomous SWE run.
 *
 * Why a second event primitive, when `MailboxKernel` already ships an
 * `EventBroker`: that broker is a *fan-out bus* for agents — it delivers to
 * subscribers and forgets. An autonomous SWE loop needs the opposite: a
 * durable, totally-ordered *log* of what the run actually did, addressable by
 * sequence number, with replay from any cursor and a checkpoint a reviewer
 * can rewind to. Subscribers come and go; the log is the run's record of
 * truth, and the submission reviewer's "what happened" view is built from it.
 *
 * Guarantees this enforces, in code:
 *  - sequence numbers are strictly monotonic and gap-free — an append that
 *    would break either is rejected rather than silently renumbered;
 *  - replay yields events in sequence order, always, from a stored snapshot;
 *  - causal parentage is recorded as `parentSeq`, so the reviewer can walk a
 *    tool call back to the model turn that produced it without parsing;
 *  - truncation refuses to cut inside a live checkpoint range, so a rewind
 *    target can never be dangled.
 */

export type SweEventKind =
  | "run_started"
  | "model_turn"
  | "tool_dispatched"
  | "tool_output"
  | "tool_failed"
  | "format_error"
  | "retry_issued"
  | "checkpoint_saved"
  | "submission_proposed"
  | "submission_accepted"
  | "submission_rejected"
  | "run_exited";

export interface SweEvent<T = unknown> {
  seq: number;
  runId: string;
  kind: SweEventKind;
  agentId?: string;
  timestamp: number;
  payload: T;
  /** Sequence number of the event this one causally descends from. */
  parentSeq?: number;
}

export interface SweStreamCheckpoint {
  checkpointId: string;
  runId: string;
  atSeq: number;
  savedAt: number;
  label?: string;
}

export interface SweStreamOptions {
  runId?: string;
  /** Hard cap on retained events; a runaway loop degrades to truncation. */
  maxEvents?: number;
  /** Max subscribers, a guard against a fan-out storm. */
  maxSubscribers?: number;
}

export interface SweReplayOptions {
  fromSeq?: number;
  toSeq?: number;
  kinds?: readonly SweEventKind[];
  agentId?: string;
  limit?: number;
}

function generateRunId(): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return `swe-run-${globalThis.crypto.randomUUID()}`;
  }
  return `swe-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export class SweEventStream {
  public readonly runId: string;
  private events: SweEvent[] = [];
  private nextSeq = 1;
  private readonly checkpoints = new Map<string, SweStreamCheckpoint>();
  private readonly subscribers = new Set<(event: SweEvent) => void>();
  private readonly maxEvents: number;
  private readonly maxSubscribers: number;
  private sealed = false;

  constructor(options: SweStreamOptions = {}) {
    this.runId = options.runId ?? generateRunId();
    this.maxEvents = Math.max(1, options.maxEvents ?? 10_000);
    this.maxSubscribers = Math.max(1, options.maxSubscribers ?? 64);
  }

  public getLength(): number {
    return this.events.length;
  }

  public getNextSeq(): number {
    return this.nextSeq;
  }

  public isSealed(): boolean {
    return this.sealed;
  }

  /**
   * Appends one event. Sequence numbers are minted here and are the only
   * place they are minted; supplying a `seq` is an explicit override that must
   * match exactly the next expected value, or it is refused.
   */
  public append<T = unknown>(
    kind: SweEventKind,
    payload: T,
    options: { agentId?: string; parentSeq?: number; seq?: number; timestamp?: number } = {},
  ): SweEvent<T> {
    if (this.sealed) throw new Error(`SWE run '${this.runId}' is sealed; no further events`);
    if (this.events.length >= this.maxEvents) {
      // Degrade by dropping the oldest event and re-basing sequence numbers so
      // the invariant "seq == index + 1" survives the eviction: retained
      // events are renumbered in place, and the next append continues from
      // the new length. Without the renumber, a rebased next sequence would
      // collide with a retained event and getEvent(seq) would address the
      // wrong record.
      this.events.shift();
      for (let index = 0; index < this.events.length; index++) {
        const retained = this.events[index];
        if (retained) retained.seq = index + 1;
      }
      this.nextSeq = this.events.length + 1;
    }

    if (options.seq !== undefined && options.seq !== this.nextSeq) {
      throw new Error(
        `Event sequence override ${options.seq} does not match the next expected sequence ${this.nextSeq}`,
      );
    }
    if (options.parentSeq !== undefined && options.parentSeq >= this.nextSeq) {
      throw new Error(
        `Causal parent ${options.parentSeq} cannot be at or after the next sequence ${this.nextSeq}`,
      );
    }

    const event: SweEvent<T> = {
      seq: options.seq ?? this.nextSeq,
      runId: this.runId,
      kind,
      agentId: options.agentId,
      timestamp: options.timestamp ?? Date.now(),
      payload,
      parentSeq: options.parentSeq,
    };
    this.events.push(event as SweEvent);
    this.nextSeq++;
    this.publish(event);
    return { ...event };
  }

  public subscribe(subscriber: (event: SweEvent) => void): () => void {
    if (this.subscribers.size >= this.maxSubscribers) {
      throw new Error(`SWE event stream subscriber limit reached (${this.maxSubscribers})`);
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Reads events by sequence range, kind, or agent, always in order. */
  public replay(options: SweReplayOptions = {}): SweEvent[] {
    const fromSeq = Math.max(1, options.fromSeq ?? 1);
    const toSeq = options.toSeq ?? Number.MAX_SAFE_INTEGER;
    const kinds = options.kinds ? new Set(options.kinds) : null;

    let results = this.events.filter((event) => {
      if (event.seq < fromSeq || event.seq > toSeq) return false;
      if (kinds && !kinds.has(event.kind)) return false;
      if (options.agentId && event.agentId !== options.agentId) return false;
      return true;
    });

    if (options.limit !== undefined) {
      results = results.slice(0, Math.max(0, options.limit));
    }
    return results.map((event) => ({ ...event, payload: event.payload }));
  }

  public getEvent(seq: number): SweEvent | undefined {
    const event = this.events[seq - 1];
    return event ? { ...event } : undefined;
  }

  public lastEvent(kind?: SweEventKind): SweEvent | undefined {
    const filtered = kind ? this.events.filter((event) => event.kind === kind) : this.events;
    const event = filtered[filtered.length - 1];
    return event ? { ...event } : undefined;
  }

  /**
   * Walks the causal chain from `seq` back to the run start. Every step
   * resolves through `parentSeq`, so a reviewer sees exactly which model turn
   * led to which tool call led to which submission.
   */
  public causalTrace(seq: number): SweEvent[] {
    const trace: SweEvent[] = [];
    const visited = new Set<number>();
    let cursor: number | undefined = seq;

    while (cursor !== undefined && !visited.has(cursor)) {
      const event = this.getEvent(cursor);
      if (!event) break;
      visited.add(cursor);
      trace.unshift({ ...event });
      cursor = event.parentSeq;
    }
    return trace;
  }

  public saveCheckpoint(checkpointId: string, label?: string): SweStreamCheckpoint {
    const id = checkpointId.trim();
    if (!id) throw new Error("Checkpoint id cannot be empty");
    if (this.checkpoints.has(id)) {
      throw new Error(`Checkpoint '${id}' already exists on run '${this.runId}'`);
    }
    const checkpoint: SweStreamCheckpoint = {
      checkpointId: id,
      runId: this.runId,
      atSeq: this.nextSeq - 1,
      savedAt: Date.now(),
      label,
    };
    this.checkpoints.set(id, checkpoint);
    return { ...checkpoint };
  }

  public getCheckpoint(checkpointId: string): SweStreamCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(checkpointId.trim());
    return checkpoint ? { ...checkpoint } : undefined;
  }

  public listCheckpoints(): SweStreamCheckpoint[] {
    return Array.from(this.checkpoints.values())
      .sort((a, b) => a.atSeq - b.atSeq)
      .map((checkpoint) => ({ ...checkpoint }));
  }

  /** Events recorded at or after a checkpoint — "everything since we saved". */
  public eventsSinceCheckpoint(checkpointId: string): SweEvent[] {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) return [];
    return this.replay({ fromSeq: checkpoint.atSeq + 1 });
  }

  /**
   * Rebuilds the stream from an external event list. Used to resume a run:
   * sequence numbers are re-derived so the resumed stream continues cleanly.
   */
  public restore(events: SweEvent[]): number {
    if (this.events.length > 0) {
      throw new Error(`Cannot restore into a non-empty SWE event stream (run '${this.runId}')`);
    }
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    let expected = 1;
    for (const event of sorted) {
      if (event.seq !== expected) {
        throw new Error(
          `Restored event stream has a sequence gap at ${event.seq} (expected ${expected})`,
        );
      }
      this.events.push({ ...event });
      expected++;
    }
    this.nextSeq = expected;
    this.sealed = false;
    return this.events.length;
  }

  /**
   * Truncates the log to `toSeq`. Refuses to cut inside a checkpoint's live
   * range — a checkpoint must always point at a sequence the log still holds,
   * otherwise a rewind target would dangle.
   */
  public truncate(toSeq: number): number {
    if (toSeq < 0) throw new Error("Truncation target sequence cannot be negative");
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.atSeq > toSeq) {
        throw new Error(
          `Refusing to truncate to seq ${toSeq}: checkpoint '${checkpoint.checkpointId}' points at seq ${checkpoint.atSeq}`,
        );
      }
    }
    const removed = Math.max(0, this.events.length - toSeq);
    this.events = this.events.slice(0, toSeq);
    this.nextSeq = this.events.length + 1;
    return removed;
  }

  public seal(): void {
    this.sealed = true;
  }

  public snapshot(): SweEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  // ---------------------------------------------------------------- internals

  private publish(event: SweEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber({ ...event });
      } catch (error) {
        console.error("[SweEventStream] subscriber error:", error);
      }
    }
  }
}
