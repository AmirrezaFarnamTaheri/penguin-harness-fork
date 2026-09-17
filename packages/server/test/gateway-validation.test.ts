import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelCombo } from "@prismshadow/penguin-core";
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

  it.each(["local_slm", "frontier", undefined] as const)(
    "persists and echoes combo targets with tier %s without defaulting omitted tiers",
    async (tier) => {
      const target = {
        provider: "test-provider",
        modelId: "test-model",
        ...(tier === undefined ? {} : { tier }),
      };
      const response = await client.put(`/api/projects/${projectId}/gateway/combos`, {
        id: "tier-combo",
        name: "Tier combo",
        targets: [target],
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { combo: ModelCombo };
      const expectedTargets = [{ ...target, maxRetries: 2 }];
      expect(body.combo.targets).toEqual(expectedTargets);

      const stored = JSON.parse(
        await fs.readFile(path.join(t.root, projectId, ".combos.json"), "utf-8"),
      ) as ModelCombo[];
      expect(stored[0]?.targets).toEqual(expectedTargets);

      const listResponse = await client.get(`/api/projects/${projectId}/gateway/combos`);
      expect(listResponse.status).toBe(200);
      const listed = (await listResponse.json()) as { combos: ModelCombo[] };
      expect(listed.combos[0]?.targets).toEqual(expectedTargets);
      if (tier === undefined) {
        expect(body.combo.targets[0]).not.toHaveProperty("tier");
        expect(stored[0]?.targets[0]).not.toHaveProperty("tier");
        expect(listed.combos[0]?.targets[0]).not.toHaveProperty("tier");
      }
    },
  );

  it.each(["unknown", "", "LOCAL_SLM", null, 1, true, [], {}].map((tier) => ({ tier })))(
    "rejects invalid combo target tier $tier",
    async ({ tier }) => {
      const response = await client.put(`/api/projects/${projectId}/gateway/combos`, {
        id: "invalid-tier-combo",
        name: "Invalid tier combo",
        targets: [{ provider: "test-provider", modelId: "test-model", tier }],
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        'targets[0].tier must be either "local_slm" or "frontier" when provided.',
      );
      const listResponse = await client.get(`/api/projects/${projectId}/gateway/combos`);
      expect(await listResponse.json()).toEqual({ combos: [] });
    },
  );

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
