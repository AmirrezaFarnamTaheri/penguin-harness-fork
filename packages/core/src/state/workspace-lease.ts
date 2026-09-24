/**
 * Workspace Lease Management and Writer Serialization.
 * Ported and synthesized from DeepSeek-Reasonix internal/workspacelease.
 *
 * Enforces strict write-serialization and read-concurrency per workspace scope
 * and file paths, guaranteeing that concurrent subagents and background tasks do not
 * conflict on disk, corrupt Git indexes, or race on lockfiles.
 */

import { randomUUID } from "node:crypto";
import { normalize, resolve } from "node:path";

export type LeaseMode = "shared" | "exclusive";

export type LeaseStatus = "pending" | "active" | "released" | "expired";

export interface WorkspaceLeaseRequest {
  /** Target workspace root or directory scope. */
  scope: string;
  /** Unique ID of the leasing agent, session, or background task. */
  holderId: string;
  /** "shared" for concurrent reads, "exclusive" for serialized writes. */
  mode: LeaseMode;
  /** Optional specific relative or absolute file paths being operated upon. */
  keys?: string[];
  /** Maximum wait time in milliseconds before timing out during acquisition (default: 30000). */
  timeoutMs?: number;
  /** Lease time-to-live before automatic expiration if no heartbeat is received (default: 60000). */
  ttlMs?: number;
  /** Optional callback invoked once if acquisition is queued and must wait. */
  onWaiting?: () => void;
}

export interface WorkspaceLease {
  id: string;
  scope: string;
  holderId: string;
  mode: LeaseMode;
  keys: readonly string[];
  acquiredAt: number;
  expiresAt: number;
  /** Explicitly releases the lease. */
  release: () => void;
  /** Extends lease expiration time by extra milliseconds or default TTL. */
  heartbeat: (extraMs?: number) => void;
  /** Checks if the lease is still valid and not expired or released. */
  isAlive: () => boolean;
}

export interface WorkspaceLeaseInfo {
  id: string;
  scope: string;
  holderId: string;
  mode: LeaseMode;
  keys: string[];
  acquiredAt: number;
  expiresAt: number;
  status: LeaseStatus;
}

interface InternalLease {
  id: string;
  normalizedScope: string;
  rawScope: string;
  holderId: string;
  mode: LeaseMode;
  normalizedKeys: string[];
  acquiredAt: number;
  expiresAt: number;
  defaultTtl: number;
  status: LeaseStatus;
}

interface QueuedAcquisition {
  id: string;
  request: WorkspaceLeaseRequest;
  normalizedScope: string;
  normalizedKeys: string[];
  resolve: (lease: WorkspaceLease) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  waitNotified: boolean;
}

/**
 * Normalizes directory and file paths to stable canonical form,
 * lowercasing on Windows for case-insensitive matching.
 */
export function normalizeScopePath(rawPath: string): string {
  if (!rawPath || rawPath.trim().length === 0) {
    return "";
  }
  const resolved = resolve(normalize(rawPath));
  const isWindows = process.platform === "win32";
  return isWindows ? resolved.toLowerCase() : resolved;
}

/**
 * WorkspaceLeaseManager coordinates shared and exclusive access to workspaces
 * and file paths, preventing concurrent write collisions across agents.
 */
export class WorkspaceLeaseManager {
  private readonly activeLeases = new Map<string, InternalLease>();
  private readonly waitQueue: QueuedAcquisition[] = [];
  private cleanTimer: NodeJS.Timeout | null = null;

  constructor(autoCleanupIntervalMs: number = 10000) {
    if (autoCleanupIntervalMs > 0) {
      this.cleanTimer = setInterval(() => {
        this.evictExpired();
      }, autoCleanupIntervalMs);
      if (this.cleanTimer.unref) {
        this.cleanTimer.unref();
      }
    }
  }

