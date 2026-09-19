import { describe, expect, it, vi } from "vitest";
import { TaskWatchdog } from "../src/agent/task-watchdog.js";

describe("TaskWatchdog health reads are side-effect free", () => {
  it("reports an exceeded budget from checkHealth/isHealthy without flipping the run terminal", () => {
    vi.useFakeTimers();
    const watchdog = new TaskWatchdog({
      totalTimeoutMs: 20,
      stepTimeoutMs: 5_000,
      stallHeartbeatMs: 5_000,
    });
    watchdog.start();
    watchdog.heartbeat({ stepNumber: 1, action: "working" });
    vi.advanceTimersByTime(50);

    // A host polling health sees the over-budget state...
    const polled = watchdog.checkHealth();
    expect(polled.state).toBe("timed_out");
    expect(polled.abortReason).toContain("total maximum timeout");
    expect(polled.currentStep).toBe(1);
    expect(watchdog.isHealthy()).toBe(false);

    // ...but the read must not have persisted it: the driver can still advance the run.
    const resumed = watchdog.heartbeat({ stepNumber: 2, action: "still working" });
    expect(resumed.currentStep).toBe(2);
    expect(resumed.lastAction).toBe("still working");
    vi.useRealTimers();
  });

  it("short-circuits further heartbeats once the driver itself has gone terminal", () => {
    vi.useFakeTimers();
    const watchdog = new TaskWatchdog({
      totalTimeoutMs: 20,
      stepTimeoutMs: 5_000,
      stallHeartbeatMs: 5_000,
    });
    watchdog.start();
    watchdog.heartbeat({ stepNumber: 1, action: "working" });
    vi.advanceTimersByTime(50);

    // Repeated health reads stay non-persistent across many polls.
    for (let i = 0; i < 5; i++) expect(watchdog.isHealthy()).toBe(false);

    // The driver transitions to terminal...
    const terminal = watchdog.heartbeat({ stepNumber: 2, action: "driver advance" });
    expect(terminal.state).toBe("timed_out");
    expect(terminal.currentStep).toBe(2);

    // ...and then heartbeats short-circuit: the step counter no longer advances.
    const after = watchdog.heartbeat({ stepNumber: 3, action: "post-terminal" });
    expect(after.state).toBe("timed_out");
    expect(after.currentStep).toBe(2);
    expect(after.abortReason).toBe(terminal.abortReason);
    vi.useRealTimers();
  });

  it("keeps a step-timeout health read non-persistent while heartbeat still records steps", async () => {
    const watchdog = new TaskWatchdog({ stepTimeoutMs: 20, stallHeartbeatMs: 5_000 });
    watchdog.start();
    watchdog.heartbeat({ stepNumber: 1, action: "long_running_tool" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(watchdog.checkHealth().state).toBe("timed_out");
    expect(watchdog.isHealthy()).toBe(false);

    // Not persisted by the read: a fresh step is accepted and re-arms the step clock.
    const next = watchdog.heartbeat({ stepNumber: 2, action: "next_tool" });
    expect(next.currentStep).toBe(2);
    expect(next.state).toBe("healthy");
  });
});
