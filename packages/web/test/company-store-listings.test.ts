/**
 * state/company.tsx listing races: an answer belongs to the Project set (and the organization
 * list) it was read for.
 *
 * The Provider re-reads the organization list whenever the Project set changes and on every
 * event that moves a summary (a run, a ticket, a budget state), and re-reads the current
 * Project's desk and ticket Sessions when the Project, the list or a run moves. Reads therefore
 * overlap, and the one that answers last is not the one that started last:
 * - an organization answer for a Project set the shell has left regresses the sidebar, and
 *   `forgetMissingOrganizations` then runs against the older list — which never knew about an
 *   organization the newer list had shown — and drops the one the user just opened;
 * - a Sessions answer for the Project the shell left overwrites the map the newer read built,
 *   so the sidebar's folders show desks and tickets that do not exist under the Project they
 *   are now in.
 *
 * No React and no DOM: the store is the seam (same reason createCompanyStore is exported).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  OrgSessionsResponse,
  OrganizationSummary,
  OrganizationsResponse,
} from "@prismshadow/penguin-server/api";

vi.mock("../src/api/endpoints", () => ({
  listOrganizations: vi.fn(),
  getOrgSessions: vi.fn(),
}));

import * as api from "../src/api/endpoints";
import { createCompanyStore } from "../src/state/company";

const listOrganizations = vi.mocked(api.listOrganizations);
const getOrgSessions = vi.mocked(api.getOrgSessions);

/** In-memory localStorage (vitest runs in Node): the remembered organization is mirrored there. */
beforeAll(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
});

/** One organization as the list carries it; only the two ids matter to the checks below. */
const summary = (projectId: string, orgId: string): OrganizationSummary => ({
  projectId,
  orgId,
  name: orgId,
  mission: "",
  status: "active",
  employeeCount: 0,
  runningCount: 0,
  pausedCount: 0,
  openTickets: 0,
  blockedTickets: 0,
  createdBy: "user:alice",
  spend: { period: "2026-09", cost: 0 },
});

function orgs(...list: OrganizationSummary[]): OrganizationsResponse {
  return { organizations: list };
}

/**
 * Each call's answer is held until the test releases it, so which read lands first is the
 * test's to pick — the whole point of the guard is the landing order, not the call order.
 */
const resolvers: Array<(res: OrganizationsResponse) => void> = [];
function holdPerCall(): void {
  resolvers.length = 0;
  listOrganizations.mockImplementation(
    () => new Promise<OrganizationsResponse>((resolve) => resolvers.push(resolve)),
  );
}
function answer(call: number, res: OrganizationsResponse): void {
  resolvers[call]?.(res);
}

describe("reloadOrganizations lands the list for the Projects it was read for", () => {
  it("merges every Project's organizations and marks the list settled", async () => {
    listOrganizations.mockImplementation((projectId) =>
      Promise.resolve(orgs(projectId === "p1" ? summary("p1", "acme") : summary("p2", "beta"))),
    );
    const store = createCompanyStore();
    await store.getState().reloadOrganizations(["p1", "p2"]);
    expect(
      store
        .getState()
        .organizations.map((o) => o.orgId)
        .sort(),
    ).toEqual(["acme", "beta"]);
    expect(store.getState().orgsLoaded).toBe(true);
    expect(store.getState().orgsPartial).toBe(false);
    expect(store.getState().orgsLoading).toBe(false);
  });

  it("records a partial list and keeps the Projects that answered", async () => {
    listOrganizations.mockImplementation((projectId) =>
      projectId === "p1"
        ? Promise.reject(new Error("unreachable"))
        : Promise.resolve(orgs(summary("p2", "beta"))),
    );
    const store = createCompanyStore();
    await store.getState().reloadOrganizations(["p1", "p2"]);
    expect(store.getState().organizations.map((o) => o.orgId)).toEqual(["beta"]);
    expect(store.getState().orgsPartial).toBe(true);
  });

  it("drops an answer that lands after the Project set moved on", async () => {
    // The set shrank from p1 to p2 while p1's read was out (a Project the user lost access to,
    // or a Project list reload). p2 answers first; p1's answer arrives last.
    holdPerCall();
    const store = createCompanyStore();
    const stale = store.getState().reloadOrganizations(["p1"]); // call 0
    const fresh = store.getState().reloadOrganizations(["p2"]); // call 1
    answer(1, orgs(summary("p2", "beta")));
    await fresh;
    answer(0, orgs(summary("p1", "acme")));
    await stale;
    // The older answer is p1's list under a Project set that no longer has p1 in it: landing it
    // would put a unreachable Project's organizations in the sidebar.
    expect(store.getState().organizations.map((o) => o.orgId)).toEqual(["beta"]);
    expect(store.getState().orgsLoaded).toBe(true);
    expect(store.getState().orgsLoading).toBe(false);
  });

  it("does not let a stale answer settle a read still in flight", async () => {
    holdPerCall();
    const store = createCompanyStore();
    const stale = store.getState().reloadOrganizations(["p1"]); // call 0
    const fresh = store.getState().reloadOrganizations(["p2"]); // call 1
    answer(0, orgs(summary("p1", "acme")));
    await stale;
    // The read for p2 has not answered yet: p1's teardown must not report the list as settled.
    expect(store.getState().orgsLoading).toBe(true);
    answer(1, orgs(summary("p2", "beta")));
    await fresh;
    expect(store.getState().orgsLoading).toBe(false);
    expect(store.getState().organizations.map((o) => o.orgId)).toEqual(["beta"]);
  });

  it("keeps an open organization an older answer never knew about", async () => {
    // The newer list showed beta and the user opened it; the older answer, read for a Project
    // set without p2 in it, has no beta in it.
    holdPerCall();
    const store = createCompanyStore();
    const stale = store.getState().reloadOrganizations(["p1"]); // call 0
    const fresh = store.getState().reloadOrganizations(["p2"]); // call 1
    answer(1, orgs(summary("p2", "beta")));
    await fresh;
    store.setState({ currentOrgKey: "p2/beta", lastOrgKey: "p2/beta" });

    answer(0, orgs(summary("p1", "acme")));
    await stale;
    // forgetMissingOrganizations runs whenever the list settles: against the older answer it
    // would see beta as gone and aim the shell away from the organization it is in.
    store.getState().forgetMissingOrganizations();
    expect(store.getState().currentOrgKey).toBe("p2/beta");
    expect(store.getState().lastOrgKey).toBe("p2/beta");
  });
});

