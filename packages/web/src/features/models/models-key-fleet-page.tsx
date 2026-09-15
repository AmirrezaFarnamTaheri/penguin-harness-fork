import { useState, useMemo, useCallback, useEffect } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { KeyHealthCard } from "./key-health-card";
import { KeyProbeModal } from "./key-probe-modal";
import {
  calculateFleetHealth,
  filterKeyFleetReports,
  type KeyActionType,
  type KeyHealthItem,
  type ModelKeyFleetReport,
  type RotationStrategy,
} from "./key-fleet-types";

function KeyIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

function SearchIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ShieldCheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function RefreshIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 21h5v-5" />
    </svg>
  );
}

const INITIAL_FLEET_REPORTS: ModelKeyFleetReport[] = [
  {
    modelRef: "openai/gpt-4o",
    provider: "openai",
    modelId: "gpt-4o",
    rotationStrategy: "round-robin",
    totalKeys: 4,
    healthyCount: 3,
    cooldownCount: 1,
    evictedCount: 0,
    activeLeases: 5,
    keys: [
      {
        maskedKey: "sk-proj-...8a1c",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 230,
        failureCount: 4,
        activeLeases: 3,
        lastUsedAt: Date.now() - 15_000,
      },
      {
        maskedKey: "sk-proj-...9f2e",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 145,
        failureCount: 2,
        activeLeases: 2,
        lastUsedAt: Date.now() - 45_000,
      },
      {
        maskedKey: "sk-proj-...3b7d",
        status: "cooldown",
        isFailed: false,
        cooldownRemainingMs: 38_000,
        successCount: 80,
        failureCount: 12,
        activeLeases: 0,
        lastUsedAt: Date.now() - 5_000,
      },
      {
        maskedKey: "sk-proj-...1c4a",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 52,
        failureCount: 1,
        activeLeases: 0,
        lastUsedAt: Date.now() - 120_000,
      },
    ],
  },
  {
    modelRef: "anthropic/claude-3-5-sonnet",
    provider: "anthropic",
    modelId: "claude-3-5-sonnet",
    rotationStrategy: "least-leases",
    totalKeys: 3,
    healthyCount: 2,
    cooldownCount: 0,
    evictedCount: 1,
    activeLeases: 2,
    keys: [
      {
        maskedKey: "sk-ant-...7b1a",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 310,
        failureCount: 3,
        activeLeases: 2,
        lastUsedAt: Date.now() - 8_000,
      },
      {
        maskedKey: "sk-ant-...4c9d",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 180,
        failureCount: 0,
        activeLeases: 0,
        lastUsedAt: Date.now() - 85_000,
      },
      {
        maskedKey: "sk-ant-...0e2f",
        status: "evicted",
        isFailed: true,
        cooldownRemainingMs: 0,
        successCount: 5,
        failureCount: 15,
        activeLeases: 0,
        lastUsedAt: Date.now() - 450_000,
      },
    ],
  },
  {
    modelRef: "google/gemini-1.5-pro",
    provider: "google",
    modelId: "gemini-1.5-pro",
    rotationStrategy: "priority-weighted",
    totalKeys: 2,
    healthyCount: 2,
    cooldownCount: 0,
    evictedCount: 0,
    activeLeases: 1,
    keys: [
      {
        maskedKey: "AIza...4g9x",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 94,
        failureCount: 1,
        activeLeases: 1,
        lastUsedAt: Date.now() - 22_000,
      },
      {
        maskedKey: "AIza...8p2k",
        status: "healthy",
        isFailed: false,
        cooldownRemainingMs: 0,
        successCount: 65,
        failureCount: 0,
        activeLeases: 0,
        lastUsedAt: Date.now() - 140_000,
      },
    ],
  },
];

