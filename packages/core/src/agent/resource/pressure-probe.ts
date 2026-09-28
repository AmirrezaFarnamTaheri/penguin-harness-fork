/**
 * ResourcePressureProbe — free memory and free disk, as information the agent can ask for.
 *
 * ## This observes. It never gates.
 *
 * There is deliberately no `allowed`, `blocked`, `throttled` or threshold field anywhere in
 * this module, and nothing here is wired into tool admission. A resource-pressure check that
 * denies a call is a gate, and a gate is a decision made *for* the agent about work the agent
 * was about to do. An agent that sees "1.2 GB free on the data root" and runs a build anyway
 * is making a decision with full information; an agent that is not permitted to run the build
 * is being overruled by a number nobody asked to be weighed. The first is the product this
 * module exists to enable. The second is the failure mode it exists to avoid.
 *
 * Consequently the pressure is exposed two ways and never a third: as this probe's report
 * (programmatic) and as the `resource_pressure` tool (the agent asks). There is no code path
 * from a pressure reading to a refusal.
 *
 * ## Memory and disk are not the same kind of number, and are not reported as if they were
 *
 * Measured on this repository (node v26.1.0, win32/x64, 2000 iterations each):
 *
 * | read                       | cost    | kind of number                          |
 * |----------------------------|---------|-----------------------------------------|
 * | `os.freemem()`             | 0.48 µs | instantaneous OS counter                 |
 * | `fs.statfsSync()`          | 8–14 µs | real capacity, syscall                   |
 * | `fs.promises.statfs()`     | 32–40 µs| real capacity, async                     |
 *
 * `os.freemem()` is a counter the OS maintains as it faults and reclaims pages. It is
 * cheap enough to read on every call, and it is also close to meaningless as a capacity
 * signal on a machine with a large page cache: it moves for reasons that have nothing to do
 * with how much more can be allocated. It is reported with `kind: "os-counter"`, sampled
 * fresh on every probe, and never cached — caching a number that costs half a microsecond
 * would add staleness for no saved work.
 *
 * `fs.statfs()` is a real answer to "how much room is left on this filesystem", it moves on
 * the scale of a build writing gigabytes over seconds, and it costs a syscall. It is
 * therefore TTL-cached and reported with `kind: "statfs-cache"`, and **every sample carries
 * its own `ageMs` and `servedFromCache`**, so a caller — the tool in particular — can tell
 * the agent how old the disk number is. A reading that is up to `diskTtlMs` stale can
 * overstate free space by whatever was written during that window; that cost is stated
 * rather than hidden, and `refresh: true` on the tool forces a re-read.
 *
 * The async API is not decoration: `statfsSync` is a blocking syscall, and a blocking
 * syscall on the tool-dispatch path is exactly what this module must not be.
 *
 * ## Bounded by construction
 *
 * - `maxPaths` caps how many paths are ever statfs'd (default 16). Excess paths are dropped
 *   and *counted* in `droppedPathCount` — never silently.
 * - `diskTtlMs` is clamped to [250 ms, 300 000 ms], so neither a 0 (a syscall per call) nor
 *   Infinity (a number that never refreshes) is expressible.
 * - Probes are single-flight: N concurrent callers share one `statfs` pass and every one of
 *   them gets the same snapshot, so concurrency cannot multiply syscalls.
 * - The cache holds exactly one snapshot, bounded by `maxPaths`. Nothing accumulates.
 */
import { statfs } from "node:fs/promises";
import os from "node:os";

/** Where a reading came from, and therefore what it means. Carried in the data, not in prose. */
export type PressureSampleKind = "os-counter" | "statfs-cache";

/** Injectable clock (ms). */
export type PressureClock = () => number;

/** The filesystem-stat call, injectable so tests never touch a real disk. */
export type StatfsLike = (path: string) => Promise<{
  bsize: number;
  blocks: number;
  bavail: number;
  bfree: number;
}>;

/** The memory counters, injectable so tests never depend on the host's real memory. */
export interface MemoryCounters {
  free: () => number;
  total: () => number;
}

/** One free-memory reading. Cheap, fresh every probe, and not a capacity guarantee. */
export interface MemoryPressureSample {
  readonly kind: "os-counter";
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly usedBytes: number;
  /** Fraction of total in use, 0–1. */
  readonly usedRatio: number;
  readonly sampledAt: number;
  /** Age at the moment the report was built. ~0 — memory is not cached. */
  readonly ageMs: number;
  /** What this number is not, stated in the data so a formatter cannot drop it. */
  readonly caveat: string;
}

