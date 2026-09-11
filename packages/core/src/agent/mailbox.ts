import { randomUUID } from "node:crypto";

export type LeaseState = "idle" | "acquired" | "expired";

export interface MailboxLease {
  agentName: string;
  inboundEventId: string;
  leaseState: LeaseState;
  acquiredAt: number;
  expiresAt: number;
}

export interface MailboxMessage<T = unknown> {
  id: string;
  fromAgent: string;
  toAgent: string;
  eventType: string;
  payload: T;
  priority: "normal" | "high";
  createdAt: number;
  attempts: number;
}

export interface MailboxSummary {
  agentName: string;
  queueDepth: number;
  pendingReplyCount: number;
  lease: MailboxLease | null;
  lastActivityAt: number | null;
}

export interface BrokerEvent<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: number;
}

export interface BrokerMetrics {
  publishedEvents: number;
  droppedEvents: number;
  mustDeliverPublished: number;
  mustDeliverDropped: number;
}

export function normalizeMailboxOwnerName(rawName: string): string {
  return (rawName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * MailboxKernel manages message delivery, recipient queues, and leases across multi-agent setups.
 */
export class MailboxKernel {
  private readonly queues = new Map<string, MailboxMessage[]>();
  private readonly leases = new Map<string, MailboxLease>();
  private readonly deadLetters = new Map<string, Array<{ msg: MailboxMessage; reason: string }>>();
  private readonly lastActivity = new Map<string, number>();

  /**
   * Post a message into a recipient agent's mailbox.
   */
  public send<T = unknown>(
    toAgent: string,
    fromAgent: string,
    eventType: string,
    payload: T,
    priority: "normal" | "high" = "normal"
  ): MailboxMessage<T> {
    const target = normalizeMailboxOwnerName(toAgent);
    const source = normalizeMailboxOwnerName(fromAgent);

    if (!target) {
      throw new Error("Recipient agent name cannot be empty");
    }

    const msg: MailboxMessage<T> = {
      id: `msg-${randomUUID().slice(0, 12)}`,
      fromAgent: source,
      toAgent: target,
      eventType,
      payload,
      priority,
      createdAt: Date.now(),
      attempts: 0,
    };

    const queue = this.queues.get(target) ?? [];
    if (priority === "high") {
      queue.unshift(msg as MailboxMessage);
    } else {
      queue.push(msg as MailboxMessage);
    }
    this.queues.set(target, queue);
    this.lastActivity.set(target, Date.now());

    return msg;
  }

  /**
   * Acquire an exclusive processing lease on an agent's mailbox.
   */
  public acquireLease(agentName: string, eventId: string, ttlMs = 30000): MailboxLease {
    const name = normalizeMailboxOwnerName(agentName);
    const existing = this.leases.get(name);
    const now = Date.now();

    if (existing && existing.leaseState === "acquired" && existing.expiresAt > now) {
      throw new Error(
        `Agent '${name}' lease is already held by '${existing.inboundEventId}' until ${new Date(
          existing.expiresAt
        ).toISOString()}`
      );
    }

    const lease: MailboxLease = {
      agentName: name,
      inboundEventId: eventId,
      leaseState: "acquired",
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };

    this.leases.set(name, lease);
    this.lastActivity.set(name, now);
    return lease;
  }

  /**
   * Renew an active lease.
   */
  public renewLease(agentName: string, ttlMs = 30000): MailboxLease {
    const name = normalizeMailboxOwnerName(agentName);
    const existing = this.leases.get(name);
    const now = Date.now();

    if (!existing || existing.leaseState !== "acquired" || existing.expiresAt <= now) {
      throw new Error(`Cannot renew inactive or expired lease for agent '${name}'`);
    }

    existing.expiresAt = now + ttlMs;
    this.lastActivity.set(name, now);
    return existing;
  }

  /**
   * Release an acquired lease.
   */
  public releaseLease(agentName: string): void {
    const name = normalizeMailboxOwnerName(agentName);
    const lease = this.leases.get(name);
    if (lease) {
      lease.leaseState = "idle";
    }
  }

  /**
   * Poll next available message from the agent's queue.
   */
  public poll<T = unknown>(agentName: string): MailboxMessage<T> | null {
    const name = normalizeMailboxOwnerName(agentName);
    const queue = this.queues.get(name);
    if (!queue || queue.length === 0) {
      return null;
    }

    const msg = queue.shift() as MailboxMessage<T>;
    msg.attempts++;
    this.lastActivity.set(name, Date.now());
    return msg;
  }

  /**
   * Move an unprocessable message to the dead letter queue.
   */
  public deadLetter(agentName: string, message: MailboxMessage, reason: string): void {
    const name = normalizeMailboxOwnerName(agentName);
    const list = this.deadLetters.get(name) ?? [];
    list.push({ msg: message, reason });
    this.deadLetters.set(name, list);
  }

  /**
   * Get queue summary for an agent.
   */
  public getSummary(agentName: string): MailboxSummary {
    const name = normalizeMailboxOwnerName(agentName);
    const queue = this.queues.get(name) ?? [];
    const lease = this.leases.get(name) ?? null;
    const now = Date.now();

    // Check if lease expired
    if (lease && lease.leaseState === "acquired" && lease.expiresAt <= now) {
      lease.leaseState = "expired";
    }

    const pendingReplyCount = queue.filter(
      (m) => m.eventType === "reply" || m.eventType === "response"
    ).length;

    return {
      agentName: name,
      queueDepth: queue.length,
      pendingReplyCount,
      lease,
      lastActivityAt: this.lastActivity.get(name) ?? null,
    };
  }

  public getDeadLetters(agentName: string): Array<{ msg: MailboxMessage; reason: string }> {
    const name = normalizeMailboxOwnerName(agentName);
    return this.deadLetters.get(name) ?? [];
  }
}

export type Subscriber<T = unknown> = (event: BrokerEvent<T>) => void | Promise<void>;

/**
 * EventBroker provides fan-out event delivery with dual delivery semantics:
 * - publish: Non-blocking, lossy under buffer saturation for high-frequency stream updates.
 * - publishMustDeliver: Bounded-blocking with timeout for terminal events.
 */
export class EventBroker {
  private readonly subscribers = new Map<string, Set<Subscriber<any>>>();
  private readonly maxBufferSize: number;
  private readonly pendingBuffers = new Map<Subscriber<any>, number>();

  public readonly metrics: BrokerMetrics = {
    publishedEvents: 0,
    droppedEvents: 0,
    mustDeliverPublished: 0,
    mustDeliverDropped: 0,
  };

  constructor(maxBufferSize = 256) {
    this.maxBufferSize = maxBufferSize;
  }

  public subscribe<T = unknown>(type: string, sub: Subscriber<T>): () => void {
    const set = this.subscribers.get(type) ?? new Set();
    set.add(sub as Subscriber<any>);
    this.subscribers.set(type, set);
    this.pendingBuffers.set(sub as Subscriber<any>, 0);

    return () => {
      set.delete(sub as Subscriber<any>);
      if (set.size === 0) {
        this.subscribers.delete(type);
      }
      this.pendingBuffers.delete(sub as Subscriber<any>);
    };
  }

  /**
   * Non-blocking, lossy publish under buffer pressure.
   */
  public publish<T = unknown>(type: string, payload: T): void {
    const set = this.subscribers.get(type);
    if (!set || set.size === 0) {
      return;
    }

    const event: BrokerEvent<T> = {
      id: `ev-${randomUUID().slice(0, 8)}`,
      type,
      payload,
      timestamp: Date.now(),
    };

    for (const sub of set) {
      const current = this.pendingBuffers.get(sub) ?? 0;
      if (current >= this.maxBufferSize) {
        this.metrics.droppedEvents++;
        continue;
      }

      this.pendingBuffers.set(sub, current + 1);
      this.metrics.publishedEvents++;

      queueMicrotask(async () => {
        try {
          await sub(event);
        } finally {
          const depth = this.pendingBuffers.get(sub) ?? 1;
          this.pendingBuffers.set(sub, Math.max(0, depth - 1));
        }
      });
    }
  }

  /**
   * Bounded-blocking publish for terminal/critical events that must deliver.
   */
  public async publishMustDeliver<T = unknown>(
    type: string,
    payload: T,
    timeoutMs = 500
  ): Promise<void> {
    const set = this.subscribers.get(type);
    if (!set || set.size === 0) {
      return;
    }

    const event: BrokerEvent<T> = {
      id: `ev-must-${randomUUID().slice(0, 8)}`,
      type,
      payload,
      timestamp: Date.now(),
    };

    const deliveryPromises: Promise<void>[] = [];

    for (const sub of set) {
      const deliverPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.metrics.mustDeliverDropped++;
          reject(new Error(`PublishMustDeliver timed out after ${timeoutMs}ms on event ${type}`));
        }, timeoutMs);

        Promise.resolve(sub(event))
          .then(() => {
            clearTimeout(timer);
            this.metrics.mustDeliverPublished++;
            resolve();
          })
          .catch((err) => {
            clearTimeout(timer);
            this.metrics.mustDeliverDropped++;
            reject(err);
          });
      });

      deliveryPromises.push(deliverPromise);
    }

    await Promise.allSettled(deliveryPromises);
  }
}
