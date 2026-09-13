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
  isValidId,
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
const ALLOWED_FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
  "rate_limit",
  "quota_exhausted",
  "auth_error",
  "overloaded",
  "timeout",
  "context_length_exceeded",
];
const MAX_SPEND_FLOW_NODES = 100;

function decodeCombos(raw: string): ModelCombo[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error("Gateway combo persistence file must contain a JSON array.");
  return parsed as ModelCombo[];
}

function registryFrom(combos: ModelCombo[]): ModelComboRegistry {
  return new ModelComboRegistry(combos);
}

async function getQuotaPayload(deps: AppDeps, projectId: string) {
  const modelsCfg = await deps.projectConfigService.getModels(projectId);
  const models: Array<{ provider: string; modelId: string; isCooling: boolean | null }> = [];
  if (modelsCfg?.models) {
    for (const model of modelsCfg.models) {
      models.push({ provider: model.provider, modelId: model.modelId, isCooling: null });
    }
  }
  return {
    activeQuota: {
      sessionUsedPct: null,
      weeklyUsedPct: null,
      resetsIn: null,
      status: "unknown" as const,
    },
    models,
  };
}

function tokenCount(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${key} must be a non-negative safe integer.`);
  }
  return value;
}

function parseSpendModelBreakdown(
  value: unknown,
  sessionIndex: number,
): SessionCostRecord["modelBreakdown"] {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`sessions[${sessionIndex}].modelBreakdown must be an object.`);
  }

  const parsed: SessionCostRecord["modelBreakdown"] = {};
  for (const [model, rawBreakdown] of Object.entries(value)) {
    if (!model || model.length > 256) {
      throw badRequest(
        `sessions[${sessionIndex}].modelBreakdown contains an invalid model identifier.`,
      );
    }
    if (
      typeof rawBreakdown !== "object" ||
      rawBreakdown === null ||
      Array.isArray(rawBreakdown)
    ) {
      throw badRequest(
        `sessions[${sessionIndex}].modelBreakdown.${model} must be an object.`,
      );
    }
    const breakdown = rawBreakdown as Record<string, unknown>;
    const costUSD = breakdown.costUSD;
    if (typeof costUSD !== "number" || !Number.isFinite(costUSD) || costUSD < 0) {
      throw badRequest(
        `sessions[${sessionIndex}].modelBreakdown.${model}.costUSD must be a non-negative finite number.`,
      );
    }
    const tokens = breakdown.tokens;
    if (
      tokens !== undefined &&
      (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0)
    ) {
      throw badRequest(
        `sessions[${sessionIndex}].modelBreakdown.${model}.tokens must be a non-negative safe integer.`,
      );
    }
    parsed[model] = {
      costUSD,
      ...(typeof tokens === "number" ? { tokens } : {}),
    };
  }
  return parsed;
}

function parseSpendSessions(value: unknown, projectId: string): SessionCostRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest("sessions must be an array when provided.");

  return value.map((rawSession, index) => {
    if (typeof rawSession !== "object" || rawSession === null || Array.isArray(rawSession)) {
      throw badRequest(`sessions[${index}] must be an object.`);
    }
    const session = rawSession as Record<string, unknown>;
    if (session.sessionId !== undefined && typeof session.sessionId !== "string") {
      throw badRequest(`sessions[${index}].sessionId must be a string when provided.`);
    }
    if (session.projectId !== undefined && typeof session.projectId !== "string") {
      throw badRequest(`sessions[${index}].projectId must be a string when provided.`);
    }
    if (session.projectPath !== undefined && typeof session.projectPath !== "string") {
      throw badRequest(`sessions[${index}].projectPath must be a string when provided.`);
    }

    return {
      sessionId: (session.sessionId as string | undefined) ?? "",
      projectId: (session.projectId as string | undefined) ?? projectId,
      projectPath: session.projectPath as string | undefined,
      modelBreakdown: parseSpendModelBreakdown(session.modelBreakdown, index),
    };
  });
}

function spendFlowLimit(value: unknown): number {
  if (value === undefined) return 8;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SPEND_FLOW_NODES
  ) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_SPEND_FLOW_NODES}.`);
  }
  return value;
}

