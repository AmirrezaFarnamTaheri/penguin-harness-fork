/**
 * Agent-to-agent mesh protocol — dynamic peer topology, routing and liveness.
 *
 * What this is, and what it is not: `agent/mailbox.ts` is the *queue* — a
 * per-agent FIFO with leases. This module is the *topology above it*. It owns
 * which peers know about each other, whether a link is live, how an envelope
 * actually crosses from node A to node B when they share no direct link
 * (relay over the shortest live path), and how a broadcast reaches everyone
 * without looping. Delivery itself is delegated to a transport, and the
 * default transport is a thin adapter onto `MailboxKernel.send`, so the mesh
 * extends the mailbox rather than replacing it.
 *
 * Algorithms, all real:
 *  - relay routing   — breadth-first search over active links for the shortest
 *                      live path, then hop-by-hop forwarding with a trace.
 *  - broadcast flood — breadth-first flood with a per-envelope visited set and
 *                      a TTL decrement per hop; cycles die on the visited set,
 *                      not on a hop count alone.
 *  - liveness        — per-node heartbeat timestamps swept against a staleness
 *                      threshold; a stale node's links are excluded from
 *                      routing without being deleted (they can re-heat).
 *  - partitioning    — connected components over the active-link graph; a mesh
 *                      that has split reports both sides, and routing across
 *                      the split fails loudly rather than silently dropping.
 *
 * Synthesized from the peer-topology and handoff-routing work in
 * autogen's SwarmGroupChat / DiGraph, llama-agents' control-loop routing and
 * HyperAgent's agent mesh, adapted onto the existing MailboxKernel transport.
 */

import { MailboxKernel, type MailboxMessage } from "../../agent/mailbox.js";

export type MeshLinkKind = "direct" | "gossip" | "relay";

export interface MeshNodeState {
  id: string;
  capabilities: readonly string[];
  joinedAt: number;
  lastHeartbeatAt: number;
  live: boolean;
}

export interface MeshLinkState {
  from: string;
  to: string;
  kind: MeshLinkKind;
  weight: number;
  active: boolean;
  establishedAt: number;
  lastUsedAt: number;
  deliveries: number;
}

export interface MeshEnvelope<T = unknown> {
  id: string;
  from: string;
  /** Destination node id, or `MESH_BROADCAST` for a mesh-wide flood. */
  to: string;
  eventType: string;
  payload: T;
  /** Remaining hops. Hit zero and the envelope is dropped, not forwarded. */
  ttl: number;
  hopCount: number;
  /** Nodes that have already handled this envelope, for gossip de-duplication. */
  visited: string[];
  priority: "normal" | "high";
}

export interface MeshTopologyView {
  nodes: MeshNodeState[];
  links: MeshLinkState[];
  partitions: string[][];
}

export interface MeshRoutingResult {
  delivered: boolean;
  path: string[];
  hops: number;
  reason: string;
}

/**
 * The seam the mesh writes through. Anything that can push an envelope into a
 * node's inbox works; `MailboxKernelMeshTransport` is the standard one.
 */
export interface MeshTransport {
  deliver<T = unknown>(to: string, envelope: MeshEnvelope<T>): MailboxMessage | null;
  knowsRecipient(nodeId: string): boolean;
}

