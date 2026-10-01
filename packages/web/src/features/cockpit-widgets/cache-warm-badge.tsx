import { cacheHitRate } from "../../lib/format";
import type { TokenBucketCounts } from "../../lib/omni/task-stats";

export type CacheUsage = Pick<TokenBucketCounts, "cacheRead" | "cacheWrite">;

/** Measured task input reuse, not a prediction of provider cache residency or TTL. */
export function CacheWarmBadge({ usage }: { usage?: CacheUsage }) {
  const valid =
    usage !== undefined &&
    Number.isFinite(usage.cacheRead) &&
    usage.cacheRead >= 0 &&
    Number.isFinite(usage.cacheWrite) &&
    usage.cacheWrite >= 0 &&
    Number.isFinite(usage.cacheRead + usage.cacheWrite);
  const rate = valid ? cacheHitRate(usage.cacheRead, usage.cacheWrite) : null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title="Current task: cached input / all reported input, including subagents. Cache lifetime is not reported."
      className={`inline-flex rounded-md border px-2 py-1 text-xs tabular-nums ${
        rate !== null && rate > 0
          ? "border-emerald-200 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300"
          : "border-gray-200 text-gray-600 dark:border-gray-800 dark:text-gray-400"
      }`}
    >
      {rate === null ? "Cache not reported" : `Cache hit: ${Math.round(rate * 100)}%`}
    </span>
  );
}
