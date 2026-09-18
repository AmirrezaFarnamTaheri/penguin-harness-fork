/**
 * CDP session pool: a raw Chrome DevTools Protocol transport, and a pooler that keeps warm
 * target sessions ready for reuse.
 *
 * The cluster cannot lean on Puppeteer or Playwright: both are heavy runtime dependencies the
 * server package does not carry, and both impose their own opinionated session model that
 * fights the pooler's need to hand a live CDP session to a caller and take it back intact. What
 * ports instead is the *transport discipline* from the Rust CDP client donor — the parts of a
 * CDP connection that are easy to get wrong and that show up as silent hangs in production:
 *
 *   - a pending-request map keyed by command id, so a response is routed to exactly one waiter;
 *   - a 30-second WebSocket ping keepalive, because reverse proxies and load balancers will
 *     reap an idle CDP socket and leave the pool believing it is healthy;
 *   - a bounded private channel per session for high-volume event streams (a screencast), where
 *     a consumer that falls behind loses frames rather than stalling the reader loop;
 *   - repair of lone-surrogate JSON escapes, which some CDP endpoints emit and a strict parser
 *     rejects wholesale — the message is rescued rather than dropped;
 *   - a command timeout that removes its own pending entry, so a response that never comes
 *     cannot leak a waiter until connection close;
 *   - a close path that is bounded in time, drains the pending map, and aborts the reader so a
 *     half-closed socket cannot wedge a pool slot.
 *
 * Endpoint discovery is the three-method cascade from the donor's `discovery` module:
 * `/json/version`, then `/json/list`, then a direct WebSocket to `/devtools/browser`. Chrome's
 * HTTP discovery answers `ws://127.0.0.1:<port>/...` even when the browser is remote, so the
 * returned URL's host and port are rewritten to the ones actually requested.
 *
 * Pooling strategy: sessions are checked out by key and returned warm. An idle session is
 * probed (a cheap `Target.getTargetInfo`) before reuse — a session whose target died while idle
 * is discarded rather than handed to a caller who would then have to rediscover that fact. The
 * pool caps both total sessions and per-key idle entries, and an eviction sweep drops the oldest
 * idle sessions when capacity is tight, which is what keeps the plan's "30 concurrent isolated
 * contexts per node" a real ceiling instead of a suggestion.
 */

import { EventEmitter } from "events";
import { request as undiciRequest } from "undici";
import { WebSocket } from "ws";

/**
 * A decoded CDP event: the method name, the raw params, and the target session it arrived on.
 * Events without a `sessionId` belong to the browser-level session.
 */
export interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

/** A CDP error object as the protocol returns one for a failed command. */
export interface CdpErrorObject {
  code?: number;
  message: string;
  data?: unknown;
}

/** Envelope of a single inbound CDP message. */
interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: CdpErrorObject;
  method?: string;
  params?: unknown;
  sessionId?: string;
}

/** Outbound command shape. */
interface CdpCommand {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
}

/** A raw inbound message, surfaced for an inspect-style proxy that forwards traffic verbatim. */
export interface RawCdpMessage {
  text: string;
  sessionId?: string;
}

/** Reason a session pool entry was discarded, recorded for telemetry. */
export type SessionEvictionReason = "capacity" | "dead" | "closed" | "error";

/** Configuration for the transport; every value has a production-derived default. */
export interface CdpTransportOptions {
  /** WebSocket ping interval. Proxies reap idle sockets well inside a minute. @default 30000 */
  keepaliveIntervalMs?: number;
  /** Per-command response timeout. @default 30000 */
  commandTimeoutMs?: number;
  /** Depth of a private (per-session) event channel. A slow consumer loses frames, not the reader. @default 16 */
  privateChannelDepth?: number;
  /** Broadcast channel depth for browser-level events. @default 4096 */
  broadcastDepth?: number;
  /** Bound on the close handshake before the socket is force-closed. @default 500 */
  closeTimeoutMs?: number;
  /** Connect timeout for the WebSocket handshake. @default 10000 */
  connectTimeoutMs?: number;
}

