import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cockpitRoutes } from "../src/http/routes/cockpit.js";
import { getSharedSwarmCoordinator, buildCockpitSnapshot } from "../src/cockpit/ws.js";

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

  it("executes an autonomous swarm task via POST /swarm/run", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes());

    const res = await app.request("/api/cockpit/swarm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: "Wire in-memory cache and verify test suite",
        files: ["src/cache.ts"],
        maxRounds: 2,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.result.status).toBe("settled");
    expect(json.result.rounds).toBeGreaterThanOrEqual(1);
    expect(json.result.artifacts.length).toBeGreaterThan(0);
  });

  it("serves key fleet metrics and handles synthetic probes", async () => {
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
    expect(probeJson.result.latencyMs).toBeGreaterThan(0);
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
});
