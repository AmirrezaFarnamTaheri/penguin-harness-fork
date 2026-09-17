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
});