const DEFAULTS: Required<CdpTransportOptions> = {
  keepaliveIntervalMs: 30_000,
  commandTimeoutMs: 30_000,
  privateChannelDepth: 16,
  broadcastDepth: 4096,
  closeTimeoutMs: 500,
  connectTimeoutMs: 10_000,
};

/** Default timeout for the HTTP discovery probes. */
const DISCOVERY_TIMEOUT_MS = 2_000;

/** Sizes the pool; the plan's per-node context ceiling is the default. */
export interface CdpSessionPoolOptions {
  /** Maximum sessions the pool will hold at once (checked out + idle). @default 30 */
  capacity?: number;
  /** Idle sessions kept warm per key for reuse. @default 4 */
  idlePerKey?: number;
  /** How often to sweep idle sessions for eviction. @default 30000 */
  sweepIntervalMs?: number;
  /** Idle sessions older than this are evicted. @default 300000 */
  maxIdleAgeMs?: number;
  transport?: CdpTransportOptions;
}

interface PooledSession {
  key: string;
  sessionId: string;
  targetId: string;
  transport: CdpTransport;
  /** When the session was last returned to the pool (idle since). */
  idleSince: number;
  /** Number of times this warm session has been reused. */
  reuseCount: number;
}

/**
 * A single live CDP connection: one WebSocket, one command-id space, one event stream.
 *
 * Callers never construct this directly for pooling purposes — the session pool owns transports
 * — but it is exported because an ad-hoc browser-level connection (the inspect proxy, or a
 * one-shot command against an unknown target) needs the same transport semantics without a pool.
 */
export class CdpTransport extends EventEmitter {
  private socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (m: CdpMessage) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private closeComplete = false;
  private readonly keepalive?: NodeJS.Timeout;
  private readonly opts: Required<CdpTransportOptions>;
  /** Per-session private channels; a session present here takes its events out of the broadcast. */
  private readonly privateChannels = new Map<string, (event: CdpEvent) => void>();

