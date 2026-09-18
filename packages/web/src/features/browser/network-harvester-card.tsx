/**
 * NetworkHarvesterCard — the cockpit's list of what a session actually fetched.
 *
 * Renders as a grid rather than a <table> because a harvester row is read as a strip of facts
 * (method, host, type, status, size) whose widths the cockpit fixes once and never re-flows;
 * a table would recompute column widths as entries arrive and make the whole list twitch while
 * a capture is running. Everything that can throw is quarantined per row: a malformed URL, a
 * clipboard the page context refuses, and a missing byte count each degrade to a placeholder
 * rather than taking the list down, because the harvester's whole job is to keep showing
 * traffic from a page that may be misbehaving.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NetworkHarvestEntry, NetworkResourceType } from "@prismshadow/penguin-core/browser";

export interface NetworkHarvesterCardProps {
  /** Harvested entries, oldest first; the newest are shown first. */
  entries: NetworkHarvestEntry[];
  maxRows?: number;
  className?: string;
}

const GRID_COLS = "grid-cols-[3.5rem_3.5rem_minmax(0,1fr)_5rem_4.5rem_4.5rem]";

/** Short label per resource type, for the grouped header counts. */
const TYPE_LABEL: Record<NetworkResourceType, string> = {
  document: "doc",
  stylesheet: "css",
  image: "img",
  media: "media",
  font: "font",
  script: "js",
  xhr: "xhr",
  fetch: "fetch",
  websocket: "ws",
  other: "other",
};

/** Host of an entry's URL, never throwing on one the page handed the harvester malformed. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Encoded length in bytes → the shortest readable form; absent while the exchange is open. */
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusOf(entry: NetworkHarvestEntry): { label: string; class: string } {
  if (entry.failed || (entry.status !== undefined && entry.status >= 500)) {
    return {
      label: entry.status === undefined ? "failed" : String(entry.status),
      class: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border-rose-300",
    };
  }
  if (entry.status !== undefined && entry.status >= 400) {
    return {
      label: String(entry.status),
      class:
        "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-300",
    };
  }
  if (entry.status !== undefined) {
    return {
      label: String(entry.status),
      class:
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-300",
    };
  }
  return {
    label: "in flight",
    class: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border-gray-200",
  };
}

export function NetworkHarvesterCard({ entries, maxRows, className }: NetworkHarvesterCardProps) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  const rows = useMemo(() => [...entries].reverse().slice(0, maxRows ?? 40), [entries, maxRows]);

  const typeCounts = useMemo(() => {
    const counts = new Map<NetworkResourceType, number>();
    for (const entry of rows)
      counts.set(entry.resourceType, (counts.get(entry.resourceType) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const copyUrl = useCallback(async (entry: NetworkHarvestEntry) => {
    // The whole URL is the only thing worth copying, and the only thing this row does not have
    // room to show; a clipboard the context refuses (insecure origin, no permission) degrades
    // silently rather than surfacing a modal for a convenience action.
    if (!entry.url) return;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(entry.url);
      setCopiedUrl(entry.url);
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setCopiedUrl(null);
      }, 1200);
    } catch {
      setCopiedUrl(null);
    }
  }, []);

  return (
    <div
      className={`rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 text-xs shadow-xs space-y-3 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Network</h3>
        <span className="text-gray-400 font-mono text-[10px]">
          {rows.length} of {entries.length}
        </span>
        {typeCounts.map(([type, count]) => (
          <span
            key={type}
            className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            {TYPE_LABEL[type]} {count}
          </span>
        ))}
        {copiedUrl && (
          <span className="ml-auto text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
            copied
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-gray-300 px-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
          No harvested requests yet — the session has not exchanged traffic.
        </div>
      ) : (
        <div className="space-y-0.5">
          <div
            className={`grid ${GRID_COLS} gap-x-2 items-center px-1 py-1 text-[10px] font-mono uppercase tracking-wide text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-800`}
          >
            <span>Method</span>
            <span>Status</span>
            <span>Host</span>
            <span>Type</span>
            <span className="text-right">Size</span>
            <span className="text-right">Time</span>
          </div>
          {rows.map((entry) => {
            const status = statusOf(entry);
            return (
              <button
                key={entry.requestId}
                type="button"
                onClick={() => copyUrl(entry)}
                title={`${entry.method} ${entry.url}${entry.failureText ? ` — ${entry.failureText}` : ""}`}
                className={`grid ${GRID_COLS} gap-x-2 items-center w-full px-1 py-1 rounded-md text-left cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50`}
              >
                <span className="font-mono text-[10px] font-semibold text-gray-700 dark:text-gray-300">
                  {entry.method}
                </span>
                <span
                  className={`inline-flex justify-center px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold border ${status.class}`}
                >
                  {status.label}
                </span>
                <span className="truncate font-mono text-[11px] text-gray-600 dark:text-gray-300">
                  {hostOf(entry.url)}
                </span>
                <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">
                  {TYPE_LABEL[entry.resourceType]}
                </span>
                <span className="text-right font-mono text-[10px] text-gray-500 dark:text-gray-400">
                  {formatBytes(entry.encodedDataLength)}
                </span>
                <span className="text-right font-mono text-[10px] text-gray-500 dark:text-gray-400">
                  {entry.durationMs !== undefined ? `${Math.round(entry.durationMs)} ms` : "—"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
