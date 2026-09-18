import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectCreateResponse } from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

describe("gateway input validation", () => {
  let t: TestApp;
  let client: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const user = await provisionUser(t.app, "gateway_validation");
    client = apiClient(t.app, user.cookie);
    const created = (await (
      await client.post("/api/projects", {
        projectId: "gateway_validation-project",
        name: "Gateway validation",
      })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("rejects negative and fractional token counts", async () => {
    const negative = await client.post(`/api/projects/${projectId}/gateway/cost`, {
      provider: "openai",
      modelId: "gpt-4o",
      promptTokens: -1,
    });
    expect(negative.status).toBe(400);

    const fractional = await client.post(`/api/projects/${projectId}/gateway/cost`, {
      provider: "openai",
      modelId: "gpt-4o",
      completionTokens: 1.5,
    });
    expect(fractional.status).toBe(400);
  });

  it("does not format unavailable pricing as a known zero-dollar cost", async () => {
    const response = await client.post(`/api/projects/${projectId}/gateway/cost`, {
      provider: "unknown-provider",
      modelId: "unknown-model",
      promptTokens: 1000,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      breakdown: { priced: boolean };
      formattedTotal: string;
      formattedSavings: string;
    };
    expect(body.breakdown.priced).toBe(false);
    expect(body.formattedTotal).toBe("Unknown");
    expect(body.formattedSavings).toBe("Unknown");
  });

  it("rejects malformed spend-flow sessions, breakdowns, and limits", async () => {
    const badSession = await client.post(`/api/projects/${projectId}/gateway/spend-flow`, {
      sessions: [null],
    });
    expect(badSession.status).toBe(400);

    const badBreakdown = await client.post(`/api/projects/${projectId}/gateway/spend-flow`, {
      sessions: [
        {
          sessionId: "s1",
          modelBreakdown: { "gpt-4o": { costUSD: -0.01 } },
        },
      ],
    });
    expect(badBreakdown.status).toBe(400);

    const badLimit = await client.post(`/api/projects/${projectId}/gateway/spend-flow`, {
      sessions: [],
      limit: 0,
    });
    expect(badLimit.status).toBe(400);
  });

  it("accepts a well-formed spend-flow payload", async () => {
    const response = await client.post(`/api/projects/${projectId}/gateway/spend-flow`, {
      sessions: [
        {
          sessionId: "s1",
          projectId,
          modelBreakdown: { "gpt-4o": { costUSD: 0.25, tokens: 1000 } },
        },
      ],
      limit: 8,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { report: { totalCostUsd: number } };
    expect(body.report.totalCostUsd).toBe(0.25);
  });
});
