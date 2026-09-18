import { describe, expect, it } from "vitest";

import {
  RoleAllocator,
  STANDARD_SWARM_ROLES,
  type AgentProfile,
  type RoleDefinition,
  type SwarmRoleId,
} from "../../../src/engine/swarm/role-allocator.js";

function profile(
  id: string,
  capabilities: Record<string, number>,
  extra: Partial<AgentProfile> = {},
): AgentProfile {
  return { id, capabilities, load: 0, ...extra };
}

describe("RoleAllocator eligibility gates", () => {
  it("gives a missing required capability a hard zero score, not a soft penalty", () => {
    const allocator = new RoleAllocator();
    const pair = allocator.scorePair(
      profile("agent-a", { implementation: 0.9 }),
      STANDARD_SWARM_ROLES.find((role) => role.id === "architect_lead") as RoleDefinition,
    );
    expect(pair.eligible).toBe(false);
    expect(pair.score).toBe(0);
    expect(pair.reasons.some((reason) => reason.includes("missing required capability"))).toBe(
      true,
    );
  });

  it("treats proficiency below the capability floor as absent", () => {
    const allocator = new RoleAllocator({ capabilityFloor: 0.5 });
    const pair = allocator.scorePair(
      profile("agent-a", { architecture: 0.3, design: 0.9 }),
      STANDARD_SWARM_ROLES.find((role) => role.id === "architect_lead") as RoleDefinition,
    );
    expect(pair.eligible).toBe(false);
    expect(pair.score).toBe(0);
  });

  it("refuses to consider an agent at its load ceiling", () => {
    const allocator = new RoleAllocator();
    const pair = allocator.scorePair(
      profile("agent-a", { testing: 0.9, implementation: 0.9 }, { load: 0.95 }),
      STANDARD_SWARM_ROLES.find((role) => role.id === "test_engineer") as RoleDefinition,
    );
    expect(pair.eligible).toBe(false);
    expect(pair.reasons.some((reason) => reason.includes("load"))).toBe(true);
  });

  it("rewards declared preferences without ever making them a gate", () => {
    const allocator = new RoleAllocator();
    const role = STANDARD_SWARM_ROLES.find((r) => r.id === "researcher") as RoleDefinition;
    const plain = allocator.scorePair(profile("a", { research: 0.8 }), role);
    const preferring = allocator.scorePair(
      profile("b", { research: 0.8 }, { preferences: ["researcher"] }),
      role,
    );
    expect(plain.eligible).toBe(true);
    expect(preferring.score).toBeGreaterThan(plain.score);
  });
});

