import { describe, expect, it } from "vitest";

import { RoleAllocator, type AgentProfile } from "../../../src/engine/swarm/role-allocator.js";
import type { Subtask } from "../../../src/engine/swarm/task-parallelizer.js";
import {
  WorkRouter,
  isRoutableClass,
  isWorkClass,
  workClassForRole,
  workRequestFromSubtask,
  type AllocationSource,
  type RouteDecision,
  type WorkRequest,
  type WorkRouterOptions,
} from "../../../src/engine/swarm/work-router.js";

function profile(
  id: string,
  capabilities: Record<string, number>,
  extra: Partial<AgentProfile> = {},
): AgentProfile {
  return { id, capabilities, load: 0, ...extra };
}

/**
 * A swarm that actually staffs the three classes that may be dispatched, so
 * routing has somewhere real to go. Capabilities are the standard roster's
 * required sets, above the allocator's 0.2 floor.
 */
function staffedSwarm(): RoleAllocator {
  const allocator = new RoleAllocator();
  allocator.registerAgent(
    profile("lead", { planning: 0.9, delegation: 0.9, implementation: 0.6, testing: 0.5 }),
  );
  allocator.registerAgent(
    profile("tester", { testing: 0.95, implementation: 0.8, debugging: 0.7, ci: 0.6 }),
  );
  allocator.registerAgent(
    profile("sec", { security: 0.95, code_review: 0.8, threat_modeling: 0.7, cryptography: 0.6 }),
  );
  allocator.registerAgent(
    profile("debugger", { debugging: 0.95, testing: 0.8, profiling: 0.7, git: 0.5 }),
  );
  allocator.allocate();
  return allocator;
}

function subtask(extra: Partial<Subtask> = {}): Subtask {
  return {
    id: "sub-1",
    goal: "run the full test suite",
    dependencies: [],
    estimatedCost: 1,
    status: "pending",
    ...extra,
  };
}

describe("the broad/narrow split — the rule the product asked for", () => {
  it("routes a full-suite run to the allocated test engineer and owes it a report", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "run the full test suite for the whole repo before we ship",
      requesterAgentId: "lead",
    });

    expect(decision.routed).toBe(true);
    expect(decision.outcome).toBe("routed");
    expect(decision.roleId).toBe("test_engineer");
    expect(decision.agentId).toBe("tester");
    expect(decision.scope).toBe("broad");
    expect(decision.workClass).toBe("verification");
    // Reported back to the requester: that asymmetry is the feature.
    expect(decision.report).toEqual({ to: "lead", required: true });
  });

  it("runs an e2e job on the test engineer too — e2e is broad by rule", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the end to end suite", requesterAgentId: "lead" });
    expect(decision.routed).toBe(true);
    expect(decision.roleId).toBe("test_engineer");
    expect(decision.scope).toBe("broad");
  });

  it("keeps the tests for the files just changed with the requester, no ceremony", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "run the tests for the files I just changed",
      requesterAgentId: "lead",
    });

    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_scoped");
    expect(decision.roleId).toBe("test_engineer");
    expect(decision.agentId).toBe("lead");
    expect(decision.report.required).toBe(false);
    expect(router.listInFlight()).toHaveLength(0);
  });

  it("treats a request scoped to known paths as narrow even without scoping words", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "regression check the suite",
      requesterAgentId: "lead",
      touchedPaths: ["src/auth.ts"],
    });
    expect(decision.scope).toBe("narrow");
    expect(decision.outcome).toBe("local_scoped");
  });

  it("lets a scoping clause beat whole-repo language in the same sentence", () => {
    // "all the tests" is broad vocabulary, "for the files I changed" is a
    // scoping clause, and the sentence means the narrow one.
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "run all the tests for the files I changed",
      requesterAgentId: "lead",
    });
    expect(decision.scope).toBe("narrow");
    expect(decision.outcome).toBe("local_scoped");
  });

  it("keeps an ambiguous scope local, which is the pre-existing behaviour", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "check the tests", requesterAgentId: "lead" });
    expect(decision.scope).toBe("unclear");
    expect(decision.routed).toBe(false);
    expect(decision.agentId).toBe("lead");
    expect(decision.reason).toMatch(/unclear/);
  });
});

