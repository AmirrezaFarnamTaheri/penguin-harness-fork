/**
 * PRR-01 acceptance (server half) — Session deletion is honest about unresolved cleanup.
 *
 * F1: DELETE /api/sessions/:id raced the Session's own work against a 5s timer. If the timer won
 * it logged a warning and carried on; a `dispose-failed` outcome also only warned. The route then
 * removed the Trace, the scratchpad and the index row and answered 204 — while a handler that
 * ignored cancellation could still be writing into files whose control surface had gone.
 *
 * Two halves are under test here, because the defect spans both:
 *
 *   - the runtime (`SessionManager`) has to *retain* a removed entry whose disposal is unresolved,
 *     remember that across a retry and across bounded history eviction, refuse recreation while
 *     the guard is up, and include retained runtimes in shutdown;
 *   - the route has to turn an unresolved cleanup into a typed 503 and keep the row, the files and
 *     the guard, and only answer 204 once cleanup is confirmed.
 *
 * Disposal failures are injected through the same `RuntimeSession` fake the existing manager suite
 * uses, so the real `disposeRemoved` path runs. The route-level case uses a real swarm handler that
 * ignores its abort signal and outlasts the route's own 5s budget, which is the review's case.
 */
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalDecision, scratchpadDir, toolCall, userText } from "@prismshadow/penguin-core";
import type { ApproveFn, OmniMessage } from "@prismshadow/penguin-core";
import { getOrCreateProjectRuntime, resetCockpitRuntimesForTesting } from "../src/cockpit/ws.js";
import { openDatabase } from "../src/db/database.js";
import { SessionsRepo } from "../src/db/repos/sessions.js";
import type { SessionRow } from "../src/db/repos/sessions.js";
import { ChannelHub } from "../src/runtime/channel.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import type { RuntimeSession, SessionLoader } from "../src/runtime/session-manager.js";
import { SessionSources } from "../src/runtime/session-sources.js";
import type { ProjectCreateResponse, SessionCreateResponse } from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser, waitFor } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const ROW: SessionRow = {
  sessionId: "session-1",
  projectId: "p1",
  agentId: "a1",
  modelId: "m1",
  provider: "custom",
  workspace: "/tmp/w",
  approvalMode: "always-ask",
  title: null,
  createdAt: "2026-07-06T00:00:00.000Z",
  lastActiveAt: "2026-07-06T00:00:00.000Z",
};

/** A scriptable fake Session whose disposal the fixture decides. */
function fakeSession(sessionId: string, dispose: () => void | Promise<void>): RuntimeSession {
  return {
    sessionId,
    toolPermission: () => "rw",
    generateTitle: async () => ({ title: null, usage: null }),
    compactability: () => "ok" as const,
    steer: () => false,
    skipReconnectWait: () => false,
    async *run(_input: OmniMessage[], opts: { approve: ApproveFn; signal: AbortSignal }) {
      const tc = toolCall({ name: "write_file", arguments: "{}", toolCallId: "tc-1" });
      yield tc;
      yield approvalDecision(await opts.approve(tc), "tc-1");
      yield { type: "abort" } as never;
    },
    async *compact() {
      /* unused */
    },
    dispose,
  };
}

const loaderOf = (session: RuntimeSession): SessionLoader => ({ load: async () => session });

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletion legitimately keeps answering 503 while the Session's own cleanup is still draining, so
 * the retry has to be a poll rather than a single request. Returns the first non-503 status, or
 * the last status seen if the budget runs out — so a test asserting 204 cannot pass on a 503.
 */
