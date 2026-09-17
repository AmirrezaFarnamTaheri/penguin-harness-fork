import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test("loop alerts follow incremental WS events, retain across reconnect, and reset by project", async ({
  page,
}) => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("./cockpit-telemetry.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  const sockets = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.route("http://cockpit.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  // REST cannot backfill loop alerts, even if an unrecognized field is present.
  await page.route("**/api/cockpit/telemetry?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: { loopEvents: [{ message: "Not recovered" }] } }),
    }),
  );
  await page.routeWebSocket("**/api/cockpit/stream?*", (ws) => sockets.push(ws));
  await page.goto("http://cockpit.test/");
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.getByRole("button", { name: "Select alpha" }).click();
  const feed = page.getByRole("region", { name: "Loop alerts" });
  const log = feed.getByRole("log");
  await expect(feed.getByText("Listening for live loop alerts.")).toBeVisible();
  const event = (taskId, message = "Repeated identical coder execution", projectId = "alpha") => ({
    type: "swarm_event",
    projectId,
    event: {
      type: "loop_detected",
      taskId,
      agentId: "coder",
      timestamp: 1700000000000,
      payload: { message },
    },
  });
  sockets[0].send(JSON.stringify(event("wrong-project", "Wrong project", "beta")));
  sockets[0].send(JSON.stringify(event("bad-message", null)));
  await expect(log.getByRole("listitem")).toHaveCount(0);
  sockets[0].send(JSON.stringify(event("first")));
  sockets[0].send(JSON.stringify(event("first")));
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByText("Repeated identical coder execution", { exact: true })).toBeVisible();
  sockets[0].send(JSON.stringify(event("second", "Stalled after repeated actions")));
  await expect(log.getByRole("listitem")).toHaveCount(2);
  await expect(log.getByRole("listitem").first()).toContainText("second");
  await expect(log.locator("time").first()).toHaveAttribute("datetime", "2023-11-14T22:13:20.000Z");
  sockets[0].close();
  await expect(
    feed.getByText("Loop alert stream unavailable. Periodic updates do not include loop alerts."),
  ).toBeVisible();
  await expect(log.getByRole("listitem")).toHaveCount(2);
  await page.clock.runFor(5000);
  await expect.poll(() => sockets.length).toBe(2);
  await expect(feed.getByText("Listening for live loop alerts.")).toBeVisible();
  sockets[1].send(JSON.stringify({ type: "cockpit_init", data: { replay: { events: [] } } }));
  await expect(log.getByRole("listitem")).toHaveCount(2);
  for (let i = 0; i < 51; i++) sockets[1].send(JSON.stringify(event(`bounded-${i}`)));
  await expect(log.getByRole("listitem")).toHaveCount(50);
  await expect(log.getByRole("listitem").first()).toContainText("bounded-50");
  await expect(log.getByText("bounded-0", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Select beta" }).click();
  await expect.poll(() => sockets.length).toBe(3);
  await expect(log.getByRole("listitem")).toHaveCount(0);
  sockets[2].send(JSON.stringify(event("late-alpha", "Old project", "alpha")));
  sockets[2].send(JSON.stringify(event("beta-task", "Beta loop", "beta")));
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByText("Beta loop", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear project" }).click();
  await expect(log.getByRole("listitem")).toHaveCount(0);
  await page.getByRole("button", { name: "Select alpha" }).click();
  await expect(feed.getByText("Listening for live loop alerts.")).toBeVisible();
  await expect(log.getByRole("listitem")).toHaveCount(0);
  await expect(log).toContainText("No loop alerts observed in this view.");
  expect(errors).toEqual([]);
});
