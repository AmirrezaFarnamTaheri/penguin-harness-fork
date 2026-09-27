/**
 * The advisory surface observations, as seen from the runtime that fires them.
 *
 * The core suite (packages/core/test/jev-surfaces-invariants.test.ts) proves the observer
 * itself cannot block or decide. This suite proves the other half, which is the half that
 * actually runs in production: that the places that FIRE an observation — a turn ending, a
 * compaction being requested, a session going quiet, a session entering the active table —
 * behave identically when the observer is hostile, slow, or absent.
 *
 * "Identically" is the operative word. A surface that quietly made a Task slower, or that let
 * a provider failure change a run's outcome, would be a blocker wearing an advisory's name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  assistantText,
  compactionBegin,
  compactionEnd,
  toolCall,
  toolCallOutput,
  userText,
} from "@prismshadow/penguin-core";
import type { OmniMessage } from "@prismshadow/penguin-core";
import { openDatabase } from "../src/db/database.js";
import { SessionsRepo } from "../src/db/repos/sessions.js";
import type { SessionRow } from "../src/db/repos/sessions.js";
import { ChannelHub } from "../src/runtime/channel.js";
import {
  SessionManager,
  type AdvisorySurfaceFacts,
  type AdvisorySurfaceObserver,
  type RuntimeSession,
  type SessionLoader,
} from "../src/runtime/session-manager.js";
import { SessionSources } from "../src/runtime/session-sources.js";
import { waitFor } from "./helpers.js";

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

function fakeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    sessionId: ROW.sessionId,
    toolPermission: () => "rw",
    generateTitle: async () => ({ title: null, usage: null }),
    compactability: () => "ok" as const,
    steer: () => false,
    skipReconnectWait: () => false,
    async *run(input: OmniMessage[]) {
      yield assistantText("working");
      yield toolCall({ name: "read_file", arguments: "{}", toolCallId: "tc-1" });
      yield toolCallOutput({ output: "ok", toolCallId: "tc-1" });
      yield assistantText("done");
    },
    async *compact() {
      yield compactionBegin({ reason: "manual", mode: "summarize", context: 1, turns: 1 });
      yield compactionEnd({ reason: "manual", mode: "summarize", status: "completed" });
    },
    ...overrides,
  } as RuntimeSession;
}

/** Records what the runtime observed, and can be told to misbehave on demand. */
class RecordingObserver implements AdvisorySurfaceObserver {
  readonly calls: Array<AdvisorySurfaceFacts & { key: string }> = [];
  mode: "record" | "throw" = "record";

  notify(input: AdvisorySurfaceFacts & { key: string }): void {
    if (this.mode === "throw") throw new Error("observer exploded");
    this.calls.push(input);
  }
}

