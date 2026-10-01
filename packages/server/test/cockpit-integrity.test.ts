import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { cockpitRoutes } from "../src/http/routes/cockpit.js";
import {
  getOrCreateProjectRuntime,
  probeProviderKey,
  resetCockpitRuntimesForTesting,
  scheduleRuntimeReap,
} from "../src/cockpit/ws.js";

afterEach(() => {
  resetCockpitRuntimesForTesting();
  vi.restoreAllMocks();
});

describe("cockpit integrity", () => {
  it("returns structured errors for invalid project ids and malformed JSON", async () => {
    const app = new Hono().route(
      "/api/cockpit",
      cockpitRoutes(undefined, { workspaceRoot: process.cwd() }),
    );
    const invalid = await app.request("/api/cockpit/telemetry?project=..%2Foutside");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      success: false,
      error: { code: "invalid_project_id", message: expect.any(String) },
    });
    const malformed = await app.request("/api/cockpit/keys/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      success: false,
      error: { code: "bad_request", message: expect.any(String) },
    });
  });

  it("never sends an unknown provider credential to a different provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const result = await probeProviderKey("private-gateway", "test-credential");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("probes an explicitly configured gateway without following redirects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const result = await probeProviderKey("private-gateway", "test-credential", {
      baseUrl: "https://gateway.example/v1/",
      clientType: "openai-chat",
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({
        redirect: "error",
        headers: { Authorization: "Bearer test-credential" },
      }),
    );
  });

  it("identifies the project in a telemetry snapshot", async () => {
    const app = new Hono();
    app.route("/api/cockpit", cockpitRoutes(undefined, { workspaceRoot: process.cwd() }));
    const response = await app.request("/api/cockpit/telemetry?project=integrity-scope");
    const snapshot = (await response.json()) as { projectId?: string };
    expect(snapshot.projectId).toBe("integrity-scope");
  });

  it.each(["refuted", "max_rounds_exceeded", "loop_aborted", "error", "timed_out"] as const)(
    "does not acknowledge %s as successful execution",
    async (status) => {
      const runtime = await getOrCreateProjectRuntime("integrity-status", {
        workspaceRoot: process.cwd(),
      });
      vi.spyOn(runtime.coordinator, "runTask").mockResolvedValue({
        taskId: "task",
        status,
        rounds: 1,
        artifacts: [],
        safetyFindings: [],
        log: [],
      });
      const app = new Hono();
      app.route("/api/cockpit", cockpitRoutes(undefined, { workspaceRoot: process.cwd() }));
      const response = await app.request("/api/cockpit/swarm/run?project=integrity-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Test goal", simulate: true }),
      });
      const json = (await response.json()) as {
        success?: boolean;
        error?: { code: string; message: string };
        result?: { status?: string };
      };
      expect(json.success).toBe(false);
      expect(json.result?.status).toBe(status);
      expect(json.error?.code).toBe("swarm_task_failed");
      expect(json.error?.message).toContain(status);
    },
  );

  it("releases key-fleet subscriptions and probe timers when reaped", async () => {
    const runtime = await getOrCreateProjectRuntime("integrity-reap", {
      workspaceRoot: process.cwd(),
    });
    const clear = vi.spyOn(runtime.keyFleet, "clear");
    const stop = vi.spyOn(runtime.keyFleet, "stopAutoProbing");
    scheduleRuntimeReap(runtime, {}, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stop).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });
});
