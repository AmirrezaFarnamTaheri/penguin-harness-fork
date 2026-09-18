/**
 * Track 1, Tier 2: the CDP transport and session pooler, exercised end to end against a real
 * in-process WebSocket server that speaks the CDP text protocol.
 *
 * A fake transport would only assert that the code calls its own fakes. The failure modes this
 * module exists for — a response routed to the wrong waiter, a pending entry leaking on
 * timeout, a lone-surrogate message dropped instead of repaired, a broadcast channel
 * overflowing because a screencast flooded it — are all protocol-level, so the test drives a
 * real socket and lets the framing land where the production code does.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendQuery,
  bracketIPv6,
  CdpSessionPool,
  CdpTransport,
  connectCdpTransport,
  discoverCdpUrl,
  normalizeWsRootPath,
  repairLoneSurrogates,
  rewriteWsHost,
  tryReadCommandId,
  tryReadSessionId,
} from "../../../src/sandbox/browser/cdp-session-pool.js";

/** A CDP-shaped server: answers commands by id, and can push events on demand. */
class FakeCdpServer {
  readonly http: Server;
  readonly wss: WebSocketServer;
  socket: WebSocket | null = null;
  /** Commands the server received, in order. */
  readonly received: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> =
    [];
  /** Methods the server deliberately never answers, for the timeout path. */
  readonly ignored: Set<string> = new Set();
  private failNext = false;

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => {
        const text = data.toString("utf-8");
        try {
          const command = JSON.parse(text) as {
            id: number;
            method: string;
            params?: unknown;
            sessionId?: string;
          };
          this.received.push(command);
          if (this.ignored.has(command.method)) {
            // A command the server never answers: the transport's own timeout must fire.
            return;
          }
          if (command.method === "Target.attachToTarget") {
            // Real Chrome answers attach with the new session id, which the pool keys on.
            socket.send(JSON.stringify({ id: command.id, result: { sessionId: "sess-attached" } }));
            return;
          }
          if (command.method === "Target.getTargetInfo") {
            if (this.failNext) {
              this.failNext = false;
              socket.send(JSON.stringify({ id: command.id, error: { message: "target closed" } }));
              return;
            }
            socket.send(
              JSON.stringify({ id: command.id, result: { targetInfo: { targetId: "t1" } } }),
            );
            return;
          }
          if (command.method === "echo.params") {
            socket.send(JSON.stringify({ id: command.id, result: command.params ?? {} }));
            return;
          }
          socket.send(JSON.stringify({ id: command.id, result: {} }));
        } catch {
          /* the malformed-response test deliberately sends unparsable text */
        }
      });
    });
  }

  async listen(): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(0, "127.0.0.1", () => {
        const address = this.http.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  pushEvent(method: string, params: unknown, sessionId?: string): void {
    this.socket?.send(JSON.stringify({ method, params, sessionId }));
  }

  /** The next probe command fails, which is how the pool discovers a dead idle session. */
  failNextProbe(): void {
    this.failNext = true;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.http.close(() => resolve());
      });
    });
  }
}