describe("SessionManager: advisory surface observations", () => {
  let db: DatabaseSync;
  let sessions: SessionsRepo;
  let channels: ChannelHub;
  let sources: SessionSources;
  let observer: RecordingObserver;

  const loaderOf = (session: RuntimeSession): SessionLoader => ({ load: async () => session });

  const makeManager = (session: RuntimeSession, withObserver: boolean): SessionManager =>
    new SessionManager({
      sessions,
      channels,
      sources,
      loader: loaderOf(session),
      recorder: { record: async () => {} },
      ...(withObserver ? { jevSurfaces: observer } : {}),
      log: () => {},
    });

  beforeEach(() => {
    db = openDatabase(":memory:");
    sessions = new SessionsRepo(db);
    sessions.insert(ROW);
    channels = new ChannelHub();
    sources = new SessionSources();
    observer = new RecordingObserver();
  });
  afterEach(() => {
    channels.dispose();
    db.close();
  });

  const runTaskToIdle = async (manager: SessionManager): Promise<void> => {
    await manager.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => manager.statusOf(ROW.sessionId) === "idle");
  };

  it("observes the turn boundary with counts, not content", async () => {
    const manager = makeManager(fakeSession(), true);
    await runTaskToIdle(manager);
    const turn = observer.calls.find((c) => c.surface === "turn");
    expect(turn).toBeDefined();
    expect(turn).toMatchObject({
      key: ROW.sessionId,
      outcome: "completed",
      messageCount: 4,
      subagentsSpawned: 0,
      contextAvailability: "ok",
      provider: "custom",
      modelId: "m1",
    });
    expect(typeof turn!.durationMs).toBe("number");
    // The whole point of the closed fact shape: there is nowhere to put the user's text.
    expect(JSON.stringify(turn)).not.toContain("go");
  });

  it("observes context pressure at the end of a turn", async () => {
    const manager = makeManager(fakeSession(), true);
    await runTaskToIdle(manager);
    const context = observer.calls.find((c) => c.surface === "context");
    expect(context).toMatchObject({ trigger: "turn_end", availability: "ok" });
  });

  it("observes a compaction request, and still refuses it on the harness's own rule", async () => {
    // The 409 is the harness's deterministic answer. The observation rides alongside it and
    // changes nothing — which is exactly the shape of every interaction here.
    const manager = makeManager(
      fakeSession({ compactability: () => "just_compacted" as const }),
      true,
    );
    await manager.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => manager.statusOf(ROW.sessionId) === "idle");

    await expect(manager.startCompact(ROW.sessionId)).rejects.toThrow(/compacted/i);
    const context = observer.calls.find(
      (c) => c.surface === "context" && c.trigger === "compaction_requested",
    );
    expect(context).toMatchObject({ availability: "just_compacted" });
  });

  it("observes a session entering the active table", () => {
    makeManager(fakeSession(), true).adopt(ROW, fakeSession());
    expect(observer.calls).toContainEqual(
      expect.objectContaining({
        surface: "session",
        event: "resumed",
        key: ROW.sessionId,
        backgroundProcesses: 0,
        backgroundSubagents: 0,
      }),
    );
  });

  it("observes the long silence that precedes an idle eviction", async () => {
    const manager = makeManager(fakeSession(), true);
    await runTaskToIdle(manager);
    observer.calls.length = 0;
    // Evict the entry: idle, no approvals, no queued work, and far past the idle window.
    manager.sweepIdle(Date.now() + 24 * 60 * 60 * 1000, 1);
    expect(observer.calls).toContainEqual(
      expect.objectContaining({
        surface: "session",
        event: "long_silence",
        key: ROW.sessionId,
      }),
    );
    const silence = observer.calls.find(
      (c) => c.surface === "session" && c.event === "long_silence",
    ) as Extract<AdvisorySurfaceFacts, { surface: "session" }> & { key: string };
    expect(silence.idleMs).toBeGreaterThan(0);
  });

  it("observes an abnormal end when the run's generator throws", async () => {
    const manager = makeManager(
      fakeSession({
        run: async function* (): AsyncGenerator<OmniMessage> {
          yield assistantText("starting");
          throw new Error("infrastructure died");
        } as RuntimeSession["run"],
      }),
      true,
    );
    await runTaskToIdle(manager);
    expect(observer.calls).toContainEqual(
      expect.objectContaining({ surface: "turn", outcome: "errored" }),
    );
    expect(observer.calls).toContainEqual(
      expect.objectContaining({ surface: "session", event: "abnormal_end" }),
    );
  });

  it("records an aborted run as aborted, not as an error", async () => {
    const manager = makeManager(
      fakeSession({
        run: async function* (
          _input: OmniMessage[],
          opts: { approve: unknown; signal: AbortSignal },
        ): AsyncGenerator<OmniMessage> {
          yield assistantText("starting");
          await new Promise((resolve) =>
            opts.signal.addEventListener("abort", resolve, { once: true }),
          );
          return;
        } as unknown as RuntimeSession["run"],
      }),
      true,
    );
    const started = manager.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => manager.statusOf(ROW.sessionId) === "running");
    manager.abortTask(ROW.sessionId);
    await started;
    await waitFor(() => manager.statusOf(ROW.sessionId) === "idle");
    expect(observer.calls).toContainEqual(
      expect.objectContaining({ surface: "turn", outcome: "aborted" }),
    );
  });
});

