/**
 * pinned-sessions.ts unit tests: the sidebar conversation list's row-level pin. Pinned
 * ids persist per Project in localStorage (injectable storage; no server field exists —
 * SessionPatchRequest accepts no pin, so persistence is deliberately frontend-side):
 * nothing stored or corrupted storage degrades to "nothing pinned", junk array elements
 * are dropped, Projects are isolated, and deleting a Session prunes its id (other stale
 * ids stay inert — a pin is a pure membership test). Ordering composes with the group
 * lists through the same pinnedFirst helper the group pins use: the pinned cluster
 * sits at the top of a group's ACTIVE rows in either grouping mode, keeping each
 * partition's own recency order; folder rows are untouched.
 */
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prismshadow/penguin-server/api";
import {
  addPinnedSessions,
  loadPinnedSessions,
  pinnedSessionsKey,
  removePinnedSession,
  removePinnedSessions,
  savePinnedSessions,
  togglePinnedSession,
} from "../src/lib/pinned-sessions";
import type { PinnedSessionsStorage } from "../src/lib/pinned-sessions";
import { partitionSessions, pinnedFirst } from "../src/lib/session-grouping";

/** In-memory storage (vitest runs in a Node environment, no localStorage; draft-cache.test.ts convention). */
function memStorage(): PinnedSessionsStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

/** Minimal SessionInfo (session-grouping.test.ts convention: only the fields the logic reads matter). */
function session(
  sessionId: string,
  over: { archived?: boolean; source?: "schedule" | "subagent" } = {},
): SessionInfo {
  return {
    sessionId,
    projectId: "proj",
    agentId: "default_agent",
    provider: "custom",
    modelId: "claude-4-8",
    workspace: "/w",
    approvalMode: "allow-all",
    createdAt: "2026-08-13T00:00:00.000Z",
    lastActiveAt: "2026-08-13T00:00:00.000Z",
    status: "idle",
    pendingApprovalCount: 0,
    pendingFollowUpCount: 0,
    hasTrace: false,
    archived: over.archived ?? false,
    ...(over.source ? { source: over.source } : {}),
  };
}

describe("persisted pins (per-Project localStorage)", () => {
  it("nothing stored — or no Project yet — is the empty set, and reading never writes", () => {
    const s = memStorage();
    expect(loadPinnedSessions("p1", s).size).toBe(0);
    expect(loadPinnedSessions(null, s).size).toBe(0);
    expect(s.map.size).toBe(0); // load never writes; save without a Project is a no-op
    savePinnedSessions(null, new Set(["a"]), s);
    expect(s.map.size).toBe(0);
  });

  it("toggle → save → load round-trips the user's set (fresh instance per load)", () => {
    const s = memStorage();
    let set = loadPinnedSessions("p1", s);
    set = togglePinnedSession(set, "session-a");
    set = togglePinnedSession(set, "session-b");
    savePinnedSessions("p1", set, s);
    const restored = loadPinnedSessions("p1", s);
    expect(restored).toEqual(new Set(["session-a", "session-b"]));
    expect(restored).not.toBe(set);
  });

  it("Projects are isolated: each key holds its own set", () => {
    const s = memStorage();
    savePinnedSessions("p1", new Set(["a"]), s);
    savePinnedSessions("p2", new Set(["b", "c"]), s);
    expect([...loadPinnedSessions("p1", s)]).toEqual(["a"]);
    expect(loadPinnedSessions("p2", s)).toEqual(new Set(["b", "c"]));
    expect(loadPinnedSessions("p3", s).size).toBe(0);
  });

  it("malformed JSON / non-array shapes degrade to empty; junk array elements are dropped", () => {
    const s = memStorage();
    for (const raw of ["{not json", '"a"', "42", "null", "{}", ""]) {
      s.map.set(pinnedSessionsKey("p1"), raw);
      expect(loadPinnedSessions("p1", s).size).toBe(0);
    }
    s.map.set(pinnedSessionsKey("p1"), '["a", 7, null, {"x": 1}]');
    expect([...loadPinnedSessions("p1", s)]).toEqual(["a"]);
  });

  it("storage throwing (quota/private mode): save does not throw, load yields empty", () => {
    const broken: PinnedSessionsStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => savePinnedSessions("p1", new Set(["a"]), broken)).not.toThrow();
    expect(loadPinnedSessions("p1", broken).size).toBe(0);
  });

  it("storage whose GETTER throws (blocked site data / partitioned iframe) degrades instead of escaping", () => {
    // These loaders run from useState initializers, so an escaping SecurityError would
    // take the sidebar's first render down — hence localStorage is resolved inside the try.
    const hostile = {
      get getItem(): never {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    } as unknown as PinnedSessionsStorage;
    expect(() => loadPinnedSessions("p1", hostile)).not.toThrow();
    expect(loadPinnedSessions("p1", hostile).size).toBe(0);
  });
});