describe("TRK-01-init / cdp transport", () => {
  let server: FakeCdpServer;
  let port: number;
  let transport: CdpTransport;

  beforeAll(async () => {
    server = new FakeCdpServer();
    port = await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    transport?.close();
  });

  it("connects over a real socket and routes a command response to its waiter", async () => {
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    const result = await transport.send("echo.params", { hello: "world" });
    expect(result).toEqual({ hello: "world" });
    expect(server.received.at(-1)?.method).toBe("echo.params");
  });

  it("rejects a failed command as an error rather than hanging", async () => {
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    await expect(transport.send("Target.getTargetInfo")).resolves.toBeDefined();
  });

  it("delivers events to subscribers and keeps the raw passthrough for an inspect proxy", async () => {
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    const events: Array<{ method: string; sessionId?: string }> = [];
    const raw: string[] = [];
    transport.on("event", (event) => events.push(event));
    transport.on("raw", (message) => raw.push(message.text));
    await transport.send("Runtime.enable");
    server.pushEvent("Runtime.executionContextCreated", { id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.map((event) => event.method)).toContain("Runtime.executionContextCreated");
    expect(raw.length).toBeGreaterThan(0);
  });

  it("routes a session-scoped event to its private channel instead of the broadcast", async () => {
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    const privateEvents: string[] = [];
    const broadcast: string[] = [];
    transport.on("event", (event) => broadcast.push(event.method));
    transport.subscribeSession("sess-1", (event) => privateEvents.push(event.method));
    server.pushEvent("Page.screencastFrame", { data: "" }, "sess-1");
    server.pushEvent("Target.targetCreated", {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(privateEvents).toContain("Page.screencastFrame");
    expect(broadcast).not.toContain("Page.screencastFrame");
    expect(broadcast).toContain("Target.targetCreated");
  });

  it("drops no waiter on timeout and leaves no pending entry behind", async () => {
    server.ignored.add("never.answered");
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`, {
      commandTimeoutMs: 60,
    });
    const before = transport.pendingCount;
    await expect(transport.send("never.answered")).rejects.toThrow(/timed out/);
    expect(transport.pendingCount).toBe(before);
  });

  it("closes cleanly and rejects commands sent after close", async () => {
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    await transport.send("Runtime.enable");
    transport.close();
    expect(transport.isClosed).toBe(true);
    await expect(transport.send("Runtime.disable")).rejects.toThrow(/closed/);
  });
});

describe("TRK-01-fault / cdp transport resilience", () => {
  let server: FakeCdpServer;
  let port: number;

  beforeAll(async () => {
    server = new FakeCdpServer();
    port = await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  it("treats a malformed response as the failure of its own command, not the connection", async () => {
    const transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    try {
      // An unparsable body carrying a positive id must resolve that one waiter with an error
      // while the socket stays usable for the next command.
      server.socket?.send('{"id": 4242, "result": not-json}');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = await transport.send("echo.params", { after: "garbage" });
      expect(result).toEqual({ after: "garbage" });
    } finally {
      transport.close();
    }
  });

  it("fails the connect promise when the target is unreachable", async () => {
    await expect(
      connectCdpTransport("ws://127.0.0.1:1/devtools/browser", { connectTimeoutMs: 200 }),
    ).rejects.toThrow(/connect failed|timed out/);
  });
});

describe("TRK-01-init / cdp session pool", () => {
  let server: FakeCdpServer;
  let port: number;
  let transport: CdpTransport;
  let pool: CdpSessionPool;

  beforeEach(async () => {
    server = new FakeCdpServer();
    port = await server.listen();
    transport = await connectCdpTransport(`ws://127.0.0.1:${port}/devtools/browser`);
    pool = new CdpSessionPool(transport, { capacity: 8, idlePerKey: 2, sweepIntervalMs: 0 });
  });

  afterEach(async () => {
    pool.close();
    transport.close();
    await server.close();
  });

  it("attaches a fresh session on first acquire and reports it active", async () => {
    const handle = await pool.acquire("session-a", "t1");
    expect(handle.sessionId).toBe("sess-attached");
    expect(handle.targetId).toBe("t1");
    expect(pool.stats.active).toBe(1);
    expect(pool.stats.created).toBe(1);
    pool.release("session-a");
    expect(pool.stats.active).toBe(0);
    expect(pool.stats.idle).toBe(1);
  });

  it("reuses a warm idle session instead of attaching again", async () => {
    const first = await pool.acquire("session-b", "t1");
    pool.release("session-b");
    const second = await pool.acquire("session-b", "t1");
    expect(second.sessionId).toBe(first.sessionId);
    expect(pool.stats.reused).toBe(1);
    expect(pool.stats.created).toBe(1);
  });

  it("discards an idle session whose probe fails and attaches a replacement", async () => {
    await pool.acquire("session-c", "t1");
    pool.release("session-c");
    server.failNextProbe();
    const handle = await pool.acquire("session-c", "t1");
    expect(handle.sessionId).toBe("sess-attached");
    expect(pool.stats.evicted).toBe(1);
  });

  it("refuses to exceed the configured capacity", async () => {
    const small = new CdpSessionPool(transport, { capacity: 1, idlePerKey: 1, sweepIntervalMs: 0 });
    await small.acquire("k1", "t1");
    await expect(small.acquire("k2", "t1")).rejects.toThrow(/capacity/);
    small.close();
  });

  it("drains every session when the browser transport closes", async () => {
    await pool.acquire("session-d", "t1");
    transport.close();
    expect(pool.stats.active + pool.stats.idle).toBe(0);
  });
});

describe("cdp discovery and url handling", () => {
  it("brackets IPv6 literals and leaves IPv4 alone", () => {
    expect(bracketIPv6("::1")).toBe("[::1]");
    expect(bracketIPv6("[::1]")).toBe("[::1]");
    expect(bracketIPv6("127.0.0.1")).toBe("127.0.0.1");
  });

  it("rewrites the host and port of a discovered ws url to the requested ones", () => {
    expect(rewriteWsHost("ws://127.0.0.1:9222/devtools/browser/abc", "10.0.0.5", 9333)).toBe(
      "ws://10.0.0.5:9333/devtools/browser/abc",
    );
  });

  it("appends a query preserving existing parameters", () => {
    expect(appendQuery("ws://h:1/x", "mode=Hello")).toBe("ws://h:1/x?mode=Hello");
    expect(appendQuery("ws://h:1/x?a=1", "b=2")).toBe("ws://h:1/x?a=1&b=2");
  });

  it("normalizes a root-path websocket url so its query lands after a slash", () => {
    expect(normalizeWsRootPath("ws://h:1?mode=Hello")).toBe("ws://h:1/?mode=Hello");
    expect(normalizeWsRootPath("ws://h:1/page?id=1?mode=Hello")).toBe(
      "ws://h:1/page?id=1?mode=Hello",
    );
  });

  it("falls back to a direct websocket url when http discovery is unavailable", async () => {
    const url = await discoverCdpUrl("127.0.0.1", 1);
    expect(url).toBe("ws://127.0.0.1:1/devtools/browser");
  });

  it("reads a command id from an otherwise unparsable message", () => {
    expect(tryReadCommandId('{"id": 7, garbage')).toBe(7);
    expect(tryReadCommandId("no json at all")).toBeNull();
  });

  it("reads the sessionId field of a raw message", () => {
    expect(tryReadSessionId('{"method":"x","sessionId":"abc"}')).toBe("abc");
    expect(tryReadSessionId('{"method":"x"}')).toBeUndefined();
  });

  it("repairs a lone high surrogate and leaves a correct pair untouched", () => {
    expect(repairLoneSurrogates('{"v":"\\uD83C"}')).toBe('{"v":"\\uFFFD"}');
    expect(repairLoneSurrogates('{"v":"\\uD83D\\uDE00"}')).toBeNull();
    expect(repairLoneSurrogates('{"ok":1}')).toBeNull();
  });
});
