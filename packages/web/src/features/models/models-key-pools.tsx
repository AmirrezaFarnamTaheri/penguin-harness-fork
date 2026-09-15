/**
 * API Key Health & Rotation Telemetry Cockpit.
 *
 * Provides real-time visibility into multi-key credential pools across configured LLM providers:
 * - Round-robin rotation status and active leases
 * - 429 rate limit cooldowns with live countdown timers
 * - 401 eviction alerts and failure error telemetry
 * - Global and per-model cooldown reset controls
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelRefDto } from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { apiErrorText } from "../../lib/api-error";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { CopyButton } from "../../components/ui/copy-button";
import { ProviderLogo } from "../../components/ui/provider-logo";
import { toastError, toastSuccess } from "../../components/ui/toast";
import { formatDateTime } from "../../lib/format";
import { formatCooldown, keyHealthLabel, type ModelKeyHealthReportDto } from "./model-keys-health";
import type { RowState } from "./models-page";
import { modelLabelOf } from "./models-page";

export interface ModelsKeyPoolsProps {
  projectId: string;
  isOwner: boolean;
  rows: readonly RowState[] | null;
  onOpenModelDialog?: (ref: ModelRefDto) => void;
}

type FilterMode = "all" | "healthy" | "issues";

export function ModelsKeyPools({
  projectId,
  isOwner,
  rows,
  onOpenModelDialog,
}: ModelsKeyPoolsProps) {
  const [reports, setReports] = useState<ModelKeyHealthReportDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [resettingAll, setResettingAll] = useState(false);
  const [resettingModel, setResettingModel] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick clock every second for live cooldown countdown
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getModelKeyHealth(projectId);
      if (Array.isArray(res.reports)) {
        setReports(res.reports);
      } else if (res && typeof res.modelRef === "string") {
        setReports([res]);
      } else {
        setReports([]);
      }
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const handleResetAll = async () => {
    if (!isOwner) return;
    setResettingAll(true);
    try {
      await api.resetModelKeys(projectId);
      toastSuccess(S.models.resetSuccess);
      await loadHealth();
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setResettingAll(false);
    }
  };

  const handleResetModel = async (provider: string, modelId: string) => {
    if (!isOwner) return;
    const refKey = `${provider}/${modelId}`;
    setResettingModel(refKey);
    try {
      await api.resetModelKeys(projectId, provider, modelId);
      toastSuccess(S.models.keysResetSuccess);
      await loadHealth();
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setResettingModel(null);
    }
  };

  // Map reports by ref string "provider/modelId" or "projectId/provider/modelId"
  const reportMap = useMemo(() => {
    const map = new Map<string, ModelKeyHealthReportDto>();
    if (!reports) return map;
    for (const r of reports) {
      map.set(r.modelRef, r);
      // Also index by bare "provider/modelId"
      const parts = r.modelRef.split("/");
      if (parts.length >= 2) {
        const bare = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
        map.set(bare, r);
      }
    }
    return map;
  }, [reports]);

  // Aggregate stats across all models
  const summaryStats = useMemo(() => {
    let totalKeys = 0;
    let healthyCount = 0;
    let cooldownCount = 0;
    let evictedCount = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    let totalLeases = 0;

    if (reports) {
      for (const r of reports) {
        totalKeys += r.totalKeys;
        healthyCount += r.healthyCount;
        cooldownCount += r.cooldownCount;
        evictedCount += r.evictedCount;
        if (r.activeLeases) totalLeases += r.activeLeases;
        for (const k of r.keys) {
          totalSuccesses += k.successCount;
          totalFailures += k.failureCount;
        }
      }
    }

    const totalCalls = totalSuccesses + totalFailures;
    const successRate = totalCalls > 0 ? (totalSuccesses / totalCalls) * 100 : 100;

    return {
      totalKeys,
      healthyCount,
      cooldownCount,
      evictedCount,
      totalSuccesses,
      totalFailures,
      totalLeases,
      successRate,
    };
  }, [reports]);

  // Models with report or from rows
  const modelEntries = useMemo(() => {
    if (!rows) return [];
    const query = search.trim().toLowerCase();

    return rows
      .map((row) => {
        const refKey = `${row.provider}/${row.modelId}`;
        const report = reportMap.get(refKey);
        const name = modelLabelOf(row.displayName, row.modelId);
        const hasKeys = (report && report.totalKeys > 0) || Boolean(row.credential?.apiKeyMasked);
        const inCooldown = (report?.cooldownCount ?? 0) > 0;
        const isEvicted = (report?.evictedCount ?? 0) > 0;
        const hasIssues = inCooldown || isEvicted;

        return {
          row,
          refKey,
          report,
          name,
          hasKeys,
          inCooldown,
          isEvicted,
          hasIssues,
        };
      })
      .filter((item) => {
        if (filter === "healthy" && item.hasIssues) return false;
        if (filter === "issues" && !item.hasIssues) return false;
        if (query) {
          const matchName = item.name.toLowerCase().includes(query);
          const matchId = item.row.modelId.toLowerCase().includes(query);
          const matchProvider = item.row.provider.toLowerCase().includes(query);
          const matchKeys =
            item.report?.keys.some((k) => k.maskedKey.toLowerCase().includes(query)) ?? false;
          if (!matchName && !matchId && !matchProvider && !matchKeys) return false;
        }
        return true;
      });
  }, [rows, reportMap, filter, search]);

  return (
    <div className="space-y-6">
      {/* Cockpit Overview Header */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/60 backdrop-blur-md p-4 sm:p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-gray-100 dark:border-gray-800/80">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {S.models.keyPoolsTitle}
              </h2>
              <Badge
                tone={
                  summaryStats.evictedCount > 0
                    ? "red"
                    : summaryStats.cooldownCount > 0
                      ? "amber"
                      : "green"
                }
              >
                {summaryStats.evictedCount > 0
                  ? `${summaryStats.evictedCount} Evicted`
                  : summaryStats.cooldownCount > 0
                    ? `${summaryStats.cooldownCount} Cooldown`
                    : "100% Operational"}
              </Badge>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{S.models.keyPoolsDesc}</p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={loading}
              onClick={() => void loadHealth()}
            >
              <span className={`inline-block mr-1.5 ${loading ? "animate-spin" : ""}`}>↺</span>
              {S.models.refreshHealth}
            </Button>
            {isOwner && (
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  resettingAll ||
                  (summaryStats.cooldownCount === 0 && summaryStats.evictedCount === 0)
                }
                onClick={() => void handleResetAll()}
              >
                {resettingAll ? S.models.resettingKeys : S.models.resetAllKeys}
              </Button>
            )}
          </div>
        </div>

        {/* Pro Telemetry Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 pt-4 font-mono">
          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              {S.models.totalKeysConfigured}
            </div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1 tabular-nums">
              {summaryStats.totalKeys}
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">Across all models</div>
          </div>

          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              {S.models.healthyPoolsRatio}
            </div>
            <div className="text-xl font-bold text-green-600 dark:text-green-400 mt-1 tabular-nums">
              {summaryStats.totalKeys > 0
                ? `${Math.round((summaryStats.healthyCount / summaryStats.totalKeys) * 100)}%`
                : "100%"}
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">
              {summaryStats.healthyCount}/{summaryStats.totalKeys} active
            </div>
          </div>

          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              429 Cooldown
            </div>
            <div
              className={`text-xl font-bold mt-1 tabular-nums ${
                summaryStats.cooldownCount > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-gray-900 dark:text-gray-100"
              }`}
            >
              {summaryStats.cooldownCount}
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">Backoff active</div>
          </div>

          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              401 Evicted
            </div>
            <div
              className={`text-xl font-bold mt-1 tabular-nums ${
                summaryStats.evictedCount > 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-900 dark:text-gray-100"
              }`}
            >
              {summaryStats.evictedCount}
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">Expired / invalid</div>
          </div>

          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              {S.models.successRate}
            </div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1 tabular-nums">
              {summaryStats.successRate.toFixed(1)}%
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">
              {summaryStats.totalSuccesses} ok / {summaryStats.totalFailures} err
            </div>
          </div>

          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              {S.models.activeLeases}
            </div>
            <div className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1 tabular-nums">
              {summaryStats.totalLeases}
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">In-flight requests</div>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 p-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 text-xs">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`px-3 py-1 rounded-md transition-colors ${
              filter === "all"
                ? "bg-white dark:bg-gray-800 font-medium text-gray-900 dark:text-gray-100 shadow-xs"
                : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            }`}
          >
            {S.models.filterAll}
          </button>
          <button
            type="button"
            onClick={() => setFilter("healthy")}
            className={`px-3 py-1 rounded-md transition-colors ${
              filter === "healthy"
                ? "bg-white dark:bg-gray-800 font-medium text-gray-900 dark:text-gray-100 shadow-xs"
                : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            }`}
          >
            {S.models.filterHealthy}
          </button>
          <button
            type="button"
            onClick={() => setFilter("issues")}
            className={`px-3 py-1 rounded-md transition-colors ${
              filter === "issues"
                ? "bg-white dark:bg-gray-800 font-medium text-amber-700 dark:text-amber-400 shadow-xs"
                : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            }`}
          >
            {S.models.filterIssues}
            {(summaryStats.cooldownCount > 0 || summaryStats.evictedCount > 0) && (
              <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-mono">
                {summaryStats.cooldownCount + summaryStats.evictedCount}
              </span>
            )}
          </button>
        </div>

        <div className="w-full sm:w-64">
          <Input
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search model, key, or vendor..."
          />
        </div>
      </div>

      {error && (
        <div className="p-3 text-xs rounded-lg border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Model Key Pools Grid */}
      <div className="space-y-4">
        {modelEntries.length === 0 ? (
          <div className="py-12 text-center rounded-xl border border-dashed border-gray-300 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
            {S.models.noSearchResults}
          </div>
        ) : (
          modelEntries.map(({ row, refKey, report, name, hasKeys, inCooldown, isEvicted }) => {
            const hasRotator = report && report.keys.length > 0;
            const modelResetting = resettingModel === refKey;

            return (
              <div
                key={refKey}
                className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/40 backdrop-blur-sm p-4 sm:p-5 transition-all duration-200 hover:border-gray-300 dark:hover:border-gray-700"
              >
                {/* Model Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-gray-100 dark:border-gray-800/80">
                  <div className="flex items-center gap-2.5">
                    <ProviderLogo provider={row.provider} className="h-5 w-5" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">
                          {name}
                        </span>
                        <span className="font-mono text-xs text-gray-400 dark:text-gray-500">
                          {row.modelId}
                        </span>
                        {inCooldown && (
                          <Badge tone="amber">
                            {S.models.keysInCooldown(report?.cooldownCount ?? 0)}
                          </Badge>
                        )}
                        {isEvicted && (
                          <Badge tone="red">
                            {S.models.keysEvicted(report?.evictedCount ?? 0)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {hasRotator && (inCooldown || isEvicted) && isOwner && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={modelResetting}
                        onClick={() => void handleResetModel(row.provider, row.modelId)}
                      >
                        {modelResetting ? S.models.resettingKeys : S.models.resetKeys}
                      </Button>
                    )}
                    {onOpenModelDialog && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          onOpenModelDialog({ provider: row.provider, modelId: row.modelId })
                        }
                      >
                        {S.models.editTitle}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Keys Breakdown */}
                <div className="pt-3">
                  {!hasKeys && !hasRotator ? (
                    <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1">
                      {S.models.noKeysConfigured}
                    </div>
                  ) : hasRotator ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {report.keys.map((k, idx) => {
                        const isCd = k.status === "cooldown";
                        const isEv = k.status === "evicted";
                        const remaining = Math.max(0, k.cooldownRemainingMs - (Date.now() - now));
                        const cdText = formatCooldown(remaining);

                        return (
                          <div
                            key={idx}
                            className={`rounded-lg border p-3 font-mono text-xs transition-colors ${
                              isEv
                                ? "border-red-200 dark:border-red-900/60 bg-red-50/30 dark:bg-red-950/20"
                                : isCd
                                  ? "border-amber-200 dark:border-amber-900/60 bg-amber-50/30 dark:bg-amber-950/20"
                                  : "border-gray-200/90 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/20"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-gray-100 dark:border-gray-800/60">
                              <div className="flex items-center gap-1.5 truncate">
                                <span
                                  className={`h-2 w-2 rounded-full shrink-0 ${
                                    isEv
                                      ? "bg-red-500"
                                      : isCd
                                        ? "bg-amber-500 animate-pulse"
                                        : "bg-green-500"
                                  }`}
                                />
                                <span className="font-semibold text-gray-900 dark:text-gray-100">
                                  {k.maskedKey}
                                </span>
                              </div>
                              <CopyButton text={k.maskedKey} label="Copy masked key" />
                            </div>

                            <div className="mt-2 space-y-1 text-[11px] tabular-nums">
                              <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
                                <span>Status</span>
                                <span
                                  className={`font-semibold ${
                                    isEv
                                      ? "text-red-600 dark:text-red-400"
                                      : isCd
                                        ? "text-amber-600 dark:text-amber-400"
                                        : "text-green-600 dark:text-green-400"
                                  }`}
                                >
                                  {keyHealthLabel(k, {
                                    active: S.models.keyHealthActive,
                                    cooldown:
                                      isCd && cdText
                                        ? `Cooldown (${cdText})`
                                        : S.models.keyHealthCooldown,
                                    evicted: S.models.keyHealthEvicted,
                                  })}
                                </span>
                              </div>

                              <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
                                <span>
                                  {S.models.successCount} / {S.models.failureCount}
                                </span>
                                <span className="text-gray-900 dark:text-gray-100">
                                  {k.successCount} / {k.failureCount}
                                </span>
                              </div>

                              {k.activeLeases !== undefined && k.activeLeases > 0 && (
                                <div className="flex items-center justify-between text-blue-600 dark:text-blue-400">
                                  <span>{S.models.activeLeases}</span>
                                  <span className="font-bold">{k.activeLeases}</span>
                                </div>
                              )}

                              <div className="flex items-center justify-between text-gray-400 text-[10px] pt-1 border-t border-gray-100 dark:border-gray-800/40">
                                <span>{S.models.lastUsed}</span>
                                <span>
                                  {k.lastUsedAt
                                    ? formatDateTime(new Date(k.lastUsedAt).toISOString())
                                    : S.models.neverUsed}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    /* Single key configured on the row */
                    <div className="rounded-lg border border-gray-200/90 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/20 p-3 font-mono text-xs max-w-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-green-500" />
                          <span className="font-semibold text-gray-900 dark:text-gray-100">
                            {row.credential?.apiKeyMasked || "••••••••"}
                          </span>
                        </div>
                        <Badge tone="green">{S.models.keyHealthActive}</Badge>
                      </div>
                      <div className="mt-1 text-[11px] text-gray-400">Single Key Configured</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
