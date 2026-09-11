import { describe, expect, it } from "vitest";
import { WorkflowPipeline } from "../src/agent/workflow-pipeline.js";

describe("WorkflowPipeline", () => {
  it("builds a DAG pipeline and detects cycle errors", () => {
    const pipeline = new WorkflowPipeline({
      id: "feature_pipeline",
      name: "Feature Pipeline",
    });

    pipeline.addNode({ id: "req", name: "Request", kind: "trigger" });
    pipeline.addNode({ id: "spec", name: "Spec", kind: "agent", agentRole: "product_manager" });
    pipeline.addNode({ id: "build", name: "Build", kind: "agent", agentRole: "fullstack_engineer" });

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
    pipeline.addNode({ id: "audit", name: "Security Audit", kind: "agent", agentRole: "security_auditor" });
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
    const run1_step3 = pipeline.completeNode(run1_step2, "audit", { output: { audit_passed: true } });
    expect(run1_step3.currentNodeIds).toContain("deploy");

    // Complete deploy
    const run1_done = pipeline.completeNode(run1_step3, "deploy", {});
    expect(run1_done.status).toBe("completed");
  });
});
