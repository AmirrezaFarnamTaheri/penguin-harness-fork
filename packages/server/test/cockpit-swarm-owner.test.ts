/**
 * E10.3 at the server seam: a swarm task started from a conversation must not outlive that
 * conversation's deletion.
 *
 * The coordinator's lifetime is the project's, not a Session's, so before this the only way to
 * end a swarm was its own round cap. These tests drive the seam the delete route calls
 * (`abortSwarmTasksForSession`) against real project runtimes: the owner's task stops, and every
 * other runtime — including one in a different project — is left alone.
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortSwarmTasksForSession,
  getOrCreateProjectRuntime,
  resetCockpitRuntimesForTesting,
} from "../src/cockpit/ws.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Handlers whose execute step hangs until the abort reaches the step's signal. */
function hangingHandlers(onAbort?: () => void) {
  return {
    onPlan: async () => ({ steps: ["long_step"] }),
    onExecute: async (
      _task: unknown,
      _step: string,
      _round: number,
      ctx?: { signal: AbortSignal },
    ): Promise<{ artifacts: never[]; summary: string }> => {
      await new Promise<void>((resolve) => {
        if (ctx?.signal.aborted) {
          onAbort?.();
          resolve();
          return;
        }
        ctx?.signal.addEventListener("abort", () => {
          onAbort?.();
          resolve();
        });
      });
      return { artifacts: [], summary: "stopped" };
    },
    // Never approves: the abort is the only thing that can end the run early.
    onReview: async () => ({ approved: false, grounds: "not yet" }),
  };
}

describe("swarm tasks are owned by the Session that started them", () => {
  let root: string;

  beforeEach(async () => {
    resetCockpitRuntimesForTesting();
    root = await fs.mkdtemp(path.join(tmpdir(), "penguin-swarm-owner-"));
  });

  afterEach(async () => {
    resetCockpitRuntimesForTesting();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stops the owner's running task and nothing else", async () => {
    const ownerProject = "swarm-owner";
    const otherProject = "swarm-other";
    const owner = await getOrCreateProjectRuntime(ownerProject, { root });
    const other = await getOrCreateProjectRuntime(otherProject, { root });

    let ownerSawAbort = false;
    let otherSawAbort = false;
    const ownerRun = owner.coordinator.runTask(
      { id: "task-owner", goal: "run until stopped", simulate: true, ownerSessionId: "session-1" },
      hangingHandlers(() => {
        ownerSawAbort = true;
      }),
    );
    const otherRun = other.coordinator.runTask(
      { id: "task-other", goal: "run until stopped", simulate: true, ownerSessionId: "session-2" },
      hangingHandlers(() => {
        otherSawAbort = true;
      }),
    );
    // Let both tasks reach their hanging execute step.
    await sleep(100);

    // A deletion for a Session that owns neither task stops neither.
    expect(abortSwarmTasksForSession("session-3", "session deleted")).toBe(0);
    expect(ownerSawAbort).toBe(false);
    expect(otherSawAbort).toBe(false);

    // The owner's deletion stops exactly the owner's task, in whichever project it lives.
    expect(abortSwarmTasksForSession("session-1", "session deleted")).toBe(1);
    const ownerResult = await ownerRun;
    expect(ownerSawAbort).toBe(true);
    expect(ownerResult.status).toBe("timed_out");
    expect(ownerResult.log.join("\n")).toMatch(/Task interrupted: session deleted/);
    // The unrelated runtime kept its task running — the helper is not a global stop button.
    expect(otherSawAbort).toBe(false);
    expect(other.coordinator.getActiveTaskId()).toBe("task-other");

    // And the other Session's deletion reaches its own task, not the first one again.
    expect(abortSwarmTasksForSession("session-2", "session deleted")).toBe(1);
    const otherResult = await otherRun;
    expect(otherSawAbort).toBe(true);
    expect(otherResult.status).toBe("timed_out");
  });

  it("is a no-op when nothing is running and when the task has no owner", async () => {
    const project = "swarm-unowned";
    const runtime = await getOrCreateProjectRuntime(project, { root });

    expect(abortSwarmTasksForSession("session-1", "session deleted")).toBe(0);

    let sawAbort = false;
    const run = runtime.coordinator.runTask(
      { id: "task-unowned", goal: "run until stopped", simulate: true },
      hangingHandlers(() => {
        sawAbort = true;
      }),
    );
    await sleep(100);
    // An untagged task belongs to no Session; deletion must not stop work it cannot attribute.
    expect(abortSwarmTasksForSession("session-1", "session deleted")).toBe(0);
    expect(sawAbort).toBe(false);
    expect(runtime.coordinator.abort("operator stop")).toBe(true);
    await run;
    expect(sawAbort).toBe(true);
  });
});
