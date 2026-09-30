export interface ScannableWorkspaceGraph {
  scanWorkspace(): Promise<void>;
  close(): void;
}

export interface WorkspaceGraphCacheResult<TWatcher> {
  watcher: TWatcher;
  cached: boolean;
}

interface CacheEntry<TWatcher> {
  watcher: TWatcher;
  scannedAt: number;
}

export interface WorkspaceGraphCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Single-flight workspace scans with a bounded, least-recently-used watcher cache. */
export class WorkspaceGraphCache<TWatcher extends ScannableWorkspaceGraph> {
  private readonly entries = new Map<string, CacheEntry<TWatcher>>();
  private readonly inFlight = new Map<string, Promise<TWatcher>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private evictions = 0;

  public constructor(
    private readonly createWatcher: (workspaceDir: string) => TWatcher,
    options: WorkspaceGraphCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 8;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) {
      throw new RangeError("ttlMs must be a non-negative finite number");
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  public async get(
    workspaceDir: string,
    force = false,
  ): Promise<WorkspaceGraphCacheResult<TWatcher>> {
    const activeScan = this.inFlight.get(workspaceDir);
    if (activeScan) return { watcher: await activeScan, cached: false };

    const existing = this.entries.get(workspaceDir);
    if (existing && !force && this.now() - existing.scannedAt < this.ttlMs) {
      // Map insertion order is the LRU order; a cache hit becomes the newest entry.
      this.entries.delete(workspaceDir);
      this.entries.set(workspaceDir, existing);
      return { watcher: existing.watcher, cached: true };
    }

    const scan = this.scanAndCache(workspaceDir);
    this.inFlight.set(workspaceDir, scan);
    try {
      return { watcher: await scan, cached: false };
    } finally {
      if (this.inFlight.get(workspaceDir) === scan) this.inFlight.delete(workspaceDir);
    }
  }

  public stats(): { cacheSize: number; cacheEvictions: number } {
    return { cacheSize: this.entries.size, cacheEvictions: this.evictions };
  }

  private async scanAndCache(workspaceDir: string): Promise<TWatcher> {
    const watcher = this.createWatcher(workspaceDir);
    try {
      await watcher.scanWorkspace();
    } catch (error) {
      watcher.close();
      throw error;
    }

    const previous = this.entries.get(workspaceDir);
    this.entries.delete(workspaceDir);
    this.entries.set(workspaceDir, { watcher, scannedAt: this.now() });
    if (previous && previous.watcher !== watcher) previous.watcher.close();

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as
        [string, CacheEntry<TWatcher>] | undefined;
      if (!oldest) break;
      const [oldestWorkspace, entry] = oldest;
      this.entries.delete(oldestWorkspace);
      this.evictions += 1;
      entry.watcher.close();
    }

    return watcher;
  }
}
