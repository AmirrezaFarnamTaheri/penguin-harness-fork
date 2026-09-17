import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachCockpitWebSocket, resetCockpitRuntimesForTesting } from "../src/cockpit/ws.js";
import { apiClient, createTestApp, provisionUser, type TestApp } from "./helpers.js";

describe("cockpit project authorization", () => {
  let app: TestApp;
  let server: Server;
  let url: string;
  let ownerCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  const projectId = "tenant_owner-shared";
  const clients = new Set<WebSocket>();

  beforeEach(async () => {
    app = await createTestApp();
    ownerCookie = (await provisionUser(app.app, "tenant_owner")).cookie;
    memberCookie = (await provisionUser(app.app, "tenant_member")).cookie;
    outsiderCookie = (await provisionUser(app.app, "tenant_outsider")).cookie;
    const owner = apiClient(app.app, ownerCookie);
    expect((await owner.post("/api/projects", { projectId, name: "Tenant fixture" })).status).toBe(
      201,
    );
    expect(
      (await owner.post(`/api/projects/${projectId}/members`, { userId: "tenant_member" })).status,
    ).toBe(201);
    server = createServer();
    attachCockpitWebSocket(server, {
      authService: app.deps.authService,
      projectService: app.deps.projectService,
      root: app.root,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test listener");
    url = `ws://127.0.0.1:${address.port}/ws/cockpit?project=${projectId}`;
  });

  afterEach(async () => {
    for (const client of clients) client.terminate();
    clients.clear();
    resetCockpitRuntimesForTesting();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await app?.cleanup();
  });

  function connect(cookie?: string): WebSocket {
    const client = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : {});
    clients.add(client);
    return client;
  }

  async function handshakeStatus(cookie?: string): Promise<number> {
    const client = connect(cookie);
    return new Promise<number>((resolve, reject) => {
      client.once("unexpected-response", (_request, response) => {
        response.resume();
        client.on("error", () => {});
        client.terminate();
        resolve(response.statusCode ?? 0);
      });
      client.once("open", () => resolve(101));
      client.once("error", reject);
    });
  }

  it("requires authentication and denies outsiders on every cockpit REST read", async () => {
    const outsider = apiClient(app.app, outsiderCookie);
    for (const route of ["telemetry", "keys", "topology"]) {
      const target = `/api/cockpit/${route}?project=${projectId}`;
      expect((await app.app.request(target)).status).toBe(401);
      expect((await outsider.get(target)).status).toBe(404);
    }
  });

  it("authorizes the body project before cockpit mutations even when the query names an accessible project", async () => {
    const outsider = apiClient(app.app, outsiderCookie);
    for (const route of ["keys/action", "keys/probe", "mailbox/send", "swarm/run"]) {
      const response = await outsider.post(`/api/cockpit/${route}?project=tenant_outsider`, {
        projectId,
        action: "revive_all",
        from: "operator",
        to: "coder",
        content: "fixture",
        goal: "fixture",
      });
      expect(response.status).toBe(404);
    }
  });

  it("serves owner and member telemetry through the authorized REST path", async () => {
    for (const cookie of [ownerCookie, memberCookie]) {
      const response = await apiClient(app.app, cookie).get(
        `/api/cockpit/telemetry?project=${projectId}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "cockpit_init", projectId });
    }
  });

  it("rejects unauthenticated and nonmember WebSocket handshakes", async () => {
    expect(await handshakeStatus()).toBe(401);
    expect(await handshakeStatus(outsiderCookie)).toBe(404);
  });

  it("sends an authorized project snapshot to owner and member WebSockets", async () => {
    for (const cookie of [ownerCookie, memberCookie]) {
      const client = connect(cookie);
      const [message] = await once(client, "message");
      expect(JSON.parse(message.toString())).toMatchObject({ type: "cockpit_init", projectId });
      client.close();
      await once(client, "close");
    }
  });

  it("rejects new REST requests and WebSocket handshakes after membership is removed", async () => {
    const owner = apiClient(app.app, ownerCookie);
    expect((await owner.delete(`/api/projects/${projectId}/members/tenant_member`)).status).toBe(
      204,
    );
    expect(
      (await apiClient(app.app, memberCookie).get(`/api/cockpit/telemetry?project=${projectId}`))
        .status,
    ).toBe(404);
    expect(await handshakeStatus(memberCookie)).toBe(404);
  });
});
