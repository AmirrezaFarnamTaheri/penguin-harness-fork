import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { WebSocket } from "ws";
import { cockpitRoutes } from "../src/http/routes/cockpit.js";
import {
  getSharedSwarmCoordinator,
  getSharedKeyFleetMonitor,
  buildCockpitSnapshot,
  attachCockpitWebSocket,
  getOrCreateProjectRuntime,
} from "../src/cockpit/ws.js";
import type { AuthService } from "../src/auth/service.js";

describe("Cockpit Telemetry and Swarm Routes", () => {
  it("serves initial telemetry snapshot via GET /telemetry", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/telemetry");
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.type).toBe("cockpit_init");
    expect(json.data.swarm).toBeDefined();
    expect(json.data.swarm.agents.length).toBeGreaterThan(0);
    expect(json.data.mailbox).toBeDefined();
    expect(json.data.watchdog).toBeDefined();
    expect(json.data.replay).toBeDefined();
    expect(json.data.keyFleet).toBeDefined();
  });

  it("executes an autonomous swarm task via POST /swarm/run with simulate flag", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/swarm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Wire in-memory cache and verify test suite",
        files: ["src/cache.ts"],
        maxRounds: 2,
        simulate: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.result.status).toBe("settled");
    expect(json.result.rounds).toBeGreaterThanOrEqual(1);
    expect(json.result.artifacts.length).toBeGreaterThan(0);
  });

  it("returns unhandled status when POST /swarm/run has no handler and simulate is false", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/swarm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Non-simulated task with no handler",
        simulate: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.result.status).toBe("unhandled");
  });

  it("serves registered key fleet metrics and handles real probes", async () => {
    const monitor = getSharedKeyFleetMonitor();
    monitor.registerProvider({
      provider: "anthropic",
      modelId: "claude-3-7-sonnet",
      modelRef: "anthropic:claude-3-7-sonnet",
      keys: ["sk-ant-api03-test-sample-key-12345678901234567890"],
      strategy: "round-robin",
      probeFn: async () => ({ ok: true, latencyMs: 42 }),
    });

    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/keys");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.reports.length).toBeGreaterThan(0);
    expect(json.stats.healthyCount).toBeGreaterThan(0);
    expect(json.snapshot.healthy).toBe(true);

    // Trigger probe
    const probeRes = await app.request("/api/cockpit/keys/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        maskedKey: json.reports[0].keys[0].maskedKey,
      }),
    });
    expect(probeRes.status).toBe(200);
    const probeJson = (await probeRes.json()) as any;
    expect(probeJson.success).toBe(true);
    expect(probeJson.result.latencyMs).toBe(42);
  });

  it("serves live code graph topology snapshot via GET /topology", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/topology");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.nodes).toBeDefined();
    expect(json.edges).toBeDefined();
    expect(json.stats).toBeDefined();
  });

  it("dispatches live inter-agent directives via POST /mailbox/send", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/mailbox/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "operator",
        to: "coder",
        content: "Run test suite and verify imports",
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.directive.id).toBeDefined();
    expect(json.directive.fromAgent).toBe("operator");
    expect(json.directive.toAgent).toBe("coder");
    expect(json.mailbox.coder.queueDepth).toBeGreaterThanOrEqual(1);
  });

  it("modifies key states via POST /keys/action", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/keys/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "cooldown",
        provider: "openai",
        maskedKey: "sk-proj-...1c4a",
        cooldownMs: 30000,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.stats).toBeDefined();
    expect(json.snapshot).toBeDefined();
  });
});

