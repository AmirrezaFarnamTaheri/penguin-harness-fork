import { describe, expect, it } from "vitest";
import { AcpConnection, type JsonRpcRequest, type JsonRpcResponse } from "../src/kernel/acp.js";

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
      { clientName: "claurst-test" }
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
      "ACP Error -32601: Method 'nonexistent/method' not found"
    );
  });
});
