/**
 * state/project.tsx unit tests: the Project list is the shell's ground truth for which Project
 * the user is in, and `reloadProjects` is the one that rewrites it.
 *
 * The reload re-derives the current Project from its answer (`wanted`, then the list's first
 * entry as a last resort), so a reload that lands after the user switched Projects — or after
 * another reload already answered — can move the shell: an older answer that never knew about
 * the Project just created and switched to falls back to `projects[0]` and drags the selection
 * back to it, and a switch made while a reload was in flight is overwritten the same way.
 *
 * No React and no DOM: the store is the seam (same reason createCompanyStore is exported).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectSummary, ProjectsResponse } from "@prismshadow/penguin-server/api";

vi.mock("../src/api/endpoints", () => ({
  listProjects: vi.fn(),
  putPrefs: vi.fn(() => Promise.resolve()),
}));

import * as api from "../src/api/endpoints";
import { createProjectStore } from "../src/state/project";

const listProjects = vi.mocked(api.listProjects);

/** In-memory localStorage (vitest runs in Node): the remembered Project is mirrored there. */
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

/** One Project as the list carries it; only the id matters to the checks below. */
const proj = (projectId: string, name?: string): ProjectSummary => ({
  projectId,
  name: name ?? projectId,
  role: "owner",
  ownerUserId: "user:alice",
  createdAt: "2026-09-01T00:00:00Z",
});

function projects(...list: ProjectSummary[]): ProjectsResponse {
  return { projects: list };
}

/** Holds every call's answer; the test releases them in the order it wants. */
const resolvers: Array<(res: ProjectsResponse) => void> = [];
function holdAnswers(): void {
  resolvers.length = 0;
  listProjects.mockImplementation(
    () => new Promise<ProjectsResponse>((resolve) => resolvers.push(resolve)),
  );
}
function answer(call: number, res: ProjectsResponse): void {
  resolvers[call]?.(res);
}

describe("reloadProjects keeps the selection the reload was not asked to move", () => {
  it("keeps the current Project when the list still holds it", async () => {
    listProjects.mockResolvedValue(projects(proj("p1"), proj("p2")));
    const store = createProjectStore();
    store.setState({ currentProjectId: "p2" });
    await store.getState().reloadProjects();
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(["p1", "p2"]);
    expect(store.getState().currentProjectId).toBe("p2");
  });

  it("falls back to the first entry when the list no longer holds the current one", async () => {
    // The current Project is gone from the answer (deleted, or access lost): the reload has to
    // land the shell somewhere that exists rather than pointing it at a Project it cannot open.
    listProjects.mockResolvedValue(projects(proj("p2")));
    const store = createProjectStore();
    store.setState({ currentProjectId: "p1" });
    await store.getState().reloadProjects();
    expect(store.getState().currentProjectId).toBe("p2");
  });

  it("does not move the selection to a Project the user just left", async () => {
    // The user is in p2 and switches to p1 while a reload is out. The reload's answer predates
    // the switch and, asked what it wants, reads the current selection — p1 — so without the
    // guard it lands the list and answers "p1 is current", which the user had already undone.
    holdAnswers();
    const store = createProjectStore();
    store.setState({ currentProjectId: "p2" });
    const reload = store.getState().reloadProjects(); // call 0
    store.getState().setCurrentProjectId("p1");
    answer(0, projects(proj("p1"), proj("p2")));
    await reload;
    expect(store.getState().currentProjectId).toBe("p1");
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(["p1", "p2"]);
  });

  it("does not drag the shell back to the first Project when a newer answer landed", async () => {
    // A Project is created and the shell switches to it; two reloads are out — one read before
    // the creation, one after. The older answer arrives last: it never knew about the new
    // Project, so its `projects[0]` fallback would pull the shell back off it.
    holdAnswers();
    const store = createProjectStore();
    store.setState({ currentProjectId: "p1" });
    const stale = store.getState().reloadProjects(); // call 0
    const fresh = store.getState().reloadProjects(); // call 1
    answer(1, projects(proj("p1"), proj("p2")));
    await fresh;
    store.getState().setCurrentProjectId("p2");
    answer(0, projects(proj("p1")));
    await stale;
    // The newer list's view of where the shell is stands.
    expect(store.getState().currentProjectId).toBe("p2");
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(["p1", "p2"]);
  });

  it("settles the loading flag only for the answer that owns the list", async () => {
    // The older reload lands while the newer one is still out: its teardown must not report the
    // list as settled before the newer answer has arrived.
    holdAnswers();
    const store = createProjectStore();
    const stale = store.getState().reloadProjects(); // call 0
    const fresh = store.getState().reloadProjects(); // call 1
    answer(0, projects(proj("p1")));
    await stale;
    expect(store.getState().projectsLoading).toBe(true);
    answer(1, projects(proj("p2")));
    await fresh;
    expect(store.getState().projectsLoading).toBe(false);
    expect(store.getState().projects.map((p) => p.projectId)).toEqual(["p2"]);
  });
});