/** One free-disk reading for one path. Real capacity, TTL-cached, carries its own age. */
export interface DiskPressureSample {
  readonly path: string;
  readonly kind: "statfs-cache";
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly usedBytes: number;
  /** Fraction of total in use, 0–1. */
  readonly usedRatio: number;
  readonly sampledAt: number;
  /** How stale this reading is now. The cost of the cache, made visible. */
  readonly ageMs: number;
  /** True when this reading was reused rather than re-statfs'd for this call. */
  readonly servedFromCache: boolean;
  /** Set when this one path failed. The probe degrades; it does not throw. */
  readonly error?: string;
}

/** A full probe result. Pure data — there is no verdict field, by design. */
export interface ResourcePressureReport {
  readonly memory: MemoryPressureSample;
  readonly disks: readonly DiskPressureSample[];
  /** How many configured paths were dropped by `maxPaths`. */
  readonly droppedPathCount: number;
  /** The configured TTL, reported so the agent can reason about the staleness it is shown. */
  readonly diskTtlMs: number;
  /**
   * How long the underlying statfs pass took, when this call performed one. Undefined when
   * served from cache — a cached call did no I/O and claiming otherwise would be a lie.
   */
  readonly sweepDurationMs?: number;
}

/** Lower clamp on the disk TTL: below this a "cache" is a syscall per call. */
const MIN_DISK_TTL_MS = 250;
/** Upper clamp on the disk TTL: past this the reading describes a machine that no longer exists. */
const MAX_DISK_TTL_MS = 300_000;
/** Default path cap. Bounds the one syscall pass regardless of how many paths are configured. */
const DEFAULT_MAX_PATHS = 16;

export interface ResourcePressureProbeOptions {
  /** Paths whose filesystem free space matters — the data root and the workspace, typically. */
  paths: readonly string[];
  /**
   * How long a disk reading is reused, in ms. Clamped to [250, 300000]. Default 5000: long
   * enough to collapse a burst of calls into one syscall sweep, short enough that a build
   * filling the disk shows up within a few seconds.
   */
  diskTtlMs?: number;
  /** Hard cap on paths statfs'd per sweep. Default 16. */
  maxPaths?: number;
  now?: PressureClock;
  statfs?: StatfsLike;
  memory?: MemoryCounters;
}

const MEMORY_CAVEAT =
  "free memory is an OS page-cache counter, not an allocation budget; it moves for reasons unrelated to capacity.";

/**
 * The paths worth watching, for a caller that has not thought about it.
 *
 * Two, because they are the two that actually fill: the harness's own data root, which
 * accumulates agent state, sessions and tool-result archives, and the workspace, which is
 * where builds write their output. De-duplicated (a workspace inside the data root would
 * otherwise be statfs'd twice) and returned in that order so the report leads with the
 * root. A caller with a third path worth watching — a model cache, a build output
 * directory — passes it in; nothing here assumes it is the only thing that fills.
 */
