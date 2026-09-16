import { describe, expect, it } from "vitest";
import { SwarmCoordinator } from "../src/agent/swarm-coordinator.js";

describe("SwarmCoordinator", () => {
  it("orchestrates Coder and Reviewer and settles consensus when criteria are met", async () => {
    const coordinator = new SwarmCoordinator({
      quorumPolicy: { threshold: 2, requireGrounded: true },
    });

    const events: string[] = [];
    coordinator.subscribe((e) => events.push(e.type));

    const result = await coordinator.runTask(
      {
        id: "task-001",
        goal: "Implement Fast Cache in Core",
        files: ["src/cache.ts"],
      },
      {
        onPlan: async () => ({
          steps: ["create_cache", "test_cache"],
          targetFiles: ["src/cache.ts"],
        }),
        onExecute: async (_task, step, round) => ({
          artifacts: [
            {
              path: "src/cache.ts",
              summary: `LRU Cache implementation created in step ${step}`,
              content: "export class LRUCache {}",
            },
          ],
          summary: `Round ${round}: cache created`,
        }),
        onReview: async (_task, artifacts, round) => ({
          approved: true,
          grounds: `Verified LRUCache in ${artifacts[0]?.path}: implements O(1) eviction policy`,
        }),
      },
    );

    expect(result.status).toBe("settled");
    expect(result.rounds).toBe(1);
    expect(result.standing?.status).toBe("settled");
    expect(result.artifacts.length).toBe(1);
    expect(result.terminalSummary?.status).toBe("completed");

    expect(events).toContain("task_started");
    expect(events).toContain("review_requested");
    expect(events).toContain("consensus_endorsed");
    expect(events).toContain("consensus_settled");
    expect(events).toContain("task_completed");

    // Mailbox summaries
    const mailbox = coordinator.getMailboxSummaries();
    expect(mailbox["coder"]).toBeDefined();
    expect(mailbox["reviewer"]).toBeDefined();

    // Replay View
    const replay = coordinator.getReplayView();
    expect(replay.events.length).toBeGreaterThan(0);
  });

  it("handles reviewer refutation and retries until settled", async () => {
    const coordinator = new SwarmCoordinator({
      quorumPolicy: { threshold: 2, requireGrounded: true },
    });

    let attempt = 0;
    const result = await coordinator.runTask(
      {
        id: "task-retry-002",
        goal: "Refactor Database Pool",
        maxRounds: 3,
      },
      {
        onExecute: async () => {
          attempt++;
          return {
            artifacts: [{ path: "src/db.ts", summary: `Attempt ${attempt}` }],
            summary: `Attempt ${attempt}`,
          };
        },
        onReview: async (_task, _artifacts, round) => {
          if (round === 1) {
            return {
              approved: false,
              grounds: "Missing connection timeout parameter in pool constructor",
            };
          }
          return {
            approved: true,
            grounds: "Timeout parameter correctly wired with 5000ms default",
          };
        },
      },
    );

    expect(result.rounds).toBe(2);
    expect(result.status).toBe("settled");
  });

  it("blocks dangerous commands via ShellGuardian and records safety refutation", async () => {
    const coordinator = new SwarmCoordinator();

    const result = await coordinator.runTask({
      id: "task-danger-003",
      goal: "Cleanup build artifacts",
      proposedCommands: ["rm -rf /", "git status"],
    });

    expect(result.status).toBe("refuted");
    expect(result.safetyFindings.length).toBeGreaterThan(0);
    expect(result.safetyFindings[0]?.riskLevel).toBe("critical");
    expect(result.standing?.status).toBe("refuted");
  });

  it("detects and aborts runaway loops via LoopDetector", async () => {
    const coordinator = new SwarmCoordinator({
      loopOptions: { maxRepeats: 2, timeoutSeconds: 30 },
    });

    const result = await coordinator.runTask(
      {
        id: "task-loop-004",
        goal: "Loop test",
        maxRounds: 10,
        simulate: true,
      },
      {
        onReview: async () => ({
          approved: false,
          grounds: "Need another revision",
        }),
      },
    );

    expect(result.status).toBe("loop_aborted");
    expect(result.rounds).toBeLessThanOrEqual(3);
  });

  it("fails closed with unhandled status when no execution handler is attached and simulate is false", async () => {
    const coordinator = new SwarmCoordinator();

    const result = await coordinator.runTask({
      id: "task-unhandled-005",
      goal: "Real task with no handlers",
    });

    expect(result.status).toBe("unhandled");
    expect(result.standing?.status).toBe("refuted");
  });

  it("safely handles concurrent task submissions through FIFO queueing without state corruption", async () => {
    const coordinator = new SwarmCoordinator();
    const results = await Promise.all([
      coordinator.runTask({
        id: "task-concurrent-1",
        goal: "Concurrent Goal 1",
        simulate: true,
      }),
      coordinator.runTask({
        id: "task-concurrent-2",
        goal: "Concurrent Goal 2",
        simulate: true,
      }),
    ]);

    expect(results[0]?.taskId).toBe("task-concurrent-1");
    expect(results[0]?.status).toBe("settled");
    expect(results[1]?.taskId).toBe("task-concurrent-2");
    expect(results[1]?.status).toBe("settled");
  });

  it("validates directive recipient against registered swarm agents", () => {
    const coordinator = new SwarmCoordinator();
    expect(coordinator.hasAgent("coder")).toBe(true);
    expect(coordinator.hasAgent("unknown-agent")).toBe(false);

    expect(() => coordinator.dispatchDirective("operator", "unknown-agent", "hello")).toThrow(
      /Recipient agent 'unknown-agent' is not registered in swarm/,
    );
  });

  it("enforces task admission queue depth limit and reports 429 backpressure", async () => {
    const coordinator = new SwarmCoordinator({ maxPendingTasks: 1 });
    let releaseFirstTask!: () => void;
    const blockPromise = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });

    const firstTask = coordinator.runTask(
      { id: "task-blocking", goal: "Block queue" },
      {
        onExecute: async () => {
          await blockPromise;
          return { artifacts: [], summary: "done" };
        },
      },
    );

    // Second task should immediately reject with 429 backpressure
    await expect(
      coordinator.runTask({ id: "task-overflow", goal: "Should be rejected" }),
    ).rejects.toThrow(/Swarm task queue limit reached/);

    releaseFirstTask();
    await firstTask;
  });

  it("guards consensus and artifacts against aborted or timed-out tasks", async () => {
    const coordinator = new SwarmCoordinator({
      watchdogConfig: { stepTimeoutMs: 50 },
    });

    const result = await coordinator.runTask(
      {
        id: "task-timedout",
        goal: "Hang during execution",
      },
      {
        onExecute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            artifacts: [{ path: "aborted.ts", summary: "Should not settle" }],
            summary: "Timed out",
          };
        },
      },
    );

    expect(result.status).toBe("timed_out");
    expect(result.artifacts.length).toBe(0);
    expect(result.standing?.status).not.toBe("settled");
  });
});
