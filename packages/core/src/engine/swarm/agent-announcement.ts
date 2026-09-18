/**
 * Agent presence and capability announcement protocol.
 *
 * This is the discovery layer the mesh needs but does not have: `MailboxKernel`
 * lets you send *to* an agent if you already know its name, and
 * `MeshProtocol` routes *between* members — but neither answers "who is out
 * there right now and what can they do?". An announcement is a leased,
 * time-boxed claim of capability that a peer can query before it addresses
 * anyone. Without it the mesh's only option is to broadcast a question to
 * everyone, which is exactly the traffic pattern the TTL flood exists to
 * absorb rather than encourage.
 *
 * The mechanics are real lease bookkeeping, not timestamps in a comment:
 *  - every announcement carries a TTL and a monotonic issued-at lease;
 *  - renewals extend the lease; expiry is computed lazily by `sweep`, which
 *    is the only place eviction happens, so reads never mutate;
 *  - a capability index maps capability name -> announcing agents, so a
 *    capability query is an index lookup, not a mesh-wide scan;
 *  - announcement equality is by (agentId, capability set, role), so a peer
 *    re-announcing unchanged content is idempotent and does not churn the
 *    index or bump observers;
 *  - observers are notified on material change only — join, capability
 *    change, role change, or expiry — never on a silent renewal.
 */

import type { MeshProtocol } from "./mesh-protocol.js";
import { MESH_BROADCAST } from "./mesh-protocol.js";

export interface Announcement {
  agentId: string;
  capabilities: readonly string[];
  role?: string;
  /** Lease duration in ms; the announcement is dead after it elapses. */
  ttlMs: number;
  issuedAt: number;
  lastSeenAt: number;
  priority: number;
  /** Monotonic counter used to distinguish content changes from refreshes. */
  revision: number;
}

export interface AnnouncementQuery {
  capability?: string;
  role?: string;
  /** Only announcements seen within this many ms. */
  fresherThanMs?: number;
  /** Cap the result count. */
  limit?: number;
}

export interface AnnouncementSubscription {
  (event: AnnouncementEvent): void;
}

export type AnnouncementEventType = "joined" | "updated" | "expired" | "revoked";

export interface AnnouncementEvent {
  type: AnnouncementEventType;
  agentId: string;
  announcement?: Announcement;
  at: number;
}

export interface AnnouncementDirectoryOptions {
  /** TTL applied when an announcement omits one. */
  defaultTtlMs?: number;
  /** Max tracked announcements. */
  maxAnnouncements?: number;
  /** Announcements older than this are preferred last in query order. */
  stalenessRank?: boolean;
}

function announcementFingerprint(announcement: {
  capabilities: readonly string[];
  role?: string;
}): string {
  return [announcement.role ?? "", ...announcement.capabilities]
    .map((c) => c.trim())
    .sort()
    .join("|");
}

export class AnnouncementDirectory {
  private readonly announcements = new Map<string, Announcement>();
  private readonly capabilityIndex = new Map<string, Set<string>>();
  private readonly observers = new Set<AnnouncementSubscription>();
  private readonly options: Required<AnnouncementDirectoryOptions>;
  private revisionCounter = 0;

  constructor(options: AnnouncementDirectoryOptions = {}) {
    this.options = {
      defaultTtlMs: options.defaultTtlMs ?? 60_000,
      maxAnnouncements: Math.max(1, options.maxAnnouncements ?? 512),
      stalenessRank: options.stalenessRank ?? true,
    };
  }

