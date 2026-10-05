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
import type { SessionRow } from "../src/db/repos/sessions.js";
import {
  abortSwarmTasksForSession,
  getOrCreateProjectRuntime,
  resetCockpitRuntimesForTesting,
} from "../src/cockpit/ws.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

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
    expect(abortSwarmTasksForSession("session-3", "session deleted").stopped).toBe(0);
    expect(ownerSawAbort).toBe(false);
    expect(otherSawAbort).toBe(false);

    // The owner's deletion stops exactly the owner's task, in whichever project it lives.
    expect(abortSwarmTasksForSession("session-1", "session deleted").stopped).toBe(1);
    const ownerResult = await ownerRun;
    expect(ownerSawAbort).toBe(true);
    expect(ownerResult.status).toBe("timed_out");
    expect(ownerResult.log.join("\n")).toMatch(/Task interrupted: session deleted/);
    // The unrelated runtime kept its task running — the helper is not a global stop button.
    expect(otherSawAbort).toBe(false);
    expect(other.coordinator.getActiveTaskId()).toBe("task-other");

    // And the other Session's deletion reaches its own task, not the first one again.
    expect(abortSwarmTasksForSession("session-2", "session deleted").stopped).toBe(1);
    const otherResult = await otherRun;
    expect(otherSawAbort).toBe(true);
    expect(otherResult.status).toBe("timed_out");
  });

  it("is a no-op when nothing is running and when the task has no owner", async () => {
    const project = "swarm-unowned";
    const runtime = await getOrCreateProjectRuntime(project, { root });

    expect(abortSwarmTasksForSession("session-1", "session deleted").stopped).toBe(0);

    let sawAbort = false;
    const run = runtime.coordinator.runTask(
      { id: "task-unowned", goal: "run until stopped", simulate: true },
      hangingHandlers(() => {
        sawAbort = true;
      }),
    );
    await sleep(100);
    // An untagged task belongs to no Session; deletion must not stop work it cannot attribute.
    expect(abortSwarmTasksForSession("session-1", "session deleted").stopped).toBe(0);
    expect(sawAbort).toBe(false);
    expect(runtime.coordinator.abort("operator stop")).toBe(true);
    await run;
    expect(sawAbort).toBe(true);
  });
});

/**
 * CR: the owner tag a client sends with a swarm task is not evidence. `POST /swarm/run` must
 * resolve the Session, require it to belong to the project the task will run in, and refuse a
 * launch while that Session is being deleted — otherwise the tag names something that no
 * deletion can ever reach, which is worse than no tag at all (the task looks owned and is not).
 */
describe("POST /swarm/run validates the owner Session before tagging a task", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  const projectId = "swarm_owner_user-validation";

  const sessionRow = (sessionId: string, project: string): SessionRow => ({
    sessionId,
    projectId: project,
    agentId: "default_agent",
    provider: "custom",
    modelId: "m1",
    workspace: "/tmp/w",
    approvalMode: "allow-all",
    title: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    resetCockpitRuntimesForTesting();
    t = await createTestApp();
    const { cookie } = await provisionUser(t.app, "swarm_owner_user");
    api = apiClient(t.app, cookie);
    expect((await api.post("/api/projects", { projectId, name: "Swarm owner" })).status).toBe(201);
  });

  afterEach(async () => {
    resetCockpitRuntimesForTesting();
    await t.cleanup();
  });

  const run = (body: Record<string, unknown>) =>
    api.post(`/api/cockpit/swarm/run?project=${projectId}`, {
      goal: "owner validation fixture",
      simulate: true,
      ...body,
    });

  it("refuses a Session that does not exist, or that belongs to another project", async () => {
    // Unknown id: nothing can be resolved, so nothing may be tagged.
    const unknown = await run({ sessionId: "session-that-never-existed" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "session_not_found" } });

    // A real Session of a DIFFERENT project: tagging this project's task with it would point the
    // ownership at a conversation that never asked for the work.
    expect((await api.post("/api/projects", { projectId: "swarm_owner_user-other" })).status).toBe(
      201,
    );
    t.deps.sessionsRepo.insert(sessionRow("session-foreign", "swarm_owner_user-other"));
    const foreign = await run({ sessionId: "session-foreign" });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "session_not_found" } });

    // And the id is never silently dropped: a caller that asked for ownership and did not get it
    // is told, rather than handed an unowned task.
    expect((await run({})).status).toBe(200);
  });

  it("refuses a launch during the Session's deletion window", async () => {
    t.deps.sessionsRepo.insert(sessionRow("session-mid-delete", projectId));
    expect((await run({ sessionId: "session-mid-delete" })).status).toBe(200);

    // The deletion window is exactly the flag the Task path already refuses on, so this route
    // cannot pass a check that the Session's own work would fail.
    t.deps.manager.beginSessionDeletion("session-mid-delete");
    try {
      expect(t.deps.manager.isSessionDeleting("session-mid-delete")).toBe(true);
      const during = await run({ sessionId: "session-mid-delete" });
      expect(during.status).toBe(409);
      expect(await during.json()).toMatchObject({ error: { code: "session_deleting" } });
    } finally {
      t.deps.manager.endSessionDeletion("session-mid-delete");
    }
    // Deletion over: the Session is launchable again (the row outlives the in-memory entry).
    expect((await run({ sessionId: "session-mid-delete" })).status).toBe(200);
  });

  it("accepts an owned task and reports it like any other", async () => {
    t.deps.sessionsRepo.insert(sessionRow("session-valid", projectId));
    const res = await run({ sessionId: "session-valid" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; result: { status: string } };
    expect(body.success).toBe(true);
    expect(body.result.status).toBe("settled");
  });
});