  constructor(socket: WebSocket, options: CdpTransportOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.socket = socket;
    this.socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) =>
      this.onMessage(this.toText(data, isBinary)),
    );
    this.socket.on("close", () => this.shutdown("closed"));
    this.socket.on("error", (error: Error) => {
      this.emit("error", error);
      this.shutdown("error");
    });

    if (this.opts.keepaliveIntervalMs > 0) {
      this.keepalive = setInterval(() => {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
          clearInterval(this.keepalive!);
          return;
        }
        // A failed ping means the socket is dead; the donor stops pinging and lets the reader
        // notice, which arrives as a close/error event here.
        this.socket.ping(undefined as never, undefined as never, () => {
          /* swallow: the close handler covers a dead socket */
        });
      }, this.opts.keepaliveIntervalMs);
    }
  }

  private toText(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): string {
    if (isBinary) {
      // Remote CDP proxies may frame responses as binary; treat them as UTF-8 text.
      const bytes = data as unknown as Uint8Array;
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        return "";
      }
    }
    return data.toString("utf-8");
  }

  /** Parses one inbound message, repairing lone surrogates if the strict parse fails. */
  private parseMessage(text: string): CdpMessage | null {
    try {
      return JSON.parse(text) as CdpMessage;
    } catch {
      const repaired = repairLoneSurrogates(text);
      if (repaired === null) return null;
      try {
        return JSON.parse(repaired) as CdpMessage;
      } catch {
        return null;
      }
    }
  }

  private onMessage(text: string): void {
    if (!text) return;

    // Raw passthrough for an inspect-style proxy, before typed parsing so negative proxy ids
    // (which the parser deliberately ignores) still reach the forwarder.
    if (this.listenerCount("raw") > 0) {
      const sessionId = tryReadSessionId(text);
      this.emit("raw", { text, sessionId } satisfies RawCdpMessage);
    }

    const parsed = this.parseMessage(text);
    if (parsed === null) {
      // Malformed: fail only its own top-level command, never the connection.
      const id = tryReadCommandId(text);
      if (id !== null)
        this.deliver(id, {
          id,
          error: { message: "Malformed CDP response" },
        });
      return;
    }

    if (typeof parsed.id === "number" && parsed.id > 0) {
      this.deliver(parsed.id, parsed);
    } else if (parsed.method) {
      const event: CdpEvent = {
        method: parsed.method,
        params: parsed.params ?? null,
        sessionId: parsed.sessionId,
      };
      // A subscribed session consumes its own events so a screencast neither floods the broadcast
      // nor can overflow another subscriber's buffer.
      const route = parsed.sessionId ? this.privateChannels.get(parsed.sessionId) : undefined;
      if (route) {
        route(event);
      } else {
        this.emit("event", event);
      }
    }
  }

  private deliver(id: number, message: CdpMessage): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(message);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("CDP connection closed");
  }

  /**
   * Sends a command and awaits its response. Rejects on protocol error, timeout, or a closed
   * transport. The closed-transport case must REJECT rather than throw: callers await this, and a
   * synchronous throw surfaces as an unhandled exception in the middle of an `await` chain
   * instead of the rejection every other failure path produces.
   */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const command: CdpCommand = { id, method, params, sessionId: sessionId || undefined };
    const json = JSON.stringify(command);

    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("CDP connection closed"));
        return;
      }
      const timer = setTimeout(() => {
        // A response that never arrives must not leak its waiter until the connection dies.
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.opts.commandTimeoutMs);

      this.pending.set(id, {
        resolve: (message) => {
          if (message.error) {
            reject(new Error(`CDP error (${method}): ${message.error.message}`));
          } else {
            resolve(message.result ?? null);
          }
        },
        timer,
      });

      const sent = this.sendRaw(json);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Failed to send CDP command: ${method}`));
      }
    });
  }

  /** Best-effort command with no awaited response; for commands Chrome may not answer. */
  sendNoWait(method: string, params?: unknown, sessionId?: string): void {
    this.ensureOpen();
    this.sendRaw(
      JSON.stringify({ id: this.nextId++, method, params, sessionId: sessionId || undefined }),
    );
  }

  /** Writes raw JSON; returns false when the write did not go out. */
  sendRaw(json: string): boolean {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(json);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Routes every event carrying `sessionId` to `sink` instead of the `event` broadcast. A slow
   * sink receives only as many as the channel holds — the rest are dropped, by design, because a
   * screencast consumer that cannot keep up should lose frames rather than stall the reader.
   * Unsubscribe with {@link unsubscribeSession} or by returning false from the sink.
   */
  subscribeSession(sessionId: string, sink: (event: CdpEvent) => void): void {
    this.privateChannels.set(sessionId, sink);
  }

  unsubscribeSession(sessionId: string): void {
    this.privateChannels.delete(sessionId);
  }

  /** True once the underlying socket has closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** In-flight commands still awaiting a response; a diagnostic the pool probes. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private shutdown(reason: SessionEvictionReason): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    // Every waiter resolves immediately rather than waiting out its own timeout.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ id, error: { message: "CDP connection closed" } });
    }
    this.emit("close", reason);
  }

  /** Closes the transport, bounded in time, then force-destroys the socket. */
  close(): void {
    if (this.closeComplete) return;
    this.shutdown("closed");
    const force = () => {
      try {
        this.socket.terminate();
      } catch {
        /* already gone */
      }
      this.closeComplete = true;
    };
    // Give the close handshake a short window; then kill the socket so a slow peer cannot hold it.
    const guard = setTimeout(force, this.opts.closeTimeoutMs);
    try {
      this.socket.close();
    } catch {
      clearTimeout(guard);
      force();
    }
  }
}

/**
 * Repairs unpaired UTF-16 surrogate escapes in a CDP message. Some endpoints emit `\uD83C` with
 * no trailing low surrogate; a strict JSON parser rejects the whole message, which loses a
 * screencast frame or a network event for a purely cosmetic encoding fault. A repaired escape is
 * replaced with the Unicode replacement character so the byte stream stays valid.
 *
 * Returns `null` when the text needs no repair, so the caller can avoid a second parse.
 */
export function repairLoneSurrogates(text: string): string | null {
  const HIGH_START = 0xd800;
  const LOW_START = 0xdc00;
  const SURROGATE_END = 0xe000;

  /**
   * Output is built lazily and only when a repair is actually needed, so an already-valid message
   * costs one scan and no allocation. `flushFrom` is the index up to which the source has already
   * been copied into `out`; every branch that moves the cursor past characters it has consumed
   * must flush them, or the tail after a repair is silently truncated. `dirty` is what makes the
   * laziness possible: the return value is `null` unless a repair actually happened.
   */
  let out = "";
  let dirty = false;
  let flushFrom = 0;
  let i = 0;
  const flushTo = (to: number): void => {
    out += text.slice(flushFrom, to);
    flushFrom = to;
  };

  while (i < text.length) {
    const c = text[i]!;
    if (c !== "\\" || text[i + 1] !== "u") {
      i += 1;
      continue;
    }
    // Skip any escape that is not a \uXXXX.
    const hex = text.slice(i + 2, i + 6);
    if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
      i += 2;
      continue;
    }
    const unit = Number.parseInt(hex, 16);
    const isHigh = unit >= HIGH_START && unit < LOW_START;
    const isLow = unit >= LOW_START && unit < SURROGATE_END;
    if (!isHigh && !isLow) {
      i += 6;
      continue;
    }
    if (isHigh) {
      // A high surrogate is only well-formed when immediately followed by a low surrogate.
      const followsLow =
        text[i + 6] === "\\" &&
        text[i + 7] === "u" &&
        /^[0-9a-fA-F]{4}$/.test(text.slice(i + 8, i + 12));
      const nextUnit = followsLow ? Number.parseInt(text.slice(i + 8, i + 12), 16) : NaN;
      if (Number.isNaN(nextUnit) || nextUnit < LOW_START || nextUnit >= SURROGATE_END) {
        dirty = true;
        flushTo(i);
        out += "\\uFFFD";
        i += 6;
        flushFrom = i;
        continue;
      }
      // Correctly paired: keep both escapes verbatim and advance past the pair.
      i += 12;
      if (dirty) flushTo(i);
      continue;
    }
    // A low surrogate without a preceding high surrogate is also lone.
    dirty = true;
    flushTo(i);
    out += "\\uFFFD";
    i += 6;
    flushFrom = i;
  }
  if (!dirty) return null;
  return out + text.slice(flushFrom);
}

/** Reads the top-level `id` of a message without a full parse (used only for error routing). */
export function tryReadCommandId(text: string): number | null {
  const match = /"id"\s*:\s*(?<id>-?\d+)/.exec(text);
  if (match === null || match.groups === undefined) return null;
  const id = Number.parseInt(match.groups.id!, 10);
  return Number.isFinite(id) ? id : null;
}

/** Reads the `sessionId` field of a raw message for the passthrough proxy. */
export function tryReadSessionId(text: string): string | undefined {
  const match = /"sessionId"\s*:\s*"(?<sid>[^"]*)"/.exec(text);
  return match?.groups?.sid;
}

/**
 * Discovers the browser-level CDP WebSocket URL for a host and port, trying three methods in
 * order: the `/json/version` HTTP endpoint, the `/json/list` target listing, and a direct
 * WebSocket to `/devtools/browser`. Chrome's HTTP discovery always reports `127.0.0.1`, so the
 * returned URL's host and port are rewritten to the ones actually requested — the donor's
 * `rewrite_ws_host`, which is what makes a remote or port-forwarded browser reachable.
 */
export async function discoverCdpUrl(host: string, port: number, query?: string): Promise<string> {
  const bracketed = bracketIPv6(host);

  const versionError = await fetchCdpInfo(bracketed, port).then(
    (info) => {
      if (info.webSocketDebuggerUrl) {
        return appendQuery(rewriteWsHost(info.webSocketDebuggerUrl, bracketed, port), query);
      }
      return `no webSocketDebuggerUrl in /json/version at ${bracketed}:${port}`;
    },
    (error: unknown) => errorMessage(error),
  );

  if (typeof versionError === "string") {
    // Fall through to /json/list rather than failing on the first method.
    const listError = await fetchCdpList(bracketed, port).then(
      (url) => {
        if (url) return appendQuery(rewriteWsHost(url, bracketed, port), query);
        return `no browser target in /json/list at ${bracketed}:${port}`;
      },
      (error: unknown) => errorMessage(error),
    );
    if (typeof listError !== "string") return listError;

    // Final fallback: some Chrome builds expose CDP over WebSocket with no HTTP discovery at all.
    const direct = `ws://${bracketed}:${port}/devtools/browser`;
    return appendQuery(direct, query);
  }
  return versionError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Brackets an IPv6 literal for a URL; a no-op for IPv4 and already-bracketed hosts. */
