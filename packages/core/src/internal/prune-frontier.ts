/**
 * B4 — prune frontier: what was already decided, so a repeated prune does not re-read it.
 *
 * The problem this solves. A prune pass walks a bounded store oldest-first, dropping entries until
 * a pending write fits. Two things go wrong without memory:
 *
 * 1. **A blocked requirement is re-scanned forever.** A write larger than the store's whole byte
 *    budget can never fit, no matter how much is pruned; today every attempt re-lists the directory
 *    and re-stats every file to reach the same answer. A recorded frontier answers the repeat from
 *    the decision instead.
 * 2. **A kept block is re-examined on every pass.** Some entries must not be dropped — the store
 *    promises they remain readable (that is what "retained context" means). A pruner that re-reads
 *    them each pass pays for them on every prune and, worse, risks dropping one when the loop's
 *    bookkeeping drifts. The frontier records them as kept, and they are never drop candidates.
 *
 * The decision cache is keyed on the **directory's own mtime**: any add, remove or rename changes
 * it, so a cached decision is only reused while the set of files is provably the same. Requirements
 * are monotone — if a write of N bytes could not fit, a larger write cannot either — so a cached
 * block answers any requirement `>=` the one it was proved for, and anything smaller forces a real
 * scan.
 *
 * Persistence is optional and explicit (`serializePruneFrontier` / `parsePruneFrontier`): a caller
 * that has a private file to keep it in gets the across-process behaviour, and a caller that does
 * not still gets the within-process one. A malformed or unknown-version frontier is discarded, never
 * trusted: a corrupt cache must not be able to keep a store from pruning.
 */

export interface PruneEntryFingerprint {
  /** Size at the time it was examined. */
  bytes: number;
  /** Modification time at the time it was examined. */
  mtimeMs: number;
}

export interface PruneFrontier {
  version: 1;
  /** Directory mtime the cached decision was made at; null when nothing is cached. */
  directoryMtimeMs: number | null;
  /** Largest requirement proven impossible at that directory state; null when not blocked. */
  blockedAtRequiredBytes: number | null;
  /** Entries that must never be dropped (retained context), with the fingerprint they had. */
  kept: Record<string, PruneEntryFingerprint>;
  /** Entries examined in the last pass and left in place. */
  examined: Record<string, PruneEntryFingerprint>;
  /** Completed passes, for observability. */
  passes: number;
}

export function createPruneFrontier(init: Partial<PruneFrontier> = {}): PruneFrontier {
  return {
    version: 1,
    directoryMtimeMs: init.directoryMtimeMs ?? null,
    blockedAtRequiredBytes: init.blockedAtRequiredBytes ?? null,
    kept: { ...(init.kept ?? {}) },
    examined: { ...(init.examined ?? {}) },
    passes: init.passes ?? 0,
  };
}

/** Parses a persisted frontier; anything unrecognized yields a fresh one rather than a failure. */
export function parsePruneFrontier(text: string | null | undefined): PruneFrontier {
  if (text === null || text === undefined || text.trim() === "") return createPruneFrontier();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return createPruneFrontier();
  }
  if (parsed === null || typeof parsed !== "object") return createPruneFrontier();
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return createPruneFrontier();
  const fingerprints = (value: unknown): Record<string, PruneEntryFingerprint> => {
    if (value === null || typeof value !== "object") return {};
    const result: Record<string, PruneEntryFingerprint> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object") continue;
      const { bytes, mtimeMs } = entry as Record<string, unknown>;
      if (
        typeof bytes === "number" &&
        Number.isFinite(bytes) &&
        typeof mtimeMs === "number" &&
        Number.isFinite(mtimeMs)
      ) {
        result[name] = { bytes, mtimeMs };
      }
    }
    return result;
  };
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return createPruneFrontier({
    directoryMtimeMs: number(record.directoryMtimeMs),
    blockedAtRequiredBytes: number(record.blockedAtRequiredBytes),
    kept: fingerprints(record.kept),
    examined: fingerprints(record.examined),
    passes: number(record.passes) ?? 0,
  });
}

export function serializePruneFrontier(frontier: PruneFrontier): string {
  return JSON.stringify(frontier);
}

export interface PrunePlanInput {
  /** Directory mtime now; null only when the caller cannot observe it (then no cache is used). */
  directoryMtimeMs: number | null;
  /** The pending write's size. */
  requiredBytes: number;
  /** Byte and entry bounds of the store. */
  limits: { maxEntries: number; maxTotalBytes: number };
  /** The listing, or undefined when the caller wants a cached answer before listing. */
  entries?: readonly (PruneEntryFingerprint & { name: string })[];
  /** Names that must never be dropped, whatever the budget pressure. */
  keepNames?: readonly string[];
  frontier?: PruneFrontier;
}

