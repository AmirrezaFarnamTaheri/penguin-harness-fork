/**
 * The store's `loading` flag never lies "done" (state/sessions.tsx).
 *
 * The flag is what every "no Sessions yet" empty state gates on, so its one hard rule is
 * that it must not read false while nothing has been fetched. The store is exercised
 * directly (node, no DOM): the Provider's reset step owns *raising* the flag on a
 * fetch-context change, which a store test cannot see — what it can pin is that the store
 * itself never clears the flag without having loaded anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prismshadow/penguin-server/api";
import { ApiError } from "../src/api/client";
import * as api from "../src/api/endpoints";
import { createSessionsStore } from "../src/state/sessions";

const SESSION: SessionInfo = {
  sessionId: "session-a",
  projectId: "project-a",
  agentId: "default_agent",
  provider: "anthropic",
  modelId: "claude-sonnet-4",
  workspace: "/workspace",
  approvalMode: "allow-all",
  createdAt: "2026-08-24T00:00:00.000Z",
  lastActiveAt: "2026-08-24T00:00:00.000Z",
  status: "idle",
  pendingApprovalCount: 0,
  pendingFollowUpCount: 0,
  hasTrace: true,
  archived: false,
};

afterEach(() => vi.restoreAllMocks());

describe("sessions store loading", () => {
  it("starts loading — a fresh store has fetched nothing", () => {
    expect(createSessionsStore().getState().loading).toBe(true);
  });

  it("reload() without an Agent set returns without claiming to be done", async () => {
    const store = createSessionsStore();
    store.setState({ projectId: "proj", agentIds: [] });
    await store.getState().reload();
    // Nothing was fetched, so nothing may report "loaded" — clearing here is what painted
    // an empty state over a list that was merely not known yet.
    expect(store.getState().loading).toBe(true);
  });

  it("keeps the last good rows when a transient list failure occurs", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValue(new ApiError(0, "network_error", "Offline"));
    const store = createSessionsStore();
    store.setState({
      projectId: SESSION.projectId,
      agentIds: [SESSION.agentId],
      sessions: [SESSION],
      loading: false,
    });

    await store.getState().reload();

    expect(store.getState().sessions).toEqual([SESSION]);
    expect(store.getState().loading).toBe(false);
  });

  it("drops old rows when a list failure definitively says the Agent is gone", async () => {
    vi.spyOn(api, "listSessions").mockRejectedValue(
      new ApiError(404, "not_found", "Agent not found"),
    );
    const store = createSessionsStore();
    store.setState({
      projectId: SESSION.projectId,
      agentIds: [SESSION.agentId],
      sessions: [SESSION],
      loading: false,
    });

    await store.getState().reload();

    expect(store.getState().sessions).toEqual([]);
    expect(store.getState().loading).toBe(false);
  });
});
