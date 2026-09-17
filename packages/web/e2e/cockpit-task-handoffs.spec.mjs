import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test("existing task-start stream updates the handoff timeline without claiming delivery", async ({
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
  const errors = [];
  const sockets = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://cockpit.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  await page.route("**/api/cockpit/telemetry?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: { mailbox: {} } }),
    }),
  );
  await page.routeWebSocket("**/api/cockpit/stream?*", (ws) => sockets.push(ws));
  await page.goto("http://cockpit.test/");
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.getByRole("button", { name: "Select alpha" }).click();
  await expect.poll(() => sockets.length).toBe(1);
  const timeline = page.getByRole("region", { name: "Live handoffs" });
  const start = {
    type: "swarm_event",
    projectId: "alpha",
    event: {
      type: "task_started",
      taskId: "task-live",
      agentId: "orchestrator",
      timestamp: 1700000000000,
      payload: { goal: "Implement live changes" },
    },
  };
  // Other projects and malformed starts must not manufacture an assignment.
  sockets[0].send(JSON.stringify({ ...start, projectId: "beta" }));
  sockets[0].send(JSON.stringify({ ...start, event: { ...start.event, taskId: "" } }));
  sockets[0].send(JSON.stringify({ ...start, event: { ...start.event, timestamp: null } }));
  sockets[0].send(JSON.stringify({ ...start, event: { ...start.event, agentId: "unknown" } }));
  await expect(timeline.getByText("Task started", { exact: true })).toHaveCount(0);
  sockets[0].send(JSON.stringify(start));
  sockets[0].send(JSON.stringify(start));
  await expect(timeline.getByText("Implement live changes", { exact: true })).toHaveCount(1);
  await expect(timeline.getByText("Task: task-live", { exact: true })).toBeVisible();
  await expect(timeline.getByText("orchestrator", { exact: true })).toBeVisible();
  await expect(timeline.getByText("coder", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Task started", { exact: true })).toHaveCount(1);
  await expect(
    timeline.getByText("Planned target; assignment delivery is not reported by this event.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(timeline.getByText("Dispatched", { exact: true })).toHaveCount(0);
  sockets[0].send(
    JSON.stringify({
      type: "swarm_event",
      projectId: "alpha",
      event: {
        type: "directive_dispatched",
        timestamp: 1700000000001,
        taskId: "task-live",
        payload: {
          from: "operator",
          to: "reviewer",
          messageId: "directive-live",
          content: "Review live changes",
        },
      },
    }),
  );
  sockets[0].send(JSON.stringify({ ...start, event: { ...start.event, type: "task_failed" } }));
  await expect(timeline.getByText("Task started", { exact: true })).toHaveCount(1);
  await expect(timeline.getByText("Dispatched", { exact: true })).toHaveCount(1);
  await expect(timeline.getByText("Review live changes", { exact: true })).toHaveCount(1);
  // The existing 50-entry cap applies to task starts as well as directives.
  for (let i = 0; i < 51; i++) {
    sockets[0].send(
      JSON.stringify({ ...start, event: { ...start.event, taskId: `bounded-${i}` } }),
    );
  }
  await expect(timeline.getByText("Task started", { exact: true })).toHaveCount(50);
  await expect(timeline.getByText("Task: bounded-0", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Select beta" }).click();
  await expect(timeline.getByText("Task started", { exact: true })).toHaveCount(0);
  await expect(timeline.getByText("Dispatched", { exact: true })).toHaveCount(0);
  await expect(
    timeline.getByText("No task starts or directives observed in this connection."),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
