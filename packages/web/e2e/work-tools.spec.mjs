import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
let script, css;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./work-tools.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
    // The dock launcher transitively imports the terminal view's xterm stylesheet; Vite
    // handles CSS in the real build, and this fixture bundles JS only (the app stylesheet
    // is read separately below).
    loader: { ".css": "empty" },
  });
  script = result.outputFiles[0].text;
  const assets = new URL("../dist/assets/", import.meta.url);
  const name = (await readdir(assets)).find((n) => /^index-.*\.css$/.test(n));
  css = await readFile(new URL(name, assets), "utf8");
});
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function boot(page, options = {}) {
  const errors = [],
    requests = [];
  let tasks = [
    {
      id: "task-1",
      boardId: "test",
      title: "Review release notes",
      description: "Check documentation before publishing.",
      state: "backlog",
      priority: "high",
      dependencies: [],
      childTaskIds: [],
      createdAt: 1,
      metadata: { labels: ["docs"] },
    },
  ];
  let pages = {
    alpha: { id: "alpha", content: "# Alpha document\n\nRead [[beta]].", links: ["beta"] },
    beta: { id: "beta", content: "# Beta document\n\nSecond page.", links: [] },
  };
  const pipelines = [
    {
      id: "workflow",
      name: "Release review",
      description: "Inspect the release.",
      nodes: [
        { id: "start", name: "Start review", kind: "trigger" },
        { id: "finish", name: "Publish report", kind: "output" },
      ],
      edges: [{ from: "start", to: "finish" }],
    },
  ];
  let run = {
    runId: "run-1",
    pipelineId: "workflow",
    status: "running",
    currentNodeIds: ["start"],
    nodeStates: { start: { nodeId: "start", status: "running" } },
    context: {},
    startedAt: 1,
  };
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("http://work-tools.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    requests.push({ path, method: req.method(), body: req.postDataJSON() });
    if (options.intercept && (await options.intercept(route, path))) return;
    if (path.endsWith("/kanban/tasks") && req.method() === "GET")
      return json(route, { tasks, total: tasks.length });
    if (path.endsWith("/kanban/tasks") && req.method() === "POST") {
      const task = { ...tasks[0], ...req.postDataJSON(), id: "new-task" };
      tasks.push(task);
      return json(route, { ok: true, task });
    }
    if (path.endsWith("/kanban/tasks/task-1")) {
      tasks[0] = { ...tasks[0], ...req.postDataJSON() };
      return json(route, { ok: true, task: tasks[0] });
    }
    if (path.endsWith("/kanban/drafts")) return json(route, { drafts: [] });
    if (path === "/api/personas") return json(route, { personas: [] });
    if (path.endsWith("/pipelines")) {
      if (req.method() === "POST") {
        const definition = req.postDataJSON();
        pipelines.push(definition);
        return json(route, definition, 201);
      }
      return json(route, { pipelines });
    }
    if (path.endsWith("/runs")) return json(route, { run }, 201);
    if (path.endsWith("/nodes/start/complete")) {
      run = {
        ...run,
        currentNodeIds: ["finish"],
        nodeStates: {
          start: { nodeId: "start", status: "succeeded" },
          finish: { nodeId: "finish", status: "running" },
        },
      };
      return json(route, { run });
    }
    if (path.endsWith("/wiki/nodes")) {
      if (req.method() === "POST") {
        const input = req.postDataJSON();
        pages[input.id] = { ...input, links: [] };
        return json(route, { node: pages[input.id] }, 201);
      }
      if (url.searchParams.has("q"))
        return json(route, {
          matches: Object.values(pages)
            .filter((p) =>
              p.content.toLowerCase().includes(url.searchParams.get("q").toLowerCase()),
            )
            .map((p) => ({ id: p.id })),
        });
      return json(route, {
        nodes: Object.values(pages).map((p) => ({
          id: p.id,
          links: p.links,
          updatedAt: "2026-09-16",
        })),
      });
    }
    if (path.endsWith("/neighbors")) return json(route, { neighbors: ["beta"] });
    if (path.endsWith("/wiki/path")) return json(route, { path: ["alpha", "beta"] });
    if (path.endsWith("/wiki/lint"))
      return json(route, {
        brokenLinks: [{ from: "alpha", to: "missing" }],
        orphanNodes: ["beta"],
      });
    if (path.includes("/wiki/nodes/"))
      return json(route, { node: pages[decodeURIComponent(path.split("/").pop())] });
    return json(
      route,
      { error: { message: `Unexpected request: ${path}`, code: "unexpected" } },
      404,
    );
  });
  await page.goto("http://work-tools.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Task board", exact: true })).toBeVisible();
  return { errors, requests };
}
test("task board has accessible details, assignment, backward movement, and metadata labels", async ({
  page,
}) => {
  const { errors, requests } = await boot(page);
  await page.getByRole("button", { name: "Review release notes", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("docs");
  await page.getByLabel("Assign to agent or user").fill("reviewer");
  await page.getByRole("button", { name: "Assign task", exact: true }).click();
  await expect
    .poll(() => requests.some((r) => r.method === "PATCH" && r.body.assignee === "reviewer"))
    .toBe(true);
  await page.keyboard.press("Escape");
  await page.getByLabel("Status for Review release notes").selectOption("review");
  await expect(page.getByRole("region", { name: "Review", exact: true })).toContainText(
    "Review release notes",
  );
  await page.getByLabel("Status for Review release notes").selectOption("backlog");
  await expect(page.getByRole("region", { name: "Backlog", exact: true })).toContainText(
    "Review release notes",
  );
  expect(errors).toEqual([]);
});
test("pipeline starts on the real runs route and completes a chosen node", async ({ page }) => {
  const { requests, errors } = await boot(page);
  await page.getByRole("button", { name: "pipelines", exact: true }).click();
  await page.getByLabel("Initial context (JSON object)").fill('{"approved":true}');
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run: running" })).toBeVisible();
  await page.getByLabel("Step output (JSON object)").fill('{"result":"reviewed"}');
  await page.getByRole("button", { name: "Mark step complete" }).click();
  await expect(page.getByText("Current steps: Publish report")).toBeVisible();
  expect(requests.find((r) => r.path.endsWith("/runs"))?.body).toEqual({
    context: { approved: true },
  });
  expect(requests.find((r) => r.path.endsWith("/nodes/start/complete"))?.body).toEqual({
    output: { result: "reviewed" },
  });
  expect(requests.some((r) => r.path.endsWith("/step") || r.path.endsWith("/run"))).toBe(false);
  expect(errors).toEqual([]);
});
test("pipeline missing response and triage errors are not successful empty data", async ({
  page,
}) => {
  await boot(page, {
    intercept: (route, path) => {
      if (path.endsWith("/kanban/drafts")) {
        void json(
          route,
          { error: { code: "unavailable", message: "Draft storage unavailable" } },
          503,
        );
        return true;
      }
      if (path.endsWith("/runs")) {
        void json(route, {});
        return true;
      }
      return false;
    },
  });
  await expect(page.getByRole("alert")).toContainText("Draft storage unavailable");
  await page.getByRole("button", { name: "pipelines", exact: true }).click();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The server did not return a run");
  await expect(page.getByText("Run: running")).toHaveCount(0);
});
test("wiki renders Markdown, retains unsaved edits, checks paths and actual lint findings", async ({
  page,
}) => {
  const { requests, errors } = await boot(page);
  await page.getByRole("button", { name: "wiki", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alpha document" })).toBeVisible();
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await page.getByLabel("Markdown content").fill("# Edited alpha\n\nSaved text.");
  await page.getByRole("button", { name: "beta", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Unsaved changes" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel("Markdown content")).toHaveValue("# Edited alpha\n\nSaved text.");
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edited alpha" })).toBeVisible();
  expect(requests.some((r) => r.body?.content === "# Edited alpha\n\nSaved text.")).toBe(true);
  await page.getByRole("button", { name: "Find a path", exact: true }).click();
  await page.getByLabel("Destination").selectOption("beta");
  await page.getByRole("button", { name: "Find path", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1 hops" })).toBeVisible();
  await page.getByRole("button", { name: "Link checks", exact: true }).click();
  await page.getByRole("button", { name: "Run link checks" }).click();
  await expect(page.getByRole("heading", { name: "Broken links (1)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pages without connections (1)" })).toBeVisible();
  expect(errors).toEqual([]);
});
test("late wiki document response cannot overwrite the new selection", async ({ page }) => {
  let delayed;
  await boot(page, {
    intercept: (route, path) => {
      if (path.endsWith("/wiki/nodes/alpha")) {
        delayed = route;
        return true;
      }
      return false;
    },
  });
  await page.getByRole("button", { name: "wiki", exact: true }).click();
  await page.getByRole("button", { name: "beta", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Beta document" })).toBeVisible();
  await json(delayed, { node: { id: "alpha", content: "# Stale alpha", links: [] } });
  await expect(page.getByRole("heading", { name: "Beta document" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stale alpha" })).toHaveCount(0);
});
test("all work tools fit mobile and desktop; missing HUD values stay unknown", async ({
  page,
}, testInfo) => {
  const { errors } = await boot(page);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tool of ["kanban", "pipelines", "wiki", "hud"]) {
      await page.getByRole("button", { name: tool, exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      if (width === 375 || width === 1440)
        await page.screenshot({
          path: testInfo.outputPath(`${tool}-${width}.png`),
          fullPage: true,
        });
    }
  }
  await expect(page.getByText("Context unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Cost unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Session details" }).click();
  // 137c8105e restored the measured cache-warm badge, whose missing-data label
  // "Cache not reported" is a fifth honest "unknown" (getByText is case-insensitive).
  await expect(page.getByText("Not reported")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("dock launcher lists every panel, scrolls on mobile, and opens a panel", async ({ page }) => {
  const { errors } = await boot(page);
  await page.setViewportSize({ width: 375, height: 700 });
  await page.getByRole("button", { name: "dock", exact: true }).click();
  await page.getByTestId("dock-launcher-ball").click();
  const menu = page.getByTestId("dock-launcher-fan");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(17);
  const bounds = await menu.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByTestId("dock-launcher-ball")).toBeFocused();
  await page.getByTestId("dock-launcher-ball").click();
  await page.getByTestId("dock-launcher-open-snapshots").scrollIntoViewIfNeeded();
  await page.getByTestId("dock-launcher-open-snapshots").click();
  await expect(page.getByLabel("Opened dock panel")).toHaveText("snapshots");
  expect(errors).toEqual([]);
});
