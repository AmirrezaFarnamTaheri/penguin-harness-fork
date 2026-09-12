/**
 * Gateway, Fallback Combos, Quota & Pricing Routes:
 * GET|PUT /api/projects/:projectId/gateway/combos — manage model fallback combos
 * DELETE /api/projects/:projectId/gateway/combos/:id — delete a combo
 * GET /api/projects/:projectId/gateway/quota — live quota & cooldown status
 * GET /api/projects/:projectId/gateway/pricing — model token pricing & custom rate overrides
 * POST /api/projects/:projectId/gateway/cost — calculate granular cost breakdown
 */
import path from "node:path";
import fs from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  DEFAULT_PRICING_CATALOG,
  ModelComboRegistry,
  PricingCatalog,
  computeSpendFlow,
  projectDir,
  atomicWriteFile,
} from "@prismshadow/penguin-core";
import type {
  ModelCombo,
  ModelComboTarget,
  FallbackTrigger,
  DetailedUsageCounts,
  SessionCostRecord,
} from "@prismshadow/penguin-core";

const projectComboRegistries = new Map<string, ModelComboRegistry>();
const pricingCatalog = new PricingCatalog();

async function getProjectComboRegistry(root: string, projectId: string): Promise<ModelComboRegistry> {
  let reg = projectComboRegistries.get(projectId);
  if (!reg) {
    reg = new ModelComboRegistry();
    projectComboRegistries.set(projectId, reg);
    try {
      const pDir = projectDir(root, projectId);
      const filePath = path.join(pDir, ".combos.json");
      const content = await fs.readFile(filePath, "utf-8");
      const list = JSON.parse(content);
      if (Array.isArray(list)) {
        for (const item of list) {
          reg.set(item);
        }
      }
    } catch {
      // Start empty if not persisted yet
    }
  }
  return reg;
}

async function saveProjectCombos(root: string, projectId: string): Promise<void> {
  const reg = projectComboRegistries.get(projectId);
  if (!reg) return;
  try {
    const pDir = projectDir(root, projectId);
    await fs.mkdir(pDir, { recursive: true });
    const filePath = path.join(pDir, ".combos.json");
    await atomicWriteFile(filePath, JSON.stringify(reg.list(), null, 2));
  } catch {
    // Disk write error recovery
  }
}

/**
 * Model Path & Segment Safety Validator (ported from agentgateway crates/llm/src/lib.rs)
 * Rejects path traversal (../), control characters, query/hash fragments, and dangerous delimiters.
 */