  /**
   * Acquire a lease asynchronously, waiting if conflicting leases are currently active.
   */
  public async acquire(request: WorkspaceLeaseRequest): Promise<WorkspaceLease> {
    this.evictExpired();

    const normalizedScope = normalizeScopePath(request.scope);
    if (!normalizedScope) {
      throw new Error("WorkspaceLeaseManager: scope cannot be empty");
    }

    const normalizedKeys = this.normalizeKeys(request.keys);
    const timeoutMs = request.timeoutMs ?? 30000;
    const ttlMs = request.ttlMs ?? 60000;

    // Check if can be granted immediately
    if (this.canGrant(normalizedScope, request.mode, normalizedKeys)) {
      return this.grantLease(request, normalizedScope, normalizedKeys, ttlMs);
    }

    // Must queue
    if (request.onWaiting) {
      try {
        request.onWaiting();
      } catch {
        // Ignore user callback errors
      }
    }

    return new Promise<WorkspaceLease>((resolvePromise, rejectPromise) => {
      const waitId = randomUUID();
      const timer = setTimeout(() => {
        // A granted request is dequeued and its timer cleared, so this only fires for a request
        // still genuinely waiting; guard anyway so a late fire can never reject a granted lease.
        const idx = this.waitQueue.findIndex((q) => q.id === waitId);
        if (idx === -1) return;
        this.waitQueue.splice(idx, 1);
        rejectPromise(
          new Error(
            `WorkspaceLeaseManager: Timeout after ${timeoutMs}ms waiting for ${request.mode} lease on '${request.scope}' (holder: ${request.holderId})`,
          ),
        );
      }, timeoutMs);

      this.waitQueue.push({
        id: waitId,
        request,
        normalizedScope,
        normalizedKeys,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        waitNotified: true,
      });
    });
  }

  /**
   * Attempt to acquire a lease synchronously/immediately without waiting.
   * Returns null if the lease cannot be granted immediately.
   */
  public tryAcquire(request: WorkspaceLeaseRequest): WorkspaceLease | null {
    this.evictExpired();

    const normalizedScope = normalizeScopePath(request.scope);
    if (!normalizedScope) {
      return null;
    }

    const normalizedKeys = this.normalizeKeys(request.keys);
    const ttlMs = request.ttlMs ?? 60000;

    if (!this.canGrant(normalizedScope, request.mode, normalizedKeys)) {
      return null;
    }

    return this.grantLease(request, normalizedScope, normalizedKeys, ttlMs);
  }

  /**
   * Releases an active lease by ID.
   */
  public release(leaseId: string): boolean {
    const lease = this.activeLeases.get(leaseId);
    if (!lease || lease.status !== "active") {
      return false;
    }

    lease.status = "released";
    this.activeLeases.delete(leaseId);
    this.processQueue();
    return true;
  }

  /**
   * Extends the TTL of an active lease.
   */
  public heartbeat(leaseId: string, extraMs?: number): boolean {
    const lease = this.activeLeases.get(leaseId);
    if (!lease || lease.status !== "active") {
      return false;
    }
    const extension = extraMs ?? lease.defaultTtl;
    lease.expiresAt = Date.now() + extension;
    return true;
  }

  /**
   * Tests if a given scope or set of keys is currently locked by an exclusive writer.
   */
  public isLocked(scope: string, keys?: string[]): boolean {
    this.evictExpired();
    const normalizedScope = normalizeScopePath(scope);
    const normalizedKeys = this.normalizeKeys(keys);

    for (const lease of this.activeLeases.values()) {
      if (lease.status !== "active") continue;
      if (lease.normalizedScope !== normalizedScope) continue;

      if (lease.mode === "exclusive") {
        if (lease.normalizedKeys.length === 0 || normalizedKeys.length === 0) {
          return true;
        }
        const hasOverlap = lease.normalizedKeys.some((k) => normalizedKeys.includes(k));
        if (hasOverlap) return true;
      }
    }
    return false;
  }

  /**
   * Returns metadata for all currently tracked leases.
   */
  public getActiveLeases(scope?: string): WorkspaceLeaseInfo[] {
    this.evictExpired();
    const normalized = scope ? normalizeScopePath(scope) : null;
    const out: WorkspaceLeaseInfo[] = [];

    for (const lease of this.activeLeases.values()) {
      if (lease.status === "active") {
        if (!normalized || lease.normalizedScope === normalized) {
          out.push({
            id: lease.id,
            scope: lease.rawScope,
            holderId: lease.holderId,
            mode: lease.mode,
            keys: [...lease.normalizedKeys],
            acquiredAt: lease.acquiredAt,
            expiresAt: lease.expiresAt,
            status: lease.status,
          });
        }
      }
    }
    return out;
  }

