import { describe, expect, it } from "vitest";
import { WorkflowPipeline } from "../src/agent/workflow-pipeline.js";

describe("WorkflowPipeline", () => {
  it("preserves prototype-named node IDs across persisted run state", () => {
    const pipeline = new WorkflowPipeline({
      id: "prototype_ids",
      name: "Prototype IDs",
      nodes: [
        { id: "__proto__", name: "Start", kind: "trigger" },
        { id: "constructor", name: "Finish", kind: "output" },
      ],
      edges: [{ from: "__proto__", to: "constructor" }],
    });
    const run = pipeline.createRun();
    expect(Object.hasOwn(run.nodeStates, "__proto__")).toBe(true);
    const persisted = JSON.parse(JSON.stringify(run));
    const started = pipeline.completeNode(persisted, "__proto__", {});
    expect(started.currentNodeIds).toEqual(["constructor"]);
    const done = pipeline.completeNode(started, "constructor", {});
    expect(done.status).toBe("completed");
    expect(done.currentNodeIds).toEqual([]);
  });

  it("does not let output prototype keys supply inherited gate decisions", () => {
    const pipeline = new WorkflowPipeline({
      id: "gate_output",
      name: "Gate output",
      nodes: [
        { id: "start", name: "Start", kind: "trigger" },
        { id: "gate", name: "Gate", kind: "gate", conditionField: "approved" },
        { id: "deploy", name: "Deploy", kind: "output" },
        { id: "review", name: "Review", kind: "output" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "deploy", conditionValue: true },
        { from: "gate", to: "review" },
      ],
    });
    const run = pipeline.createRun();
    const output = JSON.parse('{"__proto__":{"approved":true},"artifact":"build"}');
    const started = pipeline.completeNode(run, "start", { output });
    expect(started.context.approved).toBeUndefined();
    expect(Object.hasOwn(started.context, "__proto__")).toBe(true);
    expect(started.context.artifact).toBe("build");
    const gated = pipeline.completeNode(started, "gate", {});
    expect(gated.currentNodeIds).toEqual(["review"]);
  });

  it("builds a DAG pipeline and detects cycle errors", () => {
    const pipeline = new WorkflowPipeline({
      id: "feature_pipeline",
      name: "Feature Pipeline",
    });

    pipeline.addNode({ id: "req", name: "Request", kind: "trigger" });
    pipeline.addNode({ id: "spec", name: "Spec", kind: "agent", agentRole: "product_manager" });
    pipeline.addNode({
      id: "build",
      name: "Build",
      kind: "agent",
      agentRole: "fullstack_engineer",
    });

    pipeline.addEdge("req", "spec");
    pipeline.addEdge("spec", "build");

    const validCheck = pipeline.validateDAG();
    expect(validCheck.isValid).toBe(true);
    expect(validCheck.errors.length).toBe(0);

    // Introducing a cycle
    pipeline.addEdge("build", "spec");
    const cycleCheck = pipeline.validateDAG();
    expect(cycleCheck.isValid).toBe(false);
    expect(cycleCheck.errors[0]).toMatch(/Cycle detected/);
  });

  it("evaluates conditional branch gates and progresses execution", () => {
    const pipeline = new WorkflowPipeline({
      id: "release_pipeline",
      name: "Release Pipeline",
    });

    pipeline.addNode({ id: "start", name: "Start", kind: "trigger" });
    pipeline.addNode({
      id: "security_gate",
      name: "Check Risk",
      kind: "gate",
      conditionField: "requires_security_review",
    });
    pipeline.addNode({
      id: "audit",
      name: "Security Audit",
      kind: "agent",
      agentRole: "security_auditor",
    });
    pipeline.addNode({ id: "deploy", name: "Deploy to Prod", kind: "output" });

    pipeline.addEdge("start", "security_gate");
    pipeline.addEdge("security_gate", "audit", true);
    pipeline.addEdge("security_gate", "deploy", false);
    pipeline.addEdge("audit", "deploy");

    // Case 1: requires_security_review = true
    const run1 = pipeline.createRun({ requires_security_review: true });
    expect(run1.status).toBe("running");
    expect(run1.currentNodeIds).toContain("start");

    // Complete start node
    const run1_step1 = pipeline.completeNode(run1, "start", {});
    expect(run1_step1.currentNodeIds).toContain("security_gate");

    // Complete gate node
    const run1_step2 = pipeline.completeNode(run1_step1, "security_gate", {});
    expect(run1_step2.currentNodeIds).toContain("audit"); // routed to audit

    // Complete audit
    const run1_step3 = pipeline.completeNode(run1_step2, "audit", {
      output: { audit_passed: true },
    });
    expect(run1_step3.currentNodeIds).toContain("deploy");

    // Complete deploy
    const run1_done = pipeline.completeNode(run1_step3, "deploy", {});
    expect(run1_done.status).toBe("completed");
  });

  it("enforces diamond join prerequisites so join nodes wait for all upstream branches", () => {
    const pipeline = new WorkflowPipeline({
      id: "diamond_pipeline",
      name: "Diamond Pipeline",
    });

    pipeline.addNode({ id: "A", name: "Start", kind: "trigger" });
    pipeline.addNode({ id: "B", name: "Branch B", kind: "agent" });
    pipeline.addNode({ id: "C", name: "Branch C", kind: "agent" });
    pipeline.addNode({ id: "D", name: "Join D", kind: "output" });

    pipeline.addEdge("A", "B");
    pipeline.addEdge("A", "C");
    pipeline.addEdge("B", "D");
    pipeline.addEdge("C", "D");

    const run = pipeline.createRun();
    expect(run.currentNodeIds).toEqual(["A"]);

    // Complete A -> B and C should now both be running
    const stepA = pipeline.completeNode(run, "A", {});
    expect(stepA.currentNodeIds.sort()).toEqual(["B", "C"].sort());

    // Complete B -> D should NOT start yet because C is still running!
    const stepB = pipeline.completeNode(stepA, "B", {});
    expect(stepB.currentNodeIds).toEqual(["C"]);
    expect(stepB.nodeStates["D"]?.status).toBe("pending");

    // Complete C -> now all predecessors (B & C) are succeeded, D must start running!
    const stepC = pipeline.completeNode(stepB, "C", {});
    expect(stepC.currentNodeIds).toEqual(["D"]);
    expect(stepC.nodeStates["D"]?.status).toBe("running");

    // Complete D -> pipeline run completes
    const done = pipeline.completeNode(stepC, "D", {});
    expect(done.status).toBe("completed");
    expect(done.currentNodeIds).toEqual([]);
  });

  it("enforces monotonic terminal states and prevents completing non-running nodes", () => {
    const pipeline = new WorkflowPipeline({
      id: "terminal_test",
      name: "Terminal Test",
    });

    pipeline.addNode({ id: "A", name: "Node A", kind: "trigger" });
    pipeline.addNode({ id: "B", name: "Node B", kind: "output" });
    pipeline.addEdge("A", "B");

    const run = pipeline.createRun();

    // Cannot complete B while it is pending
    expect(() => pipeline.completeNode(run, "B", {})).toThrow(/not running/);

    // Fail node A -> run enters failed state
    const failedRun = pipeline.completeNode(run, "A", { error: "Execution failed" });
    expect(failedRun.status).toBe("failed");

    // Subsequent completions cannot mutate terminal run state
    expect(() => pipeline.completeNode(failedRun, "A", {})).toThrow(/already in terminal state/);
    expect(() => pipeline.completeNode(failedRun, "B", {})).toThrow(/already in terminal state/);
  });

  it("validates empty pipelines, missing trigger entry points, and duplicate node IDs", () => {
    const emptyPipeline = new WorkflowPipeline({ id: "empty", name: "Empty" });
    const emptyCheck = emptyPipeline.validateDAG();
    expect(emptyCheck.isValid).toBe(false);
    expect(emptyCheck.errors.some((e) => /contain at least one node/i.test(e))).toBe(true);

    const noTriggerPipeline = new WorkflowPipeline({ id: "no_trig", name: "No Trigger" });
    noTriggerPipeline.addNode({ id: "task1", name: "Task 1", kind: "agent" });
    const noTrigCheck = noTriggerPipeline.validateDAG();
    expect(noTrigCheck.isValid).toBe(false);
    expect(noTrigCheck.errors.some((e) => /trigger node/i.test(e))).toBe(true);

    const dupPipeline = new WorkflowPipeline({ id: "dup", name: "Dup" });
    dupPipeline.addNode({ id: "same", name: "Same", kind: "trigger" });
    expect(() => dupPipeline.addNode({ id: "same", name: "Same Again", kind: "agent" })).toThrow(
      /Duplicate node ID/,
    );
  });
});