export function ModelsKeyFleetPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [reports, setReports] = useState<ModelKeyFleetReport[]>(INITIAL_FLEET_REPORTS);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "healthy" | "cooldown" | "evicted">("all");
  const [probingTarget, setProbingTarget] = useState<{
    keyItem: KeyHealthItem;
    provider: string;
    modelId: string;
  } | null>(null);

  const fetchLiveFleet = useCallback(async () => {
    try {
      const res = await fetch("/api/cockpit/keys");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.reports) && data.reports.length > 0) {
          setReports(data.reports);
        }
      }
    } catch {
      // offline / standalone fallback
    }
  }, []);

  useEffect(() => {
    void fetchLiveFleet();
  }, [fetchLiveFleet]);

  const stats = useMemo(() => calculateFleetHealth(reports), [reports]);

  const filteredReports = useMemo(() => {
    return filterKeyFleetReports(reports, filterMode, searchQuery);
  }, [reports, filterMode, searchQuery]);

  const handleKeyAction = (
    action: KeyActionType,
    item: KeyHealthItem,
    modelRef: string,
    provider: string,
    modelId: string,
  ) => {
    if (action === "probe") {
      setProbingTarget({ keyItem: item, provider, modelId });
      return;
    }

    void fetch("/api/cockpit/keys/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        provider,
        maskedKey: item.maskedKey,
        cooldownMs: 60_000,
      }),
    }).catch(() => {});

    setReports((prev) =>
      prev.map((rep) => {
        if (rep.modelRef !== modelRef) return rep;

        const updatedKeys = rep.keys.map((k) => {
          if (k.maskedKey !== item.maskedKey) return k;

          if (action === "revive") {
            return {
              ...k,
              status: "healthy" as const,
              isFailed: false,
              cooldownRemainingMs: 0,
            };
          }
          if (action === "cooldown") {
            return {
              ...k,
              status: "cooldown" as const,
              cooldownRemainingMs: 60_000,
            };
          }
          if (action === "evict") {
            return {
              ...k,
              status: "evicted" as const,
              isFailed: true,
              cooldownRemainingMs: 0,
              activeLeases: 0,
            };
          }
          return k;
        });

        const healthyCount = updatedKeys.filter((k) => k.status === "healthy").length;
        const cooldownCount = updatedKeys.filter((k) => k.status === "cooldown").length;
        const evictedCount = updatedKeys.filter((k) => k.status === "evicted").length;

        return {
          ...rep,
          keys: updatedKeys,
          healthyCount,
          cooldownCount,
          evictedCount,
        };
      }),
    );
  };

  const handleReviveAllCooldowns = () => {
    void fetch("/api/cockpit/keys/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revive_all" }),
    }).catch(() => {});

    setReports((prev) =>
      prev.map((rep) => {
        const updatedKeys = rep.keys.map((k) => {
          if (k.status === "cooldown") {
            return {
              ...k,
              status: "healthy" as const,
              cooldownRemainingMs: 0,
            };
          }
          return k;
        });
        const healthyCount = updatedKeys.filter((k) => k.status === "healthy").length;
        const cooldownCount = 0;
        return {
          ...rep,
          keys: updatedKeys,
          healthyCount,
          cooldownCount,
        };
      }),
    );
  };

  const handleChangeStrategy = (modelRef: string, newStrategy: RotationStrategy) => {
    setReports((prev) =>
      prev.map((rep) =>
        rep.modelRef === modelRef ? { ...rep, rotationStrategy: newStrategy } : rep,
      ),
    );
  };

  return (
    <div className={`flex flex-col gap-6 ${embedded ? "p-3" : "p-6"}`}>
      {/* Top Banner & Title */}
      {!embedded && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyIcon size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                Model Key Fleet & Resilient Failover Console
              </h1>
              <p className="text-xs text-muted-foreground">
                Real-time multi-key health telemetry, rate-limit cooldown timers, and active lease
                routing
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void fetchLiveFleet()}>
              <RefreshIcon size={13} />
              Refresh
            </Button>
            {stats.cooldownCount > 0 && (
              <Button variant="secondary" size="sm" onClick={handleReviveAllCooldowns}>
                Revive All Cooldowns ({stats.cooldownCount})
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Fleet Telemetry Metrics Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Total Fleet Keys</span>
          <span className="font-mono text-2xl font-bold text-foreground">{stats.totalKeys}</span>
          <span className="text-[11px] text-muted-foreground">
            Across {reports.length} model pools
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Fleet Health</span>
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-2xl font-bold text-emerald-500">
              {stats.healthPercentage}%
            </span>
            <span className="text-xs text-muted-foreground">available</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${stats.healthPercentage}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Active Leases</span>
          <span className="font-mono text-2xl font-bold text-primary">{stats.activeLeases}</span>
          <span className="text-[11px] text-muted-foreground">Concurrent model requests</span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">In Cooldown (429)</span>
          <span className="font-mono text-2xl font-bold text-amber-500">{stats.cooldownCount}</span>
          <span className="text-[11px] text-muted-foreground">Recovering automatically</span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Evicted (401)</span>
          <span className="font-mono text-2xl font-bold text-red-500">{stats.evictedCount}</span>
          <span className="text-[11px] text-muted-foreground">
            Requires key credential rotation
          </span>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Search */}
        <div className="relative w-full max-w-sm">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            size="sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search provider, model, or masked key..."
            className="pl-9"
          />
        </div>

        {/* Filter Mode Tabs */}
        <div className="flex items-center gap-1 rounded-lg bg-muted p-1 text-xs">
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${
              filterMode === "all"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            All Keys ({stats.totalKeys})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("healthy")}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${
              filterMode === "healthy"
                ? "bg-card text-emerald-500 shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Healthy ({stats.healthyCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("cooldown")}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${
              filterMode === "cooldown"
                ? "bg-card text-amber-500 shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Cooldown ({stats.cooldownCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("evicted")}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${
              filterMode === "evicted"
                ? "bg-card text-red-500 shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Evicted ({stats.evictedCount})
          </button>
        </div>
      </div>

      {/* Model Key Fleet Groups */}
      <div className="flex flex-col gap-6">
        {filteredReports.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
            <KeyIcon size={36} />
            <span className="mt-3 text-sm font-semibold text-foreground">
              No keys match your filter criteria
            </span>
            <span className="text-xs text-muted-foreground">
              Try adjusting your search query or status filter above
            </span>
          </div>
        ) : (
          filteredReports.map((report) => (
            <div
              key={report.modelRef}
              className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
            >
              {/* Group Header */}
              <div className="flex flex-col gap-2 border-b border-border/60 pb-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted font-mono text-xs font-bold uppercase text-foreground">
                    {report.provider.slice(0, 2)}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-bold text-foreground">{report.modelId}</h2>
                      <span className="font-mono text-xs text-muted-foreground">
                        ({report.provider})
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {report.totalKeys} keys in pool • {report.activeLeases} active requests
                    </span>
                  </div>
                </div>

                {/* Strategy Switcher & Status Badges */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Rotation:</span>
                    <select
                      value={report.rotationStrategy}
                      onChange={(e) =>
                        handleChangeStrategy(report.modelRef, e.target.value as RotationStrategy)
                      }
                      className="rounded-md border border-border bg-muted/60 px-2 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="round-robin">Round Robin</option>
                      <option value="least-leases">Least Leases</option>
                      <option value="priority-weighted">Priority Weighted</option>
                    </select>
                  </div>

                  <Badge tone={report.healthyCount === report.totalKeys ? "green" : "amber"}>
                    <ShieldCheckIcon size={12} />
                    {report.healthyCount}/{report.totalKeys} Healthy
                  </Badge>
                </div>
              </div>

              {/* Cards Grid */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {report.keys.map((keyItem) => (
                  <KeyHealthCard
                    key={keyItem.maskedKey}
                    keyItem={keyItem}
                    provider={report.provider}
                    modelId={report.modelId}
                    onAction={(action, item) =>
                      handleKeyAction(
                        action,
                        item,
                        report.modelRef,
                        report.provider,
                        report.modelId,
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Probing Modal */}
      {probingTarget && (
        <KeyProbeModal
          keyItem={probingTarget.keyItem}
          provider={probingTarget.provider}
          modelId={probingTarget.modelId}
          onClose={() => setProbingTarget(null)}
        />
      )}
    </div>
  );
}