describe("classifying work from what the task is", () => {
  it("routes a broad verification job to the test engineer", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the whole test suite", requesterAgentId: "lead" });
    expect(decision.workClass).toBe("verification");
    expect(decision.roleId).toBe("test_engineer");
    expect(decision.routed).toBe(true);
  });

  it("routes a security review to the security reviewer without a breadth gate", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "security review of the auth diff",
      requesterAgentId: "lead",
    });
    expect(decision.workClass).toBe("security_review");
    expect(decision.roleId).toBe("security_reviewer");
    expect(decision.agentId).toBe("sec");
    expect(decision.routed).toBe(true);
  });

  it("routes a reproduction to the bug isolator", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "reproduce the flaky failure and bisect it to a commit",
      requesterAgentId: "lead",
    });
    expect(decision.workClass).toBe("reproduction");
    expect(decision.roleId).toBe("bug_isolator");
    expect(decision.routed).toBe(true);
  });

  it("prefers the purpose over the activity: a security review of test code is a review", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "security review of the auth test suite",
      requesterAgentId: "lead",
    });
    expect(decision.workClass).toBe("security_review");
    expect(decision.roleId).toBe("security_reviewer");
  });

  it("records the evidence that produced the class", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(decision.evidence.length).toBeGreaterThan(0);
    expect(decision.evidence.every((term) => term === term.toLowerCase())).toBe(true);
  });

  it("leaves a class no role owns running where it is", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "add the export to the feature module",
      requesterAgentId: "lead",
    });
    expect(decision.workClass).toBe("general");
    expect(decision.roleId).toBeNull();
    expect(decision.outcome).toBe("local_unclassified");
    expect(decision.routed).toBe(false);
  });
});

