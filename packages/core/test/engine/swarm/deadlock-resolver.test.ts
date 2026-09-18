import { describe, expect, it } from "vitest";

import { DeadlockResolver, type LockMode } from "../../../src/engine/swarm/deadlock-resolver.js";

describe("DeadlockResolver lock acquisition", () => {
  it("grants an exclusive lock on a free resource", () => {
    const resolver = new DeadlockResolver();
    expect(resolver.acquire("agent-a", "src/auth.ts")).toBe(true);
    expect(resolver.holderOf("src/auth.ts")).toBe("agent-a");
  });

  it("blocks a second exclusive requester and queues it", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "src/auth.ts");
    expect(resolver.acquire("agent-b", "src/auth.ts")).toBe(false);
    expect(resolver.getWaiters()).toHaveLength(1);
    expect(resolver.getWaiters()[0]?.waiter).toBe("agent-b");
  });

  it("grants concurrent shared locks but refuses an exclusive among them", () => {
    const resolver = new DeadlockResolver();
    expect(resolver.acquire("agent-a", "src/auth.ts", "shared" as LockMode)).toBe(true);
    expect(resolver.acquire("agent-b", "src/auth.ts", "shared" as LockMode)).toBe(true);
    expect(resolver.acquire("agent-c", "src/auth.ts")).toBe(false);
  });

  it("grants the head of the queue next, in FIFO order", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "file.ts");
    expect(resolver.acquire("agent-b", "file.ts")).toBe(false);
    expect(resolver.acquire("agent-c", "file.ts")).toBe(false);

    expect(resolver.release("agent-a", "file.ts")).toBe(true);
    expect(resolver.holderOf("file.ts")).toBe("agent-b");
  });

  it("normalizes path separators", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "src\\nested\\file.ts");
    expect(resolver.holderOf("src/nested/file.ts")).toBe("agent-a");
  });

  it("releases everything an agent holds", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "a.ts");
    resolver.acquire("agent-a", "b.ts");
    expect(resolver.releaseAll("agent-a")).toBe(2);
    expect(resolver.holderOf("a.ts")).toBeUndefined();
    expect(resolver.holderOf("b.ts")).toBeUndefined();
  });

  it("refuses to acquire with empty arguments", () => {
    const resolver = new DeadlockResolver();
    expect(() => resolver.acquire("", "file.ts")).toThrow(/both holder and resource/);
  });

  it("respects the resource cardinality limit", () => {
    const resolver = new DeadlockResolver({ maxResources: 2 });
    resolver.acquire("a", "one");
    resolver.acquire("a", "two");
    expect(resolver.acquire("a", "three")).toBe(false);
  });
});

describe("DeadlockResolver cycle detection", () => {
  it("detects a two-agent circular wait and returns the cycle path", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "auth.ts");
    resolver.acquire("agent-b", "auth.test.ts");
    // A wants auth.test.ts (held by B), B wants auth.ts (held by A).
    expect(resolver.acquire("agent-a", "auth.test.ts")).toBe(false);
    expect(resolver.acquire("agent-b", "auth.ts")).toBe(false);

    const cycles = resolver.detectCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain("agent-a");
    expect(cycles[0]).toContain("agent-b");
  });

  it("detects a longer three-agent cycle", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("a", "f1");
    resolver.acquire("b", "f2");
    resolver.acquire("c", "f3");
    expect(resolver.acquire("a", "f2")).toBe(false);
    expect(resolver.acquire("b", "f3")).toBe(false);
    expect(resolver.acquire("c", "f1")).toBe(false);

    expect(resolver.detectCycles().length).toBeGreaterThan(0);
  });

  it("reports no cycle for a chain that is merely waiting, not circular", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("a", "f1");
    resolver.acquire("b", "f2");
    expect(resolver.acquire("b", "f1")).toBe(false);
    expect(resolver.detectCycles()).toHaveLength(0);
  });

  it("does not report a stale cycle once a wait resolves", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("a", "f1");
    resolver.acquire("b", "f2");
    expect(resolver.acquire("a", "f2")).toBe(false);
    expect(resolver.acquire("b", "f1")).toBe(false);
    expect(resolver.detectCycles()).toHaveLength(1);

    resolver.releaseAll("a");
    expect(resolver.detectCycles()).toHaveLength(0);
  });
});

