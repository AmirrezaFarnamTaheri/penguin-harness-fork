import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      uncachedPromptTokens: -1,
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
      uncachedPromptTokens: 1000,
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

  it("rejects ambiguous total-input promptTokens so cached input cannot be double billed", async () => {
    const response = await client.post(`/api/projects/${projectId}/gateway/cost`, {
      provider: "openai",
      modelId: "gpt-4o",
      promptTokens: 1_000_000,
      cacheReadTokens: 400_000,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("uncachedPromptTokens");
  });

  it("computes a real dollar cost for a priced model", async () => {
    // openai/gpt-4o from the default catalog: prompt $2.50/M, completion $10.00/M,
    // cache read $1.25/M. With 1M prompt and 1M completion tokens the arithmetic is
    //   prompt 2.5 + completion 10.0 = $12.500
    // and nothing was read from cache, so the savings are a real $0.00 rather than "Unknown".
    const response = await client.post(`/api/projects/${projectId}/gateway/cost`, {
      provider: "openai",
      modelId: "gpt-4o",
      uncachedPromptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      breakdown: {
        priced: boolean;
        promptCost: number;
        completionCost: number;
        cacheReadCost: number;
        totalCost: number;
        savingsFromCache: number;
      };
      formattedTotal: string;
      formattedSavings: string;
    };
    expect(body.breakdown.priced).toBe(true);
    expect(body.breakdown.promptCost).toBe(2.5);
    expect(body.breakdown.completionCost).toBe(10.0);
    expect(body.breakdown.cacheReadCost).toBe(0);
    expect(body.breakdown.totalCost).toBe(12.5);
    expect(body.formattedTotal).toBe("$12.500");
    expect(body.formattedSavings).toBe("$0.00");

    // With cache reads, the same model reports the cache-write fallback (1.25x prompt, since
    // gpt-4o lists no cacheWrite rate) and a non-zero saving:
    //   prompt 2.5 + completion 5.0 + cacheRead 0.25 + cacheWrite 0.3125 = $8.063
    //   savings = (1.2M total input) - (uncached prompt + cacheRead) = 3.0 - 2.75 = $0.250
    const cached = await client.post(`/api/projects/${projectId}/gateway/cost`, {
      provider: "openai",
      modelId: "gpt-4o",
      uncachedPromptTokens: 1_000_000,
      completionTokens: 500_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 100_000,
    });
    expect(cached.status).toBe(200);
    const cachedBody = (await cached.json()) as {
      breakdown: { totalCost: number; savingsFromCache: number };
      formattedTotal: string;
      formattedSavings: string;
    };
    expect(cachedBody.breakdown.totalCost).toBe(8.0625);
    expect(cachedBody.breakdown.savingsFromCache).toBe(0.25);
    expect(cachedBody.formattedTotal).toBe("$8.063");
    expect(cachedBody.formattedSavings).toBe("$0.250");
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

  it("bounds spend-flow identifiers and refuses ambiguous display paths", async () => {
    for (const session of [
      { sessionId: "" },
      { sessionId: "a".repeat(129) },
      { sessionId: "../escape" },
      { projectId: "%2e%2e" },
      { projectId: "名前" },
      { projectPath: "" },
      { projectPath: "a".repeat(4097) },
      { projectPath: "/repo/../secret" },
      { projectPath: "/repo/%2e%2e/secret" },
      { projectPath: "/repo//src" },
      { projectPath: "C:\\repo/child" },
      { projectPath: "/repo/\u0000secret" },
      { projectPath: "/repo/\ud800" },
    ]) {
      const response = await client.post(`/api/projects/${projectId}/gateway/spend-flow`, {
        sessions: [{ modelBreakdown: {}, ...session }],
      });
      expect(response.status, JSON.stringify(session)).toBe(400);
    }
    for (const projectPath of ["/repo/日本語😀", "C:\\repo\\src", "repo/src"]) {
      const response = await client.post(`/api/projects/${projectId}/gateway/spend-flow`, {
        sessions: [{ sessionId: "s1", projectId, projectPath, modelBreakdown: {} }],
      });
      expect(response.status, projectPath).toBe(200);
    }
  });

  it("rejects malformed gateway project path ids before project access", async () => {
    const accessSpy = vi.spyOn(t.deps.projectService, "requireProjectAccess");
    try {
      for (const pathId of ["", "a".repeat(129), "%2e%2e", "part%2fchild", "名前"]) {
        const response = await client.get(`/api/projects/${pathId}/gateway/combos`);
        expect(response.status, JSON.stringify(pathId)).toBe(404);
      }
      expect(accessSpy).not.toHaveBeenCalled();
    } finally {
      accessSpy.mockRestore();
    }
  });

  it("rejects malformed approval session ids before session lookup or approval", async () => {
    const sessionLookupSpy = vi.spyOn(t.deps.sessionsRepo, "findById");
    const approvalSpy = vi.spyOn(t.deps.manager, "decideApproval");
    try {
      for (const sessionId of ["", "a".repeat(129), "../escape", "名前"]) {
        const response = await client.post(`/api/projects/${projectId}/gateway/webhooks/approval`, {
          approvalId: "tool-call",
          action: "approve",
          sessionId,
        });
        expect(response.status, JSON.stringify(sessionId)).toBe(400);
      }

      const derivedSessionId = await client.post(
        `/api/projects/${projectId}/gateway/webhooks/approval`,
        { approvalId: "../escape:tool-call", action: "approve" },
      );
      expect(derivedSessionId.status).toBe(400);
      expect(sessionLookupSpy).not.toHaveBeenCalled();
      expect(approvalSpy).not.toHaveBeenCalled();
    } finally {
      sessionLookupSpy.mockRestore();
      approvalSpy.mockRestore();
    }
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