export function defaultPressurePaths(options: {
  dataRoot?: string;
  workspaceDir?: string;
}): string[] {
  const paths: string[] = [];
  for (const p of [options.dataRoot, options.workspaceDir]) {
    if (p !== undefined && p !== "" && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

export class ResourcePressureProbe {
  private readonly paths: readonly string[];
  private readonly droppedPathCount: number;
  private readonly diskTtlMs: number;
  private readonly now: PressureClock;
  private readonly statfsFn: StatfsLike;
  private readonly memory: MemoryCounters;

  /** The one retained snapshot. Bounded by `paths.length <= maxPaths`; replaced, never grown. */
  private snapshot: { sampledAt: number; disks: DiskPressureSample[] } | null = null;
  /** The single in-flight sweep. Concurrent callers await this rather than starting their own. */
  private inflight: Promise<{ sampledAt: number; disks: DiskPressureSample[] }> | null = null;

  constructor(options: ResourcePressureProbeOptions) {
    const maxPaths = Math.max(1, Math.floor(options.maxPaths ?? DEFAULT_MAX_PATHS));
    this.paths = options.paths.slice(0, maxPaths);
    this.droppedPathCount = Math.max(0, options.paths.length - this.paths.length);
    const ttl = options.diskTtlMs ?? 5000;
    this.diskTtlMs = Math.min(MAX_DISK_TTL_MS, Math.max(MIN_DISK_TTL_MS, Math.floor(ttl)));
    this.now = options.now ?? Date.now;
    this.statfsFn = options.statfs ?? (statfs as unknown as StatfsLike);
    this.memory = options.memory ?? { free: os.freemem, total: os.totalmem };
  }

  /**
   * Free memory and free disk, as fresh as the cache allows.
   *
   * `force` re-runs the statfs sweep even when a fresh-enough snapshot exists. It is still
   * single-flight: twenty concurrent forced calls produce one sweep, not twenty.
   */
  async probe(force = false): Promise<ResourcePressureReport> {
    const now = this.now();
    const memory = this.sampleMemory(now);

    // Read into a local: `this.snapshot` is not narrowed across the `await` below, and a
    // property read that re-checks a mutable field after a suspension is exactly the shape
    // that turns into a null deref under load.
    const cached = this.snapshot;
    const fresh = cached !== null && now - cached.sampledAt < this.diskTtlMs;
    if (fresh && !force) {
      // These disks were reused, not re-read: that is the whole point of the TTL and the
      // caller has to be able to see it.
      return this.buildReport(memory, cached, true, undefined, now);
    }

    // Single-flight: the first caller starts the sweep, the rest await the same one. The
    // clear happens in `finally`, after which the next caller starts a new sweep — so a
    // caller that arrives during the sweep joins it rather than doubling the syscalls.
    this.inflight ??= this.sweep().finally(() => {
      this.inflight = null;
    });
    const startedAt = now;
    const snapshot = await this.inflight;
    // A sweep just ran, so these disks were re-read rather than reused — including when the
    // caller passed `force`, which requested a re-read precisely because it did not want the
    // cached copy.
    return this.buildReport(memory, snapshot, false, this.now() - startedAt, this.now());
  }

  /** Drops the cached disk snapshot; the next probe re-stats. Memory is never cached. */
  invalidate(): void {
    this.snapshot = null;
  }

  /** The effective disk TTL, for callers that want to reason about staleness. */
  get ttlMs(): number {
    return this.diskTtlMs;
  }

  private sampleMemory(now: number): MemoryPressureSample {
    const totalBytes = this.memory.total();
    const freeBytes = this.memory.free();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      kind: "os-counter",
      freeBytes,
      totalBytes,
      usedBytes,
      // totalBytes is 0 only on a host that reports nothing; report 0 rather than NaN.
      usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0,
      sampledAt: now,
      ageMs: 0,
      caveat: MEMORY_CAVEAT,
    };
  }

  private async sweep(): Promise<{ sampledAt: number; disks: DiskPressureSample[] }> {
    const sampledAt = this.now();
    const disks = await Promise.all(this.paths.map((path) => this.sampleDisk(path, sampledAt)));
    const snapshot = { sampledAt, disks };
    // Replace, never append: exactly one snapshot is retained whatever the call rate.
    this.snapshot = snapshot;
    return snapshot;
  }

  private async sampleDisk(path: string, sampledAt: number): Promise<DiskPressureSample> {
    try {
      const s = await this.statfsFn(path);
      // `bavail` is blocks available to an unprivileged process; on some platforms (Windows
      // among them) Node reports 0 for it while `bfree` is populated. Falling back keeps a
      // working filesystem from reading as 100% full.
      const freeBlocks = s.bavail > 0 ? s.bavail : s.bfree;
      const totalBytes = s.bsize * s.blocks;
      const freeBytes = s.bsize * freeBlocks;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      return {
        path,
        kind: "statfs-cache",
        freeBytes,
        totalBytes,
        usedBytes,
        usedRatio: totalBytes > 0 ? usedBytes / totalBytes : 0,
        sampledAt,
        ageMs: 0,
        servedFromCache: false,
      };
    } catch (err) {
      // One unreadable path must not fail the probe: the other paths and the memory reading
      // are still true and still useful.
      return {
        path,
        kind: "statfs-cache",
        freeBytes: 0,
        totalBytes: 0,
        usedBytes: 0,
        usedRatio: 0,
        sampledAt,
        ageMs: 0,
        servedFromCache: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildReport(
    memory: MemoryPressureSample,
    snapshot: { sampledAt: number; disks: DiskPressureSample[] },
    servedFromCache: boolean,
    sweepDurationMs: number | undefined,
    now: number,
  ): ResourcePressureReport {
    return {
      memory,
      // Re-stamp age against the caller's clock. The snapshot's own `ageMs: 0` is only true
      // at sweep time; every caller must see the reading's age as of *its* call.
      disks: snapshot.disks.map((d) => ({
        ...d,
        ageMs: Math.max(0, now - d.sampledAt),
        servedFromCache: d.servedFromCache || servedFromCache,
      })),
      droppedPathCount: this.droppedPathCount,
      diskTtlMs: this.diskTtlMs,
      ...(sweepDurationMs === undefined ? {} : { sweepDurationMs }),
    };
  }
}