describe("SessionManager: an observer can never fail or delay the operation it observes", () => {
  let db: DatabaseSync;
  let sessions: SessionsRepo;
  let channels: ChannelHub;
  let sources: SessionSources;
  let observer: RecordingObserver;

  const loaderOf = (session: RuntimeSession): SessionLoader => ({ load: async () => session });
  const makeManager = (session: RuntimeSession): SessionManager =>
    new SessionManager({
      sessions,
      channels,
      sources,
      loader: loaderOf(session),
      recorder: { record: async () => {} },
      jevSurfaces: observer,
      log: () => {},
    });

  beforeEach(() => {
    db = openDatabase(":memory:");
    sessions = new SessionsRepo(db);
    sessions.insert(ROW);
    channels = new ChannelHub();
    sources = new SessionSources();
    observer = new RecordingObserver();
  });
  afterEach(() => {
    channels.dispose();
    db.close();
  });

  it("completes the turn identically when the observer throws on every call", async () => {
    observer.mode = "throw";
    const manager = makeManager(fakeSession());
    await manager.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => manager.statusOf(ROW.sessionId) === "idle");
    // The Task ran to completion, published its idle flip, and released its row — the
    // observer's failures changed nothing a caller can observe.
    expect(manager.statusOf(ROW.sessionId)).toBe("idle");
    expect(sessions.findById(ROW.sessionId)).not.toBeNull();
  });

  it("does not hold the Task open for an observation that has not come back yet", async () => {
    // Models the shipped advisor's real shape: notify() returns on the same tick and the
    // provider call is in flight behind it. The Task must reach idle while that call is
    // still outstanding — if the runtime awaited the observer, idle would not arrive until
    // the provider answered or timed out, and every turn's latency would carry the advisory's.
    let inFlight = 0;
    const slowObserver: AdvisorySurfaceObserver = {
      notify: () => {
        inFlight += 1;
        void new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => {
          inFlight -= 1;
        });
      },
    };
    const manager = new SessionManager({
      sessions,
      channels,
      sources,
      loader: loaderOf(fakeSession()),
      recorder: { record: async () => {} },
      jevSurfaces: slowObserver,
      log: () => {},
    });

    await manager.startTask(ROW.sessionId, [userText("go")]);
    // Reaching idle at all, with two observations still in flight, is the assertion: the
    // 5s the observer needs is not on this path.
    await waitFor(() => manager.statusOf(ROW.sessionId) === "idle", 2_000);
    expect(inFlight).toBeGreaterThan(0);
    expect(manager.statusOf(ROW.sessionId)).toBe("idle");
  });

  it("behaves identically with no observer at all", async () => {
    // "Optional" has to mean optional: with the dep absent, the same Task reaches the same
    // idle state and nothing anywhere reaches for an observation.
    const without = new SessionManager({
      sessions,
      channels,
      sources,
      loader: loaderOf(fakeSession()),
      recorder: { record: async () => {} },
      log: () => {},
    });
    observer.calls.length = 0;
    await without.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => without.statusOf(ROW.sessionId) === "idle");
    expect(without.statusOf(ROW.sessionId)).toBe("idle");
    expect(observer.calls).toEqual([]);
    // And the same task with an observer attached reaches the same state.
    const withObserver = makeManager(fakeSession());
    observer.calls.length = 0;
    await withObserver.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => withObserver.statusOf(ROW.sessionId) === "idle");
    expect(withObserver.statusOf(ROW.sessionId)).toBe("idle");
    expect(observer.calls.length).toBeGreaterThan(0);
  });

  it("still refuses a compaction identically with an observer attached", async () => {
    const manager = makeManager(fakeSession({ compactability: () => "empty" as const }));
    await manager.startTask(ROW.sessionId, [userText("go")]);
    await waitFor(() => manager.statusOf(ROW.sessionId) === "idle");
    await expect(manager.startCompact(ROW.sessionId)).rejects.toThrow(/nothing to compact/i);
  });
});
