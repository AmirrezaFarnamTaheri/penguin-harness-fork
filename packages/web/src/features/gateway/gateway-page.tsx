/**
 * LLM Gateway, Fallback Combos & Quota Intelligence Workspace.
 *
 * Provides live quota telemetry, cooldown timers, provider fallback chains,
 * spend attribution flow, and pricing matrix calculator.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import type { ModelCombo, SpendFlowReport } from "@prismshadow/penguin-core/browser";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Modal } from "../../components/ui/modal";
import { toastSuccess, toastError } from "../../components/ui/toast";
import { SpendFlowCard } from "../hud/spend-flow-card";

interface QuotaData {
  activeQuota: {
    sessionUsedPct: number | null;
    weeklyUsedPct: number | null;
    resetsIn: string | null;
    status: string;
  };
  models: Array<{ provider: string; modelId: string; isCooling: boolean | null }>;
}

interface PricingEntry {
  modelId: string;
  provider: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
}

export function GatewayPage() {
  useDocumentTitle(S.nav.gateway ?? "Gateway & Quotas");
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId;

  const [activeTab, setActiveTab] = useState<"quota" | "combos" | "spendflow" | "pricing">("quota");
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [combos, setCombos] = useState<ModelCombo[]>([]);
  const [spendFlow, setSpendFlow] = useState<SpendFlowReport | null>(null);
  const [pricing, setPricing] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // New Combo Modal State
  const [comboModalOpen, setComboModalOpen] = useState(false);
  const [newComboId, setNewComboId] = useState("");
  const [newComboName, setNewComboName] = useState("");
  const [newComboTargets, setNewComboTargets] = useState(
    "anthropic:claude-3-7-sonnet, openai:gpt-4o, deepseek:deepseek-chat",
  );

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      setLoading(true);
      const [quotaRes, combosRes, pricingRes, spendRes] = await Promise.all([
        api.getGatewayQuota(projectId).catch(() => null),
        api.getGatewayCombos(projectId).catch(() => ({ combos: [] })),
        api.getGatewayPricing(projectId).catch(() => ({ catalog: null })),
        api.computeGatewaySpendFlow(projectId, { limit: 50 }).catch(() => null),
      ]);

      if (quotaRes) {
        setQuota(quotaRes);
      } else {
        setQuota(null);
      }

      if (Array.isArray(combosRes?.combos)) {
        setCombos(combosRes.combos);
      } else {
        setCombos([]);
      }

      if (pricingRes && typeof pricingRes === "object") {
        if ("pricing" in pricingRes && Array.isArray((pricingRes as any).pricing)) {
          setPricing((pricingRes as any).pricing);
        } else if ("catalog" in pricingRes && Array.isArray((pricingRes as any).catalog)) {
          setPricing(
            (pricingRes as any).catalog.map((entry: any) => ({
              modelId: entry.modelId,
              provider: entry.provider,
              inputPerMillion: entry.promptPerMillion ?? entry.inputPerMillion ?? 0,
              outputPerMillion: entry.completionPerMillion ?? entry.outputPerMillion ?? 0,
              cacheReadPerMillion: entry.cacheReadPerMillion,
            })),
          );
        } else {
          setPricing([]);
        }
      } else {
        setPricing([]);
      }

      if (spendRes && spendRes.report) {
        setSpendFlow(spendRes.report);
      } else {
        setSpendFlow(null);
      }
    } catch (err) {
      console.error("Failed to load gateway data:", err);
      toastError("Failed to fetch gateway metrics");
    } finally {
      setLoading(false);
    }
  }, [projectId, currentProject?.name]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCreateCombo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newComboId.trim() || !newComboName.trim()) return;
    try {
      const targets = newComboTargets
        .split(",")
        .map((part) => {
          const [provider, modelId] = part.trim().split(":");
          return {
            provider: provider?.trim() || "anthropic",
            modelId: modelId?.trim() || "default",
          };
        })
        .filter((t) => t.modelId);

      const comboPayload: ModelCombo = {
        id: newComboId.trim(),
        name: newComboName.trim(),
        targets,
      };

      await api.putGatewayCombo(projectId, comboPayload);
      setCombos((prev) => [...prev, comboPayload]);
      setComboModalOpen(false);
      setNewComboId("");
      setNewComboName("");
      toastSuccess("Model combo registered");
    } catch (err) {
      console.error("Failed to register combo:", err);
      toastError("Failed to create combo");
    }
  };

  const handleDeleteCombo = async (comboId: string) => {
    if (!projectId) return;
    try {
      await api.deleteGatewayCombo(projectId, comboId);
      setCombos((prev) => prev.filter((c) => c.id !== comboId));
      toastSuccess("Model combo deleted");
    } catch (err) {
      console.error("Failed to delete combo:", err);
      toastError("Failed to delete combo");
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-gray-50 dark:bg-gray-950 font-sans">
      {/* Top Cockpit Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-6 py-3 backdrop-blur-xs dark:border-gray-800 dark:bg-gray-900/80">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                LLM Gateway & Quota Cockpit
              </h1>
              <Badge tone="brand">Router v2 Active</Badge>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Multi-model routing chains, live cooldown gates, spend flow analysis, and quota
              telemetry
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => void loadData()}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => setComboModalOpen(true)}>
            + New Fallback Combo
          </Button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6">
        <button
          type="button"
          onClick={() => setActiveTab("quota")}
          className={`py-3 px-3 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "quota"
              ? "border-blue-500 text-blue-600 dark:text-blue-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          }`}
        >
          Quota & Cooldown Telemetry
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("combos")}
          className={`py-3 px-3 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "combos"
              ? "border-blue-500 text-blue-600 dark:text-blue-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          }`}
        >
          Fallback Combos ({combos.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("spendflow")}
          className={`py-3 px-3 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "spendflow"
              ? "border-blue-500 text-blue-600 dark:text-blue-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          }`}
        >
          Spend Flow & Attribution
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("pricing")}
          className={`py-3 px-3 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "pricing"
              ? "border-blue-500 text-blue-600 dark:text-blue-400 font-semibold"
              : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          }`}
        >
          Pricing Catalog
        </button>
      </div>

      {/* Main Workspace Content */}
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "quota" && (
          <div className="max-w-4xl mx-auto space-y-6 text-xs">
            {quota === null ? (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center text-gray-500">
                <p className="font-semibold text-gray-700 dark:text-gray-300">
                  Quota Telemetry Unavailable
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  No active quota monitors configured for this project.
                </p>
              </div>
            ) : (
              <>
                {/* Top Stat Meters */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xs">
                    <div className="text-[11px] text-gray-400 font-medium">Session Quota Used</div>
                    <div className="text-2xl font-bold font-mono text-gray-900 dark:text-gray-100 mt-1">
                      {quota.activeQuota.sessionUsedPct !== null
                        ? `${quota.activeQuota.sessionUsedPct}%`
                        : "N/A"}
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${quota.activeQuota.sessionUsedPct ?? 0}%` }}
                      />
                    </div>
                  </div>

                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xs">
                    <div className="text-[11px] text-gray-400 font-medium">Weekly Quota Used</div>
                    <div className="text-2xl font-bold font-mono text-gray-900 dark:text-gray-100 mt-1">
                      {quota.activeQuota.weeklyUsedPct !== null
                        ? `${quota.activeQuota.weeklyUsedPct}%`
                        : "N/A"}
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full"
                        style={{ width: `${quota.activeQuota.weeklyUsedPct ?? 0}%` }}
                      />
                    </div>
                  </div>

                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xs">
                    <div className="text-[11px] text-gray-400 font-medium">Next Reset Window</div>
                    <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                      {quota.activeQuota.resetsIn ?? "N/A"}
                    </div>
                    <div className="mt-2 text-[11px] text-gray-400">
                      Automatic quota replenishment
                    </div>
                  </div>
                </div>

                {/* Models Cooldown & Telemetry Status Table */}
                <div className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xs space-y-3">
                  <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-3">
                    <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                      Provider Model Health & Cooldown Circuit
                    </h3>
                    <span className="text-[11px] text-gray-400 font-mono">
                      {quota.models.length} endpoints monitored
                    </span>
                  </div>

                  <div className="divide-y divide-gray-100 dark:divide-gray-800">
                    {quota.models.map((m) => (
                      <div
                        key={`${m.provider}-${m.modelId}`}
                        className="py-3 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              m.isCooling ? "bg-amber-500 animate-pulse" : "bg-emerald-500"
                            }`}
                          />
                          <div>
                            <div className="font-semibold text-gray-800 dark:text-gray-200">
                              {m.modelId}
                            </div>
                            <div className="text-[11px] text-gray-400 font-mono capitalize">
                              Provider: {m.provider}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {m.isCooling ? (
                            <Badge tone="amber">COOLING DOWN</Badge>
                          ) : (
                            <Badge tone="green">OPERATIONAL</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === "combos" && (
          <div className="max-w-4xl mx-auto space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Configured Model Combos (Automatic Failover Chains)
              </h3>
            </div>

            {combos.length === 0 ? (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center text-gray-500">
                <p className="font-semibold text-gray-700 dark:text-gray-300">
                  No Model Combos Configured
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Register a fallback chain above to enable automatic model failover.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {combos.map((combo) => (
                  <div
                    key={combo.id}
                    className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-xs space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">
                          {combo.name}
                        </div>
                        <div className="font-mono text-[11px] text-gray-400">{combo.id}</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDeleteCombo(combo.id)}
                        className="text-red-500 hover:text-red-700"
                      >
                        Delete
                      </Button>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap font-mono text-xs pt-1">
                      {(combo.targets || []).map((target, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 font-medium text-blue-600 dark:text-blue-400">
                            {idx === 0 ? "★ Primary: " : `#${idx + 1} Fallback: `}
                            {target.modelId} ({target.provider})
                          </span>
                          {idx < (combo.targets || []).length - 1 && (
                            <span className="text-gray-400">→</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "spendflow" && (
          <div className="max-w-3xl mx-auto">
            {spendFlow ? (
              <SpendFlowCard report={spendFlow} />
            ) : (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center text-gray-500">
                <p className="font-semibold text-gray-700 dark:text-gray-300">
                  Spend Flow Metrics Unavailable
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  No spend telemetry records are available for this project yet.
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === "pricing" && (
          <div className="max-w-4xl mx-auto space-y-4 text-xs">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Model Token Pricing Matrix (USD per 1 Million Tokens)
            </h3>
            {pricing.length === 0 ? (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center text-gray-500">
                <p className="font-semibold text-gray-700 dark:text-gray-300">
                  Pricing Catalog Unavailable
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  No pricing data found for model endpoints.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden shadow-xs">
                <table className="w-full text-left">
                  <thead className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-800 font-mono text-[11px] text-gray-500">
                    <tr>
                      <th className="p-3">Model</th>
                      <th className="p-3">Provider</th>
                      <th className="p-3">Prompt Input / 1M</th>
                      <th className="p-3">Completion / 1M</th>
                      <th className="p-3">Prompt Cache Read / 1M</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800 font-mono">
                    {pricing.map((p) => (
                      <tr key={`${p.provider}-${p.modelId}`}>
                        <td className="p-3 font-semibold text-gray-900 dark:text-gray-100">
                          {p.modelId}
                        </td>
                        <td className="p-3 capitalize text-gray-600 dark:text-gray-400">
                          {p.provider}
                        </td>
                        <td className="p-3 text-blue-600 dark:text-blue-400 font-medium">
                          ${p.inputPerMillion.toFixed(2)}
                        </td>
                        <td className="p-3 text-purple-600 dark:text-purple-400 font-medium">
                          ${p.outputPerMillion.toFixed(2)}
                        </td>
                        <td className="p-3 text-emerald-600 dark:text-emerald-400">
                          ${(p.cacheReadPerMillion ?? p.inputPerMillion * 0.1).toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Combo Modal */}
      <Modal
        open={comboModalOpen}
        onClose={() => setComboModalOpen(false)}
        title="Register Model Combo"
      >
        <form onSubmit={handleCreateCombo} className="space-y-4 p-4 text-xs">
          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Combo Identifier (slug) *
            </label>
            <input
              type="text"
              required
              value={newComboId}
              onChange={(e) => setNewComboId(e.target.value)}
              placeholder="e.g. combo-robust-reasoning"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden font-mono dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Display Name *
            </label>
            <input
              type="text"
              required
              value={newComboName}
              onChange={(e) => setNewComboName(e.target.value)}
              placeholder="e.g. Robust Reasoning Combo"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium text-gray-700 dark:text-gray-300">
              Routing Target Chain (comma separated provider:model)
            </label>
            <input
              type="text"
              value={newComboTargets}
              onChange={(e) => setNewComboTargets(e.target.value)}
              placeholder="anthropic:claude-3-7-sonnet, openai:gpt-4o, deepseek:deepseek-chat"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-900 outline-hidden font-mono dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setComboModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Register Combo
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
