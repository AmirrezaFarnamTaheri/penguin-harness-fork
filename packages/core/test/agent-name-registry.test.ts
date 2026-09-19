import { describe, expect, it } from "vitest";
import { GREAT_NAME_POOL } from "../src/agent/agent-name-pool.js";
import { AgentNameRegistry } from "../src/agent/agent-name-registry.js";

describe("AgentNameRegistry", () => {
  it("assigns each decorative name once before beginning another round", () => {
    const registry = new AgentNameRegistry();
    const firstRound = GREAT_NAME_POOL.map((_, index) => registry.assign(`agent-${index}`));
    expect(new Set(firstRound)).toEqual(new Set(GREAT_NAME_POOL));
    const secondRound = GREAT_NAME_POOL.map((_, index) =>
      registry.assign(`agent-${index + GREAT_NAME_POOL.length}`),
    );
    expect(secondRound).toEqual(firstRound.map((name) => `${name} 2`));
    expect(new Set([...firstRound, ...secondRound]).size).toBe(GREAT_NAME_POOL.length * 2);
  });

  it("retains an owner's name without consuming another assignment", () => {
    const registry = new AgentNameRegistry();
    expect(registry.nameOf("reviewer")).toBeNull();
    const name = registry.assign("reviewer");
    expect(registry.assign("reviewer")).toBe(name);
    expect(registry.nameOf("reviewer")).toBe(name);
    const remaining = Array.from({ length: GREAT_NAME_POOL.length - 1 }, (_, index) =>
      registry.assign(`other-${index}`),
    );
    expect(new Set([name, ...remaining])).toEqual(new Set(GREAT_NAME_POOL));
  });

  it("releases a reservation so the owner no longer holds the name", () => {
    const registry = new AgentNameRegistry();
    const name = registry.assign("short-lived");
    registry.recordSuccess("short-lived", "code-review");
    expect(registry.nameOf("short-lived")).toBe(name);
    expect(registry.affinityDomains("short-lived")).toEqual(["code-review"]);

    expect(registry.release("short-lived")).toBe(true);
    expect(registry.nameOf("short-lived")).toBeNull();
    // The affinity record is freed alongside the reservation.
    expect(registry.affinityDomains("short-lived")).toEqual([]);
    expect(registry.getAffinity("short-lived", "code-review")).toBe(0);

    // Releasing an unknown owner is a no-op, and a revived owner gets a fresh name.
    expect(registry.release("ghost")).toBe(false);
    const revived = registry.assign("short-lived");
    expect(revived).not.toBe(name);
  });

  it("does not hand a freed name to a second owner in the same cycle", () => {
    const registry = new AgentNameRegistry();
    const first = registry.assign("owner-a");
    registry.release("owner-a");
    // Assigning every remaining name must not reuse the freed one this cycle.
    const taken = Array.from({ length: GREAT_NAME_POOL.length }, (_, index) =>
      registry.assign(`owner-${index}`),
    );
    expect(taken).not.toContain(first);
  });
});
