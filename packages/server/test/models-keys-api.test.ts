import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { ProjectCreateResponse } from "../src/api/types.js";
import type { ModelKeyHealthReport } from "../src/services/model-key-health.js";

interface ModelKeyResetResponse {
  ok: boolean;
  report: ModelKeyHealthReport;
}

describe("models key health and reset HTTP routes", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const { cookie } = await provisionUser(t.app, "alice");
    api = apiClient(t.app, cookie);
    const created = (await (
      await api.post("/api/projects", { projectId: "alice-keys_test", name: "Keys Test" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("GET /api/projects/:projectId/models/keys/health returns key health report", async () => {
    // Configure a model with multiple API keys
    const putRes = await api.put(`/api/projects/${projectId}/models`, {
      defaultModel: { provider: "deepseek", modelId: "deepseek-chat" },
      models: [
        {
          provider: "deepseek",
          modelId: "deepseek-chat",
          apiKey: "sk-proj-key-alpha, sk-proj-key-beta",
        },
      ],
    });
    expect(putRes.status).toBe(200);

    const getRes = await api.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
    );
    expect(getRes.status).toBe(200);
    const report = (await getRes.json()) as ModelKeyHealthReport;
    expect(report.totalKeys).toBe(2);
    expect(report.healthyCount).toBe(2);
    expect(report.keys).toHaveLength(2);
    expect(report.keys[0]?.status).toBe("healthy");
    expect(report.keys[0]?.maskedKey).toContain("...");
  });

  it("POST /api/projects/:projectId/models/keys/reset clears cooldowns and evictions", async () => {
    // Populate rotator and mark keys in cooldown & evicted
    const rotator = t.deps.keyHealthService.getRotator(
      projectId,
      "deepseek/deepseek-chat",
      "sk-proj-key-alpha, sk-proj-key-beta",
    );
    rotator.markRateLimited("sk-proj-key-alpha", 60_000);
    rotator.markFailed("sk-proj-key-beta");

    // Verify health reflects cooldown & eviction
    const healthRes = await api.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
    );
    expect(healthRes.status).toBe(200);
    const reportBefore = (await healthRes.json()) as ModelKeyHealthReport;
    expect(reportBefore.cooldownCount).toBe(1);
    expect(reportBefore.evictedCount).toBe(1);

    // Call reset endpoint
    const resetRes = await api.post(`/api/projects/${projectId}/models/keys/reset`, {
      provider: "deepseek",
      modelId: "deepseek-chat",
    });
    expect(resetRes.status).toBe(200);
    const resetBody = (await resetRes.json()) as ModelKeyResetResponse;
    expect(resetBody.ok).toBe(true);
    expect(resetBody.report.healthyCount).toBe(2);
    expect(resetBody.report.cooldownCount).toBe(0);
    expect(resetBody.report.evictedCount).toBe(0);
  });

  /**
   * A reset must NAME the key pool it clears. Without this rule the route fell through to
   * `{ ok: true }` for a request that named nothing — and the web cockpit's "Reset All Key
   * Pools" button sent exactly that (`{}` in the body), so a user pressing it got a success
   * toast over a pool that had not changed. A route that clears state must not report
   * success for clearing none, so the ref-less shape is now a 400 that names the fix.
   */
  it("refuses a reset that names no key pool, and the refusal changed no key", async () => {
    const rotator = t.deps.keyHealthService.getRotator(
      projectId,
      "deepseek/deepseek-chat",
      "sk-proj-key-alpha, sk-proj-key-beta",
    );
    rotator.markRateLimited("sk-proj-key-alpha", 60_000);
    rotator.markFailed("sk-proj-key-beta");

    // The shape the client used to send: an empty object, no provider/modelId, no modelRef.
    const res = await api.post(`/api/projects/${projectId}/models/keys/reset`, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    // The message has to tell the caller what to send instead, not merely that it failed.
    expect(body.error.message).toContain("provider");
    expect(body.error.message).toContain("modelId");
    expect(body.error.message).toContain("modelRef");

    // The refusal is not a no-op that merely reports itself: nothing was cleared.
    const healthRes = await api.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
    );
    expect(healthRes.status).toBe(200);
    const report = (await healthRes.json()) as ModelKeyHealthReport;
    expect(report.cooldownCount).toBe(1);
    expect(report.evictedCount).toBe(1);
  });

  /** A half-pair names no pool either — `provider` without `modelId` must not slip through. */
  it("refuses a reset that names only half of a pair", async () => {
    const res = await api.post(`/api/projects/${projectId}/models/keys/reset`, {
      provider: "deepseek",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("together");
  });

  /** The same route, the ref-ful shape: a pool named by `modelRef` clears exactly as before. */
  it("accepts a reset that names a pool by modelRef", async () => {
    const rotator = t.deps.keyHealthService.getRotator(
      projectId,
      "deepseek/deepseek-chat",
      "sk-proj-key-alpha, sk-proj-key-beta",
    );
    rotator.markRateLimited("sk-proj-key-alpha", 60_000);

    const res = await api.post(`/api/projects/${projectId}/models/keys/reset`, {
      modelRef: "deepseek/deepseek-chat",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelKeyResetResponse;
    expect(body.ok).toBe(true);
    expect(body.report.cooldownCount).toBe(0);
    expect(body.report.healthyCount).toBe(2);
  });

  it("enforces authentication on key health and reset routes", async () => {
    const unauthed = apiClient(t.app, "");
    const getRes = await unauthed.get(
      `/api/projects/${projectId}/models/keys/health?provider=deepseek&modelId=deepseek-chat`,
    );
    expect(getRes.status).toBe(401);

    const postRes = await unauthed.post(`/api/projects/${projectId}/models/keys/reset`, {
      provider: "deepseek",
      modelId: "deepseek-chat",
    });
    expect(postRes.status).toBe(401);
  });
});