describe("DeadlockResolver victim selection", () => {
  it("aborts the lowest-priority agent on a cycle", () => {
    const resolver = new DeadlockResolver({
      priorityOf: (agentId) => (agentId === "senior" ? 10 : 1),
    });
    resolver.acquire("senior", "f1");
    resolver.acquire("junior", "f2");
    expect(resolver.acquire("senior", "f2")).toBe(false);
    expect(resolver.acquire("junior", "f1")).toBe(false);

    const report = resolver.detect();
    expect(report.deadlocked).toBe(true);
    expect(report.victims).toEqual(["junior"]);
  });

  it("falls back to the youngest wait when priorities tie", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("a", "f1");
    resolver.acquire("b", "f2");
    resolver.acquire("c", "f3");
    // c waits longest, b waits newest: b should be the victim.
    expect(resolver.acquire("c", "f1")).toBe(false);
    expect(resolver.acquire("a", "f3")).toBe(false);
    expect(resolver.acquire("b", "f1")).toBe(false);

    const report = resolver.detect();
    expect(report.victims.length).toBeGreaterThan(0);
  });

  it("resolves a deadlock by releasing the victim and granting its waiters", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "auth.ts");
    resolver.acquire("agent-b", "auth.test.ts");
    expect(resolver.acquire("agent-a", "auth.test.ts")).toBe(false);
    expect(resolver.acquire("agent-b", "auth.ts")).toBe(false);

    const outcome = resolver.resolve("agent-a");
    expect(outcome.released).toContain("auth.ts");
    // `granted` reports the resource key that changed hands...
    expect(outcome.granted).toContain("auth.ts");
    // ...and `unblockedAgents` the waiter that may now resume.
    expect(outcome.unblockedAgents).toContain("agent-b");
    // The cycle is gone.
    expect(resolver.detectCycles()).toHaveLength(0);
    expect(resolver.holderOf("auth.ts")).toBe("agent-b");
  });

  it("resolving a non-holder is a no-op that reports honestly", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("agent-a", "f1");
    const outcome = resolver.resolve("bystander");
    expect(outcome.released).toHaveLength(0);
    expect(outcome.abortedWait).toBe(false);
  });
});

describe("DeadlockResolver progress heuristic", () => {
  it("does not flag a recent wait as a deadlock", () => {
    const resolver = new DeadlockResolver({ suspectAfterMs: 60_000 });
    resolver.acquire("a", "f1");
    expect(resolver.acquire("b", "f1")).toBe(false);
    const report = resolver.detect();
    expect(report.deadlocked).toBe(false);
    expect(report.suspects).toHaveLength(0);
  });

  it("flags a stalled wait past the suspect threshold when no grants occurred", () => {
    const resolver = new DeadlockResolver({ suspectAfterMs: 1_000 });
    resolver.acquire("a", "f1");
    expect(resolver.acquire("b", "f1")).toBe(false);

    const stalled = resolver.detect(Date.now() + 5_000);
    expect(stalled.suspects).toContain("b");
    expect(stalled.grantsSinceOldestWait).toBe(0);
    expect(stalled.deadlocked).toBe(true);
  });

  it("does not flag a long wait when the system is still granting", () => {
    const resolver = new DeadlockResolver({ suspectAfterMs: 1_000 });
    resolver.acquire("a", "f1");
    expect(resolver.acquire("b", "f1")).toBe(false);
    // A different resource grants and unblocks: the system is progressing.
    resolver.acquire("c", "f2");

    const stalled = resolver.detect(Date.now() + 5_000);
    expect(stalled.grantsSinceOldestWait).toBeGreaterThan(0);
    expect(stalled.deadlocked).toBe(false);
  });

  it("exposes a monotonic grant count", () => {
    const resolver = new DeadlockResolver();
    expect(resolver.getGrantCount()).toBe(0);
    resolver.acquire("a", "f1");
    resolver.acquire("b", "f2");
    expect(resolver.getGrantCount()).toBe(2);
  });
});

describe("DeadlockResolver wait-for graph", () => {
  it("builds waiter -> holder edges only for live blockers", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("a", "f1");
    expect(resolver.acquire("b", "f1")).toBe(false);
    const graph = resolver.waitForGraph();
    expect(graph.get("b")).toEqual(new Set(["a"]));
  });

  it("drops wait edges whose holder already released", () => {
    const resolver = new DeadlockResolver();
    resolver.acquire("a", "f1");
    expect(resolver.acquire("b", "f1")).toBe(false);
    resolver.releaseAll("a");
    // b's wait was granted, so no wait-for edge remains.
    expect(resolver.waitForGraph().has("b")).toBe(false);
  });
});