describe("authored work is classified but never handed over", () => {
  // A refactor, a plan and a cleanup all change files in the requester's
  // workspace, so they are done where the code is — the router says so out
  // loud rather than quietly misassigning them to a peer.
  const authored: Array<[string, string, string]> = [
    ["de-slop this module and simplify the refactor", "code_polisher", "code_polisher"],
    ["review the module boundaries and interface contracts", "architect_lead", "architect_lead"],
    ["break the work down and set the priorities", "orchestrator", "orchestrator"],
    ["research which library we should use and gather evidence", "researcher", "researcher"],
  ];

  for (const [task, roleId, workClass] of authored) {
    it(`keeps '${task}' with the requester even though ${workClass} owns it`, () => {
      const router = new WorkRouter(staffedSwarm());
      const decision = router.route({ task, requesterAgentId: "lead" });
      expect(decision.roleId).toBe(roleId);
      expect(decision.routed).toBe(false);
      expect(decision.outcome).toBe("local_authored_in_place");
      expect(decision.agentId).toBe("lead");
      expect(decision.reason).toMatch(/authors changes in the requester's workspace/);
    });
  }

  it("publishes which classes may ever be dispatched, and why the list is short", () => {
    expect(isRoutableClass("verification")).toBe(true);
    expect(isRoutableClass("reproduction")).toBe(true);
    expect(isRoutableClass("security_review")).toBe(true);
    for (const authoredClass of [
      "architecture",
      "polish",
      "research",
      "planning",
      "general",
    ] as const) {
      expect(isRoutableClass(authoredClass)).toBe(false);
    }
  });

  it("maps a role back to the class it owns", () => {
    expect(workClassForRole("test_engineer")).toBe("verification");
    expect(workClassForRole("bug_isolator")).toBe("reproduction");
    expect(workClassForRole("  security_reviewer  ")).toBe("security_review");
    expect(workClassForRole("code_polisher")).toBe("polish");
    expect(workClassForRole("not_a_role")).toBeNull();
    expect(workClassForRole(undefined)).toBeNull();
  });

  it("guards the class vocabulary against untrusted values", () => {
    expect(isWorkClass("verification")).toBe(true);
    expect(isWorkClass("test_engineer")).toBe(false);
    expect(isWorkClass(7)).toBe(false);
    expect(isWorkClass(null)).toBe(false);
    expect(isWorkClass({})).toBe(false);
  });
});

describe("labels a caller or planner supplies", () => {
  it("honours an explicit class but never lets it buy a scope exemption", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "check the tests",
      class: "verification",
      requesterAgentId: "lead",
    });
    expect(decision.classSource).toBe("caller");
    expect(decision.workClass).toBe("verification");
    // Naming the class states who owns the work, not that this instance is
    // worth handing over, so the breadth rule still applies.
    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_scoped");
    expect(decision.evidence[0]).toMatch(/caller:verification/);
  });

  it("routes a broad run the caller labelled, and records where the class came from", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "run the full suite",
      class: "verification",
      requesterAgentId: "lead",
    });
    expect(decision.classSource).toBe("caller");
    expect(decision.routed).toBe(true);
    expect(decision.roleId).toBe("test_engineer");
  });

  it("accepts the role a planner already chose", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "rework the thing",
      roleId: "security_reviewer",
      requesterAgentId: "lead",
    });
    expect(decision.classSource).toBe("declaredRole");
    expect(decision.workClass).toBe("security_review");
    expect(decision.routed).toBe(true);
  });

  it("ignores a role that owns no class, and a junk class, without throwing", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "run the full test suite",
      roleId: "not_a_role",
      // Cast on purpose: a value from JSON or a model can be outside the
      // closed vocabulary, and the router must ignore it rather than throw.
      class: "not_a_class" as never,
      requesterAgentId: "lead",
    });
    expect(decision.classSource).toBe("derived");
    expect(decision.routed).toBe(true);
    expect(decision.roleId).toBe("test_engineer");
  });

  it("turns a parallelizer subtask into a request without inventing scope", () => {
    const request = workRequestFromSubtask(
      subtask({ goal: "run the full test suite", roleId: "test_engineer" }),
      "lead",
    );
    expect(request.workId).toBe("sub-1");
    expect(request.task).toBe("run the full test suite");
    expect(request.requesterAgentId).toBe("lead");
    // The role is forwarded as a role, not laundered into a class, so the
    // audit trail can say where the classification came from.
    expect(request.roleId).toBe("test_engineer");
    expect(request.class).toBeUndefined();

    const router = new WorkRouter(staffedSwarm());
    const decision = router.route(request);
    expect(decision.routed).toBe(true);
    expect(decision.classSource).toBe("declaredRole");
    expect(decision.roleId).toBe("test_engineer");
    // estimatedCost has no defined unit, so it must not decide scope.
    const cheap = workRequestFromSubtask(subtask({ estimatedCost: 0.01, goal: "run the tests" }));
    expect(router.route(cheap).outcome).toBe("local_scoped");
  });

  it("carries a subtask role through to the class that owns it", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route(
      workRequestFromSubtask(subtask({ goal: "work out what this does", roleId: "bug_isolator" })),
    );
    expect(decision.classSource).toBe("declaredRole");
    expect(decision.workClass).toBe("reproduction");
    expect(decision.roleId).toBe("bug_isolator");
    expect(decision.routed).toBe(true);
  });

  it("omits the class entirely when the subtask names a role that owns none", () => {
    const request = workRequestFromSubtask(subtask({ roleId: "not_a_role" }));
    expect(request.class).toBeUndefined();
    expect(request.roleId).toBe("not_a_role");
  });
});