  public subscribe(observer: AnnouncementSubscription): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /**
   * Publishes or refreshes an announcement. Idempotent for unchanged content:
   * the lease extends and `lastSeenAt` moves, but no observer is notified and
   * the revision counter does not move.
   */
  public announce(input: {
    agentId: string;
    capabilities?: readonly string[];
    role?: string;
    ttlMs?: number;
    priority?: number;
  }): Announcement {
    const agentId = input.agentId.trim();
    if (!agentId) throw new Error("Announcement agentId cannot be empty");
    if (
      !this.announcements.has(agentId) &&
      this.announcements.size >= this.options.maxAnnouncements
    ) {
      throw new Error(
        `Announcement directory cardinality limit reached (${this.options.maxAnnouncements})`,
      );
    }

    const now = Date.now();
    const ttlMs = Math.max(1_000, input.ttlMs ?? this.options.defaultTtlMs);
    const capabilities = Array.from(
      new Set((input.capabilities ?? []).map((capability) => capability.trim())),
    );
    const priority = Math.max(0, Math.min(10, input.priority ?? 0));
    const existing = this.announcements.get(agentId);
    const changed =
      !existing ||
      existing.role !== input.role ||
      announcementFingerprint({ capabilities, role: input.role }) !==
        announcementFingerprint({ capabilities: existing.capabilities, role: existing.role });

    const announcement: Announcement = {
      agentId,
      capabilities,
      role: input.role?.trim() || undefined,
      ttlMs,
      issuedAt: existing?.issuedAt ?? now,
      lastSeenAt: now,
      priority,
      revision: changed ? ++this.revisionCounter : (existing?.revision ?? 0),
    };

    this.announcements.set(agentId, announcement);
    this.rebuildCapabilityIndex(agentId, capabilities);
    // Only a material change or a first appearance notifies observers; a
    // plain renewal extends the lease silently.
    this.emit(existing ? "updated" : "joined", agentId, announcement, now);
    return { ...announcement, capabilities: [...announcement.capabilities] };
  }

  /** Explicitly withdraws an announcement; distinct from lease expiry. */
  public revoke(agentId: string): boolean {
    const id = agentId.trim();
    const announcement = this.announcements.get(id);
    if (!announcement) return false;
    this.announcements.delete(id);
    this.dropFromIndex(id);
    this.emit("revoked", id, announcement, Date.now());
    return true;
  }

  public renew(agentId: string, ttlMs?: number): Announcement | null {
    const id = agentId.trim();
    const announcement = this.announcements.get(id);
    if (!announcement) return null;
    announcement.lastSeenAt = Date.now();
    if (ttlMs !== undefined) announcement.ttlMs = Math.max(1_000, ttlMs);
    return { ...announcement, capabilities: [...announcement.capabilities] };
  }

  public get(agentId: string): Announcement | undefined {
    const announcement = this.announcements.get(agentId.trim());
    if (!announcement) return undefined;
    if (this.isExpired(announcement, Date.now())) return undefined;
    return { ...announcement, capabilities: [...announcement.capabilities] };
  }

  public list(): Announcement[] {
    const now = Date.now();
    return Array.from(this.announcements.values())
      .filter((announcement) => !this.isExpired(announcement, now))
      .map((announcement) => ({ ...announcement, capabilities: [...announcement.capabilities] }));
  }

