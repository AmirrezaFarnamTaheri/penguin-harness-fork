import { describe, expect, it } from "vitest";
import {
  MailboxKernel,
  EventBroker,
  normalizeMailboxOwnerName,
} from "../src/agent/mailbox.js";

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

    const first = mb.poll<{ job: number }>("worker-1");
    expect(first?.payload.job).toBe(99); // High priority popped first

    const second = mb.poll<{ job: number }>("worker-1");
    expect(second?.payload.job).toBe(1);

    const third = mb.poll<{ job: number }>("worker-1");
    expect(third?.payload.job).toBe(2);

    expect(mb.poll("worker-1")).toBeNull();
  });

  it("manages exclusive leases and rejects overlapping leases", () => {
    const mb = new MailboxKernel();
    const lease = mb.acquireLease("agent-a", "evt-100", 10000);
    expect(lease.leaseState).toBe("acquired");
    expect(lease.inboundEventId).toBe("evt-100");

    // Second lease attempt should throw
    expect(() => mb.acquireLease("agent-a", "evt-101", 10000)).toThrow(/already held/);

    // Release lease allows new acquisition
    mb.releaseLease("agent-a");
    const lease2 = mb.acquireLease("agent-a", "evt-102", 5000);
    expect(lease2.inboundEventId).toBe("evt-102");
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
});

describe("EventBroker", () => {
  it("delivers events to subscribers non-blockingly", async () => {
    const broker = new EventBroker();
    const received: string[] = [];

    const unsubscribe = broker.subscribe<string>("agent_status", (ev) => {
      received.push(ev.payload);
    });

    broker.publish("agent_status", "hello");
    broker.publish("agent_status", "world");

    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(["hello", "world"]);
    expect(broker.metrics.publishedEvents).toBe(2);

    unsubscribe();
    broker.publish("agent_status", "after_unsub");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(["hello", "world"]);
  });

  it("supports publishMustDeliver with bounded timeout", async () => {
    const broker = new EventBroker();
    let delivered = false;

    broker.subscribe("turn_complete", () => {
      delivered = true;
    });

    await broker.publishMustDeliver("turn_complete", { turnId: "123" }, 200);
    expect(delivered).toBe(true);
    expect(broker.metrics.mustDeliverPublished).toBe(1);
  });
});