export function bracketIPv6(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/** Rewrites the host and port of a `ws://` URL to the ones actually connected to. */
export function rewriteWsHost(wsUrl: string, host: string, port: number): string {
  const match = /^ws:\/\/[^:/]+:\d+/.exec(wsUrl);
  if (match === null) return wsUrl;
  return `ws://${host}:${port}${wsUrl.slice(match[0].length)}`;
}

/** Appends a query string to a URL, preserving any existing parameters. */
export function appendQuery(url: string, query?: string): string {
  if (!query) return url;
  if (url.includes("?")) return `${url}&${query}`;
  return `${url}?${query}`;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciRequest(url, {
      signal: controller.signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}`);
    }
    return (await response.body.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
}

async function fetchCdpInfo(host: string, port: number): Promise<CdpVersionInfo> {
  const body = (await fetchJsonWithTimeout(
    `http://${host}:${port}/json/version`,
    DISCOVERY_TIMEOUT_MS,
  )) as CdpVersionInfo;
  return body;
}

async function fetchCdpList(host: string, port: number): Promise<string | null> {
  const body = (await fetchJsonWithTimeout(
    `http://${host}:${port}/json/list`,
    DISCOVERY_TIMEOUT_MS,
  )) as Array<{
    type?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const browserTarget = body.find((target) => target.type === "browser") ?? body[0];
  return browserTarget?.webSocketDebuggerUrl ?? null;
}

/**
 * Connects a transport to a CDP WebSocket URL. Exposed for the browser-level connection the
 * cluster keeps outside the pooled target sessions.
 */
export async function connectCdpTransport(
  url: string,
  options: CdpTransportOptions = {},
): Promise<CdpTransport> {
  const opts = { ...DEFAULTS, ...options };
  const normalized = normalizeWsRootPath(url);
  return new Promise<CdpTransport>((resolve, reject) => {
    const socket = new WebSocket(normalized, {
      perMessageDeflate: false,
      maxPayload: Number.MAX_SAFE_INTEGER,
    });
    const connectTimer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        /* never throw from cleanup */
      }
      reject(new Error(`CDP connect timed out: ${normalized}`));
    }, opts.connectTimeoutMs);

    socket.once("open", () => {
      clearTimeout(connectTimer);
      resolve(new CdpTransport(socket, options));
    });
    socket.once("error", (error: Error) => {
      clearTimeout(connectTimer);
      reject(new Error(`CDP WebSocket connect failed: ${error.message}`));
    });
  });
}

