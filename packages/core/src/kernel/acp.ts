/**
 * Agent Client Protocol (ACP) JSON-RPC 2.0 Protocol Engine.
 *
 * One `AcpConnection` is one *transport generation*. A transport (a pipe, a WebSocket, a
 * child-process stdio pair) can fail and be replaced, so the connection has three states
 * rather than two: `open`, `failed` (a transport died, recoverable via
 * {@link AcpConnection.reattachTransport}) and `closed` (disposed, terminal). A failed
 * connection is not dead: it remembers why, refuses to write, counts what it could not
 * deliver, and serves requests again as soon as a new transport is attached.
 *
 * Three properties are load-bearing and each is covered by a test:
 *
 * - **Bounded.** Retained bytes are capped by `maxFrameBytes`. An unterminated frame is
 *   dropped whole and the stream resynchronises at the next newline; a peer that never
 *   sends one exhausts a discard budget and fails the transport rather than growing the heap.
 * - **Ordered.** Every outbound frame goes through one queue, so the peer sees the order
 *   the caller issued. A failed write cannot wedge the frames behind it.
 * - **Askable.** A connection that has quietly fallen out of sync with its peer must be
 *   able to say so, so the counters behind that failure — late responses, malformed
 *   frames, oversized frames, undeliverable notifications — are exposed on
 *   {@link AcpConnection.getStats} and pushed to a diagnostic sink.
 */

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Writes one already-framed line, trailing newline included. */
export type AcpSendLine = (line: string) => void | Promise<void>;

/**
 * `open` serves traffic. `failed` is recoverable — a transport died, writes are refused
 * with the recorded cause, and {@link AcpConnection.reattachTransport} brings it back.
 * `closed` is terminal.
 */
export type AcpConnectionState = "open" | "failed" | "closed";

export type AcpDiagnosticCode =
  | "transport-failed"
  | "transport-replaced"
  | "request-timeout"
  | "late-response"
  | "malformed-frame"
  | "oversized-frame"
  | "notification-write-failed";

export interface AcpDiagnostic {
  code: AcpDiagnosticCode;
  message: string;
  /** The transport generation the event belongs to; increments on every reattach. */
  generation: number;
  detail?: unknown;
}

export interface AcpConnectionStats {
  state: AcpConnectionState;
  /** Incremented by every reattach. Identifies which transport an id or failure belongs to. */
  generation: number;
  pendingRequests: number;
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  /** Responses that arrived for an id this connection was not waiting on. */
  droppedLateResponses: number;
  /** Lines that failed `JSON.parse`. */
  malformedFrames: number;
  /** Lines refused for exceeding `maxFrameBytes`. */
  oversizedFrames: number;
  /** Bytes thrown away while resynchronising after an oversized frame. */
  discardedBytes: number;
  /** Retained bytes of the frame currently being assembled. Never exceeds `maxFrameBytes`. */
  bufferedBytes: number;
  /** Notifications whose write failed. */
  notificationWriteFailures: number;
  requestTimeouts: number;
  transportFailures: number;
  /** Successful reattachments, i.e. a failed connection that serves again. */
  recoveries: number;
  /** Unix ms of the last frame in either direction, or null if nothing has moved. */
  lastActivityAt: number | null;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
  /** Method names sent to the peer, with counts. Capped — see `methodCensusTruncated`. */
  methodsSent: Record<string, number>;
  /** Method names received from the peer, with counts. Capped. */
  methodsReceived: Record<string, number>;
  methodCensusTruncated: boolean;
}

export interface AcpConnectionOptions {
  /**
   * Maximum retained size of a single frame, in UTF-8 bytes. Defaults to 8 MiB, which
   * leaves room for diffs and terminal output while still bounding a hostile or wedged
   * peer to a fixed number of bytes. Must be a positive integer.
   */
  maxFrameBytes?: number;
  /**
   * How many bytes may be discarded while resynchronising after an oversized frame before
   * the transport is failed. Defaults to four times `maxFrameBytes`.
   */
  maxResyncBytes?: number;
  /** Called for every counted anomaly. Must not throw; a throw here is swallowed. */
  onDiagnostic?: (diagnostic: AcpDiagnostic) => void;
}

