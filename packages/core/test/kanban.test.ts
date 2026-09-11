import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../src/agent/kanban.js";

describe("KanbanBoard", () => {
  it("creates, retrieves, and lists tasks", () => {
    const board = new KanbanBoard({ boardId: "test-board" });
    const t1 = board.createTask({
      title: "Implement auth middleware",
      description: "Add JWT verification",
      priority: "high",
    });

    expect(t1.id).toBeDefined();
    expect(t1.title).toBe("Implement auth middleware");
    expect(t1.state).toBe("backlog");
    expect(t1.priority).toBe("high");

    const fetched = board.getTask(t1.id);
    expect(fetched?.id).toBe(t1.id);

    const list = board.listTasks({ priority: "high" });
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(t1.id);
  });

  it("enforces dependency constraints before moving to in_progress", () => {
    const board = new KanbanBoard();
    const dep = board.createTask({ title: "Setup Database Schema" });
    const task = board.createTask({
      title: "Run Migrations",
      dependencies: [dep.id],
    });

    // Cannot move to in_progress when dependency is backlog
    expect(() => board.updateTaskState(task.id, "in_progress")).toThrow(/Dependency/);

    // Mark dependency as done
    board.updateTaskState(dep.id, "in_progress", { force: true });
    board.updateTaskState(dep.id, "done");

    // Now moving to in_progress succeeds
    const updated = board.updateTaskState(task.id, "in_progress");
    expect(updated.state).toBe("in_progress");
    expect(updated.startedAt).toBeDefined();
  });

  it("manages subagent leases, heartbeats, and expiration reclamation", () => {
    const board = new KanbanBoard({ defaultLeaseDurationMs: 50 });
    const task = board.createTask({ title: "Generate Unit Tests" });

    // Claim task
    const claimed = board.claimTask(task.id, "subagent-coder-1", { leaseDurationMs: 30 });
    expect(claimed.state).toBe("in_progress");
    expect(claimed.assignee).toBe("subagent-coder-1");
    expect(claimed.claimExpires).toBeDefined();

    // Heartbeat extends lease
    const hb = board.heartbeat(task.id, 100);
    expect(hb.lastHeartbeatAt).toBeDefined();

    // Fast-forward expiration simulation
    board.setTaskClaimExpiry(task.id, Date.now() - 10);
    // Reclaim expired leases
    const reclaimed = board.reclaimExpiredLeases();
    expect(reclaimed).toContain(task.id);

    const afterReclaim = board.getTask(task.id);
    expect(afterReclaim?.state).toBe("triage");
    expect(afterReclaim?.assignee).toBeNull();
  });

  it("creates and launches triage draft into parent and child tasks with dependencies", () => {
    const board = new KanbanBoard();
    const draft = board.createTriageDraft({
      title: "Refactor Authentication System",
      body: "Modernize OAuth2 and session handling",
      suggestedTasks: [
        { title: "Define User Schema", priority: "high" },
        { title: "Implement Token Service", dependencies: ["0"], priority: "high" },
        { title: "Add Login Route", dependencies: ["Implement Token Service"], priority: "normal" },
      ],
    });

    expect(draft.id).toBeDefined();

    const launched = board.launchTriage(draft.id);
    expect(launched.parentTask.title).toBe("Refactor Authentication System");
    expect(launched.parentTask.state).toBe("in_progress");
    expect(launched.childTasks.length).toBe(3);

    const child0 = launched.childTasks[0]!;
    const child1 = launched.childTasks[1]!;
    const child2 = launched.childTasks[2]!;

    expect(child0.parentTaskId).toBe(launched.parentTask.id);
    expect(child1.dependencies).toContain(child0.id);
    expect(child2.dependencies).toContain(child1.id);
  });
});