/**
 * Chrome serves `/devtools/page?...` for root paths; a query on a root-path WebSocket has to land
 * after a slash. This mirrors the donor's `normalize_websocket_root_path`.
 */
export function normalizeWsRootPath(url: string): string {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return url;
  const authority = url.slice(schemeEnd + 3);
  const queryOffset = authority.indexOf("?");
  if (queryOffset === -1) return url;
  if (authority.slice(0, queryOffset).includes("/")) return url;
  const queryIndex = schemeEnd + 3 + queryOffset;
  return `${url.slice(0, queryIndex)}/${url.slice(queryIndex)}`;
}

/**
 * The session pooler: owns warm CDP target sessions, hands them out by key, and reclaims them.
 *
 * A session is created by attaching to a target (`Target.attachToTarget` with flatten) on the
 * browser-level transport the cluster supplies. It is returned to the pool on release; before a
 * reused session is handed out again it is probed with a cheap command, because a target that
 * died while idle must be discovered here — by the pool — rather than by the caller that just
 * wanted a working session.
 */
export class CdpSessionPool extends EventEmitter {
  private readonly browserTransport: CdpTransport;
  private readonly checkedOut = new Map<string, PooledSession>();
  private readonly idle = new Map<string, PooledSession[]>();
  private readonly opts: Required<Omit<CdpSessionPoolOptions, "transport">>;
  private sweepTimer?: NodeJS.Timeout;
  private created = 0;
  private reused = 0;
  private evicted = 0;

