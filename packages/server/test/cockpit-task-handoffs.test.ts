import { SwarmCoordinator, redactObject, type SwarmEvent } from "@prismshadow/penguin-core";
import { describe, expect, it } from "vitest";

describe("coordinator events available to the cockpit transport", () => {
  it("supplies a task start, but no per-assignment event, for the coder mailbox handoff", async () => {
    const coordinator = new SwarmCoordinator();
    const events: SwarmEvent[] = [];
    const unsubscribe = coordinator.subscribe((event) => events.push(event));
    try {
      await coordinator.runTask({ id: "task-1", goal: "Verify assignment evidence", simulate: true });
      const start = events.find((event) => event.type === "task_started");
      expect(start).toEqual({
        type: "task_started", taskId: "task-1", agentId: "orchestrator",
        timestamp: expect.any(Number), payload: { goal: "Verify assignment evidence" },
      });
      // ws.ts forwards this redacted event verbatim; no new event is needed.
      expect(JSON.parse(JSON.stringify(redactObject(start)))).toEqual(start);
      expect(events.some((event) => event.type === "directive_dispatched")).toBe(false);
      expect(coordinator.getEdges()).toContainEqual({
        from: "orchestrator", to: "coder", kind: "directive", activeCount: 1,
      });
    } finally {
      unsubscribe();
    }
  });

  it("can emit task_started even when planning fails before any coder assignment", async () => {
    const coordinator = new SwarmCoordinator();
    const events: SwarmEvent[] = [];
    const unsubscribe = coordinator.subscribe((event) => events.push(event));
    try {
      const result = await coordinator.runTask({ id: "failed-plan", goal: "Cannot plan" }, {
        onPlan: async () => {
          throw new Error("Planning failed");
        },
      });
      expect(result.status).toBe("error");
      expect(events.map((event) => event.type)).toEqual(["task_started", "task_failed"]);
      expect(coordinator.getEdges()).toContainEqual({
        from: "orchestrator",
        to: "coder",
        kind: "directive",
        activeCount: 0,
      });
      expect(coordinator.getMailboxSummaries().coder?.queueDepth).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});
