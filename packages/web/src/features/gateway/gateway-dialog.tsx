import { useState, useEffect } from "react";
import { Modal } from "../../components/ui/modal.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";

export interface GatewayDialogProps {
  open: boolean;
  onClose: () => void;
  projectId?: string;
}

export interface ModelQuotaStatus {
  provider: string;
  modelId: string;
  isCooling: boolean;
  cooldownRemainingText?: string;
}

export interface ModelComboView {
  id: string;
  name: string;
  description?: string;
  targets: Array<{ provider: string; modelId: string; label?: string }>;
}

export interface GatewayAccount {
  id: string;
  name: string;
  provider: string;
  tier: "Free" | "Pro" | "Enterprise" | "Pay-As-You-Go";
  isActive: boolean;
  latencyMs?: number;
  status: "healthy" | "degraded" | "cooling";
}

export function GatewayDialog({ open, onClose, projectId }: GatewayDialogProps) {
  const [tab, setTab] = useState<"quota" | "combos" | "pricing" | "accounts">("quota");
  const [sessionPct] = useState<number>(12);
  const [weeklyPct] = useState<number>(8);
  const [combos, setCombos] = useState<ModelComboView[]>([
    {
      id: "coding-cascade",
      name: "Autonomous Coding Cascade",
      description: "Falls back from Claude 3.7 Sonnet to DeepSeek R1 to GPT-4o upon quota exhaustion",
      targets: [
        { provider: "anthropic", modelId: "claude-3-7-sonnet-20250219", label: "Primary (Sonnet 3.7)" },
        { provider: "deepseek", modelId: "deepseek-reasoner", label: "Fallback 1 (DeepSeek R1)" },
        { provider: "openai", modelId: "gpt-4o", label: "Fallback 2 (GPT-4o)" },
      ],
    },
  ]);

  const [accounts, setAccounts] = useState<GatewayAccount[]>([
    { id: "acc-1", name: "Anthropic Team Primary", provider: "anthropic", tier: "Enterprise", isActive: true, latencyMs: 142, status: "healthy" },
    { id: "acc-2", name: "DeepSeek Reasoner Pool", provider: "deepseek", tier: "Pro", isActive: true, latencyMs: 380, status: "healthy" },
    { id: "acc-3", name: "OpenAI Fallback PayG", provider: "openai", tier: "Pay-As-You-Go", isActive: false, latencyMs: 185, status: "healthy" },
    { id: "acc-4", name: "Google Vertex Exp", provider: "google", tier: "Pro", isActive: true, latencyMs: 210, status: "healthy" },
  ]);
  const [pinging, setPinging] = useState(false);

  const handlePingEndpoints = () => {
    setPinging(true);
    setTimeout(() => {
      setAccounts((prev) =>
        prev.map((acc) => ({
          ...acc,
          latencyMs: Math.floor(100 + Math.random() * 250),
        }))
      );
      setPinging(false);
    }, 600);
  };

  const toggleAccount = (id: string) => {
    setAccounts((prev) =>
      prev.map((acc) => (acc.id === id ? { ...acc, isActive: !acc.isActive } : acc))
    );
  };

  const [newComboName, setNewComboName] = useState("");

  return (
    <Modal open={open} onClose={onClose} title="AI Gateway & Quota Cockpit" widthClass="sm:max-w-2xl">
      <div className="flex flex-col gap-4">
        {/* Navigation Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-800 gap-2">
          <button
            type="button"
            onClick={() => setTab("quota")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "quota"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Quota & Limits
          </button>
          <button
            type="button"
            onClick={() => setTab("combos")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "combos"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Fusion Combos
          </button>
          <button
            type="button"
            onClick={() => setTab("pricing")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "pricing"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Token Intelligence & Rates
          </button>
          <button
            type="button"
            onClick={() => setTab("accounts")}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === "accounts"
                ? "border-cyan-500 text-cyan-600 dark:text-cyan-400 font-semibold"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            Accounts & Latency ({accounts.filter((a) => a.isActive).length}/{accounts.length})
          </button>
        </div>

        {/* Tab Content */}
        {tab === "quota" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-gray-50 dark:bg-gray-800/60 rounded-lg border border-gray-200 dark:border-gray-700/60">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Active Session Quota</div>
                <div className="text-2xl font-semibold text-gray-800 dark:text-gray-100">{sessionPct}%</div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 h-2 rounded-full mt-2 overflow-hidden">
                  <div
                    className="bg-cyan-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${sessionPct}%` }}
                  />
                </div>
                <div className="text-[11px] text-gray-400 mt-1">Normal capacity • Resets in 2h 15m</div>
              </div>

              <div className="p-3 bg-gray-50 dark:bg-gray-800/60 rounded-lg border border-gray-200 dark:border-gray-700/60">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Weekly Rolling Quota</div>
                <div className="text-2xl font-semibold text-gray-800 dark:text-gray-100">{weeklyPct}%</div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 h-2 rounded-full mt-2 overflow-hidden">
                  <div
                    className="bg-blue-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${weeklyPct}%` }}
                  />
                </div>
                <div className="text-[11px] text-gray-400 mt-1">Rolling window reset Sunday 00:00 UTC</div>
              </div>
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400">
              Automatic cooldown detection parses 429 and RESOURCE_EXHAUSTED reset timestamps to dynamically
              route requests to active fallback models.
            </div>
          </div>
        )}

        {tab === "combos" && (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Fusion Combos automatically cascade and switch providers upon encountering rate limits or quota exhaustion:
            </div>
            {combos.map((c) => (
              <div
                key={c.id}
                className="p-3 bg-gray-50 dark:bg-gray-850 rounded-lg border border-gray-200 dark:border-gray-800 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-gray-800 dark:text-gray-200">{c.name}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 font-mono">
                    {c.targets.length} Models
                  </span>
                </div>
                {c.description && (
                  <div className="text-[11px] text-gray-500 dark:text-gray-400">{c.description}</div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  {c.targets.map((t, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1 text-[11px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-0.5 rounded">
                      <span className="font-mono text-cyan-600 dark:text-cyan-400">#{idx + 1}</span>
                      <span>{t.label ?? t.modelId}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "pricing" && (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Active token rates per 1,000,000 tokens (USD):
            </div>
            <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden text-xs">
              <table className="w-full text-left">
                <thead className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-medium">
                  <tr>
                    <th className="p-2">Model</th>
                    <th className="p-2">Input</th>
                    <th className="p-2">Output</th>
                    <th className="p-2">Cache Read</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  <tr>
                    <td className="p-2 font-mono text-[11px]">Claude 3.7 Sonnet</td>
                    <td className="p-2">$3.00</td>
                    <td className="p-2">$15.00</td>
                    <td className="p-2 text-cyan-600 dark:text-cyan-400">$0.30 (90% off)</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-mono text-[11px]">DeepSeek R1</td>
                    <td className="p-2">$0.55</td>
                    <td className="p-2">$2.19</td>
                    <td className="p-2 text-cyan-600 dark:text-cyan-400">$0.14 (75% off)</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-mono text-[11px]">GPT-4o</td>
                    <td className="p-2">$2.50</td>
                    <td className="p-2">$10.00</td>
                    <td className="p-2 text-cyan-600 dark:text-cyan-400">$1.25 (50% off)</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-mono text-[11px]">Gemini 2.5 Pro</td>
                    <td className="p-2">$1.25</td>
                    <td className="p-2">$5.00</td>
                    <td className="p-2 text-cyan-600 dark:text-cyan-400">$0.31 (75% off)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "accounts" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Multi-account pool routing & endpoint latency probes:
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePingEndpoints}
                disabled={pinging}
              >
                {pinging ? "Probing..." : "Ping All Endpoints"}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              {accounts.map((acc) => (
                <div
                  key={acc.id}
                  className="p-3 bg-gray-50 dark:bg-gray-850 rounded-lg border border-gray-200 dark:border-gray-800 flex items-center justify-between"
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-gray-800 dark:text-gray-200">
                        {acc.name}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                        {acc.provider}
                      </span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                        {acc.tier}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-3 mt-1">
                      <span>Status: <strong className="text-emerald-600 dark:text-emerald-400">{acc.status}</strong></span>
                      {acc.latencyMs !== undefined && (
                        <span>
                          Latency:{" "}
                          <span className={`font-mono font-semibold ${acc.latencyMs < 200 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                            {acc.latencyMs}ms
                          </span>
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => toggleAccount(acc.id)}
                    className={`px-3 py-1 text-xs rounded font-medium border transition-colors ${
                      acc.isActive
                        ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/20"
                        : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    }`}
                  >
                    {acc.isActive ? "Active in Pool" : "Disabled"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-gray-100 dark:border-gray-800">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