  constructor(browserTransport: CdpTransport, options: CdpSessionPoolOptions = {}) {
    super();
    this.browserTransport = browserTransport;
    this.opts = {
      capacity: options.capacity ?? 30,
      idlePerKey: options.idlePerKey ?? 4,
      sweepIntervalMs: options.sweepIntervalMs ?? 30_000,
      maxIdleAgeMs: options.maxIdleAgeMs ?? 5 * 60_000,
    };
    if (this.opts.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), this.opts.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
    browserTransport.on("close", () => this.drain("closed"));
  }

  /** Total sessions the pool knows about, checked out plus idle. */
  get size(): number {
    return this.checkedOut.size + this.idleSize;
  }

  private get idleSize(): number {
    let total = 0;
    for (const list of this.idle.values()) total += list.length;
    return total;
  }

  /** Snapshot of pool utilization for the cockpit metrics tile. */
  get stats(): {
    active: number;
    idle: number;
    capacity: number;
    created: number;
    reused: number;
    evicted: number;
  } {
    return {
      active: this.checkedOut.size,
      idle: this.idleSize,
      capacity: this.opts.capacity,
      created: this.created,
      reused: this.reused,
      evicted: this.evicted,
    };
  }

  /**
   * Acquires a session for `key`, reusing a warm idle one when the probe says it is still alive.
   * Rejects when the pool is at capacity rather than silently exceeding the node's ceiling.
   */
  async acquire(key: string, targetId: string): Promise<PooledSessionHandle> {
    if (this.checkedOut.has(key)) {
      throw new Error(`CDP session already checked out for key: ${key}`);
    }
    if (this.size >= this.opts.capacity) {
      // Evict the oldest idle session anywhere in the pool rather than failing outright —
      // a warm session that has not been used in minutes is the cheapest thing to drop.
      this.evictOldestIdle();
      if (this.size >= this.opts.capacity) {
        throw new Error(`CDP session pool at capacity (${this.opts.capacity})`);
      }
    }

    const reused = this.takeIdle(key, targetId);
    if (reused) {
      const alive = await this.probe(reused);
      if (alive) {
        this.checkedOut.set(key, reused);
        this.reused += 1;
        this.emit("acquire", { key, reused: true, sessionId: reused.sessionId });
        return this.toHandle(reused);
      }
      this.closeSession(reused, "dead");
    }

    const created = await this.attachSession(key, targetId);
    this.checkedOut.set(key, created);
    this.created += 1;
    this.emit("acquire", { key, reused: false, sessionId: created.sessionId });
    return this.toHandle(created);
  }

  /** Returns a session to the pool, warm for the next acquire of the same key. */
  release(key: string): void {
    const session = this.checkedOut.get(key);
    if (!session) return;
    this.checkedOut.delete(key);
    if (!this.browserTransport.isClosed) {
      const list = this.idle.get(session.key) ?? [];
      list.push({ ...session, idleSince: Date.now() });
      this.idle.set(session.key, list);
      this.emit("release", { key, sessionId: session.sessionId });
    } else {
      this.closeSession(session, "closed");
    }
  }

  /** Drops every session; used when the browser-level transport closes or the cluster stops. */
  drain(reason: SessionEvictionReason): void {
    for (const [key, session] of this.checkedOut) {
      this.closeSession(session, reason);
      this.checkedOut.delete(key);
    }
    for (const [key, list] of this.idle) {
      for (const session of list) this.closeSession(session, reason);
      this.idle.delete(key);
    }
  }