describe("Cockpit WebSocket Transport & Authentication", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  const mockAuthService: Partial<AuthService> = {
    authenticateWithMeta: (token: string) => {
      if (token === "valid-session-secret") {
        return {
          user: { userId: "admin", username: "admin" } as any,
          via: "cookie" as any,
          renewed: false,
        };
      }
      return null;
    },
  };

  beforeAll(async () => {
    server = createServer();
    attachCockpitWebSocket(server, {
      authService: mockAuthService as AuthService,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("refuses unauthenticated WebSocket connections with 401", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`);
      ws.on("open", () => {
        ws.close();
        reject(new Error("Expected connection to be refused"));
      });
      ws.on("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      ws.on("error", () => {
        // Socket closed by server after 401 write
        resolve();
      });
    });
  });

  it("refuses connection with spoofed Host: localhost but invalid cookie with 401", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: {
          Host: "localhost:1234",
          Cookie: "penguin_session=attacker-forged-cookie",
        },
      });
      ws.on("open", () => {
        ws.close();
        reject(new Error("Expected connection to be refused"));
      });
      ws.on("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(401);
        resolve();
      });
      ws.on("error", () => {
        resolve();
      });
    });
  });

  it("refuses connection with invalid/forbidden Origin with 403", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: {
          Cookie: "penguin_session=valid-session-secret",
          Origin: "http://malicious-site.com",
        },
      });
      ws.on("open", () => {
        ws.close();
        reject(new Error("Expected connection to be refused with 403"));
      });
      ws.on("unexpected-response", (_req, res) => {
        expect(res.statusCode).toBe(403);
        resolve();
      });
      ws.on("error", () => {
        resolve();
      });
    });
  });

  it("authenticates valid session, receives snapshot, and responds to ping/pong", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: {
          Cookie: "penguin_session=valid-session-secret",
        },
      });

      let receivedInit = false;

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "cockpit_init") {
          receivedInit = true;
          expect(msg.data.swarm).toBeDefined();
          expect(msg.data.keyFleet).toBeDefined();
        } else if (msg.type === "pong") {
          expect(receivedInit).toBe(true);
          ws.close();
          resolve();
        }
      });

      ws.on("error", (err) => reject(err));
    });
  });

  it("rejects directives exceeding 8192 characters with directive_rejected", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit`, {
        headers: {
          Cookie: "penguin_session=valid-session-secret",
        },
      });

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "send_directive",
            from: "operator",
            to: "coder",
            content: "a".repeat(8193),
          }),
        );
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "directive_rejected") {
          expect(msg.reason).toMatch(/8192/);
          ws.close();
          resolve();
        }
      });

      ws.on("error", (err) => reject(err));
    });
  });

  it("isolates WebSocket telemetry and events between different projects", async () => {
    const wsAlpha = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit?project=proj-alpha`, {
      headers: { Cookie: "penguin_session=valid-session-secret" },
    });
    const wsBeta = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit?project=proj-beta`, {
      headers: { Cookie: "penguin_session=valid-session-secret" },
    });

    let betaReceivedAlphaDirective = false;
    let alphaReceivedDirective = false;

    await new Promise<void>((resolve, reject) => {
      let openCount = 0;
      const onOpen = () => {
        openCount++;
        if (openCount === 2) {
          // Send a directive specifically to proj-alpha
          wsAlpha.send(
            JSON.stringify({
              type: "send_directive",
              from: "operator",
              to: "coder",
              content: "Directive exclusively for proj-alpha",
            }),
          );
        }
      };

      wsAlpha.on("open", onOpen);
      wsBeta.on("open", onOpen);

      wsAlpha.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "directive_dispatched") {
          alphaReceivedDirective = true;
          // Give beta a short window to verify it doesn't receive this event
          setTimeout(() => {
            wsAlpha.close();
            wsBeta.close();
            expect(alphaReceivedDirective).toBe(true);
            expect(betaReceivedAlphaDirective).toBe(false);
            resolve();
          }, 100);
        }
      });

      wsBeta.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "directive_dispatched" && msg.directive?.content?.includes("proj-alpha")) {
          betaReceivedAlphaDirective = true;
        }
      });

      wsAlpha.on("error", reject);
      wsBeta.on("error", reject);
    });
  });

  it("synchronizes taskId on async /swarm/run and returns reports on /keys/action", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    // 1. Async swarm run taskId synchronization
    const customTaskId = "custom-task-sync-id-12345";
    const asyncRes = await app.request("/api/cockpit/swarm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: customTaskId,
        goal: "Synchronized async task",
        async: true,
      }),
    });
    expect(asyncRes.status).toBe(202);
    const asyncJson = (await asyncRes.json()) as any;
    expect(asyncJson.success).toBe(true);
    expect(asyncJson.accepted).toBe(true);
    expect(asyncJson.taskId).toBe(customTaskId);

    // 2. /keys/action returns reports in response
    const actionRes = await app.request("/api/cockpit/keys/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "revive_all",
      }),
    });
    expect(actionRes.status).toBe(200);
    const actionJson = (await actionRes.json()) as {
      success: boolean;
      reports: unknown[];
      stats?: unknown;
      snapshot?: unknown;
    };
    expect(actionJson.success).toBe(true);
    expect(Array.isArray(actionJson.reports)).toBe(true);
    expect(actionJson.stats).toBeDefined();
    expect(actionJson.snapshot).toBeDefined();
  });

  it("schedules and tracks runtime lifecycle when project clients disconnect", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cockpit?project=proj-reap`, {
      headers: { Cookie: "penguin_session=valid-session-secret" },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.close();
      });
      ws.on("close", () => {
        resolve();
      });
      ws.on("error", reject);
    });

    const rt = await getOrCreateProjectRuntime("proj-reap");
    expect(rt).toBeDefined();
    expect(rt.clients.size).toBe(0);
  });
});