async function retryDeletion(
  client: ReturnType<typeof apiClient>,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let status = 0;
  for (;;) {
    const res = await client.delete(`/api/sessions/${sessionId}`);
    status = res.status;
    if (status !== 503 || Date.now() > deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("PRR-01 SessionManager retains runtimes whose cleanup is unresolved", () => {
  let db: DatabaseSync;
  let sessions: SessionsRepo;
  let channels: ChannelHub;
  let sources: SessionSources;

  const makeManager = (loader: SessionLoader): SessionManager =>
    new SessionManager({
      sessions,
      channels,
      sources,
      loader,
      recorder: { record: async () => {} },
      log: () => {},
    });

  beforeEach(() => {
    db = openDatabase(":memory:");
    sessions = new SessionsRepo(db);
    sessions.insert(ROW);
    channels = new ChannelHub();
    sources = new SessionSources();
  });
  afterEach(() => {
    channels.dispose();
    db.close();
  });

  it("reports pending cleanup while a removed runtime has not been disposed yet", async () => {
    let dispose!: () => void;
    const held = new Promise<void>((resolve) => {
      dispose = resolve;
    });
    const manager = makeManager(
      loaderOf(
        fakeSession("session-1", async () => {
          await held;
        }),
      ),
    );
    sessions.updateApprovalMode("session-1", "allow-all");
    await manager.startTask("session-1", [userText("go")]);
    await waitFor(() => manager.statusOf("session-1") === "idle");

    manager.beginSessionDeletion("session-1");
    // The entry left the active table, but the Session it belonged to is still retained: the
    // route must not report success while this is true.
    expect(manager.hasPendingSessionCleanup("session-1")).toBe(true);
    // And the deletion guard refuses recreation for as long as cleanup is unresolved.
    const rejected = await manager
      .startTask("session-1", [userText("again")])
      .catch((e: unknown) => e);
    expect((rejected as { status?: number }).status).toBe(409);

    dispose();
    await waitFor(() => manager.disposeOutcomeOf("session-1") === "disposed");
    manager.endSessionDeletion("session-1");
    expect(manager.hasPendingSessionCleanup("session-1")).toBe(false);
  });

  it("retains a failed disposal and retries it on the next deletion attempt", async () => {
    let attempts = 0;
    const manager = makeManager(
      loaderOf(
        fakeSession("session-1", () => {
          attempts += 1;
          if (attempts === 1) throw new Error("environment release failed");
        }),
      ),
    );
    sessions.updateApprovalMode("session-1", "allow-all");
    await manager.startTask("session-1", [userText("go")]);
    await waitFor(() => manager.statusOf("session-1") === "idle");

    manager.beginSessionDeletion("session-1");
    await waitFor(() => manager.disposeOutcomeOf("session-1") === "dispose-failed");
    expect(manager.hasPendingSessionCleanup("session-1")).toBe(true);

    // The route retries rather than forgetting the runtime; the retry actually runs dispose.
    manager.beginSessionDeletion("session-1");
    await waitFor(() => manager.disposeOutcomeOf("session-1") === "disposed");
    expect(attempts).toBe(2);
    manager.endSessionDeletion("session-1");
    expect(manager.hasPendingSessionCleanup("session-1")).toBe(false);
  });

  it("keeps a pending cleanup outcome across bounded outcome-history eviction", async () => {
    const manager = makeManager(loaderOf(fakeSession("session-1", () => {})));
    sessions.updateApprovalMode("session-1", "allow-all");
    await manager.startTask("session-1", [userText("go")]);
    await waitFor(() => manager.statusOf("session-1") === "idle");

    manager.beginSessionDeletion("session-1");
    await waitFor(() => manager.disposeOutcomeOf("session-1") === "disposed");
    // The Session is still retained because the caller has not confirmed cleanup, so its outcome
    // must survive however many unrelated sessions churn through the bounded history after it.
    for (let index = 0; index < 40; index++) {
      const id = `session-churn-${index}`;
      sessions.insert({ ...ROW, sessionId: id });
      const churn = makeManager(loaderOf(fakeSession(id, () => {})));
      churn.endSessionDeletion(id);
    }
    expect(manager.hasPendingSessionCleanup("session-1")).toBe(true);
    manager.endSessionDeletion("session-1");
  });

  it("retries a retained runtime's failed disposal during shutdown", async () => {
    let disposals = 0;
    const manager = makeManager(
      loaderOf(
        fakeSession("session-1", () => {
          disposals += 1;
          if (disposals === 1) throw new Error("environment release failed");
        }),
      ),
    );
    sessions.updateApprovalMode("session-1", "allow-all");
    await manager.startTask("session-1", [userText("go")]);
    await waitFor(() => manager.statusOf("session-1") === "idle");

    // Deletion gave up on a failed disposal, so the entry is retained and nothing else in the
    // process will ever retry it: if shutdown does not see it, the Session's background processes
    // outlive the harness with no UI and no further deletion attempt to reach them.
    manager.beginSessionDeletion("session-1");
    await waitFor(() => manager.disposeOutcomeOf("session-1") === "dispose-failed");
    expect(disposals).toBe(1);

    await manager.shutdown();
    expect(disposals).toBe(2);
    expect(manager.disposeOutcomeOf("session-1")).toBe("disposed");
  });

  it("refuses new work only while the guard is up", async () => {
    const manager = makeManager(loaderOf(fakeSession("session-1", () => {})));
    sessions.updateApprovalMode("session-1", "allow-all");
    await manager.startTask("session-1", [userText("go")]);
    await waitFor(() => manager.statusOf("session-1") === "idle");

    manager.beginSessionDeletion("session-1");
    const refused = await manager.startTask("session-1", [userText("x")]).catch((e: unknown) => e);
    expect((refused as { status?: number }).status).toBe(409);

    manager.endSessionDeletion("session-1");
    await manager.startTask("session-1", [userText("x")]);
    expect(manager.statusOf("session-1")).not.toBe("gone");
  });

  it("bounds a hung disposal instead of letting deletion hang on it", async () => {
    // A dispose() that never settles is the hardest case: there is no outcome to report, so the
    // bounded query must return "still pending" and the runtime must stay retained rather than
    // being reported as cleanly cleaned up.
    const manager = makeManager(
      loaderOf(fakeSession("session-1", () => new Promise<void>(() => {}))),
    );
    sessions.updateApprovalMode("session-1", "allow-all");
    await manager.startTask("session-1", [userText("go")]);
    await waitFor(() => manager.statusOf("session-1") === "idle");

    expect(manager.beginSessionDeletion("session-1")).toEqual([]);
    const started = Date.now();
    // This is what the route calls: it must come back, and it must not claim success.
    expect(await manager.disposeOutcomeWithin("session-1", 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(manager.disposeOutcomeOf("session-1")).not.toBe("disposed");
    expect(manager.hasPendingSessionCleanup("session-1")).toBe(true);
    manager.endSessionDeletion("session-1");
  });
});

describe("PRR-01 DELETE reports cleanup that never resolved", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    resetCockpitRuntimesForTesting();
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_p1");
    owner = apiClient(t.app, a.cookie);
    const created = (await (
      await owner.post("/api/projects", { projectId: "owner_p1-cleanup", name: "cleanup project" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    await owner.put(`/api/projects/${projectId}/models`, {
      defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      models: [{ provider: "anthropic", modelId: "claude-sonnet-4-6" }],
    });
  });
  afterEach(async () => {
    resetCockpitRuntimesForTesting();
    await t.cleanup();
  });

  const newSession = async (): Promise<string> => {
    const created = await owner.post(
      `/api/projects/${projectId}/agents/default_agent/sessions`,
      {},
    );
    const { session } = (await created.json()) as SessionCreateResponse;
    return session.sessionId;
  };

  const scratchpad = (sessionId: string): string =>
    path.join(scratchpadDir(t.root, projectId, "default_agent"), sessionId);

  it("still answers 204 when nothing is outstanding", async () => {
    const sessionId = await newSession();
    await fs.mkdir(scratchpad(sessionId), { recursive: true });
    await fs.writeFile(path.join(scratchpad(sessionId), "upload-1.png"), "fake");

    expect((await owner.delete(`/api/sessions/${sessionId}`)).status).toBe(204);
    expect(await exists(scratchpad(sessionId))).toBe(false);
  });

  it("answers 503 and keeps every resource when a handler outlasts the deadline", async () => {
    const sessionId = await newSession();
    await fs.mkdir(scratchpad(sessionId), { recursive: true });
    await fs.writeFile(path.join(scratchpad(sessionId), "upload-1.png"), "fake");

    // The review's case: a swarm handler that ignores its abort signal. The coordinator's step
    // deadline is far below the route's own 5s budget, so the executor gives up first — which is
    // exactly the state the repair has to notice. Waiting that budget out is the point, so the
    // test carries a timeout above vitest's 5s default.
    const runtime = await getOrCreateProjectRuntime(projectId, { root: t.root });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runtime.coordinator.runTask(
      {
        id: "task-outlasts-deletion",
        goal: "ignore cancellation",
        ownerSessionId: sessionId,
      },
      {
        onPlan: async () => {
          await held;
          return { steps: ["late"] };
        },
        onExecute: async () => ({ artifacts: [], summary: "late" }),
        onReview: async () => ({ approved: false, grounds: "not yet" }),
      },
    );
    await waitFor(() => runtime.coordinator.getActiveTaskId() === "task-outlasts-deletion");

    const deleted = await owner.delete(`/api/sessions/${sessionId}`);
    expect(deleted.status).toBe(503);
    const body = (await deleted.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("session_cleanup_pending");
    expect(body.error.message).toMatch(/resources were retained/i);

    // Nothing was removed: the files a still-running handler could write into are still there,
    // and the Session row survives so a retry has something to act on.
    expect(await exists(scratchpad(sessionId))).toBe(true);
    const stillListed = await owner.get(`/api/projects/${projectId}/agents/default_agent/sessions`);
    const listing = (await stillListed.json()) as { sessions: { sessionId: string }[] };
    expect(listing.sessions.map((s) => s.sessionId)).toContain(sessionId);

    // Once the handler really stops, a retry completes the deletion for real.
    release();
    await running.catch(() => undefined);
    const retryStatus = await retryDeletion(owner, sessionId);
    expect(retryStatus).toBe(204);
    expect(await exists(scratchpad(sessionId))).toBe(false);
    resetCockpitRuntimesForTesting();
  }, 20_000);

  it("does not recreate removed files with cleanup writes after a successful deletion", async () => {
    const sessionId = await newSession();
    const dir = scratchpad(sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "upload-1.png"), "fake");

    expect((await owner.delete(`/api/sessions/${sessionId}`)).status).toBe(204);

    // The cleanup writes that follow deletion must not revive the directory: a stray scratchpad
    // with no Session row is exactly what the deletion guard exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await exists(dir)).toBe(false);
  });
});