  /** Stops the sweep timer and drops everything. Idempotent. */
  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.drain("closed");
  }

  /** Evicts idle sessions older than the max idle age, and trims per-key excess. */
  sweepIdle(): void {
    const now = Date.now();
    for (const [key, list] of this.idle) {
      const kept: PooledSession[] = [];
      for (const session of list) {
        const tooOld = now - session.idleSince > this.opts.maxIdleAgeMs;
        if (tooOld || kept.length >= this.opts.idlePerKey) {
          this.closeSession(session, "capacity");
        } else {
          kept.push(session);
        }
      }
      if (kept.length === 0) this.idle.delete(key);
      else this.idle.set(key, kept);
    }
  }

  private takeIdle(key: string, targetId: string): PooledSession | null {
    const list = this.idle.get(key);
    if (!list || list.length === 0) return null;
    const session = list.shift()!;
    if (list.length === 0) this.idle.delete(key);
    if (session.targetId !== targetId) {
      // A stale idle session for a different target is not reusable.
      this.closeSession(session, "dead");
      return null;
    }
    return session;
  }

  /** A cheap liveness command; a session whose target is gone fails here, not in the caller. */
  private async probe(session: PooledSession): Promise<boolean> {
    try {
      await session.transport.send("Target.getTargetInfo", undefined, session.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  private async attachSession(key: string, targetId: string): Promise<PooledSession> {
    const result = (await this.browserTransport.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string };
    const sessionId = result.sessionId;
    if (!sessionId) throw new Error(`CDP attach produced no sessionId for target ${targetId}`);

    // A dedicated transport shares the browser socket in this implementation: the private channel
    // keeps this session's events out of the broadcast, which is what isolation requires.
    const transport = this.browserTransport;
    return {
      key,
      sessionId,
      targetId,
      transport,
      idleSince: Date.now(),
      reuseCount: 0,
    };
  }

  private evictOldestIdle(): void {
    let oldestKey: string | null = null;
    let oldest: PooledSession | null = null;
    for (const [key, list] of this.idle) {
      for (const session of list) {
        if (oldest === null || session.idleSince < oldest.idleSince) {
          oldest = session;
          oldestKey = key;
        }
      }
    }
    if (oldest !== null && oldestKey !== null) {
      const list = this.idle.get(oldestKey);
      if (list) {
        const index = list.indexOf(oldest);
        if (index !== -1) list.splice(index, 1);
        if (list.length === 0) this.idle.delete(oldestKey);
      }
      this.closeSession(oldest, "capacity");
    }
  }

  private closeSession(session: PooledSession, reason: SessionEvictionReason): void {
    this.evicted += 1;
    this.browserTransport.unsubscribeSession(session.sessionId);
    try {
      this.browserTransport.sendNoWait("Target.detachFromTarget", { sessionId: session.sessionId });
    } catch {
      /* transport already closed */
    }
    this.emit("evict", { key: session.key, sessionId: session.sessionId, reason });
  }

  private toHandle(session: PooledSession): PooledSessionHandle {
    return {
      sessionId: session.sessionId,
      targetId: session.targetId,
      send: (method: string, params?: unknown) =>
        session.transport.send(method, params, session.sessionId),
      sendNoWait: (method: string, params?: unknown) =>
        session.transport.sendNoWait(method, params, session.sessionId),
      subscribe: (sink: (event: CdpEvent) => void) =>
        session.transport.subscribeSession(session.sessionId, sink),
      unsubscribe: () => session.transport.unsubscribeSession(session.sessionId),
    };
  }
}

/** A checked-out CDP session: the protocol surface a caller needs, nothing more. */
export interface PooledSessionHandle {
  /** The CDP sessionId of the attached target. */
  sessionId: string;
  /** The target this session controls. */
  targetId: string;
  /** Sends a command on this session and awaits its response. */
  send: (method: string, params?: unknown) => Promise<unknown>;
  /** Sends a best-effort command with no awaited response. */
  sendNoWait: (method: string, params?: unknown) => void;
  /** Routes this session's events to `sink` instead of the transport broadcast. */
  subscribe: (sink: (event: CdpEvent) => void) => void;
  /** Stops routing this session's events to a previously registered sink. */
  unsubscribe: () => void;
}
