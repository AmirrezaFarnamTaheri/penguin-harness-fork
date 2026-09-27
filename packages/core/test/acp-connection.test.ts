import { describe, expect, it, vi } from "vitest";
import {
  AcpConnection,
  type AcpDiagnostic,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/kernel/acp.js";

/** UTF-8 size of a wire frame, matching what the connection accounts for. */
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * A notification frame whose *content* — the JSON text, not the trailing delimiter, which
 * is what `maxFrameBytes` bounds — is exactly `contentBytes` UTF-8 bytes.
 */
function notificationOfBytes(contentBytes: number): string {
  const base = `${JSON.stringify({ jsonrpc: "2.0", method: "m", params: "" })}`;
  const pad = contentBytes - utf8Bytes(base);
  if (pad < 0) throw new Error(`frame cannot be ${contentBytes} bytes`);
  return `${JSON.stringify({ jsonrpc: "2.0", method: "m", params: "x".repeat(pad) })}\n`;
}

const responseLine = (id: string | number, result: unknown): string =>
  `${JSON.stringify({ jsonrpc: "2.0", id, result } satisfies JsonRpcResponse)}\n`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("AcpConnection", () => {
  it("sends requests and correlates responses", async () => {
    let sentLine = "";
    let serverConn: AcpConnection;

    const clientConn = new AcpConnection(async (line) => {
      sentLine = line;
      // Server receives client line
      await serverConn.handleChunk(line);
    });

    serverConn = new AcpConnection(async (line) => {
      // Client receives server response line
      await clientConn.handleChunk(line);
    });

    serverConn.onRequest("initialize", (params: { clientName: string }) => {
      return { serverName: "penguin-harness", receivedClient: params.clientName };
    });

    const res = await clientConn.sendRequest<{ serverName: string; receivedClient: string }>(
      "initialize",
      { clientName: "claurst-test" },
    );

    expect(res.serverName).toBe("penguin-harness");
    expect(res.receivedClient).toBe("claurst-test");
  });

  it("dispatches notifications without expecting responses", async () => {
    let notifiedValue = "";
    const clientConn = new AcpConnection(async (line) => {
      await serverConn.handleChunk(line);
    });
    const serverConn = new AcpConnection(async (line) => {
      await clientConn.handleChunk(line);
    });

    serverConn.onNotification("session/progress", (params: { text: string }) => {
      notifiedValue = params.text;
    });

    clientConn.sendNotification("session/progress", { text: "working..." });
    await new Promise((r) => setTimeout(r, 10));

    expect(notifiedValue).toBe("working...");
  });

  it("returns method not found error on unknown methods", async () => {
    let serverConn: AcpConnection;
    const clientConn = new AcpConnection(async (line) => {
      await serverConn.handleChunk(line);
    });
    serverConn = new AcpConnection(async (line) => {
      await clientConn.handleChunk(line);
    });

    await expect(clientConn.sendRequest("nonexistent/method")).rejects.toThrow(
      "ACP Error -32601: Method 'nonexistent/method' not found",
    );
  });

  it("immediately rejects request if transport throws or rejects", async () => {
    const brokenConn = new AcpConnection(async () => {
      throw new Error("Socket connection closed abruptly");
    });

    await expect(brokenConn.sendRequest("ping")).rejects.toThrow(
      "Socket connection closed abruptly",
    );
  });

  // --- finding 1: the connection can never recover -------------------------------
  it("recovers end to end: fail, reattach a transport, serve again", async () => {
    let transportDead = true;
    const written: string[] = [];
    const conn = new AcpConnection(async (line) => {
      if (transportDead) throw new Error("Socket connection closed abruptly");
      written.push(line);
    }, 5_000);

    await expect(conn.sendRequest("initialize")).rejects.toThrow(
      "Socket connection closed abruptly",
    );
    expect(conn.getState()).toBe("failed");
    expect(conn.getStats().lastFailureMessage).toBe("Socket connection closed abruptly");

    // A failed connection refuses further writes with the recorded cause rather than
    // inventing a new one per call.
    await expect(conn.sendRequest("initialize")).rejects.toThrow(
      "Socket connection closed abruptly",
    );
    // One write reached the transport and failed; a refusal is not a second failure.
    expect(conn.getStats().transportFailures).toBe(1);

    transportDead = false;
    conn.reattachTransport(async (line) => {
      written.push(line);
    });
    expect(conn.getState()).toBe("open");
    expect(conn.getStats().generation).toBe(2);
    expect(conn.getStats().recoveries).toBe(1);

    // The recovered connection serves normally.
    const served = conn.sendRequest<{ ok: boolean }>("initialize");
    await vi.waitFor(() => expect(written).toHaveLength(1));
    const sent = JSON.parse(written[0] ?? "") as JsonRpcRequest;
    await conn.handleChunk(responseLine(sent.id, { ok: true }));
    await expect(served).resolves.toEqual({ ok: true });
    expect(conn.getStats().recoveries).toBe(1);
  });

  it("gives in-flight requests a defined fate on reattach: failed loudly, never dropped", async () => {
    const conn = new AcpConnection(async () => {}, 60_000);
    const request = conn.sendRequest("session/prompt", { text: "hi" });
    expect(conn.getStats().pendingRequests).toBe(1);

    conn.reattachTransport(async () => {});

    await expect(request).rejects.toThrow("ACP transport was replaced before the response");
    expect(conn.getStats().pendingRequests).toBe(0);
    // The recovered connection is immediately usable, and a response for the dead
    // generation's id cannot resolve anything on the new one.
    const fresh = conn.sendRequest("session/prompt");
    await conn.handleChunk(responseLine(1, "stray"));
    expect(conn.getStats().droppedLateResponses).toBe(1);
    void fresh.catch(() => undefined);
    conn.dispose();
  });

  it("records a transport the host already knows is dead", async () => {
    const conn = new AcpConnection(async () => {}, 5_000);
    expect(conn.getState()).toBe("open");

    conn.markTransportFailed(new Error("child process exited with code 1"));

    expect(conn.getState()).toBe("failed");
    await expect(conn.sendRequest("x")).rejects.toThrow("child process exited with code 1");
    expect(conn.getStats().transportFailures).toBe(1);
  });

  // --- finding 2: unbounded lineBuffer -------------------------------------------
  it("enforces the frame bound at the boundary and resynchronises the stream", async () => {
    const diagnostics: AcpDiagnostic[] = [];
    const limit = 200;
    const conn = new AcpConnection(async () => {}, 5_000, {
      maxFrameBytes: limit,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const seen: string[] = [];
    conn.onNotification("m", () => {
      seen.push("m");
    });

    // Exactly at the bound: accepted, and nothing is left retained.
    await conn.handleChunk(notificationOfBytes(limit));
    expect(seen).toHaveLength(1);
    expect(conn.getStats().oversizedFrames).toBe(0);
    expect(conn.getStats().malformedFrames).toBe(0);
    expect(conn.getStats().bufferedBytes).toBe(0);

    // One byte over: the frame is dropped whole, counted, and the connection survives.
    await conn.handleChunk(notificationOfBytes(limit + 1));
    expect(seen).toHaveLength(1);
    expect(conn.getStats().oversizedFrames).toBe(1);
    expect(conn.getStats().bufferedBytes).toBe(0);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("oversized-frame");

    // The frames after it still flow.
    await conn.handleChunk(notificationOfBytes(limit));
    expect(seen).toHaveLength(2);
    expect(conn.getState()).toBe("open");
  });

  it("bounds an unterminated stream instead of growing the buffer", async () => {
    const limit = 4_096;
    const conn = new AcpConnection(async () => {}, 5_000, {
      maxFrameBytes: limit,
      // Generous enough that the resync budget is not what stops the peer here; the
      // buffer bound alone has to hold.
      maxResyncBytes: 32 * 1024 * 1024,
    });

    // 20 MiB with no newline at all, delivered in 100 KiB chunks: a peer that never
    // terminates a frame must not be able to grow retained bytes without limit.
    for (let chunk = 0; chunk < 200; chunk++) {
      await conn.handleChunk("a".repeat(100_000));
      expect(conn.getStats().bufferedBytes).toBeLessThanOrEqual(limit);
    }
    expect(conn.getStats().bytesReceived).toBe(20_000_000);
    expect(conn.getStats().framesReceived).toBe(0);
    expect(conn.getStats().oversizedFrames).toBeGreaterThan(0);
    expect(conn.getStats().state).toBe("open");

    // The newline finally arrives, and the stream picks up from the next frame.
    const seen: string[] = [];
    conn.onNotification("after", () => seen.push("after"));
    await conn.handleChunk("a".repeat(100_000) + '\n{"jsonrpc":"2.0","method":"after"}\n');
    expect(seen).toEqual(["after"]);
    expect(conn.getStats().bufferedBytes).toBe(0);
  });

  it("fails a stream that exceeds the resync budget, and recovers on reattach", async () => {
    const conn = new AcpConnection(async () => {}, 5_000, {
      maxFrameBytes: 1_024,
      maxResyncBytes: 4_096,
    });

    for (let chunk = 0; chunk < 40; chunk++) {
      await conn.handleChunk("b".repeat(1_024));
    }

    expect(conn.getState()).toBe("failed");
    expect(conn.getStats().lastFailureMessage).toMatch(/not line-delimited/);
    await expect(conn.sendRequest("x")).rejects.toThrow("not line-delimited");

    const seen: string[] = [];
    conn.reattachTransport(async () => {});
    conn.onNotification("after", () => seen.push("after"));
    await conn.handleChunk('{"jsonrpc":"2.0","method":"after"}\n');
    expect(seen).toEqual(["after"]);
  });

  it("refuses a frame limit that could not bound anything", () => {
    expect(() => new AcpConnection(async () => {}, 5_000, { maxFrameBytes: 0 })).toThrow(
      RangeError,
    );
    expect(() => new AcpConnection(async () => {}, 5_000, { maxFrameBytes: 1.5 })).toThrow(
      RangeError,
    );
  });

  // --- finding 3: a late response vanishes without trace --------------------------
  it("counts a response that arrives after its request timed out", async () => {
    const conn = new AcpConnection(async () => {}, 20);

    await expect(conn.sendRequest("slow")).rejects.toThrow("timed out after 20ms");
    expect(conn.getStats().requestTimeouts).toBe(1);
    expect(conn.getStats().droppedLateResponses).toBe(0);

    await conn.handleChunk(responseLine(1, "too late"));

    const stats = conn.getStats();
    // Ignoring an unknown id is what JSON-RPC asks for; ignoring it *unreported* is
    // what made a systematic desync invisible.
    expect(stats.droppedLateResponses).toBe(1);
    expect(stats.framesReceived).toBe(1);
    expect(stats.state).toBe("open");
  });

  it("reports every counted anomaly to the diagnostic sink", async () => {
    const diagnostics: AcpDiagnostic[] = [];
    const collect = (diagnostic: AcpDiagnostic): void => {
      diagnostics.push(diagnostic);
    };

    // A healthy transport, so the request reaches its timeout instead of having the
    // transport fail under it first.
    const patient = new AcpConnection(async () => {}, 20, { onDiagnostic: collect });
    await expect(patient.sendRequest("slow")).rejects.toThrow("timed out after 20ms");
    await patient.handleChunk("{not json\n");
    await patient.handleChunk(responseLine(99, "orphan"));
    patient.dispose();

    // A dead transport, for the two write-failure paths.
    const broken = new AcpConnection(
      async () => {
        throw new Error("EPIPE");
      },
      5_000,
      { onDiagnostic: collect },
    );
    await broken.sendNotification("session/progress");
    await expect(broken.sendRequest("x")).rejects.toThrow("EPIPE");

    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("request-timeout");
    expect(codes).toContain("malformed-frame");
    expect(codes).toContain("late-response");
    expect(codes).toContain("notification-write-failed");
    expect(codes).toContain("transport-failed");
    for (const diagnostic of diagnostics) {
      expect(diagnostic.generation).toBeGreaterThanOrEqual(1);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
  });

  // --- finding 4: malformed input swallowed with no record -------------------------
  it("counts malformed frames instead of swallowing them", async () => {
    const conn = new AcpConnection(async () => {}, 5_000);
    const seen: string[] = [];
    conn.onNotification("good", () => seen.push("good"));

    await conn.handleChunk("{not json\n");
    await conn.handleChunk("}\n");
    await conn.handleChunk("[1, 2, 3\n");

    expect(conn.getStats().malformedFrames).toBe(3);
    expect(conn.getStats().framesReceived).toBe(3);

    // A good frame behind the garbage is still delivered.
    await conn.handleChunk('{"jsonrpc":"2.0","method":"good"}\n');
    expect(seen).toEqual(["good"]);
    expect(conn.getState()).toBe("open");
  });

  it("surfaces a handler's own SyntaxError instead of blaming the peer", async () => {
    const conn = new AcpConnection(async () => {}, 5_000);
    conn.onNotification("boom", () => {
      throw new SyntaxError("handler bug, not a bad frame");
    });

    await expect(conn.handleChunk('{"jsonrpc":"2.0","method":"boom"}\n')).rejects.toThrow(
      "handler bug, not a bad frame",
    );
    // The peer sent a perfectly valid frame; counting it as malformed would be a lie.
    expect(conn.getStats().malformedFrames).toBe(0);
  });

  // --- finding 5: no write ordering, notification errors discarded ----------------
  it("writes concurrent requests in the order they were issued", async () => {
    const arrival: string[] = [];
    // Delays inverted against issue order: without a write queue the last request
    // written would reach the transport first.
    const delays: Record<string, number> = { alpha: 30, beta: 10, gamma: 0 };
    const conn = new AcpConnection(async (line) => {
      const request = JSON.parse(line) as JsonRpcRequest;
      await sleep(delays[request.method] ?? 0);
      arrival.push(request.method);
      await conn.handleChunk(responseLine(request.id, request.method));
    });

    const results = await Promise.all([
      conn.sendRequest("alpha"),
      conn.sendRequest("beta"),
      conn.sendRequest("gamma"),
    ]);

    expect(arrival).toEqual(["alpha", "beta", "gamma"]);
    expect(results).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not let a failed write wedge the frames queued behind it", async () => {
    let attempt = 0;
    const conn = new AcpConnection(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("EPIPE");
    });
    conn.onRequest("noop", () => null);

    await expect(conn.sendNotification("a")).resolves.toBeUndefined();
    expect(conn.getState()).toBe("failed");

    const written: string[] = [];
    conn.reattachTransport(async (line) => {
      written.push(line);
    });
    await conn.sendNotification("b");
    await conn.sendNotification("c");

    expect(written.map((line) => (JSON.parse(line) as JsonRpcNotification).method)).toEqual([
      "b",
      "c",
    ]);
  });

  it("makes a failed notification write observable without rejecting", async () => {
    const diagnostics: AcpDiagnostic[] = [];
    const conn = new AcpConnection(
      async () => {
        throw new Error("EPIPE");
      },
      5_000,
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    );

    // A notification has no caller to reject to; an ignored rejection would crash the
    // process, so the failure has to be reported rather than thrown.
    await expect(conn.sendNotification("session/progress", { text: "x" })).resolves.toBeUndefined();

    const stats = conn.getStats();
    expect(stats.notificationWriteFailures).toBe(1);
    expect(stats.state).toBe("failed");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "transport-failed",
      "notification-write-failed",
    ]);
    // The real caller is not left in the dark either.
    await expect(conn.sendRequest("session/prompt")).rejects.toThrow("EPIPE");
  });

  // --- finding 6: notification handlers run serially ------------------------------
  it("does not let a slow notification handler stall later frames in the same chunk", async () => {
    const conn = new AcpConnection(async () => {}, 5_000);
    const order: string[] = [];
    let releaseSlow = (): void => undefined;
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    // An async handler is assignable to a `(params) => void` slot, so a "sync" notification
    // handler can in fact be slow — this is the case the serial loop got wrong.
    conn.onNotification("slow", async () => {
      await slowDone;
      order.push("slow");
    });
    conn.onNotification("fast", () => {
      order.push("fast");
    });

    const chunked = conn.handleChunk(
      '{"jsonrpc":"2.0","method":"slow"}\n{"jsonrpc":"2.0","method":"fast"}\n',
    );

    await vi.waitFor(() => expect(order).toEqual(["fast"]));
    expect(conn.getStats().framesReceived).toBe(2);

    releaseSlow();
    await chunked;
    expect(order).toEqual(["fast", "slow"]);
  });

  it("still lets a request handler be answered by a response in the same chunk", async () => {
    // Characterization of the documented request-dispatch contract, kept because this
    // task rewrote the loop that implements it: a request handler awaiting its own
    // outbound request must not prevent the line answering it from being read out of the
    // same chunk. If a future change reads the loop serially again, this still holds —
    // the request branch was already dispatched without awaiting, before this task.
    const toClient: string[] = [];
    const server = new AcpConnection(async (line) => {
      toClient.push(line);
    });
    server.onRequest("ask-then-answer", async () => {
      const answer = await server.sendRequest("peer/question");
      return { answer };
    });

    // One chunk: the request, then the response to the question that request's handler
    // is about to send. The handler's request is registered synchronously as the handler
    // starts, so by the time the second line is dispatched the id it will be given is 1.
    const chunked = server.handleChunk(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ask-then-answer" })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "the answer" })}\n`,
    );

    const outcome = await Promise.race([
      chunked.then(() => "resolved" as const),
      sleep(1_000).then(() => "stalled" as const),
    ]);
    expect(outcome).toBe("resolved");

    const frames = toClient.map((line) => JSON.parse(line) as JsonRpcRequest & JsonRpcResponse);
    const question = frames.find((frame) => frame.method === "peer/question");
    expect(question?.id).toBe(1);
    const answer = frames.find((frame) => frame.id === 1 && "result" in frame);
    expect(answer?.result).toEqual({ answer: "the answer" });
  });

  it("keeps the protocol-safe null result for a void handler", async () => {
    const toClient: string[] = [];
    const server = new AcpConnection(async (line) => {
      toClient.push(line);
    });
    server.onRequest("noop", () => undefined);

    await server.handleChunk('{"jsonrpc":"2.0","id":7,"method":"noop"}\n');

    const response = JSON.parse(toClient[0] ?? "") as JsonRpcResponse;
    expect(response.id).toBe(7);
    // JSON.stringify drops an undefined member, so an unnormalised void handler would
    // put a response with no result member at all on the wire.
    expect(response).toHaveProperty("result", null);
  });

  // --- finding 7: liveness, without inventing a frame -----------------------------
  it("answers liveness from this end without putting anything new on the wire", async () => {
    const written: string[] = [];
    const conn = new AcpConnection(async (line) => {
      written.push(line);
    }, 5_000);

    expect(conn.isHealthy()).toBe(true);
    await expect(conn.whenIdle()).resolves.toBeUndefined();

    const request = conn.sendRequest("session/prompt");
    let idleWhilePending = false;
    void conn.whenIdle().then(() => {
      idleWhilePending = true;
    });
    await sleep(20);
    expect(idleWhilePending).toBe(false);
    // In flight means not idle, which is not the same as unwell.
    expect(conn.isHealthy()).toBe(true);

    await conn.handleChunk(responseLine(1, "ok"));
    await expect(request).resolves.toBe("ok");
    await expect(conn.whenIdle()).resolves.toBeUndefined();
    // Exactly the two frames the protocol actually defines: no invented probe.
    expect(written).toHaveLength(1);
    expect((JSON.parse(written[0] ?? "") as JsonRpcRequest).method).toBe("session/prompt");

    conn.markTransportFailed("peer went away");
    expect(conn.isHealthy()).toBe(false);
    conn.dispose();
  });

  // --- finding 8: dispose leaves a stale transport failure behind ------------------
  it("dispose reports closed and stops the connection for good", async () => {
    const conn = new AcpConnection(async () => {
      throw new Error("boom");
    });
    await expect(conn.sendRequest("x")).rejects.toThrow("boom");

    conn.dispose();
    expect(conn.getState()).toBe("closed");
    expect(conn.getStats().state).toBe("closed");

    await expect(conn.sendRequest("y")).rejects.toThrow("ACP connection disposed");
    await expect(conn.handleChunk('{"jsonrpc":"2.0","method":"m"}\n')).rejects.toThrow(
      "ACP connection disposed",
    );
    // Terminal: a disposed connection cannot be reattached into a half-live state.
    expect(() => conn.reattachTransport(async () => undefined)).toThrow("ACP connection disposed");

    conn.dispose();
    expect(conn.getState()).toBe("closed");
  });

  it("keeps the method census bounded", async () => {
    const conn = new AcpConnection(async () => {}, 5_000);
    conn.onNotification("m", () => undefined);
    for (let index = 0; index < 300; index++) {
      await conn.handleChunk(`${JSON.stringify({ jsonrpc: "2.0", method: `m/${index}` })}\n`);
    }

    const stats = conn.getStats();
    expect(stats.methodCensusTruncated).toBe(true);
    expect(Object.keys(stats.methodsReceived).length).toBe(128);
    expect(stats.framesReceived).toBe(300);
  });
});
