import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useProject } from "../../state/project";
import * as api from "../../api/endpoints";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { S } from "../../lib/strings";
import { toastError, toastSuccess } from "../../components/ui/toast";
import { KeyHealthCard } from "./key-health-card";
import { KeyNameEditor } from "./key-name-editor";
import { KeyProbeModal } from "./key-probe-modal";
import {
  calculateFleetHealth,
  filterKeyFleetReports,
  joinKeyNames,
  keyNameOf,
  type KeyActionType,
  type KeyHealthItem,
  type KeyNameEntry,
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

const DEMO_FLEET_REPORTS: ModelKeyFleetReport[] = [
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
        keyId: "openai-key-1",
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
        keyId: "openai-key-2",
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
        keyId: "openai-key-3",
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
        keyId: "openai-key-4",
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
        keyId: "anthropic-key-1",
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
        keyId: "anthropic-key-2",
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
        keyId: "anthropic-key-3",
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
        keyId: "google-key-1",
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
        keyId: "google-key-2",
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
  const { currentProject } = useProject();
  // The Project this page is scoped to, or null while the Project list is still resolving.
  //
  // This used to fall back to the literal string "default", which is not a Project id in
  // this codebase — real ones are `default_project` or `<user>-default_project`. The
  // server's `DEFAULT_PROJECT_ID` fallback cannot rescue it, because that only applies when
  // the param is ABSENT and `?project=default` is present. So the first fetch of this page
  // asked about a Project that does not exist, took a 404, and rendered the key fleet
  // empty on first paint. There is no correct value to guess: `null` until it resolves, and
  // every fetch below waits for it.
  const projectId = currentProject?.projectId ?? null;
  // Naming a key is a write, so the control only appears for someone who may write. The
  // server refuses it either way (403); this is about not offering a button that cannot work.
  const isOwner = currentProject?.role === "owner";

  const [reports, setReports] = useState<ModelKeyFleetReport[]>([]);
  const [keyNames, setKeyNames] = useState<KeyNameEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo] = useState(false);
  const [demoReports, setDemoReports] = useState(DEMO_FLEET_REPORTS);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "healthy" | "cooldown" | "evicted">("all");
  const [renamingKey, setRenamingKey] = useState<{
    maskedKey: string;
    provider: string;
    modelId: string;
    name?: string;
    label?: string;
  } | null>(null);
  const [probingTarget, setProbingTarget] = useState<{
    keyItem: KeyHealthItem;
    provider: string;
    modelId: string;
  } | null>(null);

  // The names are joined onto the health report rather than fetched inside it: the report
  // comes from the key rotator, which never sees a name, and the fleet report identifies a
  // key by the mask it prints. Demo mode has no Project to ask, so it shows no names — the
  // sample data is labelled as sample data on screen for exactly that reason.
  const liveReports = useMemo(() => joinKeyNames(reports, keyNames), [reports, keyNames]);

  const activeReports = useMemo(() => {
    return isDemo ? demoReports : liveReports;
  }, [isDemo, demoReports, liveReports]);

  const fetchAbortRef = useRef<AbortController | null>(null);

  const fetchLiveFleet = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    fetchAbortRef.current = abortCtrl;

    setLoading(true);
    setError(null);
    try {
      // No Project resolved yet: there is nothing to ask about, and a guessed id
      // is the 404 this guard replaces. Every caller waits the same way.
      if (projectId === null) return;
      const res = await fetch(`/api/cockpit/keys?project=${encodeURIComponent(projectId)}`, {
        signal: abortCtrl.signal,
      });
      if (!res.ok) throw new Error(`Could not load keys (HTTP ${res.status}).`);
      const data = await res.json();
      if (!Array.isArray(data.reports))
        throw new Error("The server returned an invalid key report.");
      if (!abortCtrl.signal.aborted) setReports(data.reports);
      // Names are a second read, and a failure of this one must not blank the fleet: the
      // keys are all still there, they are just unnamed on screen, which is what an unnamed
      // key looks like anyway. The error is therefore not surfaced as a page error.
      const names = await api.listModelKeyNames(projectId);
      if (!abortCtrl.signal.aborted && Array.isArray(names.keys)) setKeyNames(names.keys);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(
        err instanceof Error ? err.message : "Could not load keys. Check the connection and retry.",
      );
    } finally {
      if (!abortCtrl.signal.aborted) {
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setReports([]);
    setKeyNames([]);
    setProbingTarget(null);
    setRenamingKey(null);
    // No Project yet: there is nothing to ask about, and the effect re-runs the moment the
    // real id lands. Firing with a placeholder is the 404 this replaces.
    if (projectId === null) {
      setLoading(true);
      return;
    }
    void fetchLiveFleet();
    return () => {
      fetchAbortRef.current?.abort();
    };
  }, [projectId, fetchLiveFleet]);

  /**
   * A name, folded into the fleet in place so the row it belongs to is the row that changes.
   * Re-fetching the whole fleet instead would be a second round trip to learn one string, and
   * would move the cooldown timers of every other key under the person typing.
   *
   * The fleet coordinates come from the row that opened the editor, not from the previous
   * list: a key being named for the FIRST time has no entry to inherit them from, and an
   * entry built from nothing would never join onto anything.
   */
  const applySavedName = useCallback(
    (
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
    },
    [],
  );

  const stats = useMemo(() => calculateFleetHealth(activeReports), [activeReports]);

  const filteredReports = useMemo(() => {
    return filterKeyFleetReports(activeReports, filterMode, searchQuery);
  }, [activeReports, filterMode, searchQuery]);

  const handleKeyAction = async (
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

    if (isDemo) {
      setDemoReports((source) => {
        return source.map((rep) => {
          if (rep.modelRef !== modelRef) return rep;
          const updatedKeys = rep.keys.map((k) => {
            if (k.keyId !== item.keyId) return k;
            if (action === "revive") {
              return { ...k, status: "healthy" as const, isFailed: false, cooldownRemainingMs: 0 };
            }
            if (action === "cooldown") {
              return { ...k, status: "cooldown" as const, cooldownRemainingMs: 60_000 };
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
          return {
            ...rep,
            keys: updatedKeys,
            healthyCount: updatedKeys.filter((k) => k.status === "healthy").length,
            cooldownCount: updatedKeys.filter((k) => k.status === "cooldown").length,
            evictedCount: updatedKeys.filter((k) => k.status === "evicted").length,
          };
        });
      });
      return;
    }

    if (actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      // No Project resolved yet: there is nothing to ask about, and a guessed id
      // is the 404 this guard replaces. Every caller waits the same way.
      if (projectId === null) return;
      const res = await fetch(`/api/cockpit/keys/action?project=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectId ?? undefined,
          action,
          provider,
          keyId: item.keyId,
          maskedKey: item.maskedKey,
          cooldownMs: 60_000,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.reports)) {
          setReports(data.reports);
          return;
        }
      }
      // A failure has to say WHICH key, or the user gets a red banner over six rows and no
      // idea which one refused. The name is the identifier they chose, so it is the one that
      // goes in the sentence; an unnamed key falls back to its mask, which is what the row
      // they clicked already showed them.
      throw new Error(S.models.keyActionFailed(keyNameOf(item, S.models.keyUnnamed).name, action));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : S.models.keyActionFailed(keyNameOf(item, S.models.keyUnnamed).name, action),
      );
    } finally {
      setActionPending(false);
    }
  };

  const handleReviveAllCooldowns = async () => {
    if (isDemo) {
      setDemoReports((source) => {
        return source.map((rep) => {
          const updatedKeys = rep.keys.map((k) => {
            if (k.status === "cooldown") {
              return { ...k, status: "healthy" as const, cooldownRemainingMs: 0 };
            }
            return k;
          });
          return {
            ...rep,
            keys: updatedKeys,
            healthyCount: updatedKeys.filter((k) => k.status === "healthy").length,
            cooldownCount: 0,
          };
        });
      });
      return;
    }

    if (actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      // No Project resolved yet: there is nothing to ask about, and a guessed id
      // is the 404 this guard replaces. Every caller waits the same way.
      if (projectId === null) return;
      const res = await fetch(`/api/cockpit/keys/action?project=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "revive_all" }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.reports)) {
          setReports(data.reports);
          return;
        }
      }
      throw new Error(`Key action failed (HTTP ${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Key action failed. Refresh and try again.");
    } finally {
      setActionPending(false);
    }
  };

  const handleChangeStrategy = (modelRef: string, newStrategy: RotationStrategy) => {
    setDemoReports((source) => {
      return source.map((rep) =>
        rep.modelRef === modelRef ? { ...rep, rotationStrategy: newStrategy } : rep,
      );
    });
  };

  return (
    <div
      className={`min-w-0 flex flex-col gap-6 text-gray-900 dark:text-gray-100 ${embedded ? "p-3" : "p-4 sm:p-6"}`}
    >
      {/* Top Banner & Title */}
      {
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
                  Model keys
                </h1>
                {isDemo ? (
                  <Badge tone="amber">Local demo</Badge>
                ) : (
                  <Badge tone="green">Project keys</Badge>
                )}
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Inspect key health and manage cooldowns. Refresh to retrieve the latest project
                data.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (isDemo) {
                  setIsDemo(false);
                  void fetchLiveFleet();
                } else {
                  setIsDemo(true);
                }
              }}
            >
              {isDemo ? "Exit Demo Mode" : "Demo Mode"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void fetchLiveFleet()}
              disabled={loading || actionPending || isDemo}
            >
              <RefreshIcon size={13} />
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
            {stats.cooldownCount > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleReviveAllCooldowns()}
                disabled={actionPending || (!isDemo && (loading || !!error))}
              >
                Revive All Cooldowns ({stats.cooldownCount})
              </Button>
            )}
          </div>
        </div>
      }

      {isDemo && (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
          Sample keys only. Actions and probes in this mode do not contact a provider.
        </p>
      )}
      {error && !isDemo && (
        <div role="alert" className="text-sm text-red-700 dark:text-red-400">
          <p>{error} Previously loaded data may be out of date.</p>
          <Button variant="secondary" onClick={() => void fetchLiveFleet()}>
            Retry loading keys
          </Button>
        </div>
      )}
      <dl className="flex flex-wrap gap-x-8 gap-y-3 border-b border-gray-200 pb-4 text-sm dark:border-gray-800">
        {[
          ["Keys", stats.totalKeys],
          ["Available", stats.healthPercentage === null ? "—" : `${stats.healthPercentage}%`],
          ["Active requests", stats.activeLeases],
          ["In cooldown", stats.cooldownCount],
          ["Evicted", stats.evictedCount],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 border-b border-gray-200 dark:border-gray-800 py-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Search */}
        <div className="relative w-full max-w-sm">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 dark:text-gray-400"
          />
          <Input
            aria-label="Filter model keys"
            size="sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by model, provider, or key suffix..."
            className="pl-9"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "healthy", "cooldown", "evicted"] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={filterMode === mode}
              onClick={() => setFilterMode(mode)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                filterMode === mode
                  ? "bg-blue-700 text-white"
                  : "bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-muted/80 hover:text-foreground"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex flex-col gap-6">
        {loading && !isDemo && reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-12 text-center">
            <RefreshIcon size={24} />
            <span className="mt-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
              Loading key fleet telemetry...
            </span>
          </div>
        ) : !isDemo && error && reports.length === 0 ? null : !isDemo && reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-12 text-center">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              No API key pools configured
            </h3>
            <p className="mt-1 max-w-md text-sm text-gray-600 dark:text-gray-400">
              No key reports were returned for this project. Configure a model key in Project
              Settings, then refresh.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setIsDemo(true)}>
                Try sample keys
              </Button>
            </div>
          </div>
        ) : filteredReports.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-12 text-center">
            <KeyIcon size={36} />
            <span className="mt-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
              No keys match your filter criteria
            </span>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Try adjusting your search query or status filter above
            </span>
          </div>
        ) : (
          filteredReports.map((report) => (
            <div
              key={report.modelRef}
              className="flex flex-col gap-4 border-b border-gray-200 dark:border-gray-800 py-4 "
            >
              {/* Group Header */}
              <div className="flex flex-col gap-2 border-b border-gray-200 dark:border-gray-800 pb-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-900 text-sm font-semibold  text-gray-900 dark:text-gray-100">
                    {report.provider.slice(0, 2)}
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {report.modelId}
                      </h2>
                      <span className=" text-sm text-gray-600 dark:text-gray-400">
                        ({report.provider})
                      </span>
                    </div>
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {report.totalKeys} keys in pool • {report.activeLeases} active requests
                    </span>
                  </div>
                </div>

                {/* Strategy Switcher & Status Badges */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
                    <span>Rotation:</span>
                    {isDemo ? (
                      <select
                        aria-label={`Demo rotation for ${report.modelId}`}
                        value={report.rotationStrategy}
                        onChange={(e) =>
                          handleChangeStrategy(report.modelRef, e.target.value as RotationStrategy)
                        }
                        className="rounded-md border border-gray-200 dark:border-gray-800 bg-gray-100 dark:bg-gray-900 px-2 py-1 text-sm font-medium text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-600"
                      >
                        <option value="round-robin">Round Robin</option>
                        <option value="least-leases">Least Leases</option>
                        <option value="priority-weighted">Priority Weighted</option>
                      </select>
                    ) : (
                      <Badge tone="gray">
                        {report.rotationStrategy === "priority-weighted"
                          ? "Priority Weighted"
                          : report.rotationStrategy === "least-leases"
                            ? "Least Leases"
                            : "Round Robin"}
                      </Badge>
                    )}
                  </div>

                  <Badge tone={report.healthyCount === report.totalKeys ? "green" : "amber"}>
                    <ShieldCheckIcon size={12} />
                    {report.healthyCount}/{report.totalKeys} Healthy
                  </Badge>
                </div>
              </div>

              {/* Cards Grid */}
              <div className="flex flex-col divide-y divide-gray-200 dark:divide-gray-800">
                {report.keys.map((keyItem) => {
                  const isRenaming =
                    renamingKey !== null && renamingKey.maskedKey === keyItem.maskedKey;
                  return (
                    <KeyHealthCard
                      key={keyItem.keyId}
                      keyItem={keyItem}
                      disabled={actionPending || (!isDemo && (loading || !!error))}
                      provider={report.provider}
                      modelId={report.modelId}
                      canRename={!isDemo && isOwner && projectId !== null}
                      renaming={isRenaming}
                      onRename={(item) =>
                        setRenamingKey({
                          maskedKey: item.maskedKey,
                          provider: report.provider,
                          modelId: report.modelId,
                          ...(item.name === undefined ? {} : { name: item.name }),
                          ...(item.label === undefined ? {} : { label: item.label }),
                        })
                      }
                      onAction={(action, item) =>
                        void handleKeyAction(
                          action,
                          item,
                          report.modelRef,
                          report.provider,
                          report.modelId,
                        )
                      }
                    >
                      {isRenaming && projectId !== null ? (
                        <KeyNameEditor
                          projectId={projectId}
                          provider={report.provider}
                          modelId={report.modelId}
                          maskedKey={keyItem.maskedKey}
                          {...(renamingKey?.name === undefined ? {} : { name: renamingKey.name })}
                          {...(renamingKey?.label === undefined
                            ? {}
                            : { label: renamingKey.label })}
                          onSaved={(saved) => applySavedName(renamingKey, saved)}
                          onCancel={() => setRenamingKey(null)}
                        />
                      ) : null}
                    </KeyHealthCard>
                  );
                })}
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
          isDemo={isDemo}
          projectId={projectId ?? undefined}
          onClose={() => {
            setProbingTarget(null);
            if (!isDemo) void fetchLiveFleet();
          }}
        />
      )}
    </div>
  );
}
