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
    const task = board.createTask({ title: "Run Migrations", dependencies: [dep.id] });

    expect(() => board.updateTaskState(task.id, "in_progress")).toThrow(/Dependency/);
    board.updateTaskState(dep.id, "in_progress", { force: true });
    board.updateTaskState(dep.id, "done");

    const updated = board.updateTaskState(task.id, "in_progress");
    expect(updated.state).toBe("in_progress");
    expect(updated.startedAt).toBeDefined();
  });

  it("manages subagent leases, heartbeats, and expiration reclamation", () => {
    const board = new KanbanBoard({ defaultLeaseDurationMs: 50 });
    const task = board.createTask({ title: "Generate Unit Tests" });
    const claimed = board.claimTask(task.id, "subagent-coder-1", { leaseDurationMs: 30 });
    expect(claimed.state).toBe("in_progress");
    expect(claimed.assignee).toBe("subagent-coder-1");
    expect(claimed.claimExpires).toBeDefined();

    const hb = board.heartbeat(task.id, {
      workerId: "subagent-coder-1",
      generation: claimed.leaseGeneration!,
      leaseDurationMs: 100,
    });
    expect(hb.lastHeartbeatAt).toBeDefined();

    board.setTaskClaimExpiry(task.id, Date.now() - 10);
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

  it("enforces dependency constraints on claimTask", () => {
    const board = new KanbanBoard();
    const dep = board.createTask({ title: "Base task" });
    const blocked = board.createTask({ title: "Blocked task", dependencies: [dep.id] });

    expect(() => board.claimTask(blocked.id, "worker-1")).toThrow(/Dependency/);
    board.updateTaskState(dep.id, "in_progress", { force: true });
    board.updateTaskState(dep.id, "done");

    const claimed = board.claimTask(blocked.id, "worker-1");
    expect(claimed.state).toBe("in_progress");
    expect(claimed.assignee).toBe("worker-1");
  });

  it("enforces lease generation fencing and worker identity on heartbeat, update, and release", () => {
    const board = new KanbanBoard();
    const task = board.createTask({ title: "Fencing task" });
    const c1 = board.claimTask(task.id, "worker-alpha");
    expect(c1.leaseGeneration).toBe(1);

    expect(() => board.heartbeat(task.id, { workerId: "worker-alpha", generation: 1 })).not.toThrow();
    expect(() => board.heartbeat(task.id, { workerId: "imposter-worker", generation: 1 })).toThrow(/worker mismatch/);
    expect(() => board.heartbeat(task.id, { workerId: "worker-alpha", generation: 99 })).toThrow(/generation mismatch/);

    expect(() =>
      board.updateTaskState(task.id, "review", { workerId: "wrong-worker", generation: 1 }),
    ).toThrow(/worker mismatch/);
    expect(() =>
      board.updateTaskState(task.id, "review", { workerId: "worker-alpha", generation: 0 }),
    ).toThrow(/generation mismatch/);

    expect(() => board.releaseTask(task.id, { workerId: "other", generation: 1 })).toThrow(/worker mismatch/);
    expect(() => board.releaseTask(task.id, { workerId: "worker-alpha", generation: 999 })).toThrow(/generation mismatch/);

    const released = board.releaseTask(task.id, { workerId: "worker-alpha", generation: 1 });
    expect(released.assignee).toBeNull();
    expect(released.state).toBe("triage");

    const c2 = board.claimTask(task.id, "worker-beta");
    expect(c2.leaseGeneration).toBe(3);
  });
});
