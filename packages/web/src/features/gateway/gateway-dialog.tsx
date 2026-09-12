import { useEffect, useState } from "react";
import { Modal } from "../../components/ui/modal.js";
import { Button } from "../../components/ui/button.js";

export interface GatewayDialogProps {
  open: boolean;
  onClose: () => void;
  projectId?: string;
}

interface QuotaPayload {
  activeQuota: {
    sessionUsedPct: number | null;
    weeklyUsedPct: number | null;
    resetsIn: string | null;
    status: "unknown" | string;
  };
  models: Array<{ provider: string; modelId: string; isCooling: boolean | null }>;
}

interface ModelComboView {
  id: string;
  name: string;
  description?: string;
  targets: Array<{ provider: string; modelId: string; label?: string }>;
  updatedAt?: string;
}

type Tab = "quota" | "combos" | "pricing";

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const known = typeof value === "number" && Number.isFinite(value);
  const bounded = known ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700/60 dark:bg-gray-800/60">
      <div className="mb-1 text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-2xl font-semibold text-gray-800 dark:text-gray-100">
        {known ? `${value}%` : "Unknown"}
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className="h-full rounded-full bg-cyan-500 transition-all duration-300" style={{ width: `${bounded}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-gray-400">
        {known ? "Provider-reported usage" : "No usage telemetry is available for this project."}
      </div>
    </div>
  );
}

export function GatewayDialog({ open, onClose, projectId }: GatewayDialogProps) {
  const [tab, setTab] = useState<Tab>("quota");
  const [quota, setQuota] = useState<QuotaPayload | null>(null);
  const [combos, setCombos] = useState<ModelComboView[]>([]);
  const [pricing, setPricing] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!projectId) {
      setQuota(null);
      setCombos([]);
      setPricing(null);
      setError("Select a project to inspect gateway state.");
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      fetchJson<QuotaPayload>(`/api/projects/${projectId}/gateway/quota`, controller.signal),
      fetchJson<{ combos: ModelComboView[] }>(`/api/projects/${projectId}/gateway/combos`, controller.signal),
      fetchJson<{ catalog: unknown }>(`/api/projects/${projectId}/gateway/pricing`, controller.signal),
    ])
      .then(([quotaResult, comboResult, pricingResult]) => {
        setQuota(quotaResult);
        setCombos(comboResult.combos ?? []);
        setPricing(pricingResult.catalog);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [open, projectId]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "quota", label: "Quota & Limits" },
    { id: "combos", label: `Fallback Combos (${combos.length})` },
    { id: "pricing", label: "Pricing Catalog" },
  ];

  return (
    <Modal open={open} onClose={onClose} title="AI Gateway" widthClass="sm:max-w-2xl">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2 border-b border-gray-200 dark:border-gray-800">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                tab === item.id
                  ? "border-cyan-500 font-semibold text-cyan-600 dark:text-cyan-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {loading && <div className="text-sm text-gray-500">Loading gateway state…</div>}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            Gateway data could not be loaded: {error}
          </div>
        )}

        {!loading && !error && tab === "quota" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Meter label="Active Session Usage" value={quota?.activeQuota.sessionUsedPct ?? null} />
              <Meter label="Weekly Rolling Usage" value={quota?.activeQuota.weeklyUsedPct ?? null} />
            </div>
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Configured models</div>
              {quota?.models.length ? (
                <div className="flex flex-col gap-2">
                  {quota.models.map((model) => (
                    <div key={`${model.provider}:${model.modelId}`} className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium text-gray-800 dark:text-gray-100">{model.provider}</span>
                        <span className="text-gray-400"> / </span>
                        <span className="break-all text-gray-600 dark:text-gray-300">{model.modelId}</span>
                      </div>
                      <span className="shrink-0 text-xs text-gray-500">
                        {model.isCooling === true ? "Cooling" : model.isCooling === false ? "Ready" : "Status unknown"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-500">No models are configured for this project.</div>
              )}
            </div>
            <div className="text-xs text-gray-500">
              Quota status: {quota?.activeQuota.status ?? "unknown"}
              {quota?.activeQuota.resetsIn ? ` · resets in ${quota.activeQuota.resetsIn}` : ""}
            </div>
          </div>
        )}

        {!loading && !error && tab === "combos" && (
          <div className="flex flex-col gap-3">
            {combos.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">
                No fallback combos are configured.
              </div>
            ) : (
              combos.map((combo) => (
                <div key={combo.id} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-800 dark:text-gray-100">{combo.name}</div>
                      {combo.description && <div className="mt-1 text-xs text-gray-500">{combo.description}</div>}
                    </div>
                    <code className="text-[11px] text-gray-400">{combo.id}</code>
                  </div>
                  <ol className="mt-3 flex flex-col gap-1 text-xs text-gray-600 dark:text-gray-300">
                    {combo.targets.map((target, index) => (
                      <li key={`${target.provider}:${target.modelId}:${index}`}>
                        {index + 1}. {target.label ? `${target.label} · ` : ""}{target.provider}/{target.modelId}
                      </li>
                    ))}
                  </ol>
                  {combo.updatedAt && <div className="mt-2 text-[11px] text-gray-400">Updated {combo.updatedAt}</div>}
                </div>
              ))
            )}
          </div>
        )}

        {!loading && !error && tab === "pricing" && (
          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="mb-2 text-xs text-gray-500">
              Server pricing catalog. Values are shown as supplied by the backend; unknown prices are not inferred.
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-3 text-[11px] text-gray-700 dark:bg-gray-900 dark:text-gray-300">
              {JSON.stringify(pricing, null, 2)}
            </pre>
          </div>
        )}

        <div className="flex justify-end border-t border-gray-200 pt-3 dark:border-gray-800">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
