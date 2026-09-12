/**
 * Gateway, Fallback Combos, Quota & Pricing Routes.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.js";
import { badRequest, notFound, readJson, requireString, requireValidId } from "../validate.js";
import type { AppDeps } from "../../app.js";
import {
  DEFAULT_PRICING_CATALOG,
  ModelComboRegistry,
  PricingCatalog,
  computeSpendFlow,
} from "@prismshadow/penguin-core";
import type {
  ModelCombo,
  ModelComboTarget,
  FallbackTrigger,
  DetailedUsageCounts,
  SessionCostRecord,
} from "@prismshadow/penguin-core";
import { ProjectJsonStore } from "../../services/project-json-store.js";

const pricingCatalog = new PricingCatalog();

function decodeCombos(raw: string): ModelCombo[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Gateway combo persistence file must contain a JSON array.");
  return parsed as ModelCombo[];
}

function registryFrom(combos: ModelCombo[]): ModelComboRegistry {
  const registry = new ModelComboRegistry();
  for (const combo of combos) registry.set(combo);
  return registry;
}

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
  return name.split("/").every(isSafeSegment);
}

export function gatewayRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const combos = new ProjectJsonStore<ModelCombo[]>(
    deps.config.root,
    ".combos.json",
    () => [],
    decodeCombos,
  );

  app.get("/combos", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json({ combos: registryFrom(await combos.read(projectId)).list() });
  });

  app.put("/combos", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    const body = await readJson(c);
    const id = requireString(body, "id", { minLen: 1, maxLen: 64, label: "id" });
    const name = requireString(body, "name", { minLen: 1, maxLen: 100, label: "name" });
    const description = typeof body.description === "string" ? body.description : undefined;

    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      throw badRequest("targets must be a non-empty array of model references.");
    }

    const targets: ModelComboTarget[] = body.targets.map((item, index) => {
      if (typeof item !== "object" || item === null) throw badRequest(`targets[${index}] must be an object.`);
      const target = item as Record<string, unknown>;
      return {
        provider: requireString(target, "provider", { minLen: 1, maxLen: 64, label: `targets[${index}].provider` }),
        modelId: requireString(target, "modelId", { minLen: 1, maxLen: 200, label: `targets[${index}].modelId` }),
        label: typeof target.label === "string" ? target.label : undefined,
        maxRetries: typeof target.maxRetries === "number" ? target.maxRetries : 2,
        timeoutMs: typeof target.timeoutMs === "number" ? target.timeoutMs : undefined,
      };
    });

    const fallbackTriggers: FallbackTrigger[] = Array.isArray(body.fallbackTriggers)
      ? (body.fallbackTriggers as FallbackTrigger[])
      : ["rate_limit", "quota_exhausted", "overloaded", "timeout"];
    const combo: ModelCombo = { id, name, description, targets, fallbackTriggers };

    await combos.update(projectId, (current) => {
      const registry = registryFrom(current);
      registry.set(combo);
      return { value: registry.list(), result: undefined };
    });
    return c.json({ ok: true, combo });
  });

  app.delete("/combos/:id", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    const id = requireValidId(c, "id");
    const deleted = await combos.update(projectId, (current) => {
      const registry = registryFrom(current);
      const result = registry.delete(id);
      return { value: registry.list(), result };
    });
    return c.json({ ok: true, deleted });
  });

  app.get("/quota", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const modelsCfg = await deps.projectConfigService.getModels(projectId);
    const models: Array<{ provider: string; modelId: string; isCooling: boolean | null }> = [];
    if (modelsCfg?.models) {
      for (const model of modelsCfg.models) {
        models.push({ provider: model.provider, modelId: model.modelId, isCooling: null });
      }
    }
    return c.json({
      activeQuota: {
        sessionUsedPct: null,
        weeklyUsedPct: null,
        resetsIn: null,
        status: "unknown",
      },
      models,
    });
  });

  app.get("/pricing", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json({ catalog: DEFAULT_PRICING_CATALOG });
  });

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

  app.post("/spend-flow", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
    const sessions: SessionCostRecord[] = rawSessions.map((session: Record<string, unknown>) => ({
      sessionId: typeof session.sessionId === "string" ? session.sessionId : "",
      projectId: typeof session.projectId === "string" ? session.projectId : projectId,
      projectPath: typeof session.projectPath === "string" ? session.projectPath : undefined,
      modelBreakdown:
        typeof session.modelBreakdown === "object" && session.modelBreakdown !== null
          ? (session.modelBreakdown as Record<string, { costUSD: number; tokens?: number }>)
          : {},
    }));
    return c.json({
      report: computeSpendFlow(sessions, {
        topNodeLimit: typeof body.limit === "number" ? body.limit : 8,
      }),
    });
  });

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
    return c.json(
      {
        error: {
          message: "Direct chat completion gateway endpoint is not supported in this runtime; use session execution.",
          type: "not_implemented",
          code: 501,
        },
      },
      501,
    );
  });

  app.post("/webhooks/approval", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const approvalId = requireString(body, "approvalId", { minLen: 1, maxLen: 128, label: "approvalId" });
    const action = requireString(body, "action", { minLen: 1, maxLen: 32, label: "action" });
    if (action !== "approve" && action !== "reject") {
      throw badRequest('action must be either "approve" or "reject".');
    }

    let sessionId: string;
    let toolCallId: string;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      sessionId = body.sessionId;
      toolCallId =
        typeof body.toolCallId === "string" && body.toolCallId.length > 0 ? body.toolCallId : approvalId;
    } else if (approvalId.includes(":")) {
      const separator = approvalId.indexOf(":");
      sessionId = approvalId.slice(0, separator);
      toolCallId = approvalId.slice(separator + 1);
    } else {
      throw badRequest("sessionId and toolCallId are required when approvalId is not '<sessionId>:<toolCallId>'.");
    }
    if (!sessionId || !toolCallId || sessionId.length > 128 || toolCallId.length > 128) {
      throw badRequest("sessionId and toolCallId must be non-empty identifiers no longer than 128 characters.");
    }

    const session = deps.sessionsRepo.findById(sessionId);
    if (!session || session.projectId !== projectId) {
      // Deliberately hide whether an out-of-project session exists.
      throw notFound("Approval does not exist or is not accessible in this project.");
    }
    deps.projectService.requireProjectAccess(c.var.user.userId, session.projectId);

    const decision = action === "approve" ? "allow" : "deny";
    const ok = deps.manager.decideApproval(sessionId, toolCallId, decision);
    if (!ok) throw notFound("Approval does not exist or has already been decided.");

    return c.json({
      ok: true,
      approvalId,
      sessionId,
      toolCallId,
      status: action === "approve" ? "approved" : "rejected",
      comment: typeof body.comment === "string" ? body.comment : undefined,
      approver: c.var.user.userId,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
