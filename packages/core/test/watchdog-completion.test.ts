import { describe, expect, it } from "vitest";
import { TaskWatchdog } from "../src/agent/task-watchdog.js";
import { CompletionTracker } from "../src/agent/completion-tracker.js";

describe("TaskWatchdog", () => {
  it("tracks steps and reports healthy state within normal bounds", () => {
    const watchdog = new TaskWatchdog({ maxStepCount: 10, stallHeartbeatMs: 5000 });
    watchdog.start();

    const status1 = watchdog.heartbeat({ action: "read_file" });
    expect(status1.state).toBe("healthy");
    expect(status1.currentStep).toBe(1);
    expect(status1.lastAction).toBe("read_file");
  });

  it("detects max steps exceeded", () => {
    const watchdog = new TaskWatchdog({ maxStepCount: 3 });
    watchdog.start();

    watchdog.heartbeat();
    watchdog.heartbeat();
    watchdog.heartbeat();
    const status = watchdog.heartbeat(); // 4th step

    expect(status.state).toBe("max_steps_exceeded");
    expect(watchdog.isHealthy()).toBe(false);
  });

  it("handles explicit abort", () => {
    const watchdog = new TaskWatchdog();
    watchdog.start();
    const aborted = watchdog.abort("User cancelled execution");

    expect(aborted.state).toBe("aborted");
    expect(aborted.abortReason).toBe("User cancelled execution");
    expect(watchdog.isHealthy()).toBe(false);
  });

  it("detects step timeout when a single step duration exceeds stepTimeoutMs", async () => {
    const watchdog = new TaskWatchdog({ stepTimeoutMs: 20 });
    watchdog.start();
    watchdog.heartbeat({ stepNumber: 1, action: "long_running_tool" });

    // Wait 30ms to exceed 20ms step timeout
    await new Promise((r) => setTimeout(r, 30));

    const status = watchdog.checkHealth();
    expect(status.state).toBe("timed_out");
    expect(status.abortReason).toContain("step timeout");
    expect(watchdog.isHealthy()).toBe(false);
  });
});

describe("CompletionTracker", () => {
  it("enforces required verification evidence before verifying", () => {
    const tracker = new CompletionTracker("task-101", "agent-alpha");

    tracker.addRequirement({
      id: "unit_tests",
      kind: "test_suite",
      description: "Run vitest test suite",
    });

    tracker.addRequirement({
      id: "tsc_check",
      kind: "typecheck",
      description: "Run tsc --noEmit",
    });

    // Both pending
    let check = tracker.verifyAll();
    expect(check.verified).toBe(false);
    expect(check.pendingCount).toBe(2);

    // Record one pass
    tracker.recordEvidence("unit_tests", true, "10/10 passing in 340ms");
    check = tracker.verifyAll();
    expect(check.verified).toBe(false);
    expect(check.pendingCount).toBe(1);

    // Record second pass
    tracker.recordEvidence("tsc_check", true, "0 errors found");
    check = tracker.verifyAll();
    expect(check.verified).toBe(true);
    expect(check.pendingCount).toBe(0);

    // Receipt generation
    const receipt = tracker.generateReceipt("Implemented and verified feature", {
      filesChanged: 2,
      insertions: 150,
      deletions: 10,
    });
    expect(receipt.verified).toBe(true);
    expect(receipt.diffStats?.filesChanged).toBe(2);
  });

  it("fails verification if a required check fails", () => {
    const tracker = new CompletionTracker("task-102", "agent-beta");
    tracker.addRequirement({
      id: "security_audit",
      kind: "code_review",
      description: "Run SAST scan",
    });

    tracker.recordEvidence("security_audit", false, "Found SQL injection vulnerability");
    const check = tracker.verifyAll();

    expect(check.verified).toBe(false);
    expect(check.failedItems).toHaveLength(1);
    expect(check.failedItems[0]!.evidence).toContain("SQL injection");
  });
});
