import { describe, expect, it } from "vitest";

import { TaskParallelizer, type Subtask } from "../../../src/engine/swarm/task-parallelizer.js";

function subtask(id: string, dependencies: string[] = [], extra: Partial<Subtask> = {}): Subtask {
  return { id, goal: id, dependencies, estimatedCost: 1, status: "pending", ...extra };
}

describe("TaskParallelizer graph construction", () => {
  it("adds subtasks and rejects duplicate ids", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a"));
    expect(planner.size()).toBe(1);
    expect(() => planner.addSubtask(subtask("a"))).toThrow(/Duplicate subtask id/);
  });

  it("reports dangling and self-referential dependency edges", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a", ["missing"]));
    planner.addSubtask(subtask("b", ["b"]));
    const validation = planner.validateDependencies();
    expect(validation.valid).toBe(false);
    expect(validation.dangling).toEqual(["missing"]);
    expect(validation.selfEdges).toEqual(["b"]);
  });

  it("deduplicates repeated dependencies on add", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a"));
    planner.addSubtask(subtask("b", ["a", "a", "a"]));
    expect(planner.getSubtask("b")?.dependencies).toEqual(["a"]);
  });
});

describe("TaskParallelizer wave levelling", () => {
  it("levels a diamond dependency graph into three parallel waves", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("root"));
    planner.addSubtask(subtask("left", ["root"]));
    planner.addSubtask(subtask("right", ["root"]));
    planner.addSubtask(subtask("join", ["left", "right"]));

    const plan = planner.fanOut();
    expect(plan.cycle).toBeNull();
    expect(plan.waves.map((wave) => wave.subtaskIds.sort())).toEqual([
      ["root"],
      ["left", "right"],
      ["join"],
    ]);
  });

  it("places independent subtasks in the first wave", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("x"));
    planner.addSubtask(subtask("y"));
    const plan = planner.fanOut();
    expect(plan.waves[0]?.subtaskIds.sort()).toEqual(["x", "y"]);
  });

  it("chunks a wide wave to respect the worker budget", () => {
    const planner = new TaskParallelizer({ workerBudget: 4 });
    for (let index = 0; index < 9; index++) planner.addSubtask(subtask(`t${index}`));
    const plan = planner.fanOut();
    const wave = plan.waves[0];
    expect(wave?.chunks).toEqual([["t0", "t1", "t2", "t3"], ["t4", "t5", "t6", "t7"], ["t8"]]);
  });

  it("reports the critical path length as a lower bound on wall clock", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a"));
    planner.addSubtask(subtask("b", ["a"]));
    planner.addSubtask(subtask("c", ["b"]));
    planner.addSubtask(subtask("independent"));
    const plan = planner.fanOut();
    expect(plan.criticalPathLength).toBe(3);
  });

  it("sums estimated cost across the plan", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a", [], { estimatedCost: 2 }));
    planner.addSubtask(subtask("b", [], { estimatedCost: 3 }));
    expect(planner.fanOut().totalCost).toBe(5);
  });
});

describe("TaskParallelizer cycles and cascade failure", () => {
  it("detects a dependency cycle and refuses to level it", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a", ["c"]));
    planner.addSubtask(subtask("b", ["a"]));
    planner.addSubtask(subtask("c", ["b"]));
    const plan = planner.fanOut();
    expect(plan.cycle).not.toBeNull();
    expect(plan.cycle).toContain("a");
    expect(plan.waves).toHaveLength(0);
  });

  it("poisons the transitive dependents of a failed subtask", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("root"));
    planner.addSubtask(subtask("middle", ["root"]));
    planner.addSubtask(subtask("leaf", ["middle"]));
    planner.addSubtask(subtask("unrelated"));

    const outcome = planner.complete("root", false);
    expect(outcome.poisoned).toContain("middle");
    expect(outcome.poisoned).toContain("leaf");
    expect(outcome.poisoned).not.toContain("unrelated");
    expect(planner.getSubtask("leaf")?.status).toBe("cancelled");
  });

  it("advances the ready set when a dependency succeeds", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a"));
    planner.addSubtask(subtask("b", ["a"]));
    expect(planner.readySet()).toEqual(["a"]);

    planner.complete("a", true);
    expect(planner.readySet()).toEqual(["b"]);
  });
});

describe("TaskParallelizer ready set", () => {
  it("holds a subtask until every dependency succeeds", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a"));
    planner.addSubtask(subtask("b"));
    planner.addSubtask(subtask("c", ["a", "b"]));
    expect(planner.readySet()).toEqual(["a", "b"]);

    planner.complete("a", true);
    expect(planner.readySet()).toEqual(["b"]);

    planner.complete("b", true);
    expect(planner.readySet()).toEqual(["c"]);
  });

  it("never marks a running subtask ready", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a", [], { status: "running" }));
    expect(planner.readySet()).toHaveLength(0);
  });

  it("completes only subtasks in a non-terminal state", () => {
    const planner = new TaskParallelizer();
    planner.addSubtask(subtask("a", [], { status: "succeeded" }));
    expect(() => planner.complete("a", true)).toThrow(
      /Cannot complete unknown subtask|non-terminal|unknown/,
    );
  });
});