export interface PrunePlan {
  /**
   * `fits` — nothing needs dropping; `drop` — drop `drops` (oldest first) and the write fits;
   * `blocked` — even after dropping everything droppable it cannot fit; `cached-blocked` — the same
   * answer, returned without listing the directory at all.
   */
  decision: "fits" | "drop" | "blocked" | "cached-blocked";
  drops: readonly string[];
  /** Entries whose droppability was actually considered this pass. */
  examined: number;
  /** Kept entries that were not reconsidered (the no-re-read guarantee). */
  skippedKept: number;
  /** Names that must survive: newly requested keepers plus everything already in the frontier. */
  keptNames: readonly string[];
  frontier: PruneFrontier;
}

/**
 * Plans one prune pass. Pure: the caller lists, unlinks and persists; this decides.
 *
 * A blocked answer is recorded together with the directory mtime, so the next call with the same
 * directory state and a requirement that is not smaller returns `cached-blocked` with `examined: 0`
 * and without needing `entries` at all.
 */
export function planPrune(input: PrunePlanInput): PrunePlan {
  const frontier = input.frontier ?? createPruneFrontier();
  const kept: Record<string, PruneEntryFingerprint> = { ...frontier.kept };
  const keepNames = new Set([...Object.keys(kept), ...(input.keepNames ?? [])]);
  for (const name of input.keepNames ?? []) {
    const entry = input.entries?.find((candidate) => candidate.name === name);
    if (entry !== undefined) kept[name] = { bytes: entry.bytes, mtimeMs: entry.mtimeMs };
  }
  const keptNames = [...keepNames].sort();

  const cacheValid =
    input.directoryMtimeMs !== null &&
    frontier.directoryMtimeMs !== null &&
    frontier.directoryMtimeMs === input.directoryMtimeMs;
  if (
    cacheValid &&
    frontier.blockedAtRequiredBytes !== null &&
    input.requiredBytes >= frontier.blockedAtRequiredBytes
  ) {
    return {
      decision: "cached-blocked",
      drops: [],
      examined: 0,
      skippedKept: keptNames.length,
      keptNames,
      frontier: { ...frontier, kept, passes: frontier.passes + 1 },
    };
  }

  // A requirement larger than the store itself cannot fit at any level of pruning.
  if (input.requiredBytes > input.limits.maxTotalBytes) {
    return {
      decision: "blocked",
      drops: [],
      examined: 0,
      skippedKept: keptNames.length,
      keptNames,
      frontier: {
        ...frontier,
        kept,
        directoryMtimeMs: input.directoryMtimeMs,
        blockedAtRequiredBytes: input.requiredBytes,
        passes: frontier.passes + 1,
      },
    };
  }

  const entries = [...(input.entries ?? [])].sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
  );
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let count = entries.length;
  const fits = (): boolean =>
    count + 1 <= input.limits.maxEntries &&
    totalBytes + input.requiredBytes <= input.limits.maxTotalBytes;
  if (fits()) {
    return {
      decision: "fits",
      drops: [],
      examined: 0,
      skippedKept: keptNames.length,
      keptNames,
      frontier: {
        ...frontier,
        kept,
        directoryMtimeMs: input.directoryMtimeMs,
        blockedAtRequiredBytes: null,
        examined: Object.fromEntries(
          entries.map((entry) => [entry.name, { bytes: entry.bytes, mtimeMs: entry.mtimeMs }]),
        ),
        passes: frontier.passes + 1,
      },
    };
  }

  const drops: string[] = [];
  const examined: Record<string, PruneEntryFingerprint> = {};
  let examinedCount = 0;
  for (const entry of entries) {
    if (fits()) break;
    examined[entry.name] = { bytes: entry.bytes, mtimeMs: entry.mtimeMs };
    examinedCount += 1;
    if (keepNames.has(entry.name)) continue; // retained context: skip it and keep making progress
    drops.push(entry.name);
    totalBytes -= entry.bytes;
    count -= 1;
  }
  if (!fits()) {
    return {
      decision: "blocked",
      drops: [],
      examined: examinedCount,
      skippedKept: keptNames.length,
      keptNames,
      frontier: {
        ...frontier,
        kept,
        directoryMtimeMs: input.directoryMtimeMs,
        // Even the fully-pruned store cannot hold this write: record it so the next attempt with a
        // requirement this large or larger is answered without touching the directory.
        blockedAtRequiredBytes: input.requiredBytes,
        examined,
        passes: frontier.passes + 1,
      },
    };
  }
  return {
    decision: "drop",
    drops,
    examined: examinedCount,
    skippedKept: keptNames.length,
    keptNames,
    frontier: {
      ...frontier,
      kept,
      directoryMtimeMs: input.directoryMtimeMs,
      blockedAtRequiredBytes: null,
      examined,
      passes: frontier.passes + 1,
    },
  };
}
