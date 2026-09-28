import { describe, it, expect, vi } from "vitest";
import { AgentIdleSignal } from "../../../src/agent/resource/idle-signal.js";
import {
  IdleResourceRegistry,
  OwnedProcessGuard,
  type ReleasableResource,
} from "../../../src/agent/resource/idle-release.js";

/**
 * A releasable plus counters for what the registry actually did to it. Counters are read
 * through functions because the registry calls `release` long after the object is built.
 */
function recorder(overrides: Partial<ReleasableResource> = {}) {
  const counts = { releases: 0, restores: 0 };
  const resource: ReleasableResource = {
    id: "res-1",
    kind: "custom",
    reconstructable: true,
    terminatesOwnedProcess: false,
    describe: () => "test resource",
    isIdle: () => true,
    release: async () => {
      counts.releases++;
      return { released: true };
    },
    restore: async () => {
      counts.restores++;
    },
    ...overrides,
  };
  return {
    resource,
    releases: (): number => counts.releases,
    restores: (): number => counts.restores,
  };
}

/** A registry whose clock and idle signal are both driven by the test. */
function harness(
  options: {
    minIdleMs?: number;
    cooldownMs?: number;
    maxReleasesPerSweep?: number;
    maxRegistrations?: number;
    historyLimit?: number;
  } = {},
) {
  let t = 0;
  const idle = new AgentIdleSignal({ now: () => t });
  const registry = new IdleResourceRegistry({
    idle,
    now: () => t,
    minIdleMs: options.minIdleMs ?? 1000,
    cooldownMs: options.cooldownMs ?? 10_000,
    maxReleasesPerSweep: options.maxReleasesPerSweep,
    maxRegistrations: options.maxRegistrations,
    historyLimit: options.historyLimit,
  });
  return {
    registry,
    idle,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

describe("IdleResourceRegistry — idle is required, and it is the agent's word", () => {
  it("releases nothing while the agent is active, without examining anything", async () => {
    const h = harness();
    const rec = recorder();
    h.registry.register(rec.resource);
    // The resource itself says it is idle. The agent has not said so, and the agent wins.
    h.advance(999);
    const result = await h.registry.sweep();
    expect(result.agentActive).toBe(true);
    expect(result.releasedCount).toBe(0);
    expect(result.outcomes).toHaveLength(0);
    expect(rec.releases()).toBe(0);
  });

  it("does not fire under load, however long the run", async () => {
    // The property the whole design rests on: an agent working continuously is never idle,
    // so a sweep loop ticking every second for an hour releases nothing.
    const h = harness({ minIdleMs: 5000 });
    const rec = recorder();
    h.registry.register(rec.resource);

    for (let second = 0; second < 3600; second++) {
      h.advance(1000);
      h.idle.noteActivity();
      await h.registry.sweep();
    }
    expect(rec.releases()).toBe(0);
  });

  it("releases once the agent has declared itself idle", async () => {
    const h = harness();
    const rec = recorder();
    h.registry.register(rec.resource);
    h.advance(1000);
    const result = await h.registry.sweep();
    expect(result.agentActive).toBe(false);
    expect(result.releasedCount).toBe(1);
    expect(rec.releases()).toBe(1);
  });

  it("a resource that is busy is held even when the agent is idle", async () => {
    // The two signals are independent, and a busy resource overrides an idle agent: a
    // browser with a form half-filled looks exactly as idle as one nobody will touch.
    const h = harness();
    const rec = recorder({ isIdle: () => false });
    h.registry.register(rec.resource);
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(rec.releases()).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-busy");
  });

  it("a resource whose isIdle throws is held, not released", async () => {
    // Failing open here is the one direction that loses work.
    const h = harness();
    const rec = recorder({
      isIdle: () => {
        throw new Error("probe unavailable");
      },
    });
    h.registry.register(rec.resource);
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(rec.releases()).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-busy");
  });

  it("a resource that declines at the last moment is not counted as released", async () => {
    const h = harness();
    const rec = recorder({
      release: async () => ({ released: false, detail: "closed mid-flight" }),
    });
    h.registry.register(rec.resource);
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(result.releasedCount).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-busy");
    expect(result.outcomes[0]?.detail).toBe("closed mid-flight");
  });

  it("a resource whose release throws does not abort the sweep", async () => {
    const h = harness();
    const bad = recorder({
      id: "bad",
      release: async () => {
        throw new Error("transport wedged");
      },
    });
    const good = recorder({ id: "good" });
    h.registry.register(bad.resource);
    h.registry.register(good.resource);
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(result.releasedCount).toBe(1);
    expect(good.releases()).toBe(1);
  });
});

describe("IdleResourceRegistry — only reconstructable things are let go", () => {
  it("refuses a resource that cannot be rebuilt, however idle it is", async () => {
    const h = harness();
    const rec = recorder({ reconstructable: false });
    h.registry.register(rec.resource);
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(rec.releases()).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-not-reconstructable");
  });

  it("never terminates a process it has no ownership proof for", async () => {
    const h = harness();
    const rec = recorder({ terminatesOwnedProcess: true });
    h.registry.register(rec.resource); // no guard
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(rec.releases()).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-unowned-process");
  });

  it("terminates a process once a guard vouches for it", async () => {
    const h = harness();
    const rec = recorder({ terminatesOwnedProcess: true, ownedProcessIds: () => [4321] });
    h.registry.register(rec.resource, new OwnedProcessGuard([4321]));
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(rec.releases()).toBe(1);
  });

  it("rejects an ownership guard that does not own the resource's declared pid", async () => {
    const h = harness();
    const rec = recorder({ terminatesOwnedProcess: true, ownedProcessIds: () => [9999] });
    h.registry.register(rec.resource, new OwnedProcessGuard([4321]));
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(rec.releases()).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-unowned-process");
  });
});

describe("OwnedProcessGuard", () => {
  it("owns exactly the pids it was given", () => {
    const guard = new OwnedProcessGuard([10, 20]);
    expect(guard.owns(10)).toBe(true);
    expect(guard.owns(9999)).toBe(false);
    expect(guard.size).toBe(2);
  });

  it("an empty guard owns nothing, so nothing can be released through it", () => {
    const guard = new OwnedProcessGuard();
    expect(guard.owns(10)).toBe(false);
    expect(guard.size).toBe(0);
  });
});

describe("IdleResourceRegistry — release is reversible", () => {
  it("rebuilds a released resource on request", async () => {
    const h = harness();
    const rec = recorder();
    h.registry.register(rec.resource);
    h.advance(10_000);
    await h.registry.sweep();
    expect(rec.restores()).toBe(0);

    expect(await h.registry.restore("res-1")).toBe(true);
    expect(rec.restores()).toBe(1);
  });

  it("does not restore automatically — that would re-acquire what was just released", async () => {
    // Two sweeps inside the cooldown: the second is held, and more to the point neither
    // sweep rebuilt anything. Restoring is the caller's decision, made when the resource is
    // actually needed.
    const h = harness({ cooldownMs: 10_000 });
    const rec = recorder();
    h.registry.register(rec.resource);
    h.advance(10_000);
    await h.registry.sweep();
    h.advance(1000);
    await h.registry.sweep();
    expect(rec.releases()).toBe(1);
    expect(rec.restores()).toBe(0);
  });

  it("does not overlap two concurrent sweeps for one resource", async () => {
    const h = harness();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const rec = recorder({
      release: async () => {
        calls += 1;
        started();
        await gate;
        return { released: true };
      },
    });
    h.registry.register(rec.resource);
    h.advance(10_000);

    const first = h.registry.sweep();
    await entered;
    const second = await h.registry.sweep();
    release();
    await first;
    expect(calls).toBe(1);
    expect(second.outcomes[0]?.outcome).toBe("skipped-busy");
  });

  it("restoreAll rebuilds every registered resource for an explicit wake", async () => {
    const h = harness();
    const a = recorder({ id: "a" });
    const b = recorder({ id: "b" });
    h.registry.register(a.resource);
    h.registry.register(b.resource);
    expect(await h.registry.restoreAll()).toBe(2);
    expect(a.restores()).toBe(1);
    expect(b.restores()).toBe(1);
  });

  it("reports a failed restore instead of throwing", async () => {
    const h = harness();
    const rec = recorder({
      restore: async () => {
        throw new Error("server would not come back");
      },
    });
    h.registry.register(rec.resource);
    expect(await h.registry.restore("res-1")).toBe(false);
    expect(h.registry.history().some((o) => o.outcome === "restore-failed")).toBe(true);
  });

  it("restoring an unknown id is false, not a crash", async () => {
    const h = harness();
    expect(await h.registry.restore("nope")).toBe(false);
  });
});

describe("IdleResourceRegistry — bounds", () => {
  it("caps live registrations and refuses rather than growing", () => {
    const h = harness({ maxRegistrations: 2 });
    expect(h.registry.register(recorder({ id: "a" }).resource)).toBe(true);
    expect(h.registry.register(recorder({ id: "b" }).resource)).toBe(true);
    expect(h.registry.register(recorder({ id: "c" }).resource)).toBe(false);
    expect(h.registry.size).toBe(2);
    expect(h.registry.has("c")).toBe(false);
  });

  it("rejects a duplicate id", () => {
    const h = harness();
    expect(h.registry.register(recorder({ id: "dup" }).resource)).toBe(true);
    expect(h.registry.register(recorder({ id: "dup" }).resource)).toBe(false);
    expect(h.registry.size).toBe(1);
  });

  it("caps releases per sweep so one sweep cannot take on unbounded work", async () => {
    const h = harness({ maxReleasesPerSweep: 2 });
    const recs = ["a", "b", "c", "d", "e"].map((id) => recorder({ id }));
    for (const r of recs) h.registry.register(r.resource);
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(result.releasedCount).toBe(2);
    expect(recs.filter((r) => r.releases() === 1)).toHaveLength(2);
    expect(result.outcomes.filter((o) => o.outcome === "skipped-capacity")).toHaveLength(3);
  });

  it("keeps history in a fixed-size ring", async () => {
    const h = harness({ historyLimit: 3 });
    h.registry.register(recorder({ id: "a" }).resource);
    for (let i = 0; i < 10; i++) {
      h.advance(10_000);
      await h.registry.sweep();
    }
    // Cooldown is 10s and each advance is 10s, so every sweep is a real attempt; the ring
    // still cannot exceed its cap.
    expect(h.registry.history().length).toBeLessThanOrEqual(3);
  });

  it("unregister removes the resource and its bookkeeping", () => {
    const h = harness();
    h.registry.register(recorder({ id: "a" }).resource, new OwnedProcessGuard([1]));
    expect(h.registry.unregister("a")).toBe(true);
    expect(h.registry.has("a")).toBe(false);
    expect(h.registry.unregister("a")).toBe(false);
  });

  it("does not carry an old release's cooldown onto a replacement with the same id", async () => {
    const h = harness();
    let started!: () => void;
    let finish!: (value: { released: boolean }) => void;
    const releaseStarted = new Promise<void>((resolve) => (started = resolve));
    const releasePending = new Promise<{ released: boolean }>((resolve) => (finish = resolve));
    const old = recorder({
      id: "shared-id",
      release: () => {
        started();
        return releasePending;
      },
    });
    h.registry.register(old.resource);
    h.advance(1_000);
    const oldSweep = h.registry.sweep();
    await releaseStarted;

    expect(h.registry.unregister("shared-id")).toBe(true);
    const replacement = recorder({ id: "shared-id" });
    expect(h.registry.register(replacement.resource)).toBe(true);
    finish({ released: true });
    await oldSweep;

    const newSweep = await h.registry.sweep();
    expect(newSweep.releasedCount).toBe(1);
    expect(replacement.releases()).toBe(1);
  });
});

describe("IdleResourceRegistry — cooldown", () => {
  it("does not let a resource thrash between released and rebuilt", async () => {
    const h = harness({ cooldownMs: 60_000 });
    const rec = recorder();
    h.registry.register(rec.resource);

    h.advance(10_000);
    await h.registry.sweep();
    expect(rec.releases()).toBe(1);

    h.advance(10_000);
    const second = await h.registry.sweep();
    expect(rec.releases()).toBe(1);
    expect(second.outcomes[0]?.outcome).toBe("skipped-cooldown");

    h.advance(60_000);
    await h.registry.sweep();
    expect(rec.releases()).toBe(2);
  });
});

describe("IdleResourceRegistry — evaluate explains itself", () => {
  it("gives the real reason a resource would not be released right now", () => {
    const h = harness();
    const busy = recorder({ id: "busy", isIdle: () => false });
    const destructive = recorder({ id: "destructive", reconstructable: false });
    const unowned = recorder({ id: "unowned", terminatesOwnedProcess: true });
    h.registry.register(busy.resource);
    h.registry.register(destructive.resource);
    h.registry.register(unowned.resource);

    // Agent still active: every resource is held for the same reason, whatever its own view.
    expect(h.registry.evaluate(busy.resource)).toBe("skipped-agent-active");
    expect(h.registry.evaluate(destructive.resource)).toBe("skipped-agent-active");

    h.advance(10_000);
    expect(h.registry.evaluate(busy.resource)).toBe("skipped-busy");
    expect(h.registry.evaluate(destructive.resource)).toBe("skipped-not-reconstructable");
    expect(h.registry.evaluate(unowned.resource)).toBe("skipped-unowned-process");
  });

  it("describes every registered resource without releasing anything", () => {
    const h = harness();
    h.registry.register(recorder({ id: "a", kind: "mcp-connection" }).resource);
    h.registry.register(recorder({ id: "b", kind: "file-index" }).resource);
    const described = h.registry.describeAll();
    expect(described).toHaveLength(2);
    expect(described[0]?.id).toBe("a");
    expect(described[1]?.kind).toBe("file-index");
  });
});

describe("IdleResourceRegistry — no timer of its own", () => {
  it("schedules nothing; a sweep is the caller's decision", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const h = harness();
    h.registry.register(recorder().resource);
    h.advance(10_000);
    await h.registry.sweep();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