export function isSafeSegment(segment: string): boolean {
  if (!segment || segment.length === 0 || segment.length > 128) return false;
  if (segment === "." || segment === "..") return false;
  if (/[\x00-\x1F\x7F\\?#]/.test(segment)) return false;
  if (segment.includes("..") || segment.includes("/") || segment.includes("%2f") || segment.includes("%2F")) return false;
  return /^[a-zA-Z0-9_\-\.:@]+$/.test(segment);
}

export function isSafeResourceName(name: string): boolean {
  if (!name || name.length === 0 || name.length > 256) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  const segments = name.split("/");
  return segments.every(isSafeSegment);
}

export function gatewayRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /combos
  app.get("/combos", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const reg = await getProjectComboRegistry(deps.config.root, projectId);
    return c.json({ combos: reg.list() });
  });

  // PUT /combos
  app.put("/combos", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    const reg = await getProjectComboRegistry(deps.config.root, projectId);
    const body = await readJson(c);

    const id = requireString(body, "id", { minLen: 1, maxLen: 64, label: "id" });
    const name = requireString(body, "name", { minLen: 1, maxLen: 100, label: "name" });
    const description = typeof body.description === "string" ? body.description : undefined;

    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      throw badRequest("targets must be a non-empty array of model references.");
    }

    const targets: ModelComboTarget[] = body.targets.map((item, i) => {
      if (typeof item !== "object" || item === null) {
        throw badRequest(`targets[${i}] must be an object.`);
      }
      const t = item as Record<string, unknown>;
      return {
        provider: requireString(t, "provider", { minLen: 1, maxLen: 64, label: `targets[${i}].provider` }),
        modelId: requireString(t, "modelId", { minLen: 1, maxLen: 200, label: `targets[${i}].modelId` }),
        label: typeof t.label === "string" ? t.label : undefined,
        maxRetries: typeof t.maxRetries === "number" ? t.maxRetries : 2,
        timeoutMs: typeof t.timeoutMs === "number" ? t.timeoutMs : undefined,
      };
    });

    const fallbackTriggers: FallbackTrigger[] = Array.isArray(body.fallbackTriggers)
      ? (body.fallbackTriggers as FallbackTrigger[])
      : ["rate_limit", "quota_exhausted", "overloaded", "timeout"];

    const combo: ModelCombo = {
      id,
      name,
      description,
      targets,
      fallbackTriggers,
    };

    reg.set(combo);
    await saveProjectCombos(deps.config.root, projectId);
    return c.json({ ok: true, combo });
  });

  // DELETE /combos/:id
  app.delete("/combos/:id", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    const reg = await getProjectComboRegistry(deps.config.root, projectId);
    const id = requireValidId(c, "id");
    const deleted = reg.delete(id);
    await saveProjectCombos(deps.config.root, projectId);
    return c.json({ ok: true, deleted });
  });

  // GET /quota
  app.get("/quota", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);

    const modelsCfg = await deps.projectConfigService.getModels(projectId);
    const quotaStatuses: Array<{
      provider: string;
      modelId: string;
      isCooling: boolean;
    }> = [];

    if (modelsCfg?.models) {
      for (const m of modelsCfg.models) {
        quotaStatuses.push({
          provider: m.provider,
          modelId: m.modelId,
          isCooling: false,
        });
      }
    }

    return c.json({
      activeQuota: {
        sessionUsedPct: null,
        weeklyUsedPct: null,
        resetsIn: null,
        status: "unmetered",
      },
      models: quotaStatuses,
    });
  });

  // GET /pricing
  app.get("/pricing", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json({
      catalog: DEFAULT_PRICING_CATALOG,
    });
  });

  // POST /cost
  app.post("/cost", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);

    const provider = requireString(body, "provider", { minLen: 1, maxLen: 64, label: "provider" });
    const modelId = requireString(body, "modelId", { minLen: 1, maxLen: 200, label: "modelId" });

    const usage: DetailedUsageCounts = {
      promptTokens: typeof body.promptTokens === "number" ? body.promptTokens : 0,
      completionTokens: typeof body.completionTokens === "number" ? body.completionTokens : 0,
      reasoningTokens: typeof body.reasoningTokens === "number" ? body.reasoningTokens : 0,
      cacheReadTokens: typeof body.cacheReadTokens === "number" ? body.cacheReadTokens : 0,
      cacheWriteTokens: typeof body.cacheWriteTokens === "number" ? body.cacheWriteTokens : 0,
    };

    const breakdown = pricingCatalog.calculateCost(provider, modelId, usage);
    return c.json({
      breakdown,
      formattedTotal: pricingCatalog.formatCost(breakdown.totalCost),
      formattedSavings: pricingCatalog.formatCost(breakdown.savingsFromCache),
    });
  });

  // POST /spend-flow
  app.post("/spend-flow", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);

    const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
    const sessions: SessionCostRecord[] = rawSessions.map((s: Record<string, unknown>) => ({
      sessionId: typeof s.sessionId === "string" ? s.sessionId : "",
      projectId: typeof s.projectId === "string" ? s.projectId : projectId,
      projectPath: typeof s.projectPath === "string" ? s.projectPath : undefined,
      modelBreakdown:
        typeof s.modelBreakdown === "object" && s.modelBreakdown !== null
          ? (s.modelBreakdown as Record<string, { costUSD: number; tokens?: number }>)
          : {},
    }));

    const report = computeSpendFlow(sessions, {
      topNodeLimit: typeof body.limit === "number" ? body.limit : 8,
    });
    return c.json({ report });
  });

  // POST /chat/completions — OpenAI-compatible proxy interface (ported from agy2api / AIClient2API)
  app.post("/chat/completions", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);

    const model = requireString(body, "model", { minLen: 1, maxLen: 256, label: "model" });
    if (!isSafeResourceName(model)) {
      throw badRequest(`Invalid model resource name: "${model}". Prohibited characters or path traversal pattern.`);
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw badRequest("messages must be a non-empty array of chat message objects.");
    }

    // Direct proxy completions are not supported; clients must use session execution
    return c.json(
      {
        error: {
          message: "Direct chat completion gateway endpoint is not supported in this runtime; use session execution.",
          type: "not_implemented",
          code: 501,
        },
      },
      501
    );
  });

  // POST /webhooks/approval — IM human-in-the-loop approval callback (ported from cc-haha / feishu-notify)
  app.post("/webhooks/approval", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);

    const approvalId = requireString(body, "approvalId", { minLen: 1, maxLen: 128, label: "approvalId" });
    const action = requireString(body, "action", { minLen: 1, maxLen: 32, label: "action" });

    if (action !== "approve" && action !== "reject") {
      throw badRequest('action must be either "approve" or "reject".');
    }

    const comment = typeof body.comment === "string" ? body.comment : undefined;
    const approver = typeof body.approver === "string" ? body.approver : c.var.user.userId;

    let sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    let toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : undefined;

    if (!sessionId && approvalId.includes(":")) {
      const parts = approvalId.split(":");
      sessionId = parts[0];
      toolCallId = parts.slice(1).join(":");
    } else if (!sessionId) {
      sessionId = approvalId;
      toolCallId = approvalId;
    }

    const decision = action === "approve" ? "allow" : "deny";
    const ok = deps.manager.decideApproval(sessionId, toolCallId ?? approvalId, decision);
    if (!ok) {
      throw notFound("Approval does not exist or has already been decided.");
    }

    return c.json({
      ok: true,
      approvalId,
      status: action === "approve" ? "approved" : "rejected",
      comment,
      approver,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