  /**
   * Capability- and role-filtered lookup against the index, ranked by priority
   * then by freshness so a stale duplicate never outranks a live one.
   */
  public query(query: AnnouncementQuery = {}): Announcement[] {
    const now = Date.now();
    let candidates: Announcement[];

    if (query.capability) {
      const capability = query.capability.trim();
      const ids = this.capabilityIndex.get(capability) ?? new Set<string>();
      candidates = Array.from(ids)
        .map((id) => this.announcements.get(id))
        .filter((announcement): announcement is Announcement => announcement !== undefined);
    } else {
      candidates = Array.from(this.announcements.values());
    }

    const results = candidates
      .filter((announcement) => !this.isExpired(announcement, now))
      .filter((announcement) => !query.role || announcement.role === query.role.trim())
      .filter(
        (announcement) =>
          query.fresherThanMs === undefined || now - announcement.lastSeenAt <= query.fresherThanMs,
      )
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (this.options.stalenessRank) return b.lastSeenAt - a.lastSeenAt;
        return a.agentId.localeCompare(b.agentId);
      })
      .map((announcement) => ({ ...announcement, capabilities: [...announcement.capabilities] }));

    return query.limit !== undefined ? results.slice(0, Math.max(0, query.limit)) : results;
  }

  /** Agents known to hold `capability`, ids only. */
  public agentsWithCapability(capability: string): string[] {
    return Array.from(this.capabilityIndex.get(capability.trim()) ?? []);
  }

  /**
   * The one mutating read: sweeps expired announcements out and reports them.
   * Callers should run this on a timer or before any decision that depends on
   * liveness; reads above tolerate stale entries without sweeping.
   */
  public sweep(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [agentId, announcement] of this.announcements) {
      if (this.isExpired(announcement, now)) {
        expired.push(agentId);
        this.announcements.delete(agentId);
        this.dropFromIndex(agentId);
        this.emit("expired", agentId, announcement, now);
      }
    }
    return expired;
  }

  public count(): number {
    return this.announcements.size;
  }

  /**
   * Propagates the local directory over a mesh as a broadcast, and merges
   * envelopes received from peers. This is the gossip half of the protocol:
   * a peer's announcement becomes locally visible without a central registry.
   */
  public gossipOverMesh(
    mesh: MeshProtocol,
    fromAgentId: string,
    options: { ttl?: number; limit?: number } = {},
  ): { sent: number; reason: string } {
    const payload = this.list()
      .slice(0, options.limit ?? 64)
      .map((announcement) => ({
        agentId: announcement.agentId,
        capabilities: [...announcement.capabilities],
        role: announcement.role,
        ttlMs: announcement.ttlMs,
        priority: announcement.priority,
      }));
    const result = mesh.broadcast(
      fromAgentId,
      "swarm.announcement.gossip",
      { origin: fromAgentId, announcements: payload },
      { ttl: options.ttl },
    );
    return { sent: payload.length, reason: result.reason };
  }

  /** Merges a gossip payload received over the mesh into this directory. */
  public mergeGossipPayload(payload: unknown, localAgentId: string): number {
    if (!payload || typeof payload !== "object") return 0;
    const record = payload as { origin?: string; announcements?: unknown[] };
    if (!Array.isArray(record.announcements)) return 0;
    let merged = 0;
    for (const raw of record.announcements) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as {
        agentId?: string;
        capabilities?: string[];
        role?: string;
        ttlMs?: number;
        priority?: number;
      };
      if (!entry.agentId || entry.agentId === localAgentId) continue;
      this.announce({
        agentId: entry.agentId,
        capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
        role: entry.role,
        ttlMs: entry.ttlMs,
        priority: entry.priority,
      });
      merged++;
    }
    return merged;
  }

  // ---------------------------------------------------------------- internals

  private isExpired(announcement: Announcement, now: number): boolean {
    return now - announcement.lastSeenAt > announcement.ttlMs;
  }

  private rebuildCapabilityIndex(agentId: string, capabilities: readonly string[]): void {
    this.dropFromIndex(agentId);
    for (const capability of capabilities) {
      const set = this.capabilityIndex.get(capability) ?? new Set<string>();
      set.add(agentId);
      this.capabilityIndex.set(capability, set);
    }
  }

  private dropFromIndex(agentId: string): void {
    for (const [capability, set] of this.capabilityIndex) {
      set.delete(agentId);
      if (set.size === 0) this.capabilityIndex.delete(capability);
    }
  }

  private emit(
    type: AnnouncementEventType,
    agentId: string,
    announcement: Announcement,
    at: number,
  ): void {
    if (this.observers.size === 0) return;
    const event: AnnouncementEvent = {
      type,
      agentId,
      announcement: { ...announcement, capabilities: [...announcement.capabilities] },
      at,
    };
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch (error) {
        // One bad observer must not silence the directory.
        console.error("[AnnouncementDirectory] observer error:", error);
      }
    }
  }
}

/** Re-exported so callers can build a broadcast target in one import. */
export { MESH_BROADCAST };
