/**
 * Cockpit HTTP routes: telemetry snapshot and autonomous swarm invocation.
 */
import { Hono } from "hono";
import { getSharedSwarmCoordinator, buildCockpitSnapshot } from "../../cockpit/ws.js";

export function cockpitRoutes(): Hono {
  const app = new Hono();

  app.get("/telemetry", (c) => {
    const coordinator = getSharedSwarmCoordinator();
    const snapshot = buildCockpitSnapshot(coordinator);
    return c.json(snapshot);
  });

  app.post("/swarm/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const goal = typeof body.goal === "string" ? body.goal : "Autonomous local task";
    const files = Array.isArray(body.files) ? body.files : undefined;
    const proposedCommands = Array.isArray(body.proposedCommands) ? body.proposedCommands : undefined;
    const maxRounds = typeof body.maxRounds === "number" ? body.maxRounds : 3;

    const coordinator = getSharedSwarmCoordinator();
    const result = await coordinator.runTask({
      goal,
      files,
      proposedCommands,
      maxRounds,
    });

    return c.json({
      success: true,
      result,
    });
  });

  return app;
}
