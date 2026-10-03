import { describe, expect, it, vi } from "vitest";
import { refreshAndSelectCreatedProject } from "../src/lib/project-create-flow";

describe("refreshAndSelectCreatedProject", () => {
  it("waits for the refreshed list before selecting the created Project", async () => {
    const order: string[] = [];
    const reloadProjects = vi.fn(async () => {
      order.push("reload-started");
      await Promise.resolve();
      order.push("reload-finished");
    });
    const setCurrentProjectId = vi.fn((projectId: string) => order.push(`select:${projectId}`));
    const onError = vi.fn();

    await refreshAndSelectCreatedProject(
      "new-project",
      reloadProjects,
      setCurrentProjectId,
      onError,
    );

    expect(order).toEqual(["reload-started", "reload-finished", "select:new-project"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed refresh and never selects a Project absent from the current list", async () => {
    const error = new Error("Project list is temporarily unavailable");
    const reloadProjects = vi.fn().mockRejectedValue(error);
    const setCurrentProjectId = vi.fn();
    const onError = vi.fn();

    await expect(
      refreshAndSelectCreatedProject("new-project", reloadProjects, setCurrentProjectId, onError),
    ).resolves.toBeUndefined();

    expect(setCurrentProjectId).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });
});
