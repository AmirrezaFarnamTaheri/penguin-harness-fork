/**
 * PRR-01 acceptance (core half) — deletion waits for the *handlers*, not the executor's race.
 *
 * F1: the coordinator bounded handler waiting through a deadline/grace race, so
 * `activeTaskSettled` (the executor's `finally`) could resolve while a handler that ignored the
 * abort signal was still running. A Session-deletion path that awaited only that promise removed
 * the Session's Trace and scratchpad while a live handler could still write to them. The repair
 * records every owned step handler in a per-Session set and makes the returned `settled` promise
 * await them too.
 *
 * The fixture is the shape the review names: a plan handler that holds past both the step deadline
 * and the grace window and never checks its signal. What is asserted is *when* `settled` resolves,
 * because that is the promise the deletion route races against its 5s budget.
 *
 * Every test waits on `getActiveTaskId()` before aborting. `runTask` enqueues rather than starting
 * synchronously, so aborting before the task is active is a different (and much weaker) claim than
 * the one under test.
 */
import { describe, expect, it } from "vitest";
import { SwarmCoordinator } from "../src/agent/swarm-coordinator.js";

const SESSION = "session-owner";
const TASK = { id: "task-001", goal: "hold past the deadline", ownerSessionId: SESSION };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A deferred the fixture controls, standing in for a handler that will not stop on request. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Tracks whether `settled` has resolved, without ever blocking on it. */
function track(promise: Promise<unknown>): { resolved: () => boolean; when: () => Promise<void> } {
  let done = false;
  const when = promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { resolved: () => done, when: () => when };
}

/** Resolves once the task owns the executor and its first step handler is registered. */
async function waitForActive(coordinator: SwarmCoordinator, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (coordinator.getActiveTaskId() === taskId) {
      // One turn of the microtask queue so the step handler is registered before we abort.
      await sleep(0);
      return;
    }
    await sleep(5);
  }
  throw new Error(`task ${taskId} never became active`);
}

/** A plan handler that ignores its abort signal and settles only when the fixture opens the gate. */
function stubbornPlan(wait: Promise<void>) {
  return async () => {
    await wait;
    return { steps: ["never"], targetFiles: [] };
  };
}

describe("PRR-01 swarm deletion tracks owned handlers past the executor race", () => {
  it("keeps a stubborn handler alive after the executor has already settled", async () => {
    // 20ms step deadline + the coordinator's 100ms grace: 400ms is well past both, so the
    // executor's own timeout path has certainly run before the assertion.
    const coordinator = new SwarmCoordinator({ watchdogConfig: { stepTimeoutMs: 20 } });
    const held = gate();

    const run = coordinator.runTask(TASK, { onPlan: stubbornPlan(held.wait) } as never);
    await waitForActive(coordinator, TASK.id);

    const settled = track(coordinator.abortTasksForSession(SESSION, "session deleted").settled);

    await sleep(400);
    // The executor gave up on the step, but the handler it abandoned is still running, so
    // deletion must still be waiting.
    expect(settled.resolved()).toBe(false);

    held.open();
    await settled.when();
    expect(settled.resolved()).toBe(true);
    await run.catch(() => undefined);
  });

  it("settles once the stubborn handler finally returns", async () => {
    const coordinator = new SwarmCoordinator({ watchdogConfig: { stepTimeoutMs: 20 } });
    const held = gate();

    const run = coordinator.runTask(TASK, { onPlan: stubbornPlan(held.wait) } as never);
    await waitForActive(coordinator, TASK.id);

    const outcome = coordinator.abortTasksForSession(SESSION, "session deleted");
    expect(outcome.stopped).toBe(true);

    await sleep(400);
    held.open();
    await outcome.settled;
    await run.catch(() => undefined);
  });

  it("settles immediately when nothing of the Session's work is running", async () => {
    const coordinator = new SwarmCoordinator();
    const outcome = coordinator.abortTasksForSession("session-never-used", "session deleted");

    expect(outcome.stopped).toBe(false);
    await outcome.settled;
  });

  it("never settles another Session's deletion on this Session's work", async () => {
    const coordinator = new SwarmCoordinator({ watchdogConfig: { stepTimeoutMs: 20 } });
    const held = gate();

    const run = coordinator.runTask(TASK, { onPlan: stubbornPlan(held.wait) } as never);
    await waitForActive(coordinator, TASK.id);

    const mine = track(coordinator.abortTasksForSession(SESSION, "deleted").settled);
    const theirs = track(coordinator.abortTasksForSession("other-session", "deleted").settled);

    await sleep(400);
    // An unrelated Session's deletion is not blocked by work it does not own…
    expect(theirs.resolved()).toBe(true);
    // …and this Session's deletion is still waiting on its own handler.
    expect(mine.resolved()).toBe(false);

    held.open();
    await mine.when();
    await run.catch(() => undefined);
  });

  it("latches a queued task so it never starts after its Session is deleted", async () => {
    const coordinator = new SwarmCoordinator({ watchdogConfig: { stepTimeoutMs: 20 } });
    const held = gate();

    // Occupy the executor so the Session's own task can only be queued behind it.
    const blocking = coordinator.runTask(
      { id: "task-block", goal: "block", ownerSessionId: "other-session" },
      { onPlan: stubbornPlan(held.wait) } as never,
    );
    await waitForActive(coordinator, "task-block");

    let planRan = false;
    const queued = coordinator.runTask(
      { id: "task-queued", goal: "queued", ownerSessionId: SESSION },
      {
        onPlan: async () => {
          planRan = true;
          return { steps: ["x"], targetFiles: [] };
        },
      } as never,
    );
    expect(coordinator.getPendingTaskCount()).toBeGreaterThan(0);

    const outcome = coordinator.abortTasksForSession(SESSION, "session deleted");
    expect(outcome.stopped).toBe(false);
    await outcome.settled;

    held.open();
    await blocking.catch(() => undefined);
    await queued.catch(() => undefined);

    expect(planRan).toBe(false);
  });
});