/** A transport died or was replaced. Carries the generation so callers can tell them apart. */
export class AcpTransportError extends Error {
  readonly name = "AcpTransportError";
  readonly generation: number;

  constructor(message: string, generation: number, options?: ErrorOptions) {
    super(message, options);
    this.generation = generation;
  }
}

/** The connection was disposed. Terminal: it cannot be reattached. */
export class AcpConnectionClosedError extends Error {
  readonly name = "AcpConnectionClosedError";

  constructor() {
    super("ACP connection disposed");
  }
}

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_RESYNC_MULTIPLE = 4;

/**
 * Distinct method names are counted, not retained without limit: a peer that generates
 * unique names (id-suffixed methods, for instance) must not be able to grow the census.
 * Past the cap the census stops adding and says so rather than silently undercounting.
 */
const MAX_TRACKED_METHODS = 128;

/**
 * UTF-8 length of a string without allocating. `Buffer.byteLength` and `TextEncoder`
 * both exist, but the first ties this file to Node and the second allocates a copy of
 * every chunk it measures — on a path that exists precisely because a peer is sending
 * absurd amounts of data. A lone surrogate counts as the 3 bytes of U+FFFD that
 * `TextEncoder` substitutes, so the two agree.
 *
 * Exported for `./acp-resume.js`, which bounds replay retention by the same unit; it is
 * deliberately NOT part of the kernel's public surface (see ./index.ts).
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

interface PendingRequest {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  generation: number;
}

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly requestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown> | unknown
  >();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  private sendLine: AcpSendLine;
  private readonly maxFrameBytes: number;
  private readonly maxResyncBytes: number;
  private readonly onDiagnostic: ((diagnostic: AcpDiagnostic) => void) | undefined;

  private state: AcpConnectionState = "open";
  private generation = 1;
  /** The first transport failure's cause. Cleared only by reattach or dispose. */
  private failure: AcpTransportError | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureMessage: string | null = null;
  private lastActivityAt: number | null = null;

  private lineBuffer = "";
  /** UTF-8 size of `lineBuffer`, tracked incrementally so bounding it costs no extra scan. */
  private lineBufferBytes = 0;
  /** True while skipping to the next newline after an oversized frame. */
  private resyncing = false;
  private discardBytes = 0;

  private framesSent = 0;
  private framesReceived = 0;
  private bytesSent = 0;
  private bytesReceived = 0;
  private droppedLateResponses = 0;
  private malformedFrames = 0;
  private oversizedFrames = 0;
  private notificationWriteFailures = 0;
  private requestTimeouts = 0;
  private transportFailures = 0;
  private recoveries = 0;

  private readonly methodCensusSent = new Map<string, number>();
  private readonly methodCensusReceived = new Map<string, number>();
  private methodCensusTruncated = false;

  /**
   * Serialises every outbound frame. A request, a notification and a response all pass
   * through it, so the peer observes the order the caller issued them in.
   */
  private writeTail: Promise<void> = Promise.resolve();
  private readonly idleWaiters: (() => void)[] = [];

  constructor(
    sendRawLine: AcpSendLine,
    private readonly requestTimeoutMs = 30_000,
    options: AcpConnectionOptions = {},
  ) {
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError(
        `AcpConnection maxFrameBytes must be a positive integer, received ${String(maxFrameBytes)}`,
      );
    }
    const maxResyncBytes = options.maxResyncBytes ?? maxFrameBytes * DEFAULT_RESYNC_MULTIPLE;
    if (!Number.isSafeInteger(maxResyncBytes) || maxResyncBytes <= 0) {
      throw new RangeError(
        `AcpConnection maxResyncBytes must be a positive integer, received ${String(maxResyncBytes)}`,
      );
    }
    this.sendLine = sendRawLine;
    this.maxFrameBytes = maxFrameBytes;
    this.maxResyncBytes = maxResyncBytes;
    this.onDiagnostic = options.onDiagnostic;
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private diagnose(code: AcpDiagnosticCode, message: string, detail?: unknown): void {
    if (!this.onDiagnostic) return;
    const diagnostic: AcpDiagnostic = { code, message, generation: this.generation };
    if (detail !== undefined) diagnostic.detail = detail;
    try {
      this.onDiagnostic(diagnostic);
    } catch {
      // A diagnostic sink that throws must not take the connection down with it: these
      // fire from inside error paths, where a new exception replaces the real diagnosis.
    }
  }

  private noteMethod(census: Map<string, number>, method: string): void {
    const seen = census.get(method);
    if (seen !== undefined) {
      census.set(method, seen + 1);
      return;
    }
    if (census.size >= MAX_TRACKED_METHODS) {
      this.methodCensusTruncated = true;
      return;
    }
    census.set(method, 1);
  }

  /** Wakes {@link whenIdle} once nothing is in flight. */
  private signalIdleChange(): void {
    if (this.pending.size > 0) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.signalIdleChange();
  }

  /**
   * Records a transport failure. The *first* cause is the one kept: later failures are
   * usually its consequences, and replacing the cause would let a downstream symptom
   * ("write after end") overwrite the diagnosis ("socket closed").
   *
   * In-flight requests are rejected here, loudly and all at once, rather than left to
   * time out 30s later against a transport that is already gone.
   */
  private failTransport(error: unknown, generation = this.generation): Error {
    const normalized = this.normalizeError(error);
    // A rejected write from a retired transport is not evidence about the replacement.
    // The caller that enqueued it still receives a failure, but the current connection
    // must not be poisoned by an obsolete socket's late rejection.
    if (generation !== this.generation) {
      return new AcpTransportError(normalized.message, generation, { cause: normalized });
    }
    if (this.state === "closed") {
      // Disposed connections are terminal; a write that was already in flight when
      // dispose landed settles afterwards, and it must not resurrect a failure state or
      // re-count a rejection nobody is waiting for. The cause it actually saw is kept.
      return this.failure ?? new AcpConnectionClosedError();
    }
    if (error !== this.failure) {
      // A queued write that reaches the head of the queue after the transport already
      // failed rejects with the cached cause, and re-delivering that cause is not a new
      // failure — only a write that actually reached the transport can be one.
      this.transportFailures += 1;
    }
    if (!this.failure) {
      this.failure = new AcpTransportError(normalized.message, this.generation, {
        cause: normalized,
      });
      this.lastFailureAt = Date.now();
      this.lastFailureMessage = normalized.message;
      this.state = "failed";
      this.diagnose("transport-failed", normalized.message);
    }
    // A partial frame buffered from a dead transport cannot be trusted to still be a
    // frame boundary: the bytes may have been cut in half by whatever broke the transport.
    // The host supplies a whole new transport on reattach, so the partial frame is dropped
    // rather than carried into the next generation. Inbound frames are still accepted and
    // read while a connection is failed — a half-open socket can still deliver — but the
    // writes it would need to answer them are refused, and those refusals are counted.
    this.lineBuffer = "";
    this.lineBufferBytes = 0;
    this.resyncing = false;
    this.discardBytes = 0;
    this.rejectAllPending(this.failure);
    return this.failure;
  }

  /**
   * Queues one frame. State is checked twice — at enqueue time so the caller fails
   * immediately, and again when the write reaches the head of the queue, because the
   * transport can die while this frame waits its turn.
   */
  private writeLine(message: JsonRpcMessage): Promise<void> {
    if (this.state === "closed") return Promise.reject(new AcpConnectionClosedError());
    if (this.failure) return Promise.reject(this.failure);

    // Bind the write to the transport generation that accepted the caller's operation.
    // Reading this.sendLine inside the queued closure would let an old request migrate to a
    // replacement peer after it had already been rejected by reattachTransport().
    const generation = this.generation;
    const sendLine = this.sendLine;
    const line = `${JSON.stringify(message)}\n`;
    const run = this.writeTail.then(async () => {
      if (generation !== this.generation) {
        throw new AcpTransportError(
          "ACP write cancelled because its transport was replaced",
          generation,
        );
      }
      if (this.state === "closed") throw new AcpConnectionClosedError();
      if (this.failure) throw this.failure;
      this.framesSent += 1;
      this.bytesSent += utf8Length(line);
      await sendLine(line);
    });

    // The tail swallows its own rejection. Without that, one failed write would leave the
    // tail rejected and every later frame would reject without ever reaching the
    // transport — a dead queue instead of a dead connection. `run` still rejects for the
    // one caller that cares about this particular write.
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((error: unknown) => {
      throw this.failTransport(error, generation);
    });
  }

  /**
   * Attach a new transport, recovering a failed connection.
   *
   * Ids are *not* reset: a late frame from the previous transport must never be able to
   * resolve a request issued on this one, and a monotonic counter makes that impossible
   * rather than unlikely.
   *
   * Requests that were in flight belong to the old transport and are rejected here. They
   * are not replayed — the caller knows whether its request is safe to repeat (an
   * `initialize`, say) and a protocol engine does not, so it fails them loudly and lets
   * the caller decide.
   */
  public reattachTransport(sendLine: AcpSendLine): void {
    if (this.state === "closed") throw new AcpConnectionClosedError();
    const previousFailure = this.failure;

    // Reject the previous generation's requests before the state flips, while the cause
    // is still the one they were issued under.
    this.rejectAllPending(
      new AcpTransportError(
        "ACP transport was replaced before the response arrived",
        this.generation,
        previousFailure ? { cause: previousFailure } : undefined,
      ),
    );

    this.sendLine = sendLine;
    this.failure = null;
    this.state = "open";
    this.generation += 1;
    this.lineBuffer = "";
    this.lineBufferBytes = 0;
    this.resyncing = false;
    this.discardBytes = 0;
    if (previousFailure) this.recoveries += 1;
    this.diagnose(
      "transport-replaced",
      previousFailure
        ? `ACP transport recovered after: ${previousFailure.message}`
        : "ACP transport replaced while healthy",
    );
  }

  /**
   * Declare the transport dead without waiting for a write to fail. A host that sees a
   * socket `close` or a child `exit` knows the connection is unusable even when nothing is
   * being sent, and without this the failure would go unrecorded until the next request —
   * or never, if the only traffic left is inbound.
   */
  public markTransportFailed(error: unknown): void {
    this.failTransport(error);
  }

  public getState(): AcpConnectionState {
    return this.state;
  }

  /**
   * A snapshot of everything the connection has counted. This is the answer to "is this
   * link healthy, or has it been quietly dropping frames?" — the counters that only
   * matter when nothing is visibly wrong.
   */
  public getStats(): AcpConnectionStats {
    return {
      state: this.state,
      generation: this.generation,
      pendingRequests: this.pending.size,
      framesSent: this.framesSent,
      framesReceived: this.framesReceived,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      droppedLateResponses: this.droppedLateResponses,
      malformedFrames: this.malformedFrames,
      oversizedFrames: this.oversizedFrames,
      discardedBytes: this.discardBytes,
      bufferedBytes: this.lineBufferBytes,
      notificationWriteFailures: this.notificationWriteFailures,
      requestTimeouts: this.requestTimeouts,
      transportFailures: this.transportFailures,
      recoveries: this.recoveries,
      lastActivityAt: this.lastActivityAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureMessage: this.lastFailureMessage,
      methodsSent: Object.fromEntries(this.methodCensusSent),
      methodsReceived: Object.fromEntries(this.methodCensusReceived),
      methodCensusTruncated: this.methodCensusTruncated,
    };
  }

  /**
   * Liveness without inventing a protocol frame.
   *
   * There is no `ping` on the wire here on purpose: a probe this engine invented would
   * get `-32601` from every peer that does not implement it, and a probe method the peer
   * does implement proves only that *that* method answers. What is observable without the
   * peer's cooperation is whether *this end* is still moving — bytes in and out, a write
   * queue that drains, an activity clock that has not gone quiet past the request
   * deadline. That closes the specific gap a per-request timeout leaves: a connection
   * sitting idle and silent past its own deadline, with no request outstanding to time
   * out, is a peer that is wedged or gone.
   *
   * It is deliberately not a stronger claim than that. While a request is in flight the
   * connection is reported healthy, because the only thing that can settle that question
   * is the response, and the request timeout is the thing that settles it.
   */
  public isHealthy(idleThresholdMs = this.requestTimeoutMs): boolean {
    if (this.state !== "open") return false;
    if (this.pending.size > 0) return true;
    if (this.lastActivityAt === null) return true;
    return Date.now() - this.lastActivityAt < idleThresholdMs;
  }

  /**
   * Resolves when the write queue has drained and no request is in flight. Loops rather
   * than subscribing: both conditions can change while awaiting, so the only correct
   * check is re-reading the state after each wait.
   */
  public async whenIdle(): Promise<void> {
    for (;;) {
      await this.writeTail;
      if (this.pending.size === 0) return;
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
  }

  public onRequest<P = unknown, R = unknown>(
    method: string,
    handler: (params: P) => Promise<R> | R,
  ): void {
    this.requestHandlers.set(method, handler as (params: unknown) => Promise<unknown>);
  }

  public onNotification<P = unknown>(method: string, handler: (params: P) => void): void {
    this.notificationHandlers.set(method, handler as (params: unknown) => void);
  }

  public async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state === "closed") throw new AcpConnectionClosedError();
    if (this.failure) throw this.failure;

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.noteMethod(this.methodCensusSent, method);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.requestTimeouts += 1;
        this.signalIdleChange();
        const message = `ACP request '${method}' with id ${id} timed out after ${this.requestTimeoutMs}ms`;
        this.diagnose("request-timeout", message, { id, method });
        reject(new Error(message));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
        method,
        generation: this.generation,
      });

      void this.writeLine(req).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.signalIdleChange();
        reject(this.normalizeError(error));
      });
    });
  }

  /**
   * Returns a promise that never rejects, because a notification has no caller to reject
   * to and an ignored rejection becomes an unhandled rejection. The write failure is
   * instead counted, reported to the diagnostic sink, and — as for every other write —
   * poisons the transport, so the next request fails with the real cause. Discarding the
   * error outright, as this once did, let a dead transport look alive for as long as only
   * notifications were flowing.
   */
  public sendNotification(method: string, params?: unknown): Promise<void> {
    const notif: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.noteMethod(this.methodCensusSent, method);
    return this.writeLine(notif).catch((error: unknown) => {
      this.notificationWriteFailures += 1;
      this.diagnose("notification-write-failed", this.normalizeError(error).message, { method });
    });
  }

  public async handleChunk(chunk: string): Promise<void> {
    if (this.state === "closed") throw new AcpConnectionClosedError();

    this.bytesReceived += utf8Length(chunk);
    if (chunk.length > 0) this.lastActivityAt = Date.now();

    const dispatched: Promise<void>[] = [];
    let cursor = 0;

    // Walk the chunk in place instead of `split("\n")`, because the split version cannot
    // enforce the frame bound: the oversized prefix has to be found and dropped without
    // ever being concatenated onto the carry buffer.
    while (cursor < chunk.length) {
      if (this.resyncing) {
        // Everything up to the next newline belongs to the oversized frame we dropped.
        const newline = chunk.indexOf("\n", cursor);
        if (newline === -1) {
          this.discardBytes += utf8Length(chunk.slice(cursor));
          cursor = chunk.length;
          if (this.discardBytes > this.maxResyncBytes) {
            this.failTransport(
              new Error(
                `ACP peer sent more than ${this.maxResyncBytes} bytes with no frame delimiter; the stream is not line-delimited and the connection cannot resynchronise`,
              ),
            );
          }
          break;
        }
        this.discardBytes += utf8Length(chunk.slice(cursor, newline));
        cursor = newline + 1;
        this.resyncing = false;
        this.discardBytes = 0;
        continue;
      }

      const newline = chunk.indexOf("\n", cursor);
      const segment = newline === -1 ? chunk.slice(cursor) : chunk.slice(cursor, newline);
      const segmentBytes = utf8Length(segment);

      if (this.lineBufferBytes + segmentBytes > this.maxFrameBytes) {
        // The frame is the carry plus this segment, so both are dropped: nothing inside an
        // unterminated line can be trusted, and the newline that ends it is inside data we
        // are refusing to buffer. The connection survives — one oversized frame is a
        // contained event, not a reason to drop every later frame with it.
        this.oversizedFrames += 1;
        this.diagnose(
          "oversized-frame",
          `ACP frame exceeds maxFrameBytes (${this.maxFrameBytes}); frame dropped`,
          { received: this.lineBufferBytes + segmentBytes, limit: this.maxFrameBytes },
        );
        this.lineBuffer = "";
        this.lineBufferBytes = 0;
        if (newline === -1) {
          this.resyncing = true;
          cursor = chunk.length;
        } else {
          cursor = newline + 1;
        }
        continue;
      }

      this.lineBuffer += segment;
      this.lineBufferBytes += segmentBytes;
      if (newline === -1) {
        cursor = chunk.length;
        break;
      }

      const line = this.lineBuffer;
      this.lineBuffer = "";
      this.lineBufferBytes = 0;
      cursor = newline + 1;
      if (line.trim().length > 0) dispatched.push(this.dispatchLine(line));
    }

    if (dispatched.length === 0) return;
    // Handlers are dispatched without serialising this loop. A request handler is allowed
    // to issue its own outbound requests, and its response may already be in this same
    // chunk, so awaiting one before reading the next frame starves it; a slow
    // notification handler must not hold up the frames behind it either.
    //
    // `allSettled` rather than `all`: the losers must stay observed, or a rejection from a
    // frame that already completed becomes an unhandled rejection. The first failure is
    // then rethrown so callers still learn that something went wrong.
    const results = await Promise.allSettled(dispatched);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  /**
   * Parses and dispatches one frame. Parse failures are contained here and counted: they
   * used to be caught by the same handler as dispatch failures, where a `SyntaxError` was
   * indistinguishable from a malformed frame — so garbage from a peer vanished silently
   * *and* a handler that happened to throw one was swallowed as if the peer had misbehaved.
   */
  private dispatchLine(line: string): Promise<void> {
    this.framesReceived += 1;
    let message: JsonRpcMessage;
    try {
      const decoded: unknown = JSON.parse(line);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new TypeError("ACP JSON-RPC frame must be an object");
      }
      message = decoded as JsonRpcMessage;
    } catch (error) {
      this.malformedFrames += 1;
      this.diagnose("malformed-frame", this.normalizeError(error).message, {
        bytes: utf8Length(line),
      });
      // Never throws: a frame we cannot parse must not wedge the frames behind it.
      return Promise.resolve();
    }
    return this.handleMessage(message);
  }

  public async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (this.state === "closed") throw new AcpConnectionClosedError();

    this.lastActivityAt = Date.now();

    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        // JSON-RPC says to ignore a response with no matching request, so dropping it is
        // correct. Dropping it *silently* is not: a response for an id this connection is
        // not waiting on is the signature of the two sides disagreeing about what is in
        // flight, and the usual cause is a response that lost a race with its timeout.
        // Counted and reported so the rate is alertable.
        this.droppedLateResponses += 1;
        this.diagnose("late-response", `ACP response for unknown id ${String(msg.id)}`, {
          id: msg.id,
        });
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      this.signalIdleChange();
      if (msg.error) entry.reject(new Error(`ACP Error ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
      return;
    }

    if ("id" in msg && "method" in msg) {
      this.noteMethod(this.methodCensusReceived, msg.method);
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        await this.writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method '${msg.method}' not found` },
        });
        return;
      }

      let response: JsonRpcResponse<unknown>;
      try {
        const result = await handler(msg.params);
        // JSON.stringify omits undefined object properties. JSON-RPC success responses must carry
        // a result member, so normalize a void handler to the protocol-safe null result.
        response = { jsonrpc: "2.0", id: msg.id, result: result ?? null };
      } catch (error) {
        const normalized = this.normalizeError(error);
        response = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: normalized.message || "Internal error" },
        };
      }
      await this.writeLine(response);
      return;
    }

    if ("method" in msg) {
      this.noteMethod(this.methodCensusReceived, msg.method);
      const notifHandler = this.notificationHandlers.get(msg.method);
      if (notifHandler) notifHandler(msg.params);
    }
  }

  /**
   * Terminal. Pending requests are rejected, buffered bytes are dropped, handlers are
   * released, and the state is reported as `closed` — not as the last transport failure,
   * so a disposed connection does not keep advertising a cause that no longer matters.
   *
   * Nothing is written to the peer. Any close frame this invented would be a protocol
   * extension the peer may not implement; the transport owner closes the socket.
   */
  public dispose(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.failure = null;
    this.lastFailureAt = null;
    this.lastFailureMessage = null;
    this.lineBuffer = "";
    this.lineBufferBytes = 0;
    this.resyncing = false;
    this.discardBytes = 0;
    this.rejectAllPending(new AcpConnectionClosedError());
    this.requestHandlers.clear();
    this.notificationHandlers.clear();
  }
}