  /**
   * Evicts leases whose TTL has expired and wakes waiting requests.
   */
  public evictExpired(): number {
    const now = Date.now();
    let evictedCount = 0;

    for (const [id, lease] of this.activeLeases.entries()) {
      if (lease.status === "active" && lease.expiresAt <= now) {
        lease.status = "expired";
        this.activeLeases.delete(id);
        evictedCount++;
      }
    }

    if (evictedCount > 0) {
      this.processQueue();
    }

    return evictedCount;
  }

  /**
   * Cleans all active leases and terminates internal intervals.
   */
  public dispose(): void {
    if (this.cleanTimer) {
      clearInterval(this.cleanTimer);
      this.cleanTimer = null;
    }
    for (const q of this.waitQueue) {
      clearTimeout(q.timer);
      q.reject(new Error("WorkspaceLeaseManager disposed"));
    }
    this.waitQueue.length = 0;
    this.activeLeases.clear();
  }

  // --- Internal helpers ---

  /**
   * Normalizes request keys and drops empty ones: an empty path (a caller bug) would otherwise join
   * key-overlap matching as if it were a real path, and an all-empty key set must read as
   * whole-scope rather than as a per-key request that conflicts with nothing.
   */
  private normalizeKeys(keys?: string[]): string[] {
    return (keys ?? []).map(normalizeScopePath).filter((key) => key.length > 0);
  }

  private canGrant(scope: string, mode: LeaseMode, keys: string[]): boolean {
    for (const lease of this.activeLeases.values()) {
      if (lease.status !== "active") continue;
      if (lease.normalizedScope !== scope) continue;

      // Exclusive holder blocks both new exclusive and new shared requests
      if (lease.mode === "exclusive") {
        if (lease.normalizedKeys.length === 0 || keys.length === 0) {
          return false;
        }
        const conflict = lease.normalizedKeys.some((k) => keys.includes(k));
        if (conflict) {
          return false;
        }
      }

      // If new request is exclusive, existing shared holders block it
      if (mode === "exclusive") {
        if (lease.normalizedKeys.length === 0 || keys.length === 0) {
          return false;
        }
        const conflict = lease.normalizedKeys.some((k) => keys.includes(k));
        if (conflict) {
          return false;
        }
      }
    }
    return true;
  }

  private grantLease(
    request: WorkspaceLeaseRequest,
    normalizedScope: string,
    normalizedKeys: string[],
    ttlMs: number,
  ): WorkspaceLease {
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const internal: InternalLease = {
      id,
      normalizedScope,
      rawScope: request.scope,
      holderId: request.holderId,
      mode: request.mode,
      normalizedKeys,
      acquiredAt: now,
      expiresAt,
      defaultTtl: ttlMs,
      status: "active",
    };

    this.activeLeases.set(id, internal);

    const publicLease: WorkspaceLease = {
      id,
      scope: request.scope,
      holderId: request.holderId,
      mode: request.mode,
      keys: Object.freeze([...normalizedKeys]),
      acquiredAt: now,
      get expiresAt() {
        return internal.expiresAt;
      },
      release: () => {
        this.release(id);
      },
      heartbeat: (extraMs?: number) => {
        this.heartbeat(id, extraMs);
      },
      isAlive: () => {
        return internal.status === "active" && internal.expiresAt > Date.now();
      },
    };

    return publicLease;
  }

  private processQueue(): void {
    if (this.waitQueue.length === 0) return;

    for (let i = 0; i < this.waitQueue.length;) {
      const item = this.waitQueue[i]!;
      if (this.canGrant(item.normalizedScope, item.request.mode, item.normalizedKeys)) {
        this.waitQueue.splice(i, 1);
        clearTimeout(item.timer);
        const lease = this.grantLease(
          item.request,
          item.normalizedScope,
          item.normalizedKeys,
          item.request.ttlMs ?? 60000,
        );
        item.resolve(lease);
      } else {
        i++;
      }
    }
  }
}
