/**
 * state/project.tsx unit tests: the Agent list belongs to the Project it was read for.
 *
 * The Provider re-reads the list whenever the current Project changes, and the two reads
 * race — the response for the Project the user left can land after the one for the Project
 * they are on. Without a guard the store ends up holding the old Project's agents under the
 * new one, which is the exact state setCurrentProjectId clears the list to avoid: the Session
 * list mounted under it fetches with the wrong Agent set and can create spurious Sessions.
 *
 * No React and no DOM: the store is the seam (same reason createCompanyStore is exported).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentsResponse, AgentSummary } from "@prismshadow/penguin-server/api";

vi.mock("../src/api/endpoints", () => ({ listAgents: vi.fn() }));

import * as api from "../src/api/endpoints";
import { createProjectStore } from "../src/state/project";

const listAgents = vi.mocked(api.listAgents);

/** In-memory localStorage (vitest runs in Node): the store reads the remembered Agent lazily. */
const storage = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
});

// Same fixture shape as agent-handoff.test.ts: only the fields the store reads (agentId, name)
// carry real values; the counters are the type's required-but-irrelevant surface.
const agent = (agentId: string, name?: string): AgentSummary => ({
  agentId,
  ...(name !== undefined ? { name } : {}),
  activeSessionCount: 0,
  sessionCount: 0,
  sessionActivity: [],
  toolCount: 0,
  version: 1,
  kernelOutdated: false,
  vaultKeyCount: 0,
  scheduleCount: 0,
  pluginUpdates: [],
  skillCount: 0,
  hookCount: 0,
  memoryCount: 0,
});

function agents(...list: AgentSummary[]): AgentsResponse {
  return { agents: list };
}

/** The store starts with no current Project; every test picks one first. */
function storeOn(projectId: string) {
  const store = createProjectStore();
  store.setState({ currentProjectId: projectId });
  return store;
}

describe("reloadAgents keeps the Agent list aligned with the current Project", () => {
  it("lands the list and defaults the selection to default_agent", async () => {
    listAgents.mockResolvedValue(agents(agent("default_agent"), agent("other")));
    const store = storeOn("p1");
    await store.getState().reloadAgents();
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["default_agent", "other"]);
    expect(store.getState().currentAgentId).toBe("default_agent");
    expect(store.getState().agentsLoading).toBe(false);
  });

  it("keeps a remembered Agent when the list still has it", async () => {
    listAgents.mockResolvedValue(agents(agent("other"), agent("kept")));
    const store = storeOn("p1");
    store.setState({ currentAgentId: "kept" });
    await store.getState().reloadAgents();
    expect(store.getState().currentAgentId).toBe("kept");
  });

  it("drops a response that lands after the user switched Projects", async () => {
    // p1's list is slow; p2's is fast. Without the guard p1's late response replaces p2's
    // agents while currentProjectId is still p2.
    let resolveP1!: (res: AgentsResponse) => void;
    listAgents.mockImplementation((projectId) => {
      if (projectId === "p1") {
        return new Promise<AgentsResponse>((resolve) => {
          resolveP1 = resolve;
        });
      }
      return Promise.resolve(agents(agent("default_agent"), agent("p2-agent")));
    });
    const store = storeOn("p1");
    const p1 = store.getState().reloadAgents();
    store.setState({ currentProjectId: "p2", agents: [], currentAgentId: null });
    const p2 = store.getState().reloadAgents();
    await p2;
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["default_agent", "p2-agent"]);

    resolveP1(agents(agent("p1-agent")));
    await p1;
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["default_agent", "p2-agent"]);
    expect(store.getState().currentAgentId).toBe("default_agent");
    // The late response's loading flag belongs to the Project it was read for too.
    expect(store.getState().agentsLoading).toBe(false);
  });

  it("clears the loading flag only for the Project it was set for", async () => {
    // p1 lands while p2 is still loading: p1's teardown must not report p2's list as settled.
    let resolveP1!: (res: AgentsResponse) => void;
    let resolveP2!: (res: AgentsResponse) => void;
    listAgents.mockImplementation(
      (projectId) =>
        new Promise<AgentsResponse>((resolve) => {
          if (projectId === "p1") resolveP1 = resolve;
          else resolveP2 = resolve;
        }),
    );
    const store = storeOn("p1");
    const p1 = store.getState().reloadAgents();
    store.setState({ currentProjectId: "p2", agents: [], currentAgentId: null });
    const p2 = store.getState().reloadAgents();
    resolveP1(agents(agent("p1-agent")));
    await p1;
    expect(store.getState().agentsLoading).toBe(true);
    resolveP2(agents(agent("p2-agent")));
    await p2;
    expect(store.getState().agentsLoading).toBe(false);
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["p2-agent"]);
  });

  it("still loads when the user switches Projects and comes back", async () => {
    listAgents.mockResolvedValue(agents(agent("default_agent")));
    const store = storeOn("p1");
    await store.getState().reloadAgents();
    store.setState({ currentProjectId: "p2", agents: [], currentAgentId: null });
    await store.getState().reloadAgents();
    store.setState({ currentProjectId: "p1", agents: [], currentAgentId: null });
    await store.getState().reloadAgents();
    expect(store.getState().agents.map((a) => a.agentId)).toEqual(["default_agent"]);
    expect(store.getState().currentAgentId).toBe("default_agent");
  });
});
