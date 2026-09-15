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
