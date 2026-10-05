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
import { useUiClock } from "../../lib/use-ui-clock";
import { sharedUiClock } from "../../lib/ui-clock";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { CopyButton } from "../../components/ui/copy-button";
import { ProviderLogo } from "../../components/ui/provider-logo";
import { toastError, toastSuccess } from "../../components/ui/toast";
import { formatDateTime } from "../../lib/format";
import { formatCooldown, keyHealthLabel, type ModelKeyHealthReportDto } from "./model-keys-health";
import { KeyNameEditor } from "./key-name-editor";
import { keyMatchesQuery, keyNameOf, type KeyNameEntry } from "./key-fleet-types";
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
  const [keyNames, setKeyNames] = useState<KeyNameEntry[]>([]);
  const [renamingKey, setRenamingKey] = useState<{
    maskedKey: string;
    provider: string;
    modelId: string;
    name?: string;
    label?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [resettingAll, setResettingAll] = useState(false);
  const [resettingModel, setResettingModel] = useState<string | null>(null);

  /**
   * Names whose key is no longer configured.
   *
   * The health report only lists keys that are there, so a name given to a key that was later
   * rotated away has no tile to sit on. Dropping it silently is the one outcome that teaches
   * the user the feature loses things, so it is listed once, at the bottom, saying so.
   */
  const orphanedNames = useMemo(() => keyNames.filter((entry) => entry.orphaned), [keyNames]);

  // Live cooldown countdown; the tick comes from the shared UI clock (F2), so this page does not
  // own a second one and a tab restored from sleep repaints the countdown on the wakeup.
  const now = useUiClock(1000);

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

  // A second read, for the names whose key is gone. A failure here leaves the pools exactly
  // as they are, which is the right failure: the health report is the page, the orphan list is
  // a footnote about it.
  useEffect(() => {
    let cancelled = false;
    void api
      .listModelKeyNames(projectId)
      .then((res) => {
        if (!cancelled && Array.isArray(res.keys)) setKeyNames(res.keys);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const applySavedName = (
    target: { maskedKey: string; provider: string; modelId: string },
    saved: { name: string; label?: string; keyId: string },
  ) => {
    setKeyNames((source) => [
      ...source.filter((entry) => entry.keyId !== saved.keyId),
      {
        keyId: saved.keyId,
        name: saved.name,
        ...(saved.label === undefined ? {} : { label: saved.label }),
        provider: target.provider,
        modelId: target.modelId,
        maskedKey: target.maskedKey,
        orphaned: false,
      },
    ]);
    toastSuccess(S.models.keyNameSaved(saved.name));
    setRenamingKey(null);
    void loadHealth();
  };

  const handleResetAll = async () => {
    if (!isOwner) return;
    // A reset that names no pool is refused by the server (400). It used to be answered
    // { ok: true } — so this button could show "Key pool status reset successfully" over a
    // pool that had not changed at all. There is no ref-less call to make any more: send
    // the refs this button actually means, one request each, so every request names its
    // own pool and the count in the toast is a count of work that really happened.
    const targets = resettableRefs;
    if (targets.length === 0) return;
    setResettingAll(true);
    try {
      let done = 0;
      let failure: unknown;
      for (const target of targets) {
        try {
          await api.resetModelKeys(projectId, target.provider, target.modelId);
          done += 1;
        } catch (e) {
          // Keep going rather than bail: the pools already cleared are cleared, and
          // stopping at the first failure would leave the rest cooling while the user
          // believed the button had reset everything.
          failure ??= e;
        }
      }
      // A partial run is reported as the failure it is, not as a success. loadHealth()
      // below then puts each pool that did NOT clear back on screen still cooling, which
      // is the per-pool truth the single success toast used to paper over.
      if (failure !== undefined) toastError(apiErrorText(failure));
      else toastSuccess(S.models.resetAllKeysDone(done));
      await loadHealth();
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

  /**
   * Every pool the "Reset All Key Pools" button means, as (provider, modelId) pairs.
   *
   * Derived from `rows` + `reportMap` rather than from `modelEntries`, because
   * `modelEntries` is already narrowed by the search box and the filter chips: a search in
   * progress would have made "reset all" clear only the pools that search happened to
   * leave on screen, which is the same class of silent surprise as the bug this replaces.
   * A pool qualifies exactly when its health report says a key is cooling down or evicted
   * — and a `rows` entry (not a bare report) is what guarantees a real provider/modelId to
   * send, which is the one thing a reset request cannot do without.
   */
  const resettableRefs = useMemo(() => {
    const out: Array<{ provider: string; modelId: string }> = [];
    for (const row of rows ?? []) {
      const report = reportMap.get(`${row.provider}/${row.modelId}`);
      if (!report) continue;
      if (report.cooldownCount > 0 || report.evictedCount > 0) {
        out.push({ provider: row.provider, modelId: row.modelId });
      }
    }
    return out;
  }, [rows, reportMap]);

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
          // A key is found by its name and its label as well as by its mask: "show me prod"
          // is the question a named fleet exists to answer.
          const matchKeys = item.report?.keys.some((k) => keyMatchesQuery(k, query)) ?? false;
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
                // Disabled when there is no pool to clear — and `resettableRefs` is the
                // same list the click handler iterates, so the button can never be
                // enabled with nothing behind it, nor fire with a list it did not mean.
                disabled={resettingAll || resettableRefs.length === 0}
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
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              Across all models
            </div>
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
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
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
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              Backoff active
            </div>
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
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              Expired / invalid
            </div>
          </div>

          <div className="rounded-lg border border-gray-200/80 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-3">
            <div className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-sans">
              {S.models.successRate}
            </div>
            <div className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1 tabular-nums">
              {summaryStats.successRate.toFixed(1)}%
            </div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
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
            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
              In-flight requests
            </div>
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
          {/* A filter bar's search box has no room for a visible label — and a placeholder
              is not a name: it is skipped by some screen readers and vanishes on the first
              keystroke, leaving this control announced as an unlabelled text field. So it
              takes the same `aria-label` every other search box in the app takes. */}
          <Input
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={S.models.searchKeyPools}
            placeholder={S.models.searchKeyPools}
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
            // A model with exactly one configured key and no health-report entry has nothing
            // for the rotator branch to show, so the fallback tile draws from the model row —
            // which carries the models table's own (narrowest) mask. Joining on THAT is exact;
            // guessing by position or by pool size would put a name on the wrong key.
            const rowMask = row.credential?.apiKeyMasked;
            const singleName =
              rowMask === undefined
                ? undefined
                : keyNames.find(
                    (entry) =>
                      !entry.orphaned &&
                      entry.provider === row.provider &&
                      entry.modelId === row.modelId &&
                      entry.rowMask === rowMask,
                  );

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
                        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
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
                    <div className="text-xs text-gray-500 dark:text-gray-400 italic py-1">
                      {S.models.noKeysConfigured}
                    </div>
                  ) : hasRotator ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {report.keys.map((k, idx) => {
                        const isCd = k.status === "cooldown";
                        const isEv = k.status === "evicted";
                        const remaining = Math.max(
                          0,
                          k.cooldownRemainingMs - (sharedUiClock().now() - now),
                        );
                        const cdText = formatCooldown(remaining);
                        const { name, isUnnamed } = keyNameOf(k, S.models.keyUnnamed);
                        const isRenaming =
                          renamingKey !== null && renamingKey.maskedKey === k.maskedKey;

                        return (
                          <div
                            key={k.keyId ?? `${k.maskedKey}-${idx}`}
                            className={`rounded-lg border p-3 font-mono text-xs transition-colors ${
                              isEv
                                ? "border-red-200 dark:border-red-900/60 bg-red-50/30 dark:bg-red-950/20"
                                : isCd
                                  ? "border-amber-200 dark:border-amber-900/60 bg-amber-50/30 dark:bg-amber-950/20"
                                  : "border-gray-200/90 dark:border-gray-800 bg-gray-50/40 dark:bg-gray-800/20"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-gray-100 dark:border-gray-800/60">
                              <div className="flex min-w-0 flex-col gap-0.5">
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
                                {isRenaming ? null : (
                                  <div className="flex items-center gap-1.5">
                                    {isUnnamed ? (
                                      <span className="font-sans text-[11px] text-gray-500 italic dark:text-gray-400">
                                        {S.models.keyUnnamed}
                                      </span>
                                    ) : (
                                      <span className="font-sans text-[11px] font-medium text-gray-900 dark:text-gray-100">
                                        {name}
                                      </span>
                                    )}
                                    {isOwner && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setRenamingKey({
                                            maskedKey: k.maskedKey,
                                            provider: row.provider,
                                            modelId: row.modelId,
                                            ...(k.name === undefined ? {} : { name: k.name }),
                                            ...(k.label === undefined ? {} : { label: k.label }),
                                          })
                                        }
                                        className="font-sans text-[11px] text-blue-700 underline underline-offset-2 hover:no-underline dark:text-blue-400"
                                      >
                                        {isUnnamed ? S.models.keyNameAction : S.models.keyNameEdit}
                                      </button>
                                    )}
                                  </div>
                                )}
                                {k.label !== undefined && k.label !== "" && (
                                  <span className="font-sans text-[11px] text-gray-500 dark:text-gray-400">
                                    {k.label}
                                  </span>
                                )}
                              </div>
                              <CopyButton text={k.maskedKey} label="Copy masked key" />
                            </div>

                            {isRenaming ? (
                              <div className="mt-2">
                                <KeyNameEditor
                                  projectId={projectId}
                                  provider={row.provider}
                                  modelId={row.modelId}
                                  maskedKey={k.maskedKey}
                                  {...(renamingKey?.name === undefined
                                    ? {}
                                    : { name: renamingKey.name })}
                                  {...(renamingKey?.label === undefined
                                    ? {}
                                    : { label: renamingKey.label })}
                                  onSaved={(saved) => applySavedName(renamingKey, saved)}
                                  onCancel={() => setRenamingKey(null)}
                                />
                              </div>
                            ) : null}

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
                                    cooldown: S.models.keyHealthCooldown,
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

                              <div className="flex items-center justify-between text-gray-500 dark:text-gray-400 text-[10px] pt-1 border-t border-gray-100 dark:border-gray-800/40">
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
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-green-500" />
                            <span className="font-semibold text-gray-900 dark:text-gray-100">
                              {row.credential?.apiKeyMasked || "••••••••"}
                            </span>
                          </div>
                          {singleName !== undefined ? (
                            <span className="font-sans text-[11px] font-medium text-gray-900 dark:text-gray-100">
                              {singleName.name}
                            </span>
                          ) : (
                            <span className="font-sans text-[11px] text-gray-500 italic dark:text-gray-400">
                              {S.models.keyUnnamed}
                            </span>
                          )}
                        </div>
                        <Badge tone="green">{S.models.keyHealthActive}</Badge>
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                        Single Key Configured
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {orphanedNames.length > 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-3 text-xs dark:border-gray-700">
          <div className="font-medium text-gray-700 dark:text-gray-300">{S.models.keyOrphaned}</div>
          <ul className="mt-1 list-inside list-disc text-gray-500 dark:text-gray-400">
            {orphanedNames.map((entry) => (
              <li key={entry.keyId}>
                <span className="font-medium text-gray-700 dark:text-gray-300">{entry.name}</span>
                {entry.label !== undefined && entry.label !== "" ? ` — ${entry.label}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