export function isSafeSegment(segment: string): boolean {
  if (!segment || segment.length === 0 || segment.length > 128) return false;
  if (segment === "." || segment === "..") return false;
  if (/[\x00-\x1F\x7F\\?#]/.test(segment)) return false;
  if (
    segment.includes("..") ||
    segment.includes("/") ||
    segment.includes("%2f") ||
    segment.includes("%2F")
  )
    return false;
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
    if (!isValidId(id)) {
      throw badRequest("id must contain only letters, numbers, underscores, and hyphens.");
    }
    const name = requireString(body, "name", { minLen: 1, maxLen: 100, label: "name" });
    const description = typeof body.description === "string" ? body.description : undefined;

    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      throw badRequest("targets must be a non-empty array of model references.");
    }

    const targets: ModelComboTarget[] = body.targets.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw badRequest(`targets[${index}] must be an object.`);
      }
      const target = item as Record<string, unknown>;
      const maxRetries = target.maxRetries === undefined ? 2 : target.maxRetries;
      const timeoutMs = target.timeoutMs;
      if (!Number.isInteger(maxRetries) || (maxRetries as number) < 0) {
        throw badRequest(`targets[${index}].maxRetries must be a non-negative integer.`);
      }
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      ) {
        throw badRequest(`targets[${index}].timeoutMs must be a positive finite number.`);
      }
      return {
        provider: requireString(target, "provider", {
          minLen: 1,
          maxLen: 64,
          label: `targets[${index}].provider`,
        }),
        modelId: requireString(target, "modelId", {
          minLen: 1,
          maxLen: 200,
          label: `targets[${index}].modelId`,
        }),
        label: typeof target.label === "string" ? target.label : undefined,
        maxRetries: maxRetries as number,
        timeoutMs: timeoutMs as number | undefined,
      };
    });

    const fallbackTriggers: FallbackTrigger[] = Array.isArray(body.fallbackTriggers)
      ? body.fallbackTriggers.map((value, index) => {
          if (
            typeof value !== "string" ||
            !ALLOWED_FALLBACK_TRIGGERS.includes(value as FallbackTrigger)
          ) {
            throw badRequest(`fallbackTriggers[${index}] is not a supported fallback reason.`);
          }
          return value as FallbackTrigger;
        })
      : ["rate_limit", "quota_exhausted", "overloaded", "timeout"];
    const combo: ModelCombo = { id, name, description, targets, fallbackTriggers };

    const saved = await combos.update(projectId, (current) => {
      const registry = registryFrom(current);
      registry.set(combo);
      const persisted = registry.get(id)!;
      return { value: registry.list(), result: persisted };
    });
    return c.json({ ok: true, combo: saved });
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
    return c.json(await getQuotaPayload(deps, projectId));
  });

  app.get("/status", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(await getQuotaPayload(deps, projectId));
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
      promptTokens: tokenCount(body, "promptTokens"),
      completionTokens: tokenCount(body, "completionTokens"),
      reasoningTokens: tokenCount(body, "reasoningTokens"),
      cacheReadTokens: tokenCount(body, "cacheReadTokens"),
      cacheWriteTokens: tokenCount(body, "cacheWriteTokens"),
    };
    const breakdown = pricingCatalog.calculateCost(provider, modelId, usage);
    return c.json({
      breakdown,
      formattedTotal: pricingCatalog.formatCost(breakdown.totalCost, breakdown.priced),
      formattedSavings: pricingCatalog.formatCost(breakdown.savingsFromCache, breakdown.priced),
    });
  });

  app.post("/spend-flow", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const sessions = parseSpendSessions(body.sessions, projectId);
    return c.json({
      report: computeSpendFlow(sessions, {
        topNodeLimit: spendFlowLimit(body.limit),
      }),
    });
  });

  app.post("/chat/completions", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const body = await readJson(c);
    const model = requireString(body, "model", { minLen: 1, maxLen: 256, label: "model" });
    if (!isSafeResourceName(model)) {
      throw badRequest(
        `Invalid model resource name: "${model}". Prohibited characters or path traversal pattern.`,
      );
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw badRequest("messages must be a non-empty array of chat message objects.");
    }
    return c.json(
      {
        error: {
          message:
            "Direct chat completion gateway endpoint is not supported in this runtime; use session execution.",
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
    const approvalId = requireString(body, "approvalId", {
      minLen: 1,
      maxLen: 128,
      label: "approvalId",
    });
    const action = requireString(body, "action", { minLen: 1, maxLen: 32, label: "action" });
    if (action !== "approve" && action !== "reject") {
      throw badRequest('action must be either "approve" or "reject".');
    }

    let sessionId: string;
    let toolCallId: string;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      sessionId = body.sessionId;
      toolCallId =
        typeof body.toolCallId === "string" && body.toolCallId.length > 0
          ? body.toolCallId
          : approvalId;
    } else if (approvalId.includes(":")) {
      const separator = approvalId.indexOf(":");
      sessionId = approvalId.slice(0, separator);
      toolCallId = approvalId.slice(separator + 1);
    } else {
      throw notFound("Approval does not exist or is not accessible in this project.");
    }
    if (!sessionId || !toolCallId || sessionId.length > 128 || toolCallId.length > 128) {
      throw badRequest(
        "sessionId and toolCallId must be non-empty identifiers no longer than 128 characters.",
      );
    }

    const session = deps.sessionsRepo.findById(sessionId);
    if (!session || session.projectId !== projectId) {
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
