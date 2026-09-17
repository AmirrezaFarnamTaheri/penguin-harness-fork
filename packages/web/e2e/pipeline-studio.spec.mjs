import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";

let script, css;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./pipeline-studio.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
    loader: { ".css": "empty" },
  });
  script = result.outputFiles[0].text;
  const assets = new URL("../dist/assets/", import.meta.url);
  const name = (await readdir(assets)).find((n) => /^index-.*\.css$/.test(n));
  css = await readFile(new URL(name, assets), "utf8");
});

async function boot(page) {
  const errors = [],
    writes = [];
  let refreshed = false;
  const pipeline = {
    id: "review",
    name: "Release review",
    nodes: [
      { id: "worker", name: "Architect", kind: "agent", agentRole: "Reviewer" },
      { id: "gate", name: "Approval Gate", kind: "gate" },
      { id: "out", name: "Report", kind: "output" },
    ],
    edges: [
      { from: "worker", to: "gate", conditionValue: true },
      { from: "gate", to: "out" },
    ],
  };
  const run = {
    runId: "run-1",
    pipelineId: "review",
    status: "running",
    currentNodeIds: ["gate"],
    nodeStates: { gate: { nodeId: "gate", status: "waiting_gate" } },
    context: {},
    startedAt: 1,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://pipeline-studio.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    const reply = (body) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/personas") return reply({ personas: [] });
    if (path === "/api/projects/studio-test/pipelines")
      return reply({
        pipelines: [
          refreshed
            ? {
                ...pipeline,
                nodes: [{ id: "new", name: "Updated step", kind: "output" }],
                edges: [],
              }
            : pipeline,
          { id: "empty", name: "Empty workflow", nodes: [], edges: [] },
        ],
      });
    if (path === "/api/projects/studio-test/pipelines/review/runs") return reply({ run });
    return route.fulfill({ status: 404, body: "Unexpected fixture request" });
  });
  await page.goto("http://pipeline-studio.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("region", { name: "Workflow graph", exact: true })).toBeVisible();
  return {
    errors,
    writes,
    refreshData: () => {
      refreshed = true;
    },
  };
}

test("saved graph selection is read-only, keyboard accessible, and reflects refreshed topology", async ({
  page,
}) => {
  const { errors, writes, refreshData } = await boot(page);
  const graph = page.getByRole("region", { name: "Workflow graph", exact: true });
  const gate = graph.getByRole("button", { name: "Approval Gate, gate", exact: true });
  await gate.focus();
  await page.keyboard.press("Enter");
  await expect(gate).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("region", { name: "Step details" })
      .getByRole("heading", { name: "Approval Gate" }),
  ).toBeVisible();
  const worker = graph.getByRole("button", { name: "Architect, agent, Reviewer", exact: true });
  await worker.focus();
  await page.keyboard.press("Space");
  await expect(worker).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Step details" })).toContainText("Reviewer");
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(
    graph.getByRole("button", { name: "Approval Gate, gate, waiting_gate", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(writes).toEqual(["/api/projects/studio-test/pipelines/review/runs"]);
  refreshData();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    graph.getByRole("button", { name: "Updated step, output", exact: true }),
  ).toBeVisible();
  await expect(graph.getByRole("button")).toHaveCount(1);
  await expect(graph.locator("[data-edge-from]")).toHaveCount(0);
  await page.getByRole("button", { name: "Empty workflow" }).click();
  await expect(graph).toContainText("No steps in this workflow.");
  await expect(graph.locator("svg")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("narrow viewport contains graph overflow and supports pointer selection", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { errors, writes } = await boot(page);
  const graph = page.getByRole("region", { name: "Workflow graph", exact: true });
  await graph.getByRole("button", { name: "Approval Gate, gate", exact: true }).click();
  await expect(page.getByRole("region", { name: "Step details" })).toContainText("Approval Gate");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await graph.screenshot({ path: testInfo.outputPath("workflow-mobile.png") });
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