describe("RoleAllocator.allocate", () => {
  it("staffs an exclusive role with exactly one agent", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.8, architecture: 0.6 }));
    allocator.registerAgent(profile("other", { planning: 0.7, delegation: 0.7 }));

    const allocation = allocator.allocate();
    const orchestrators = allocation.assignments.filter((a) => a.roleId === "orchestrator");
    expect(orchestrators).toHaveLength(1);
    expect(orchestrators[0]?.agentId).toBe("lead");
  });

  it("leaves a role unassigned when nobody qualifies", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("only-research", { research: 0.9 }));
    const allocation = allocator.allocate();
    expect(allocation.unassigned).toContain("orchestrator");
    expect(allocation.unassigned).toContain("architect_lead");
    expect(allocation.assignments.map((a) => a.roleId)).toContain("researcher");
  });

  it("respects maxConcurrent for non-exclusive roles", () => {
    const roles: RoleDefinition[] = [
      {
        id: "researcher",
        label: "Researcher",
        summary: "research",
        requiredCapabilities: ["research"],
        preferredCapabilities: [],
        priority: 30,
        exclusive: false,
        maxConcurrent: 2,
      },
    ];
    const allocator = new RoleAllocator(roles);
    allocator.registerAgent(profile("r1", { research: 0.9 }));
    allocator.registerAgent(profile("r2", { research: 0.8 }));
    allocator.registerAgent(profile("r3", { research: 0.7 }));

    const allocation = allocator.allocate();
    expect(allocation.assignments).toHaveLength(2);
    expect(allocation.assignments.map((a) => a.agentId)).toEqual(["r1", "r2"]);
  });

  it("does not stack every role onto one agent", () => {
    const allocator = new RoleAllocator(STANDARD_SWARM_ROLES, { maxRolesPerAgent: 1 });
    allocator.registerAgent(
      profile("omni", {
        planning: 0.9,
        delegation: 0.9,
        architecture: 0.9,
        design: 0.9,
        security: 0.9,
        code_review: 0.9,
        testing: 0.9,
        debugging: 0.9,
        implementation: 0.9,
        research: 0.9,
      }),
    );
    allocator.registerAgent(
      profile("specialist", { testing: 0.6, implementation: 0.6, debugging: 0.4 }),
    );

    const allocation = allocator.allocate();
    const heldByOmni = allocation.assignments.filter((a) => a.agentId === "omni");
    expect(heldByOmni).toHaveLength(1);
    expect(allocation.assignments.length).toBeGreaterThan(1);
  });

  it("prioritises higher-priority roles when agents are scarce", () => {
    const allocator = new RoleAllocator();
    // One agent who qualifies for both orchestrator and architect_lead.
    allocator.registerAgent(
      profile("lead", { planning: 0.9, delegation: 0.9, architecture: 0.9, design: 0.9 }),
    );
    const allocation = allocator.allocate();
    expect(allocation.assignments.map((a) => a.roleId)).toContain("orchestrator");
    // An exclusive role locks the agent out of every other exclusive role.
    expect(allocation.assignments.filter((a) => a.roleId === "architect_lead")).toHaveLength(0);
  });

  it("demotes an agent multiplicatively after failures", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("backup", { planning: 0.55, delegation: 0.55 }));

    allocator.allocate();
    expect(allocator.holderOf("orchestrator")).toBe("lead");

    allocator.fail("lead", 3);
    allocator.allocate();
    expect(allocator.holderOf("orchestrator")).toBe("backup");
  });

  it("is stable: identical inputs keep the incumbent absent hysteresis pressure", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    const first = allocator.allocate();
    const second = allocator.allocate();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.assignments.find((a) => a.roleId === "orchestrator")?.agentId).toBe("lead");
    expect(second.assignments.find((a) => a.roleId === "orchestrator")?.incumbent).toBe(true);
  });

  it("keeps the incumbent when a challenger wins only marginally", () => {
    const allocator = new RoleAllocator({ hysteresis: 0.5 });
    allocator.registerAgent(profile("incumbent", { planning: 0.8, delegation: 0.8 }));
    // Staffed while the challenger is not yet in the pool, so 'incumbent'
    // genuinely holds the role before the contest begins.
    allocator.allocate();
    expect(allocator.holderOf("orchestrator")).toBe("incumbent");

    const orchestrator = STANDARD_SWARM_ROLES.find(
      (r) => r.id === "orchestrator",
    ) as RoleDefinition;
    const challenger = profile("challenger", { planning: 0.82, delegation: 0.82 });
    allocator.registerAgent(challenger);
    // The challenger really does outscore the incumbent — this is not a tie.
    const incumbentScore = allocator
      .getCurrentAllocation()
      ?.scores.find((s) => s.agentId === "incumbent" && s.roleId === "orchestrator")?.score;
    expect(allocator.scorePair(challenger, orchestrator).score).toBeGreaterThan(
      incumbentScore ?? 0,
    );
    // ...but not by the 0.5 hysteresis margin, so the incumbent keeps the role.
    allocator.allocate();
    expect(allocator.holderOf("orchestrator")).toBe("incumbent");
  });

  it("registers and unregisters agents", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    expect(allocator.getAgent("lead")).toBeDefined();
    expect(allocator.unregisterAgent("lead")).toBe(true);
    expect(allocator.getAgent("lead")).toBeUndefined();
  });

  it("rejects duplicate role definitions", () => {
    const role: RoleDefinition = {
      id: "researcher" as SwarmRoleId,
      label: "dup",
      summary: "",
      requiredCapabilities: [],
      preferredCapabilities: [],
      priority: 1,
      exclusive: false,
      maxConcurrent: 1,
    };
    expect(() => new RoleAllocator([role, role])).toThrow(/Duplicate swarm role id/);
  });

  it("clears failures so a recovered agent can be staffed again", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("backup", { planning: 0.4, delegation: 0.4 }));
    allocator.fail("lead", 5);
    allocator.allocate();
    expect(allocator.holderOf("orchestrator")).toBe("backup");
    allocator.clearFailures("lead");
    allocator.allocate();
    expect(allocator.holderOf("orchestrator")).toBe("lead");
  });
});