describe("togglePinnedSession / removePinnedSession", () => {
  it("toggle adds an absent id and removes a present one, without mutating the input", () => {
    const initial = new Set(["a"]);
    const withB = togglePinnedSession(initial, "b");
    expect(withB).toEqual(new Set(["a", "b"]));
    expect(initial.has("b")).toBe(false); // input untouched (React state discipline)
    expect(togglePinnedSession(withB, "a")).toEqual(new Set(["b"]));
  });

  it("remove prunes a pinned id and returns the SAME set when it wasn't pinned (delete-path fast exit)", () => {
    const pins: ReadonlySet<string> = new Set(["a", "b"]);
    expect(removePinnedSession(pins, "a")).toEqual(new Set(["b"]));
    expect(removePinnedSession(pins, "zzz")).toBe(pins); // same reference: caller skips state + storage writes
  });
});

describe("pinned ordering composes with the group lists", () => {
  it("the pinned cluster tops a group's active rows, each partition keeping its own order; stale ids are inert", () => {
    const rows = [
      session("s1"),
      session("s2"),
      session("s3"),
      session("s4", { archived: true }),
      session("s5", { source: "subagent" }),
    ];
    // Both grouping modes feed the shared group body the same way: partition first,
    // then pinnedFirst over the ACTIVE rows only (pinning is an active-list priority).
    const parts = partitionSessions(rows);
    const pins = new Set(["s3", "deleted-elsewhere"]);
    const active = pinnedFirst(parts.active, (s) => s.sessionId, pins);
    expect(active.map((s) => s.sessionId)).toEqual(["s3", "s1", "s2"]);
    // Folder rows keep chronological order and membership regardless of pins …
    expect(parts.archived.map((s) => s.sessionId)).toEqual(["s4"]);
    expect(parts.subagent.map((s) => s.sessionId)).toEqual(["s5"]);
    // … and a stored id of a Session deleted elsewhere never surfaces a row.
    expect(active.some((s) => s.sessionId === "deleted-elsewhere")).toBe(false);
  });

  it("no pins = the group's original order, untouched", () => {
    const rows = [session("s1"), session("s2")];
    const active = pinnedFirst(partitionSessions(rows).active, (s) => s.sessionId, new Set());
    expect(active.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });
});

/**
 * Batch pin/unpin: the conversation list's selection bar acts on every marked row at once.
 * The contract these two share with the single-row helpers is the same one the sidebar
 * depends on — one immutable pass, and the INPUT reference back when nothing changed, so
 * a no-op batch costs no re-render of a list that can hold hundreds of rows.
 */
describe("batch pin / unpin", () => {
  it("adds a whole selection in one pass, keeping the order it was given", () => {
    const pinned = new Set(["s0"]);
    const next = addPinnedSessions(pinned, ["s3", "s1", "s2"]);
    expect([...next]).toEqual(["s0", "s3", "s1", "s2"]);
    // The input is untouched, and re-adding a known id changes nothing.
    expect([...pinned]).toEqual(["s0"]);
    expect(addPinnedSessions(next, ["s1"])).toBe(next);
  });

  it("returns the input reference when every id was already pinned", () => {
    const pinned = new Set(["s1", "s2"]);
    expect(addPinnedSessions(pinned, ["s1", "s2"])).toBe(pinned);
    expect(addPinnedSessions(pinned, [])).toBe(pinned);
  });

  it("removes a whole selection, leaving the pins it was not given", () => {
    const pinned = new Set(["s0", "s1", "s2", "s3"]);
    const next = removePinnedSessions(pinned, ["s1", "s3"]);
    expect([...next]).toEqual(["s0", "s2"]);
    expect([...pinned]).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("returns the input reference when nothing in the selection was pinned", () => {
    const pinned = new Set(["s0"]);
    expect(removePinnedSessions(pinned, ["s9"])).toBe(pinned);
    expect(removePinnedSessions(pinned, [])).toBe(pinned);
  });

  it("a mixed selection unpins only the pinned half, and leaves the rows in the same order", () => {
    // What the batch bar's "Unpin" does to a selection holding both kinds: a no-op id in
    // the middle must neither drop an unrelated pin nor reorder the survivors.
    const pinned = new Set(["s1", "s5", "s9"]);
    const next = removePinnedSessions(pinned, ["s1", "s4", "s9"]);
    expect([...next]).toEqual(["s5"]);
  });

  it("a batch round-trips through storage exactly as the single-row helpers do", () => {
    const store = memStorage();
    savePinnedSessions("p1", addPinnedSessions(new Set<string>(), ["a", "b", "c"]), store);
    expect([...loadPinnedSessions("p1", store)]).toEqual(["a", "b", "c"]);
    savePinnedSessions("p1", removePinnedSessions(new Set(["a", "b", "c"]), ["b"]), store);
    expect([...loadPinnedSessions("p1", store)]).toEqual(["a", "c"]);
  });
});
