import { describe, expect, it } from "vitest";
import { MailboxKernel, EventBroker, normalizeMailboxOwnerName } from "../src/agent/mailbox.js";

describe("MailboxKernel", () => {
  it("normalizes owner and agent names consistently", () => {
    expect(normalizeMailboxOwnerName(" Agent_Smith.42 ")).toBe("agent-smith-42");
    expect(normalizeMailboxOwnerName("---Alpha---")).toBe("alpha");
  });

  it("queues messages and respects priority ordering", () => {
    const mb = new MailboxKernel();
    mb.send("worker-1", "orchestrator", "task", { job: 1 });
    mb.send("worker-1", "orchestrator", "task", { job: 2 });
    mb.send("worker-1", "orchestrator", "urgent_interrupt", { job: 99 }, "high");

    expect(mb.poll<{ job: number }>("worker-1")?.payload.job).toBe(99);
    expect(mb.poll<{ job: number }>("worker-1")?.payload.job).toBe(1);
    expect(mb.poll<{ job: number }>("worker-1")?.payload.job).toBe(2);
    expect(mb.poll("worker-1")).toBeNull();
  });

  it("manages exclusive fenced leases and rejects stale owners", () => {
    const mb = new MailboxKernel();
    const lease = mb.acquireLease("agent-a", "evt-100", 10000);
    expect(lease.leaseState).toBe("acquired");
    expect(lease.inboundEventId).toBe("evt-100");
    expect(() => mb.acquireLease("agent-a", "evt-101", 10000)).toThrow(/already held/);

    mb.releaseLease("agent-a", lease.leaseToken);
    const lease2 = mb.acquireLease("agent-a", "evt-102", 5000);
    expect(lease2.inboundEventId).toBe("evt-102");
    expect(() => mb.releaseLease("agent-a", lease.leaseToken)).toThrow(/token mismatch/);
    expect(() => mb.renewLease("agent-a", lease.leaseToken)).toThrow(/token mismatch/);
    expect(mb.renewLease("agent-a", lease2.leaseToken).leaseState).toBe("acquired");
  });

  it("handles dead-lettering for unprocessable messages", () => {
    const mb = new MailboxKernel();
    const msg = mb.send("worker-2", "orchestrator", "bad_format", { broken: true });
    mb.deadLetter("worker-2", msg, "invalid schema");

    const deadLetters = mb.getDeadLetters("worker-2");
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0]!.reason).toBe("invalid schema");
    expect(deadLetters[0]!.msg.id).toBe(msg.id);
  });

  it("provides accurate mailbox summaries", () => {
    const mb = new MailboxKernel();
    mb.send("worker-3", "caller", "reply", { result: "ok" });
    mb.send("worker-3", "caller", "data", { v: 1 });

    const summary = mb.getSummary("worker-3");
    expect(summary.agentName).toBe("worker-3");
    expect(summary.queueDepth).toBe(2);
    expect(summary.pendingReplyCount).toBe(1);
  });

  it("enforces maximum queue capacity to prevent resource exhaustion", () => {
    const mb = new MailboxKernel({ maxQueueDepth: 3 });
    mb.send("worker-capped", "caller", "m1", {});
    mb.send("worker-capped", "caller", "m2", {});
    mb.send("worker-capped", "caller", "m3", {});

    expect(() => mb.send("worker-capped", "caller", "m4", {})).toThrow(/maximum queue capacity/);
  });

  it("enforces maximum payload size", () => {
    const mb = new MailboxKernel({ maxPayloadSizeBytes: 100 });
    const hugePayload = "x".repeat(200);

    expect(() => mb.send("worker-payload", "caller", "msg", hugePayload)).toThrow(
      /maximum allowed size/,
    );
  });

  it("atomically polls and acquires lease without dropping messages on conflict", () => {
    const mb = new MailboxKernel();
    mb.send("worker-atomic", "caller", "work", { job: 1 });

    // Acquire lease first
    const l1 = mb.acquireLease("worker-atomic", "other-event", 5000);
    expect(l1.leaseState).toBe("acquired");

    // pollAndLease should return null because lease is already held, message must NOT be dropped
    const conflict = mb.pollAndLease("worker-atomic", 5000);
    expect(conflict).toBeNull();

    // Release lease
    mb.releaseLease("worker-atomic", l1.leaseToken);

    // Now pollAndLease should succeed and return the intact message
    const success = mb.pollAndLease<{ job: number }>("worker-atomic", 5000);
    expect(success).not.toBeNull();
    expect(success?.message.payload.job).toBe(1);
    expect(success?.lease.leaseState).toBe("acquired");
  });

  it("supports requeueing messages safely", () => {
    const mb = new MailboxKernel();
    mb.send("worker-requeue", "caller", "work", { step: 1 });
    const msg = mb.poll<{ step: number }>("worker-requeue");
    expect(msg?.payload.step).toBe(1);

    // Requeue
    mb.requeue("worker-requeue", msg!);
    const polledAgain = mb.poll<{ step: number }>("worker-requeue");
    expect(polledAgain?.payload.step).toBe(1);
    expect(polledAgain?.attempts).toBe(2);
  });

  it("enforces maximum mailbox cardinality limit", () => {
    const mb = new MailboxKernel({ maxMailboxes: 2 });
    mb.send("agent-1", "caller", "event", {});
    mb.send("agent-2", "caller", "event", {});
    expect(() => mb.send("agent-3", "caller", "event", {})).toThrow(
      /Maximum mailbox cardinality limit reached/,
    );
  });

  it("enforces maximum queue capacity on requeue", () => {
    const mb = new MailboxKernel({ maxQueueDepth: 1 });
    mb.send("worker-capacity", "caller", "event", { n: 1 });
    const polled = mb.poll("worker-capacity")!;
    // Fill queue back to max capacity
    mb.send("worker-capacity", "caller", "event", { n: 2 });
    expect(() => mb.requeue("worker-capacity", polled)).toThrow(/reached maximum queue capacity/);
  });
});

describe("EventBroker", () => {
  it("delivers events to subscribers non-blockingly", async () => {
    const broker = new EventBroker();
    const received: string[] = [];
    const unsubscribe = broker.subscribe<string>("agent_status", (event) => {
      received.push(event.payload);
    });

    broker.publish("agent_status", "hello");
    broker.publish("agent_status", "world");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual(["hello", "world"]);
    expect(broker.metrics.publishedEvents).toBe(2);

    unsubscribe();
    broker.publish("agent_status", "after_unsub");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual(["hello", "world"]);
  });

  it("bounds critical delivery from enqueue time without violating subscriber ordering", async () => {
    const broker = new EventBroker();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;

    broker.subscribe("turn_complete", async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstBlocked;
      active--;
    });

    broker.publish("turn_complete", { turnId: "ordinary" });
    await expect(
      broker.publishMustDeliver("turn_complete", { turnId: "critical" }, 15),
    ).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("does not reset a callback queue when the callback subscribes to another event type", async () => {
    const broker = new EventBroker();
    const received: string[] = [];
    const callback = async (event: { payload: string }) => {
      received.push(event.payload);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    const unsubscribeA = broker.subscribe<string>("a", callback);
    broker.publish("a", "a1");
    const unsubscribeB = broker.subscribe<string>("b", callback);
    broker.publish("b", "b1");
    unsubscribeA();
    broker.publish("b", "b2");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toEqual(["a1", "b1", "b2"]);
    unsubscribeB();
  });
});
