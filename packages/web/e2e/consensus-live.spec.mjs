import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let bundle;
test.beforeAll(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("./consensus-live.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
  });
  bundle = outputFiles[0].text;
});

for (const surface of ["embedded", "cockpit"]) {
  test(`${surface} consensus receives project handoffs and mailbox snapshots`, async ({ page }) => {
    const errors = [];
    const sockets = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://cockpit.test/**", (route) => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === "/") {
        return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      }
      if (url.pathname === "/api/projects") {
        body = { projects: [{ projectId: "alpha" }, { projectId: "beta" }] };
      } else if (/^\/api\/projects\/[^/]+\/agents$/.test(url.pathname)) {
        body = { agents: [] };
      } else if (url.pathname === "/api/cockpit/telemetry") {
        expect(url.searchParams.has("sessionId")).toBe(false);
        body = { data: { mailbox: {} } };
      } else if (url.pathname === "/api/me/prefs") {
        body = {};
      } else {
        throw new Error(`Unexpected request: ${url}`);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.routeWebSocket("**/api/cockpit/stream?*", (ws) => sockets.push(ws));
    await page.goto(`http://cockpit.test/?surface=${surface}`);
    await page.addScriptTag({ content: bundle });
    await expect.poll(() => sockets.length).toBe(1);
    expect(new URL(sockets[0].url()).search).toBe("?project=alpha");
    await page.getByRole("button", { name: "Reviews & handoffs", exact: true }).click();
    await page.getByRole("button", { name: "Handoffs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Handoffs (live)", exact: true })).toBeVisible();
    await expect(
      page.getByText("No task starts or directives observed in this connection."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Simulate Next Stage" })).toHaveCount(0);
    const start = {
      type: "swarm_event",
      projectId: "alpha",
      event: {
        type: "task_started",
        taskId: "task-wiring",
        agentId: "orchestrator",
        timestamp: 1700000000000,
        payload: { goal: "Live consensus task" },
      },
    };
    sockets[0].send(JSON.stringify(start));
    sockets[0].send(
      JSON.stringify({
        ...start,
        event: {
          type: "directive_dispatched",
          timestamp: 1700000000001,
          payload: {
            messageId: "directive-wiring",
            from: "operator",
            to: "reviewer",
            content: "Live consensus directive",
          },
        },
      }),
    );
    await expect(page.getByText("Live consensus task", { exact: true })).toBeVisible();
    await expect(page.getByText("Live consensus directive", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Planned target; assignment delivery is not reported by this event."),
    ).toBeVisible();
    await expect(page.getByText("Dispatched", { exact: true })).toHaveCount(1);
    sockets[0].send(
      JSON.stringify({
        type: "cockpit_init",
        projectId: "alpha",
        data: { mailbox: { "live-reviewer": { queueDepth: 4, pendingReplyCount: 2 } } },
      }),
    );
    await page.getByRole("button", { name: "Messages", exact: true }).click();
    await expect(page.getByText("live-reviewer", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select beta", exact: true }).click();
    await expect.poll(() => sockets.length).toBe(2);
    expect(new URL(sockets[1].url()).search).toBe("?project=beta");
    await page.getByRole("button", { name: "Reviews & handoffs", exact: true }).click();
    await page.getByRole("button", { name: "Handoffs", exact: true }).click();
    await expect(page.getByText("Live consensus task", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Live consensus directive", { exact: true })).toHaveCount(0);
    await expect(page.getByText("live-reviewer", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("No task starts or directives observed in this connection."),
    ).toBeVisible();
    sockets[1].send(
      JSON.stringify({
        ...start,
        projectId: "beta",
        event: { ...start.event, payload: { goal: "Beta task" } },
      }),
    );
    await expect(page.getByText("Beta task", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const lang of ["en", "zh"]) {
  test(`${lang} coordination labels and proposal dialog are localized`, async ({ page }) => {
    const zh = lang === "zh";
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://cockpit.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/")
        return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(pathname === "/api/projects" ? { projects: [] } : {}),
      });
    });
    await page.goto(`http://cockpit.test/?lang=${lang}&surface=standalone`);
    await page.addScriptTag({ content: bundle });
    await expect(
      page.getByRole("heading", { name: zh ? "智能体协作" : "Agent coordination", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: zh ? "提出决策" : "Propose decision", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("textbox", { name: zh ? "新主题" : "New topic", exact: true })
      .fill("Locale regression proposal");
    await dialog
      .getByRole("button", { name: zh ? "创建提案" : "Create Proposal", exact: true })
      .click();
    await expect(page.getByText("Locale regression proposal", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: zh ? "消息" : "Messages", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: zh ? "消息（本地演示）" : "Messages (local demo)",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: zh ? "编写演示消息" : "Compose demo message", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: zh ? "发送 Agent" : "From agent", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: zh ? "取消" : "Cancel", exact: true })
      .click();
    await page.getByRole("button", { name: zh ? "交接" : "Handoffs", exact: true }).click();
    await expect(
      page.getByRole("button", { name: zh ? "模拟下一阶段" : "Simulate Next Stage", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
