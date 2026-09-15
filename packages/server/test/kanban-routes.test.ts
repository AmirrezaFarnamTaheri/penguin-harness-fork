import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, loginAdmin, type TestApp } from "./helpers.js";

describe("Kanban HTTP Routes", () => {
  let t: TestApp;
  let admin: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp();
    admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("handles full lifecycle: create with assignee and labels, list, update, stats, and drafts", async () => {
    // 1. Initial list should be empty with total = 0
    const emptyList = await admin.get("/api/projects/default_project/kanban/tasks");
    expect(emptyList.status).toBe(200);
    const emptyBody = (await emptyList.json()) as any;
    expect(emptyBody.tasks).toEqual([]);
    expect(emptyBody.total).toBe(0);

    // 2. Create task with assignee and labels
    const createRes = await admin.post("/api/projects/default_project/kanban/tasks", {
      title: "Build auth service",
      description: "Implement JWT & OAuth2",
      priority: "high",
      assignee: "alice",
      labels: ["backend", "auth"],
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    expect(createBody.ok).toBe(true);
    expect(createBody.task.title).toBe("Build auth service");
    expect(createBody.task.assignee).toBe("alice");
    expect(createBody.task.priority).toBe("high");
    expect(createBody.task.metadata?.labels).toEqual(["backend", "auth"]);
    const taskId = createBody.task.id;

    // 3. List tasks should return total: 1 and the task
    const listRes = await admin.get("/api/projects/default_project/kanban/tasks");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.total).toBe(1);
    expect(listBody.tasks[0]?.id).toBe(taskId);

    // 4. Update task via general PATCH /tasks/:taskId
    const updateRes = await admin.patch(`/api/projects/default_project/kanban/tasks/${taskId}`, {
      title: "Build auth service v2",
      priority: "urgent",
      force: true,
      state: "in_progress",
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as any;
    expect(updateBody.ok).toBe(true);
    expect(updateBody.task.title).toBe("Build auth service v2");
    expect(updateBody.task.priority).toBe("urgent");
    expect(updateBody.task.state).toBe("in_progress");

    // 5. Query stats
    const statsRes = await admin.get("/api/projects/default_project/kanban/stats");
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as any;
    expect(statsBody.totalTasks).toBe(1);
    expect(statsBody.byState.in_progress).toBe(1);
    expect(statsBody.activeDrafts).toBe(0);

    // 6. Create triage draft
    const draftRes = await admin.post("/api/projects/default_project/kanban/triage/draft", {
      title: "Security Hardening",
      body: "Audit endpoints and add rate limiting",
      suggestedTasks: [
        { title: "Review CORS headers", priority: "high" },
        { title: "Add rate limiter", priority: "normal" },
      ],
    });
    expect(draftRes.status).toBe(201);
    const draftBody = (await draftRes.json()) as any;
    expect(draftBody.ok).toBe(true);
    expect(draftBody.draft.title).toBe("Security Hardening");
    const draftId = draftBody.draft.id;

    // 7. List drafts
    const draftsList = await admin.get("/api/projects/default_project/kanban/drafts");
    expect(draftsList.status).toBe(200);
    const draftsBody = (await draftsList.json()) as any;
    expect(draftsBody.drafts.length).toBe(1);
    expect(draftsBody.drafts[0]?.id).toBe(draftId);

    // 8. Launch triage draft via /drafts/:draftId/launch
    const launchRes = await admin.post(
      `/api/projects/default_project/kanban/drafts/${draftId}/launch`,
      {},
    );
    expect(launchRes.status).toBe(200);
    const launchBody = (await launchRes.json()) as any;
    expect(launchBody.ok).toBe(true);
    expect(launchBody.parentTask.title).toBe("Security Hardening");
    expect(launchBody.childTasks.length).toBe(2);

    // 9. Re-check stats after launch
    const finalStats = await admin.get("/api/projects/default_project/kanban/stats");
    const finalStatsBody = (await finalStats.json()) as any;
    // 1 original + 1 parent + 2 children = 4 total tasks
    expect(finalStatsBody.totalTasks).toBe(4);
    expect(finalStatsBody.activeDrafts).toBe(0);
  });
});