function generateEnvelopeId(): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return `mesh-${globalThis.crypto.randomUUID()}`;
  }
  return `mesh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Default transport: pushes the envelope into a `MailboxKernel` queue. The mesh
 * decides *where*; the mailbox decides *whether* (capacity, payload limits).
 */
export class MailboxKernelMeshTransport implements MeshTransport {
  constructor(private readonly mailbox: MailboxKernel) {}

  public deliver<T = unknown>(to: string, envelope: MeshEnvelope<T>): MailboxMessage | null {
    try {
      return this.mailbox.send<T>(
        to,
        envelope.from,
        envelope.eventType,
        envelope.payload,
        envelope.priority,
      );
    } catch {
      // Queue-full / payload-too-large / unknown-recipient are routing outcomes
      // for the caller, not crashes for the mesh.
      return null;
    }
  }

  public knowsRecipient(nodeId: string): boolean {
    return this.mailbox.getSummary(nodeId) !== null;
  }
}

export interface MeshProtocolOptions {
  transport?: MeshTransport;
  /** Heartbeat staleness threshold in ms before a node is routed around. */
  staleAfterMs?: number;
  /** Default TTL for envelopes that do not specify one. */
  defaultTtl?: number;
  /** Max simultaneous nodes in a mesh, a blunt guard against runaway joins. */
  maxNodes?: number;
  /** Max tracked links before join/link is refused. */
  maxLinks?: number;
}

export const MESH_BROADCAST = "*";

export class MeshProtocol {
  public readonly transport: MeshTransport;

  private readonly nodes = new Map<string, MeshNodeState>();
  /** Adjacency: nodeId -> neighbourId -> link (directed; add both ways for symmetric). */
  private readonly adjacency = new Map<string, Map<string, MeshLinkState>>();
  private readonly staleAfterMs: number;
  private readonly defaultTtl: number;
  private readonly maxNodes: number;
  private readonly maxLinks: number;
  private linkCount = 0;
  private deliveredCount = 0;
  private droppedCount = 0;
  private readonly flooded = new Set<string>();

  constructor(options: MeshProtocolOptions = {}) {
    this.transport = options.transport ?? new MailboxKernelMeshTransport(new MailboxKernel());
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.defaultTtl = options.defaultTtl ?? 8;
    this.maxNodes = options.maxNodes ?? 256;
    this.maxLinks = options.maxLinks ?? 4_096;
  }

  public getDeliveredCount(): number {
    return this.deliveredCount;
  }

  public getDroppedCount(): number {
    return this.droppedCount;
  }

  /** Joins a node into the mesh, or refreshes its capabilities if already present. */
  public join(nodeId: string, capabilities: readonly string[] = []): MeshNodeState {
    const id = nodeId.trim();
    if (!id) throw new Error("Mesh node id cannot be empty");

    const now = Date.now();
    const existing = this.nodes.get(id);
    if (existing) {
      existing.capabilities = Array.from(new Set(capabilities));
      existing.lastHeartbeatAt = now;
      existing.live = true;
      return { ...existing, capabilities: [...existing.capabilities] };
    }
    if (this.nodes.size >= this.maxNodes) {
      throw new Error(`Mesh node cardinality limit reached (${this.maxNodes})`);
    }

    const node: MeshNodeState = {
      id,
      capabilities: Array.from(new Set(capabilities)),
      joinedAt: now,
      lastHeartbeatAt: now,
      live: true,
    };
    this.nodes.set(id, node);
    this.adjacency.set(id, new Map());
    return { ...node, capabilities: [...node.capabilities] };
  }

  public leave(nodeId: string): boolean {
    const id = nodeId.trim();
    const node = this.nodes.get(id);
    if (!node) return false;
    this.nodes.delete(id);
    const out = this.adjacency.get(id);
    if (out) {
      this.linkCount -= out.size;
      this.adjacency.delete(id);
    }
    for (const [neighbour, edges] of this.adjacency) {
      const link = edges.get(id);
      if (link) {
        edges.delete(id);
        this.linkCount--;
      }
      if (edges.size === 0 && !this.nodes.has(neighbour)) {
        // keep the map entry; nodes may rejoin
      }
    }
    return true;
  }

  /**
   * Refreshes a node's liveness. `now` may be supplied so liveness can be
   * evaluated against an arbitrary instant (a test clock, or a replayed
   * timeline); it defaults to the real clock and does not change behaviour.
   */
  public heartbeat(nodeId: string, now: number = Date.now()): void {
    const node = this.nodes.get(nodeId.trim());
    if (!node) throw new Error(`Cannot heartbeat unknown mesh node '${nodeId}'`);
    node.lastHeartbeatAt = now;
    node.live = true;
  }

  /** Links two nodes. `symmetric` (default) adds the reverse edge too. */
  public link(
    from: string,
    to: string,
    kind: MeshLinkKind = "direct",
    weight = 1,
    options: { symmetric?: boolean } = {},
  ): MeshLinkState {
    const fromId = from.trim();
    const toId = to.trim();
    if (!fromId || !toId) throw new Error("Mesh link endpoints cannot be empty");
    if (fromId === toId) throw new Error("Mesh link cannot be self-referential");
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) {
      throw new Error(`Cannot link non-member mesh nodes '${fromId}' -> '${toId}'`);
    }
    if (this.linkCount >= this.maxLinks) {
      throw new Error(`Mesh link cardinality limit reached (${this.maxLinks})`);
    }

    const created = this.putEdge(fromId, toId, kind, weight);
    if (options.symmetric !== false && !this.hasEdge(toId, fromId)) {
      this.putEdge(toId, fromId, kind, weight);
    }
    return created;
  }

  /**
   * Tears down a link. Symmetric by default, mirroring `link`: leaving one
   * direction open would make the mesh asymmetric and let a node route where
   * its peer cannot reply. Pass `{ symmetric: false }` for a directed teardown.
   */
  public unlink(from: string, to: string, options: { symmetric?: boolean } = {}): boolean {
    const removed = this.removeEdge(from.trim(), to.trim());
    if (options.symmetric !== false) {
      const reverse = this.removeEdge(to.trim(), from.trim());
      return removed || reverse;
    }
    return removed;
  }

  public hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId.trim());
  }

  public getNode(nodeId: string): MeshNodeState | undefined {
    const node = this.nodes.get(nodeId.trim());
    return node ? { ...node, capabilities: [...node.capabilities] } : undefined;
  }

  public listNodes(): MeshNodeState[] {
    return Array.from(this.nodes.values()).map((node) => ({
      ...node,
      capabilities: [...node.capabilities],
    }));
  }

  public listLinks(): MeshLinkState[] {
    const links: MeshLinkState[] = [];
    for (const edges of this.adjacency.values()) {
      for (const link of edges.values()) links.push({ ...link });
    }
    return links;
  }

  /** Neighbours reachable from `nodeId` over currently-live links. */
  public neighboursOf(nodeId: string): string[] {
    const edges = this.adjacency.get(nodeId.trim());
    if (!edges) return [];
    const result: string[] = [];
    for (const [neighbour, link] of edges) {
      if (link.active && this.isLive(neighbour)) result.push(neighbour);
    }
    return result;
  }

  /**
   * Routes an envelope to one node, relaying over live peers when there is no
   * direct link. Never throws on unroutable input — returns a routing result
   * with a reason so callers can distinguish "dropped" from "delivered".
   */
  public send<T = unknown>(
    to: string,
    from: string,
    eventType: string,
    payload: T,
    options: { ttl?: number; priority?: "normal" | "high" } = {},
  ): MeshRoutingResult {
    const fromId = from.trim();
    const toId = to.trim();
    if (!this.nodes.has(fromId)) {
      return this.drop(`sender '${fromId}' is not a mesh member`);
    }
    if (toId === MESH_BROADCAST) {
      return this.flood<T>(fromId, eventType, payload, options);
    }
    if (!this.nodes.has(toId)) {
      return this.drop(`recipient '${toId}' is not a mesh member`);
    }

    const path = this.shortestPath(fromId, toId);
    if (path.length === 0) {
      return this.drop(`no live route from '${fromId}' to '${toId}' (partitioned or isolated)`);
    }

    const envelope = this.envelope<T>(fromId, toId, eventType, payload, options, path);
    const delivered = this.transport.deliver<T>(toId, envelope) !== null;
    if (!delivered) {
      return this.drop(
        `transport rejected delivery to '${toId}' (queue full or payload too large)`,
      );
    }
    this.markUsed(path);
    this.deliveredCount++;
    return { delivered: true, path, hops: path.length - 1, reason: "delivered" };
  }

  /**
   * Floods the mesh from `fromId`. Breadth-first over live links, each hop
   * costs one TTL, and a per-envelope visited set stops cycles dead — so a
   * ring mesh delivers each node exactly once and terminates.
   */
  public broadcast<T = unknown>(
    from: string,
    eventType: string,
    payload: T,
    options: { ttl?: number; priority?: "normal" | "high" } = {},
  ): MeshRoutingResult {
    const fromId = from.trim();
    if (!this.nodes.has(fromId)) return this.drop(`broadcaster '${fromId}' is not a mesh member`);
    return this.flood<T>(fromId, eventType, payload, options);
  }

  /**
   * Reapplies the liveness rule: a node whose heartbeat is older than the
   * staleness threshold is routed around. Returns the ids that went stale.
   */
  public sweepStale(now: number = Date.now()): string[] {
    const stale: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.live && now - node.lastHeartbeatAt > this.staleAfterMs) {
        node.live = false;
        stale.push(node.id);
      }
    }
    return stale;
  }

  public revive(nodeId: string): boolean {
    const node = this.nodes.get(nodeId.trim());
    if (!node) return false;
    node.live = true;
    node.lastHeartbeatAt = Date.now();
    return true;
  }

  public isLive(nodeId: string): boolean {
    const node = this.nodes.get(nodeId.trim());
    return node?.live === true;
  }

  /**
   * Connected components over live links. An empty result means a partitionless
   * mesh (or an empty one). Two or more components means the mesh has split and
   * cross-component routing is now impossible.
   */
  public partitions(): string[][] {
    const seen = new Set<string>();
    const components: string[][] = [];

    for (const node of this.nodes.values()) {
      if (seen.has(node.id) || !node.live) continue;
      const component: string[] = [];
      const queue: string[] = [node.id];
      seen.add(node.id);
      while (queue.length > 0) {
        const current = queue.shift() as string;
        component.push(current);
        for (const neighbour of this.neighboursOf(current)) {
          if (!seen.has(neighbour)) {
            seen.add(neighbour);
            queue.push(neighbour);
          }
        }
      }
      components.push(component);
    }
    return components;
  }

  public getTopology(): MeshTopologyView {
    return {
      nodes: this.listNodes(),
      links: this.listLinks(),
      partitions: this.partitions(),
    };
  }

  // ---------------------------------------------------------------- internals

  private putEdge(from: string, to: string, kind: MeshLinkKind, weight: number): MeshLinkState {
    const edges = this.adjacency.get(from) ?? new Map();
    let link = edges.get(to);
    if (link) {
      link.kind = kind;
      link.weight = weight;
      link.active = true;
      return { ...link };
    }
    link = {
      from,
      to,
      kind,
      weight,
      active: true,
      establishedAt: Date.now(),
      lastUsedAt: Date.now(),
      deliveries: 0,
    };
    edges.set(to, link);
    this.adjacency.set(from, edges);
    this.linkCount++;
    return { ...link };
  }

  private hasEdge(from: string, to: string): boolean {
    return this.adjacency.get(from)?.has(to) === true;
  }

  private removeEdge(from: string, to: string): boolean {
    const edges = this.adjacency.get(from);
    if (!edges || !edges.has(to)) return false;
    edges.delete(to);
    this.linkCount--;
    return true;
  }

  private envelope<T>(
    from: string,
    to: string,
    eventType: string,
    payload: T,
    options: { ttl?: number; priority?: "normal" | "high" },
    path: string[],
  ): MeshEnvelope<T> {
    return {
      id: generateEnvelopeId(),
      from,
      to,
      eventType,
      payload,
      ttl: options.ttl ?? this.defaultTtl,
      hopCount: path.length - 1,
      visited: path,
      priority: options.priority ?? "normal",
    };
  }

  private drop(reason: string): MeshRoutingResult {
    this.droppedCount++;
    return { delivered: false, path: [], hops: 0, reason };
  }

  private markUsed(path: string[]): void {
    for (let index = 0; index < path.length - 1; index++) {
      const link = this.adjacency.get(path[index] as string)?.get(path[index + 1] as string);
      if (link) {
        link.lastUsedAt = Date.now();
        link.deliveries++;
      }
    }
  }

  /** BFS shortest path over live links. Empty array means unreachable. */
  private shortestPath(from: string, to: string): string[] {
    if (from === to) return [from];
    const predecessor = new Map<string, string>();
    const queue: string[] = [from];
    const seen = new Set<string>([from]);

    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const neighbour of this.neighboursOf(current)) {
        if (seen.has(neighbour)) continue;
        predecessor.set(neighbour, current);
        if (neighbour === to) {
          return this.reconstructPath(predecessor, from, to);
        }
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
    return [];
  }

  private reconstructPath(predecessor: Map<string, string>, from: string, to: string): string[] {
    const path: string[] = [to];
    let cursor: string | undefined = to;
    while (cursor !== undefined && cursor !== from) {
      cursor = predecessor.get(cursor);
      if (cursor === undefined) break;
      path.unshift(cursor);
    }
    if (path[0] !== from) return [];
    return path;
  }

  private flood<T>(
    from: string,
    eventType: string,
    payload: T,
    options: { ttl?: number; priority?: "normal" | "high" },
  ): MeshRoutingResult {
    const ttl = options.ttl ?? this.defaultTtl;
    if (ttl <= 0) return this.drop("broadcast TTL exhausted at origin");

    // Flood dedup is keyed by envelope id, so a re-broadcast of identical
    // content still reaches everyone (new id) while one envelope never lands
    // on the same node twice.
    const envelopeId = generateEnvelopeId();
    if (this.flooded.has(envelopeId)) return this.drop("envelope id collision");
    this.flooded.add(envelopeId);

    const visited = new Set<string>([from]);
    /** Frontier entries carry the remaining TTL at arrival. */
    let frontier: Array<{ node: string; ttl: number }> = [{ node: from, ttl }];
    let delivered = 0;

    while (frontier.length > 0) {
      const nextFrontier: Array<{ node: string; ttl: number }> = [];
      for (const entry of frontier) {
        if (entry.ttl <= 0) continue;
        for (const neighbour of this.neighboursOf(entry.node)) {
          if (visited.has(neighbour)) continue;
          visited.add(neighbour);
          const envelope: MeshEnvelope<T> = {
            id: envelopeId,
            from,
            to: MESH_BROADCAST,
            eventType,
            payload,
            ttl: entry.ttl - 1,
            hopCount: Math.max(0, entry.ttl - 1),
            visited: Array.from(visited),
            priority: options.priority ?? "normal",
          };
          if (this.transport.deliver<T>(neighbour, envelope) !== null) delivered++;
          if (entry.ttl - 1 > 0) nextFrontier.push({ node: neighbour, ttl: entry.ttl - 1 });
        }
      }
      frontier = nextFrontier;
    }

    if (delivered === 0) {
      return this.drop(`broadcast from '${from}' reached no other node (isolated)`);
    }
    this.deliveredCount += delivered;
    return {
      delivered: true,
      path: Array.from(visited),
      hops: delivered,
      reason: `broadcast reached ${delivered} node(s)`,
    };
  }
}