describe("degradation — routing is an optimisation, never a gate", () => {
  it("runs the job locally when no allocation has been computed", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("tester", { testing: 0.9, implementation: 0.8 }));
    const router = new WorkRouter(allocator);
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "tester" });
    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_no_role");
    expect(decision.reason).toMatch(/no allocation has been computed/i);
  });

  it("runs the job locally when the class is owned but nobody is allocated to it", () => {
    // Research-only agent: no role in the standard roster can be staffed, so
    // test_engineer in particular has no holder.
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("scholar", { research: 0.9, documentation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator);
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "scholar" });
    expect(decision.outcome).toBe("local_no_role");
    expect(decision.roleId).toBe("test_engineer");
    expect(decision.reason).toMatch(/no agent is allocated to test_engineer/);
  });

  it("behaves exactly as before for a one-agent swarm", () => {
    // One agent, capable of every role. The premise is deliberately NOT "every
    // role is staffed to it": `orchestrator` is exclusive and outranks the rest,
    // so the allocator staffs that and the lone agent is then barred from every
    // other role. The invariant under test is the one that matters — a swarm
    // with nobody to hand work to keeps the work — not the outcome label.
    const allocator = new RoleAllocator({ maxRolesPerAgent: 8 });
    allocator.registerAgent(
      profile("solo", {
        planning: 0.9,
        delegation: 0.9,
        testing: 0.9,
        implementation: 0.9,
        security: 0.9,
        code_review: 0.9,
        debugging: 0.9,
        refactoring: 0.9,
        research: 0.9,
        architecture: 0.9,
        design: 0.9,
      }),
    );
    allocator.allocate();
    const router = new WorkRouter(allocator);

    // With one agent, the allocator gives it the exclusive orchestrator role,
    // and an agent holding an exclusive role holds no others — so no
    // peer-ownable role is staffed at all. Every job therefore stays with the
    // requester, which is what a one-agent swarm did before this module.
    for (const task of [
      "run the full test suite",
      "security review of the whole repo",
      "reproduce the failure and bisect it",
    ]) {
      const decision = router.route({ task, requesterAgentId: "solo" });
      expect(decision.routed).toBe(false);
      expect(decision.outcome).toBe("local_no_role");
      expect(decision.agentId).toBe("solo");
    }
    // No slots taken, so a one-agent swarm accumulates no router state.
    expect(router.listInFlight()).toHaveLength(0);
  });

  it("leaves a job alone when the requester is itself the specialist", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "tester" });
    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_requester_owns");
    expect(decision.agentId).toBe("tester");
    expect(decision.reason).toMatch(/already holds test_engineer/);
    expect(router.listInFlight()).toHaveLength(0);
  });

  it("routes an unknown agent's work when the requester is not the specialist", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({
      task: "run the full test suite",
      requesterAgentId: "outsider",
    });
    expect(decision.routed).toBe(true);
    expect(decision.agentId).toBe("tester");
  });

  it("routes with no requester at all, and owes nobody a report", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite" });
    expect(decision.routed).toBe(true);
    expect(decision.report).toEqual({ to: null, required: false });
  });
});

