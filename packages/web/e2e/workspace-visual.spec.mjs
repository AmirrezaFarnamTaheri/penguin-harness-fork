import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run from packages/web: node node_modules/@playwright/test/cli.js test
// --config e2e/playwright.config.mjs workspace-visual.spec.mjs
// Build web first. WORKSPACE_SCREENSHOT_DIR overrides the durable screenshot directory.
const outputDir = process.env.WORKSPACE_SCREENSHOT_DIR
  ? resolve(process.env.WORKSPACE_SCREENSHOT_DIR)
  : fileURLToPath(new URL("../../../artifacts/context-review/workspace/", import.meta.url));
let script, css;
test.use({ locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./workspace-visual.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
    loader: { ".css": "empty" },
  });
  script = result.outputFiles[0].text;
  const assets = new URL("../dist/assets/", import.meta.url);
  const names = (await readdir(assets)).filter((name) => /^index-.*\.css$/.test(name));
  expect(names, "Build packages/web first; exactly one app stylesheet is required").toHaveLength(1);
  css = await readFile(new URL(names[0], assets), "utf8");
  await mkdir(outputDir, { recursive: true });
});

const populated = {
  swarm: {
    agents: [
      {
        id: "release-coder",
        name: "Edsger",
        description: "Owns the retry-flake fix and the regression suite this round.",
        role: "coder",
        status: "active",
        tasksCompleted: 4,
        currentTask: "Fix the flaky retry test and document the root cause.",
      },
      {
        id: "release-reviewer",
        name: "Ada",
        description: "Reviews the patch and confirms failure recovery before handoff.",
        role: "reviewer",
        status: "waiting_approval",
        tasksCompleted: 2,
        currentTask: "Check the patch and confirm failure recovery.",
      },
      {
        id: "release-tester",
        role: "tester",
        status: "handoff",
        tasksCompleted: 3,
        handoffTarget: "release-reviewer",
      },
    ],
    edges: [{ from: "release-coder", to: "release-reviewer", kind: "review_gate", activeCount: 1 }],
  },
  mailbox: {
    "release-coder": { queueDepth: 2, pendingReplyCount: 1, lease: { leaseState: "acquired" } },
    "release-reviewer": { queueDepth: 0, pendingReplyCount: 0, lease: { leaseState: "idle" } },
  },
  replay: {
    events: [
      {
        kind: "turn_done",
        turnId: "release-plan",
        seq: 12,
        status: "completed",
        payload: {
          durationMs: 1240,
          outcome: "Identified the retry boundary. Added a regression plan and assigned review.",
          recordCount: 8,
        },
      },
      {
        kind: "turn_done",
        turnId: "retry-verification",
        seq: 24,
        status: "failed",
        payload: {
          durationMs: 3850,
          outcome:
            "The retry test still fails when the connection closes before acknowledgement. Preserve the draft and retry after recovery.",
          recordCount: 14,
        },
      },
    ],
  },
};
const empty = { swarm: { agents: [], edges: [] }, mailbox: {}, replay: { events: [] } };
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function boot(page) {
  const state = {
    snapshot: populated,
    offline: false,
    pendingTask: null,
    taskMode: "success",
    messageMode: "success",
    requests: [],
    unexpected: [],
    errors: [],
    sockets: [],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  page.on("console", (message) => {
    // HTTP failures are deliberately exercised; other console errors are not expected.
    if (
      message.type() === "error" &&
      !/^Failed to load resource: the server responded with a status of (400|503)\b/.test(
        message.text(),
      )
    )
      state.errors.push(message.text());
  });
  await page.clock.setFixedTime(new Date("2026-09-17T10:00:00Z"));
  await page.addInitScript(() => localStorage.setItem("penguin.lang", "en"));
  await page.routeWebSocket("**/api/cockpit/stream?*", (socket) => {
    state.sockets.push(socket);
    if (state.offline) socket.close();
  });
  await page.route("http://workspace-visual.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
      });
    if (path === "/api/projects")
      return json(route, { projects: [{ projectId: "alpha", name: "Release workspace" }] });
    if (path === "/api/projects/alpha/agents")
      return json(route, { agents: [{ agentId: "default_agent", name: "Release agent" }] });
    if (path === "/api/projects/alpha/agents/default_agent/sessions")
      return json(route, {
        sessions: [],
        counts: { active: 0, archived: 0, subagent: 0, schedule: 0 },
      });
    // 204 tells the real EventSource not to reconnect; no SSE data is needed here.
    if (path === "/api/events") return route.fulfill({ status: 204 });
    state.requests.push({
      path,
      project: url.searchParams.get("project"),
      method: request.method(),
      body: request.postDataJSON(),
    });
    if (path === "/api/cockpit/telemetry")
      return state.offline
        ? json(route, { error: { message: "Telemetry unavailable. Reconnect and refresh." } }, 503)
        : json(route, { success: true, data: state.snapshot });
    if (path === "/api/cockpit/swarm/run") {
      if (state.taskMode === "pending") {
        state.pendingTask = route;
        return;
      }
      return state.taskMode === "error"
        ? json(
            route,
            { error: { message: "Runtime unavailable. Your task has not been sent." } },
            503,
          )
        : json(route, { success: true, result: { status: "completed" } });
    }
    if (path === "/api/cockpit/mailbox/send")
      return state.messageMode === "error"
        ? json(route, { error: { message: "Unknown agent. Choose a recipient and retry." } }, 400)
        : json(route, { success: true, mailbox: populated.mailbox });
    state.unexpected.push(path);
    return json(route, { error: { message: `Unexpected fixture request: ${path}` } }, 404);
  });
  await page.goto("http://workspace-visual.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Workspace control" })).toBeVisible();
  await expect(page.getByText("Live updates", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agents", exact: true })).toContainText(
    "release-coder",
  );
  return state;
}
async function selectTool(page, name, value) {
  if (page.viewportSize().width < 1024)
    await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption(value);
  else {
    const button = page.getByRole("button", { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
  }
}
async function check(page, state) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.requests.every((request) => request.project === "alpha")).toBe(true);
}
async function capture(page, state, name) {
  await check(page, state);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(outputDir, `${name}.png`),
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`${width} ${theme}: workspace screenshots and acknowledged actions`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = await boot(page);
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        theme === "dark",
      );
      const prefix = `${width}-${theme}`;
      const goal = page.getByRole("textbox", { name: "What should the agents do?" });
      const run = page.getByRole("button", { name: "Run task", exact: true });
      await expect(run).toBeDisabled();
      await goal.fill("   \n  ");
      await expect(run).toBeDisabled();
      expect(state.requests.filter((r) => r.method === "POST")).toEqual([]);
      await goal.fill(
        "Fix the flaky retry test; run the regression suite and report what changed.",
      );
      if (width === 1440 && theme === "dark") {
        state.taskMode = "pending";
        await run.click();
        await expect(page.getByRole("button", { name: "Task running…" })).toBeDisabled();
        await expect(goal).toBeDisabled();
        await expect.poll(() => Boolean(state.pendingTask)).toBe(true);
        await capture(page, state, `${prefix}-run-task-loading`);
        await json(state.pendingTask, { success: true, result: { status: "completed" } });
        await expect(goal).toHaveValue("");
        await expect(page.getByText("Task finished. Review its activity below.")).toBeVisible();
      } else if (width === 390 && theme === "light") {
        state.taskMode = "error";
        await run.click();
        await expect(page.getByRole("alert")).toContainText("Runtime unavailable");
        await expect(goal).toHaveValue(
          "Fix the flaky retry test; run the regression suite and report what changed.",
        );
        await expect(run).toBeEnabled();
        await capture(page, state, `${prefix}-run-task-error`);
      } else if (width === 390 && theme === "dark") {
        state.snapshot = empty;
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect(
          page.getByText("No agent activity reported yet. Run a task to begin."),
        ).toBeVisible();
        await goal.fill("");
        await capture(page, state, `${prefix}-run-task-empty`);
      } else {
        await page.getByText("Coordination (1)", { exact: true }).click();
        await capture(page, state, `${prefix}-run-task`);
        await run.click();
        await expect(goal).toHaveValue("");
        await expect(page.getByText("Task finished. Review its activity below.")).toBeVisible();
      }
      // Reset through the actual refresh action before inspecting the remaining tools.
      state.snapshot = populated;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("region", { name: "Agents", exact: true })).toContainText(
        "release-coder",
      );
      await selectTool(page, "Activity", "ledger");
      await expect(page.getByText("retry-verification", { exact: true })).toBeVisible();
      await page.getByText("Duration: 3,850 ms", { exact: true }).click();
      if (width === 390 && theme === "dark") {
        state.offline = true;
        for (const socket of state.sockets) socket.close();
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("Telemetry unavailable");
        await expect(
          page.getByText("Disconnected — displayed data may be out of date."),
        ).toBeVisible();
      }
      await capture(page, state, `${prefix}-activity${state.offline ? "-disconnected" : ""}`);
      state.offline = false;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveCount(width === 390 && theme === "light" ? 1 : 0);
      await selectTool(page, "Agent messages", "mailbox");
      const send = page.getByRole("button", { name: "Send message", exact: true });
      await expect(send).toBeDisabled();
      await page
        .getByRole("combobox", { name: "Recipient", exact: true })
        .selectOption("release-coder");
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Please rerun the retry regression and attach the observed result.");
      if (width === 390 && theme === "light") {
        state.messageMode = "error";
        await send.click();
        await expect(page.getByRole("alert")).toContainText("Unknown agent");
        await expect(page.getByRole("textbox", { name: "Message", exact: true })).not.toBeEmpty();
      } else {
        await send.click();
        await expect(page.getByText("Message queued.", { exact: true })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
      }
      await capture(page, state, `${prefix}-agent-messages`);
      // Clear the deliberately failed command through an acknowledged retry.
      if (state.messageMode === "error") {
        state.messageMode = "success";
        await send.click();
        await expect(page.getByRole("alert")).toHaveCount(0);
      }
      await selectTool(page, "Reviews & handoffs", "consensus");
      await expect(page.getByRole("heading", { name: "Agent coordination" })).toBeVisible();
      await expect(
        page.getByText("No decisions in this view. Propose a decision to collect peer feedback."),
      ).toBeVisible();
      if (theme === "dark") {
        await page.getByRole("button", { name: "Handoffs", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Handoffs (live)" })).toBeVisible();
      }
      await capture(
        page,
        state,
        `${prefix}-reviews-${theme === "dark" ? "handoffs" : "decisions"}`,
      );
      await check(page, state);
      const task = state.requests.find((r) => r.path.endsWith("/swarm/run"));
      if (task)
        expect(task.body).toEqual({
          projectId: "alpha",
          goal: "Fix the flaky retry test; run the regression suite and report what changed.",
          maxRounds: 3,
        });
      expect(state.requests.find((r) => r.path.endsWith("/mailbox/send"))?.body).toEqual({
        projectId: "alpha",
        from: "operator",
        to: "release-coder",
        content: "Please rerun the retry regression and attach the observed result.",
      });
    });
  }
}
