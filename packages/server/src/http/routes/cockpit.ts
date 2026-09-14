/**
 * Cockpit HTTP routes: telemetry snapshot and autonomous swarm invocation.
 */
import { Hono } from "hono";
import {
  getSharedSwarmCoordinator,
  getSharedKeyFleetMonitor,
  getSharedCodeGraphWatcher,
  buildCockpitSnapshot,
} from "../../cockpit/ws.js";

export function cockpitRoutes(): Hono {
  const app = new Hono();

  app.get("/telemetry", (c) => {
    const coordinator = getSharedSwarmCoordinator();
    const snapshot = buildCockpitSnapshot(coordinator);
    return c.json(snapshot);
  });

  app.get("/keys", (c) => {
    const monitor = getSharedKeyFleetMonitor();
    return c.json({
      reports: monitor.getFleetReport(),
      stats: monitor.getFleetStats(),
      snapshot: monitor.getCockpitSnapshot(),
    });
  });

  app.post("/keys/probe", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const provider = typeof body.provider === "string" ? body.provider : "anthropic";
    const maskedKey = typeof body.maskedKey === "string" ? body.maskedKey : "";
    const monitor = getSharedKeyFleetMonitor();
    const result = await monitor.probeKey(provider, maskedKey);
    return c.json({
      success: result.status === "ok",
      result,
    });
  });

  app.post("/keys/action", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = body.action;
    const provider = typeof body.provider === "string" ? body.provider : "";
    const maskedKey = typeof body.maskedKey === "string" ? body.maskedKey : "";
    const monitor = getSharedKeyFleetMonitor();

    if (action === "revive") {
      monitor.reviveKey(provider, maskedKey);
    } else if (action === "cooldown") {
      monitor.cooldownKey(provider, maskedKey, typeof body.cooldownMs === "number" ? body.cooldownMs : 60_000);
    } else if (action === "evict") {
      monitor.evictKey(provider, maskedKey);
    } else if (action === "revive_all") {
      monitor.reviveAllCooldowns();
    }

    return c.json({
      success: true,
      stats: monitor.getFleetStats(),
      snapshot: monitor.getCockpitSnapshot(),
    });
  });

  app.post("/mailbox/send", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const from = typeof body.from === "string" ? body.from : "operator";
    const to = typeof body.to === "string" ? body.to : "coder";
    const content = typeof body.content === "string" ? body.content : "";

    if (!content.trim()) {
      return c.json({ success: false, error: "Directive content cannot be empty" }, 400);
    }

    const coordinator = getSharedSwarmCoordinator();
    const directive = coordinator.dispatchDirective(from, to, content.trim());
    return c.json({
      success: true,
      directive,
      mailbox: coordinator.getMailboxSummaries(),
    });
  });

  app.get("/topology", (c) => {
    const watcher = getSharedCodeGraphWatcher();
    return c.json(watcher.exportSnapshot());
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