describe("ceilings — never route into a queue that cannot drain", () => {
  it("skips a holder that is already busy and picks the next eligible one", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("tester-a", { testing: 0.95, implementation: 0.8 }));
    allocator.registerAgent(profile("tester-b", { testing: 0.9, implementation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator);

    const first = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(first.routed).toBe(true);
    const second = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(second.routed).toBe(true);
    // A different holder: the busy one was skipped, not queued behind.
    expect(second.agentId).not.toBe(first.agentId);
    expect(new Set([first.agentId, second.agentId]).size).toBe(2);
  });

  it("names the holder it passed over, and why", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("tester", { testing: 0.95, implementation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator);
    router.route({ task: "run the full test suite", requesterAgentId: "lead" });

    const second = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(second.routed).toBe(false);
    expect(second.outcome).toBe("local_at_capacity");
    expect(second.considered).toHaveLength(1);
    expect(second.considered[0]?.agentId).toBe("tester");
    expect(second.considered[0]?.reason).toMatch(/already running 1 of 1/);
    expect(second.reason).toMatch(/no test_engineer holder is free/);
  });

  it("uses the allocator's own load ceiling rather than a second copy of it", () => {
    const allocator = staffedSwarm();
    const router = new WorkRouter(allocator);
    // Allocated while idle, then saturated: the allocation still names it, and
    // the allocator's own availability answer must keep work away from it.
    allocator.registerAgent(
      profile("tester", { testing: 0.95, implementation: 0.8 }, { load: 0.99 }),
    );

    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_at_capacity");
    expect(decision.considered[0]?.agentId).toBe("tester");
    expect(decision.considered[0]?.reason).toMatch(/load 0.99 at or above ceiling 0.90/);
  });

  it("skips a holder the allocator no longer knows about", () => {
    const allocator = staffedSwarm();
    allocator.unregisterAgent("tester");
    const router = new WorkRouter(allocator);
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    // A stale allocation still names the gone agent; routing must not hand
    // work to it, and must say that is why.
    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_at_capacity");
    expect(decision.considered[0]?.reason).toMatch(/no longer known to the allocator/);
  });

  it("honours a per-agent ceiling above one", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("tester", { testing: 0.95, implementation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator, { maxInFlightPerAgent: 2 });

    expect(router.route({ task: "run the full test suite", requesterAgentId: "lead" }).routed).toBe(
      true,
    );
    expect(router.route({ task: "run the full test suite", requesterAgentId: "lead" }).routed).toBe(
      true,
    );
    expect(router.route({ task: "run the full test suite", requesterAgentId: "lead" }).routed).toBe(
      false,
    );
  });

  it("refuses to queue once the global ledger is full", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("tester", { testing: 0.95, implementation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator, { maxInFlight: 1, maxInFlightPerAgent: 5 });

    expect(router.route({ task: "run the full test suite", requesterAgentId: "lead" }).routed).toBe(
      true,
    );
    const next = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(next.outcome).toBe("local_at_capacity");
    expect(next.reason).toMatch(/refusing to queue/);
    expect(router.stats().inFlight).toBe(1);
  });

  it("does not queue the same caller work id twice", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("tester", { testing: 0.95, implementation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator, { maxInFlightPerAgent: 4 });

    const first = router.route({
      task: "run the full test suite",
      requesterAgentId: "lead",
      workId: "sub-1",
    });
    expect(first.routed).toBe(true);
    const second = router.route({
      task: "run the full test suite",
      requesterAgentId: "lead",
      workId: "sub-1",
    });
    expect(second.routed).toBe(false);
    expect(second.reason).toMatch(/already in flight/);
    expect(router.stats().inFlight).toBe(1);
  });
});

describe("the report back to the requester", () => {
  it("hands the specialist's result to the requester as a value", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    const report = router.complete(decision.jobId, {
      ok: true,
      summary: "412 passed, 1 failed",
      detail: { suites: 12 },
    });

    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.to).toBe("lead");
    expect(report.agentId).toBe("tester");
    expect(report.roleId).toBe("test_engineer");
    expect(report.ok).toBe(true);
    expect(report.summary).toBe("412 passed, 1 failed");
    expect(report.detail).toEqual({ suites: 12 });
    expect(router.getReport(decision.jobId)).toEqual(report);
    expect(router.reportsFor("lead")).toHaveLength(1);
    expect(router.reportsFor("tester")).toHaveLength(0);
  });

  it("records a failure as a report and frees the same slot", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    const report = router.fail(decision.jobId, "suite timed out", { exit: 124 });

    expect(report?.ok).toBe(false);
    expect(report?.summary).toBe("suite timed out");
    expect(report?.detail).toEqual({ exit: 124 });
    expect(router.listInFlight()).toHaveLength(0);
    // Freeing the slot lets the same holder take the next job.
    expect(router.route({ task: "run the full test suite", requesterAgentId: "lead" }).routed).toBe(
      true,
    );
  });

  it("makes a double close inert rather than a second release", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(router.complete(decision.jobId)).not.toBeNull();
    expect(router.complete(decision.jobId)).toBeNull();
    expect(router.reportsFor("lead")).toHaveLength(1);
  });

  it("returns null for a job that was never routed or already closed", () => {
    const router = new WorkRouter(staffedSwarm());
    expect(router.complete("work-999")).toBeNull();
    expect(router.fail("nonsense", "boom")).toBeNull();
    expect(router.getReport("work-999")).toBeNull();
  });

  it("owes a report only for a job that actually left the requester", () => {
    const router = new WorkRouter(staffedSwarm());
    const local = router.route({
      task: "run the tests for the file I changed",
      requesterAgentId: "lead",
    });
    expect(local.report.required).toBe(false);
    expect(router.reportsFor("lead")).toHaveLength(0);
    expect(router.getReport(local.jobId)).toBeNull();
  });

  it("closes a swept job with a failed report, because the requester is still owed an answer", () => {
    const allocator = staffedSwarm();
    const router = new WorkRouter(allocator, { staleJobMs: 1_000 });
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(router.listInFlight()).toHaveLength(1);

    // Nothing is due yet, so the slot legitimately holds.
    expect(router.reapStale(Date.now())).toBe(0);
    const reaped = router.reapStale(Date.now() + 10_000);
    expect(reaped).toBe(1);
    expect(router.listInFlight()).toHaveLength(0);

    const report = router.getReport(decision.jobId);
    expect(report?.ok).toBe(false);
    expect(report?.summary).toMatch(/no result reported within 1000ms/);
  });
});