describe("reloadOrgSessions lands the map for the Project and list it was read for", () => {
  /** Empty Sessions listings: only which organization got an entry matters below. */
  const empty = (): OrgSessionsResponse => ({ desks: [], tickets: [] });

  /** Holds every call's answer; the test releases them in the order it wants. */
  const sessionResolvers: Array<() => void> = [];
  function holdSessions(): void {
    sessionResolvers.length = 0;
    getOrgSessions.mockImplementation(
      () =>
        new Promise<OrgSessionsResponse>((resolve) => {
          sessionResolvers.push(() => resolve(empty()));
        }),
    );
  }
  function settle(call: number): void {
    sessionResolvers[call]?.();
  }

  it("lands one entry per organization of the Project it was asked for", async () => {
    getOrgSessions.mockResolvedValue(empty());
    const store = createCompanyStore();
    store.setState({
      organizations: [summary("p1", "acme"), summary("p1", "beta"), summary("p2", "gamma")],
    });
    await store.getState().reloadOrgSessions("p1");
    expect([...store.getState().orgSessions.keys()].sort()).toEqual(["p1/acme", "p1/beta"]);
  });

  it("keeps a failed organization out of the map and the rest in", async () => {
    getOrgSessions.mockImplementation((projectId, orgId) =>
      orgId === "beta" ? Promise.reject(new Error("gone")) : Promise.resolve(empty()),
    );
    const store = createCompanyStore();
    store.setState({ organizations: [summary("p1", "acme"), summary("p1", "beta")] });
    await store.getState().reloadOrgSessions("p1");
    expect([...store.getState().orgSessions.keys()]).toEqual(["p1/acme"]);
  });

  it("drops an answer that lands after the shell moved to another Project", async () => {
    // The user switches from p1 to p2 while p1's read is out. p2 answers first; p1's answer
    // arrives last and, without the guard, replaces the map with one holding only p1's entries.
    holdSessions();
    const store = createCompanyStore();
    store.setState({ organizations: [summary("p1", "acme"), summary("p2", "beta")] });
    const stale = store.getState().reloadOrgSessions("p1"); // call 0 (acme)
    const fresh = store.getState().reloadOrgSessions("p2"); // call 1 (beta)
    settle(1);
    await fresh;
    expect([...store.getState().orgSessions.keys()]).toEqual(["p2/beta"]);

    settle(0);
    await stale;
    // The sidebar reads this map by the current Project's org keys: p1's answer must not evict
    // p2's entry from it.
    expect([...store.getState().orgSessions.keys()]).toEqual(["p2/beta"]);
  });

  it("drops an answer read against an organization list that has since grown", async () => {
    // The list gains an organization mid-read: the older answer carries no entry for it, and
    // landing it would take the new organization's folder away as soon as it appeared.
    holdSessions();
    const store = createCompanyStore();
    store.setState({ organizations: [summary("p1", "acme")] });
    const stale = store.getState().reloadOrgSessions("p1"); // call 0 (acme)
    store.setState({ organizations: [summary("p1", "acme"), summary("p1", "beta")] });
    const fresh = store.getState().reloadOrgSessions("p1"); // calls 1, 2 (acme, beta)
    settle(1);
    settle(2);
    await fresh;
    expect([...store.getState().orgSessions.keys()].sort()).toEqual(["p1/acme", "p1/beta"]);

    settle(0);
    await stale;
    expect([...store.getState().orgSessions.keys()].sort()).toEqual(["p1/acme", "p1/beta"]);
  });
});
