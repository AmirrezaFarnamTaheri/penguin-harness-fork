function generateId(prefix = ""): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    const uuid = globalThis.crypto.randomUUID();
    return prefix ? `${prefix}${uuid}` : uuid;
  }
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  return prefix ? `${prefix}${rand}` : rand;
}

export type LeaseState = "idle" | "acquired" | "expired";

export interface MailboxLease {
  agentName: string;
  inboundEventId: string;
  leaseToken: string;
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
  subscriberFailures: number;
  mustDeliverPublished: number;
  mustDeliverDropped: number;
}

export interface BrokerDeliveryError {
  eventId: string;
  type: string;
  critical: boolean;
  message: string;
  timestamp: number;
}

export function normalizeMailboxOwnerName(rawName: string): string {
  return (rawName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export class MailboxKernel {
  private readonly queues = new Map<string, MailboxMessage[]>();
  private readonly leases = new Map<string, MailboxLease>();
  private readonly deadLetters = new Map<string, Array<{ msg: MailboxMessage; reason: string }>>();
  private readonly lastActivity = new Map<string, number>();
  private readonly maxQueueDepth: number;
  private readonly maxPayloadSizeBytes: number;

  constructor(options?: { maxQueueDepth?: number; maxPayloadSizeBytes?: number }) {
    this.maxQueueDepth = options?.maxQueueDepth ?? 500;
    this.maxPayloadSizeBytes = options?.maxPayloadSizeBytes ?? 512 * 1024;
  }

  public send<T = unknown>(
    toAgent: string,
    fromAgent: string,
    eventType: string,
    payload: T,
    priority: "normal" | "high" = "normal",
  ): MailboxMessage<T> {
    const target = normalizeMailboxOwnerName(toAgent);
    const source = normalizeMailboxOwnerName(fromAgent);

    if (!target) throw new Error("Recipient agent name cannot be empty");

    if (payload !== undefined && payload !== null) {
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (payloadStr.length > this.maxPayloadSizeBytes) {
        throw new Error(
          `Message payload exceeds maximum allowed size of ${this.maxPayloadSizeBytes} bytes`,
        );
      }
    }

    const queue = this.queues.get(target) ?? [];
    if (queue.length >= this.maxQueueDepth) {
      throw new Error(
        `Mailbox for agent '${target}' has reached maximum queue capacity (${this.maxQueueDepth})`,
      );
    }

    const msg: MailboxMessage<T> = {
      id: generateId("msg-"),
      fromAgent: source,
      toAgent: target,
      eventType,
      payload,
      priority,
      createdAt: Date.now(),
      attempts: 0,
    };

    if (priority === "high") queue.unshift(msg as MailboxMessage);
    else queue.push(msg as MailboxMessage);
    this.queues.set(target, queue);
    this.lastActivity.set(target, Date.now());
    return msg;
  }

  public acquireLease(agentName: string, eventId: string, ttlMs = 30000): MailboxLease {
    const name = normalizeMailboxOwnerName(agentName);
    const existing = this.leases.get(name);
    const now = Date.now();

    if (existing && existing.leaseState === "acquired" && existing.expiresAt > now) {
      throw new Error(
        `Agent '${name}' lease is already held by '${existing.inboundEventId}' until ${new Date(existing.expiresAt).toISOString()}`,
      );
    }

    const lease: MailboxLease = {
      agentName: name,
      inboundEventId: eventId,
      leaseToken: generateId(),
      leaseState: "acquired",
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };

    this.leases.set(name, lease);
    this.lastActivity.set(name, now);
    return { ...lease };
  }

  public renewLease(agentName: string, leaseToken: string, ttlMs = 30000): MailboxLease {
    const name = normalizeMailboxOwnerName(agentName);
    const existing = this.leases.get(name);
    const now = Date.now();

    if (!existing || existing.leaseState !== "acquired" || existing.expiresAt <= now) {
      throw new Error(`Cannot renew inactive or expired lease for agent '${name}'`);
    }
    if (existing.leaseToken !== leaseToken) {
      throw new Error(`Cannot renew lease for agent '${name}': lease token mismatch`);
    }

    existing.expiresAt = now + ttlMs;
    this.lastActivity.set(name, now);
    return { ...existing };
  }

  public releaseLease(agentName: string, leaseToken: string): void {
    const name = normalizeMailboxOwnerName(agentName);
    const lease = this.leases.get(name);
    if (!lease) return;
    if (lease.leaseToken !== leaseToken) {
      throw new Error(`Cannot release lease for agent '${name}': lease token mismatch`);
    }
    lease.leaseState = "idle";
  }

  public requeue<T = unknown>(agentName: string, message: MailboxMessage<T>): void {
    const name = normalizeMailboxOwnerName(agentName);
    const queue = this.queues.get(name) ?? [];
    queue.unshift(message as MailboxMessage);
    this.queues.set(name, queue);
    this.lastActivity.set(name, Date.now());
  }

  public poll<T = unknown>(agentName: string): MailboxMessage<T> | null {
    const name = normalizeMailboxOwnerName(agentName);
    const queue = this.queues.get(name);
    if (!queue || queue.length === 0) return null;

    const msg = queue.shift() as MailboxMessage<T>;
    msg.attempts++;
    this.lastActivity.set(name, Date.now());
    return msg;
  }

  public pollAndLease<T = unknown>(
    agentName: string,
    ttlMs = 30000,
  ): { message: MailboxMessage<T>; lease: MailboxLease } | null {
    const name = normalizeMailboxOwnerName(agentName);
    const queue = this.queues.get(name);
    if (!queue || queue.length === 0) return null;

    const existing = this.leases.get(name);
    const now = Date.now();
    if (existing && existing.leaseState === "acquired" && existing.expiresAt > now) {
      // Lease currently held, do not pop or consume the message
      return null;
    }

    const msg = queue.shift() as MailboxMessage<T>;
    msg.attempts++;
    this.lastActivity.set(name, now);

    const lease: MailboxLease = {
      agentName: name,
      inboundEventId: msg.id,
      leaseToken: generateId(),
      leaseState: "acquired",
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };
    this.leases.set(name, lease);
    return { message: msg, lease };
  }

  public deadLetter(agentName: string, message: MailboxMessage, reason: string): void {
    const name = normalizeMailboxOwnerName(agentName);
    const list = this.deadLetters.get(name) ?? [];
    list.push({ msg: message, reason });
    this.deadLetters.set(name, list);
  }

  public getSummary(agentName: string): MailboxSummary {
    const name = normalizeMailboxOwnerName(agentName);
    const queue = this.queues.get(name) ?? [];
    const lease = this.leases.get(name) ?? null;
    const now = Date.now();

    if (lease && lease.leaseState === "acquired" && lease.expiresAt <= now)
      lease.leaseState = "expired";

    const pendingReplyCount = queue.filter(
      (message) => message.eventType === "reply" || message.eventType === "response",
    ).length;

    return {
      agentName: name,
      queueDepth: queue.length,
      pendingReplyCount,
      lease: lease ? { ...lease } : null,
      lastActivityAt: this.lastActivity.get(name) ?? null,
    };
  }

  public getDeadLetters(agentName: string): Array<{ msg: MailboxMessage; reason: string }> {
    const name = normalizeMailboxOwnerName(agentName);
    return this.deadLetters.get(name) ?? [];
  }
}

export type Subscriber<T = unknown> = (event: BrokerEvent<T>) => void | Promise<void>;

export class EventBroker {
  private readonly subscribers = new Map<string, Set<Subscriber<any>>>();
  private readonly maxBufferSize: number;
  private readonly pendingBuffers = new Map<Subscriber<any>, number>();
  private readonly deliveryTails = new Map<Subscriber<any>, Promise<void>>();
  private readonly deliveryErrors: BrokerDeliveryError[] = [];
  private readonly maxRecordedErrors = 100;

  public readonly metrics: BrokerMetrics = {
    publishedEvents: 0,
    droppedEvents: 0,
    subscriberFailures: 0,
    mustDeliverPublished: 0,
    mustDeliverDropped: 0,
  };

  constructor(maxBufferSize = 256) {
    this.maxBufferSize = maxBufferSize;
  }

  private subscriberStillRegistered(sub: Subscriber<any>): boolean {
    for (const set of this.subscribers.values()) {
      if (set.has(sub)) return true;
    }
    return false;
  }

  public subscribe<T = unknown>(type: string, sub: Subscriber<T>): () => void {
    const subscriber = sub as Subscriber<any>;
    const set = this.subscribers.get(type) ?? new Set();
    set.add(subscriber);
    this.subscribers.set(type, set);
    if (!this.pendingBuffers.has(subscriber)) this.pendingBuffers.set(subscriber, 0);
    if (!this.deliveryTails.has(subscriber)) this.deliveryTails.set(subscriber, Promise.resolve());

    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(type);
      if (!this.subscriberStillRegistered(subscriber)) {
        this.pendingBuffers.delete(subscriber);
        this.deliveryTails.delete(subscriber);
      }
    };
  }

  public getDeliveryErrors(): BrokerDeliveryError[] {
    return this.deliveryErrors.map((entry) => ({ ...entry }));
  }

  private recordFailure(event: BrokerEvent, critical: boolean, error: unknown): void {
    this.metrics.subscriberFailures++;
    this.deliveryErrors.push({
      eventId: event.id,
      type: event.type,
      critical,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    if (this.deliveryErrors.length > this.maxRecordedErrors) {
      this.deliveryErrors.splice(0, this.deliveryErrors.length - this.maxRecordedErrors);
    }
  }

  private enqueueDelivery(
    sub: Subscriber<any>,
    event: BrokerEvent,
    options: { critical: boolean; timeoutMs?: number },
  ): Promise<void> {
    const previous = this.deliveryTails.get(sub) ?? Promise.resolve();
    this.pendingBuffers.set(sub, (this.pendingBuffers.get(sub) ?? 0) + 1);

    const execute = previous
      .catch(() => undefined)
      .then(() => Promise.resolve().then(() => sub(event)));
    const orderedTail = execute
      .finally(() => {
        const depth = this.pendingBuffers.get(sub) ?? 1;
        this.pendingBuffers.set(sub, Math.max(0, depth - 1));
      })
      .then(() => undefined);

    // Ordering follows the actual callback lifetime, not the caller's observation deadline.
    this.deliveryTails.set(
      sub,
      orderedTail.catch(() => undefined),
    );

    if (options.timeoutMs === undefined) return orderedTail;

    const deadline = new Promise<void>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Event delivery timed out after ${options.timeoutMs}ms on ${event.type}`),
          ),
        options.timeoutMs,
      );
      timer.unref?.();
      void orderedTail.finally(() => clearTimeout(timer)).catch(() => undefined);
    });
    return Promise.race([orderedTail, deadline]);
  }

  public publish<T = unknown>(type: string, payload: T): void {
    const set = this.subscribers.get(type);
    if (!set || set.size === 0) return;

    const event: BrokerEvent<T> = {
      id: generateId("ev-"),
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

      this.metrics.publishedEvents++;
      void this.enqueueDelivery(sub, event, { critical: false }).catch((error) => {
        this.recordFailure(event, false, error);
      });
    }
  }

  public async publishMustDeliver<T = unknown>(
    type: string,
    payload: T,
    timeoutMs = 500,
  ): Promise<void> {
    const set = this.subscribers.get(type);
    if (!set || set.size === 0) return;

    const event: BrokerEvent<T> = {
      id: generateId("ev-must-"),
      type,
      payload,
      timestamp: Date.now(),
    };

    const deliveries = [...set].map(async (sub) => {
      try {
        await this.enqueueDelivery(sub, event, { critical: true, timeoutMs });
        this.metrics.mustDeliverPublished++;
      } catch (error) {
        this.metrics.mustDeliverDropped++;
        this.recordFailure(event, true, error);
        throw error;
      }
    });

    const results = await Promise.allSettled(deliveries);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const details = failures.map((failure) =>
        failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
      );
      throw new Error(
        `Critical event '${type}' failed for ${failures.length} subscriber(s): ${details.join("; ")}`,
      );
    }
  }
}