describe("bounded state", () => {
  it("keeps the history ring bounded across decisions and closures", () => {
    const allocator = new RoleAllocator();
    allocator.registerAgent(profile("lead", { planning: 0.9, delegation: 0.9 }));
    allocator.registerAgent(profile("tester", { testing: 0.95, implementation: 0.8 }));
    allocator.allocate();
    const router = new WorkRouter(allocator, { retainDecisions: 6 });
    for (let index = 0; index < 10; index++) {
      const decision = router.route({
        task: "run the full test suite",
        requesterAgentId: "lead",
        workId: `sub-${index}`,
      });
      if (decision.routed) router.complete(decision.jobId, { ok: true, summary: `run ${index}` });
    }
    // Each iteration adds a decision, a release and a report; the ring holds 6.
    expect(router.stats().eventsRetained).toBe(6);
    expect(router.recentEvents(100).length).toBeLessThanOrEqual(6);
  });

  it("keeps the decision history bounded", () => {
    const router = new WorkRouter(staffedSwarm(), { retainDecisions: 3 });
    for (let index = 0; index < 20; index++) {
      router.route({ task: `job ${index}: add the export`, requesterAgentId: "lead" });
    }
    expect(router.stats().eventsRetained).toBe(3);
    expect(router.recentDecisions(100)).toHaveLength(3);
  });

  it("sweeps stale jobs as a side effect of routing, without a timer", () => {
    const allocator = staffedSwarm();
    const router = new WorkRouter(allocator, { staleJobMs: 1_000 });
    router.route({ task: "run the full test suite", requesterAgentId: "lead" });

    // A routing call far in the future implies the holder never reported.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      const second = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
      // The stale slot was swept and closed, so the holder is free again.
      expect(second.routed).toBe(true);
      expect(router.stats().inFlight).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("returns copies from the in-flight listing", () => {
    const router = new WorkRouter(staffedSwarm());
    router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    const [job] = router.listInFlight();
    if (job === undefined) return;
    job.agentId = "tampered";
    expect(router.listInFlight()[0]?.agentId).toBe("tester");
  });
});

describe("observability", () => {
  it("answers why a job went where it went, after the fact", () => {
    const router = new WorkRouter(staffedSwarm());
    router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    const [decision] = router.recentDecisions(1);
    expect(decision).toBeDefined();
    if (decision === undefined) return;

    expect(decision.agentId).toBe("tester");
    expect(decision.roleId).toBe("test_engineer");
    expect(decision.reason).toMatch(/reported back to lead/);
    const line = router.describe(decision);
    expect(line).toMatch(/routed to tester \(test_engineer\)/);
    expect(line).toMatch(/work-router/);
  });

  it("describes a local decision as local, with the outcome", () => {
    const router = new WorkRouter(staffedSwarm());
    router.route({ task: "run the tests for the file I changed", requesterAgentId: "lead" });
    const [decision] = router.recentDecisions(1);
    if (decision === undefined) return;
    expect(router.describe(decision)).toMatch(/local \(local_scoped\)/);
  });

  it("notifies the decision and report hooks, and survives sinks that throw", () => {
    const decisions: RouteDecision[] = [];
    const reports: string[] = [];
    const router = new WorkRouter(staffedSwarm(), {
      onDecision: (decision) => {
        decisions.push(decision);
        throw new Error("decision sink is down");
      },
      onReport: (report) => {
        reports.push(report.summary);
        throw new Error("report sink is down");
      },
    });
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(decision.routed).toBe(true);
    // A broken sink must not take the close-out with it.
    expect(router.complete(decision.jobId, { ok: true, summary: "all green" })).not.toBeNull();
    expect(decisions).toHaveLength(1);
    expect(reports).toEqual(["all green"]);
  });

  it("does not let a caller mutate retained history", () => {
    const router = new WorkRouter(staffedSwarm());
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    decision.evidence.push("tampered");
    decision.considered.push({ agentId: "ghost", reason: "tampered" });
    const [retained] = router.recentDecisions(1);
    if (retained === undefined) return;
    expect(retained.evidence).not.toContain("tampered");
    expect(retained.considered.some((skip) => skip.agentId === "ghost")).toBe(false);
  });

  it("reports which allocation generation it read", () => {
    const allocator = staffedSwarm();
    const router = new WorkRouter(allocator);
    expect(router.stats().allocationGeneration).toBe(0);
    router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(router.stats().allocationGeneration).toBeGreaterThan(0);
  });
});

describe("the non-blocking invariant", () => {
  it("returns a local decision when the allocation source itself faults", () => {
    const exploding: AllocationSource = {
      holdersOf: () => {
        throw new Error("allocation store unavailable");
      },
      agentAvailability: () => undefined,
      allocationGeneration: () => 1,
    };
    const router = new WorkRouter(exploding);
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });

    // A routing fault is not a reason a test suite does not run.
    expect(decision.routed).toBe(false);
    expect(decision.agentId).toBe("lead");
    expect(decision.reason).toMatch(/routing faulted, running locally/);
    expect(decision.reason).toMatch(/allocation store unavailable/);
  });

  it("survives a faulting availability check on the path to a holder", () => {
    const allocator = staffedSwarm();
    const hostile: AllocationSource = {
      holdersOf: (roleId) => allocator.holdersOf(roleId),
      agentAvailability: () => {
        throw new Error("registry unavailable");
      },
      allocationGeneration: () => 1,
    };
    const router = new WorkRouter(hostile);
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(decision.routed).toBe(false);
    expect(decision.agentId).toBe("lead");
  });

  it("returns a decision for every kind of junk input, and never throws", () => {
    const router = new WorkRouter(staffedSwarm());
    const junk: unknown[] = [
      undefined,
      null,
      {},
      { task: "" },
      { task: 42 },
      { task: "run the full test suite", requesterAgentId: 7 },
      { task: "run the full test suite", touchedPaths: "not-an-array" },
      { task: "run the full test suite", class: 12 },
      { task: "run the full test suite", roleId: 99 },
      { task: "run the full test suite", workId: "   " },
    ];
    for (const candidate of junk) {
      let decision: RouteDecision | undefined;
      expect(() => {
        decision = router.route(candidate as WorkRequest);
      }).not.toThrow();
      expect(decision?.routed).toBeTypeOf("boolean");
    }
  });

  it("works with a source that has no allocation and no agents at all", () => {
    const empty: AllocationSource = {
      holdersOf: () => [],
      agentAvailability: () => undefined,
      allocationGeneration: () => 0,
    };
    const router = new WorkRouter(empty);
    const decision = router.route({ task: "run the full test suite", requesterAgentId: "lead" });
    expect(decision.routed).toBe(false);
    expect(decision.outcome).toBe("local_no_role");
  });
});

describe("router options", () => {
  it("clamps nonsensical bounds to something workable", () => {
    const options: WorkRouterOptions = {
      maxInFlight: 0,
      maxInFlightPerAgent: -3,
      staleJobMs: 0,
      retainDecisions: 0,
    };
    const router = new WorkRouter(staffedSwarm(), options);
    expect(router.stats().maxInFlight).toBe(1);
    // A zero retention still keeps one event, so observability never vanishes.
    router.route({ task: "add the export", requesterAgentId: "lead" });
    expect(router.stats().eventsRetained).toBe(1);
  });
});
