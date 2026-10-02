/**
 * A swarm task must not outlive the budget it was given.
 *
 * `TaskWatchdog` reports a terminal state but deliberately never aborts by itself, so a caller
 * that discards `heartbeat()`'s answer leaves `totalTimeoutMs` and `maxStepCount` as
 * documentation rather than enforcement. These tests pin the enforcement at the swarm loop, and
 * the external `abort()` that a host needs when the Session spawning the task goes away.
 */
import { describe, expect, it } from "vitest";
import { SwarmCoordinator } from "../src/agent/swarm-coordinator.js";

const TASK = { id: "task-bounded", goal: "Bound this run", files: ["src/a.ts"] };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("SwarmCoordinator task bounds", () => {
  it("stops a task that has exceeded its total time budget", async () => {
    // totalTimeoutMs far below the work's own duration: every step would finish if allowed to.
    // Without enforcement the task walks to its round cap and reports max_rounds_exceeded,
    // which names the round budget as the cause and hides the time budget that was ignored.
    const coordinator = new SwarmCoordinator({
      maxPendingTasks: 4,
      watchdogConfig: {
        totalTimeoutMs: 30,
        stepTimeoutMs: 5_000,
        stallHeartbeatMs: 60_000,
        maxStepCount: 500,
      },
    });

    const result = await coordinator.runTask(TASK, {
      onPlan: async () => ({ steps: ["step_a"] }),
      onExecute: async (_task, step) => {
        await sleep(40);
        return {
          artifacts: [{ path: "src/a.ts", summary: `did ${step}`, content: "x" }],
          summary: "did",
        };
      },
      // Never approves, so the only thing that can end this task is a bound.
      onReview: async () => ({ approved: false, grounds: "not yet" }),
    });

    expect(result.status).toBe("timed_out");
    // The budget is the point: it stopped early rather than running the rounds out.
    expect(result.rounds).toBeLessThan(3);
    // The log is the run's narrative handed back to the caller; it must name the cause, or the
    // run is the "it just ended" case this mechanism exists to replace.
    expect(result.log.join("\n")).toMatch(/Task interrupted after .*total maximum timeout/);
  });

  it("stops a task that has exceeded its step budget", async () => {
    // maxStepCount below the number of steps one round performs, so the budget is spent inside
    // the first round. Rounds alone cannot stop this — the round never completes.
    const coordinator = new SwarmCoordinator({
      watchdogConfig: {
        maxStepCount: 1,
        totalTimeoutMs: 60_000,
        stepTimeoutMs: 5_000,
        stallHeartbeatMs: 60_000,
      },
    });

    const result = await coordinator.runTask(TASK, {
      onPlan: async () => ({ steps: ["s1", "s2", "s3", "s4", "s5", "s6"] }),
      onExecute: async (_task, step) => {
        await sleep(5);
        return { artifacts: [{ path: "src/a.ts", summary: step, content: "x" }], summary: step };
      },
      onReview: async () => ({ approved: false, grounds: "not yet" }),
    });

    expect(result.status).toBe("timed_out");
  });

  it("aborts an in-flight task from outside, and the step handler sees the abort", async () => {
    const coordinator = new SwarmCoordinator({
      watchdogConfig: { totalTimeoutMs: 60_000, stepTimeoutMs: 30_000, stallHeartbeatMs: 60_000 },
    });

    let sawAbort = false;
    const running = coordinator.runTask(TASK, {
      onPlan: async () => ({ steps: ["long_step"] }),
      onExecute: async (_task, _step, _round, ctx) => {
        // A handler that hangs until told to stop is the case a step timeout alone covers only
        // after its full budget; the abort must reach it immediately.
        await new Promise<void>((resolve) => {
          ctx?.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
        return { artifacts: [], summary: "stopped" };
      },
      // Never approves, so the ONLY thing that can end this task is the external abort. An
      // approving reviewer would let it settle on its own and the assertion would pass even
      // with no interruption mechanism at all.
      onReview: async () => ({ approved: false, grounds: "not yet" }),
    });

    // Let the task reach its execute step before aborting.
    await sleep(50);
    expect(coordinator.abort("session deleted")).toBe(true);

    const result = await running;
    expect(sawAbort).toBe(true);
    expect(result.status).toBe("timed_out");
    // It stopped on the first round instead of walking to the round cap.
    expect(result.rounds).toBe(1);
    expect(result.log.join("\n")).toMatch(/Task interrupted: session deleted/);
  });

  it("stops a task only when the Session asking is its owner (E10.3)", async () => {
    const coordinator = new SwarmCoordinator({
      watchdogConfig: { totalTimeoutMs: 60_000, stepTimeoutMs: 30_000, stallHeartbeatMs: 60_000 },
    });

    let sawAbort = false;
    const running = coordinator.runTask(
      { ...TASK, ownerSessionId: "session-a" },
      {
        onPlan: async () => ({ steps: ["long_step"] }),
        onExecute: async (_task, _step, _round, ctx) => {
          await new Promise<void>((resolve) => {
            ctx?.signal.addEventListener("abort", () => {
              sawAbort = true;
              resolve();
            });
          });
          return { artifacts: [], summary: "stopped" };
        },
        onReview: async () => ({ approved: false, grounds: "not yet" }),
      },
    );
    await sleep(50);

    // A different Session, and a coordinator-level abort with no owner, must not touch it.
    expect(coordinator.abortTasksForSession("session-b", "other session deleted").stopped).toBe(
      false,
    );
    expect(sawAbort).toBe(false);

    // The owner stops it, and the run ends on the first round with the reason in its log.
    const outcome = coordinator.abortTasksForSession("session-a", "session deleted");
    expect(outcome.stopped).toBe(true);
    // The promise the deletion path waits on settles when the task has actually left the
    // executor, which is what makes it safe to remove the Session's files afterwards.
    await outcome.settled;
    const result = await running;
    expect(sawAbort).toBe(true);
    expect(result.rounds).toBe(1);
    expect(result.log.join("\n")).toMatch(/Task interrupted: session deleted/);
  });

  it("never attributes an unowned task to a Session (E10.3)", async () => {
    const coordinator = new SwarmCoordinator({
      watchdogConfig: { totalTimeoutMs: 60_000, stepTimeoutMs: 30_000, stallHeartbeatMs: 60_000 },
    });
    const running = coordinator.runTask(TASK, {
      onPlan: async () => ({ steps: ["long_step"] }),
      onExecute: async (_task, _step, _round, ctx) => {
        await new Promise<void>((resolve) => {
          ctx?.signal.addEventListener("abort", () => resolve());
        });
        return { artifacts: [], summary: "stopped" };
      },
      onReview: async () => ({ approved: false, grounds: "not yet" }),
    });
    await sleep(50);
    // A task launched without ownerSessionId belongs to nobody: a Session deletion cannot reach
    // it, and the plain abort() path still can.
    expect(coordinator.abortTasksForSession("session-a", "session deleted").stopped).toBe(false);
    expect(coordinator.abort("operator stop")).toBe(true);
    await running;
  });

  it("refuses to start queued work whose owner Session was deleted (CR)", async () => {
    const coordinator = new SwarmCoordinator({
      watchdogConfig: { totalTimeoutMs: 60_000, stepTimeoutMs: 30_000, stallHeartbeatMs: 60_000 },
    });
    const order: string[] = [];
    const handlers = (label: string, release: () => void) => ({
      onPlan: async () => ({ steps: ["step"] }),
      onExecute: async () => {
        order.push(label);
        await new Promise<void>((resolve) => {
          release();
          resolve();
        });
        return { artifacts: [], summary: label };
      },
      onReview: async () => ({ approved: true, grounds: "ok" }),
    });

    // A long task for session-a occupies the FIFO; session-b queues behind it and its Session is
    // deleted while it waits.
    let releaseActive: () => void = () => undefined;
    const active = new Promise<void>((resolve) => {
      releaseActive = () => resolve();
    });
    const first = coordinator.runTask(
      { ...TASK, id: "task-active", ownerSessionId: "session-a" },
      {
        onPlan: async () => ({ steps: ["step"] }),
        onExecute: async (_task, _step, _round, ctx) => {
          order.push("session-a");
          await Promise.race([
            active,
            new Promise<void>((resolve) => ctx?.signal.addEventListener("abort", () => resolve())),
          ]);
          return { artifacts: [], summary: "a" };
        },
        onReview: async () => ({ approved: true, grounds: "ok" }),
      },
    );
    await sleep(30);
    const queued = coordinator.runTask(
      { ...TASK, id: "task-queued", ownerSessionId: "session-b" },
      handlers("session-b", () => undefined),
    );
    await sleep(10);

    // session-b goes away while its task is still in the queue.
    expect(coordinator.abortTasksForSession("session-b", "session deleted").stopped).toBe(false);
    releaseActive();
    await first;
    const queuedResult = await queued;

    // The queued task never ran: no handler was invoked for it, and the caller got a real result
    // explaining that its owner is gone rather than silence.
    expect(order).toEqual(["session-a"]);
    expect(queuedResult.status).toBe("unhandled");
    expect(queuedResult.log.join("\n")).toMatch(
      /not started: the Session that queued it was deleted/i,
    );
  });

  it("reports abort() as a no-op when no task is running", () => {
    const coordinator = new SwarmCoordinator();
    expect(coordinator.abort("nothing to stop")).toBe(false);
  });

  it("does not carry an interruption into the next task on the same coordinator", async () => {
    const coordinator = new SwarmCoordinator({
      watchdogConfig: { totalTimeoutMs: 60_000, stepTimeoutMs: 30_000, stallHeartbeatMs: 60_000 },
    });

    const handlers = {
      onPlan: async () => ({ steps: ["s"] }),
      onExecute: async () => ({
        artifacts: [{ path: "src/a.ts", summary: "built", content: "export const a = 1;" }],
        summary: "built",
      }),
      onReview: async (_t: unknown, artifacts: Array<{ path: string }>) => ({
        approved: true,
        grounds: `verified ${artifacts[0]?.path}`,
      }),
    };

    const first = await coordinator.runTask(TASK, handlers);
    expect(first.status).toBe("settled");

    // A stale latch here would make this task return timed_out on its very first step.
    const second = await coordinator.runTask({ ...TASK, id: "task-second" }, handlers);
    expect(second.status).toBe("settled");
  });
});
