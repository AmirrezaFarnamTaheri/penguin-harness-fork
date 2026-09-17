import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { glob, readFile } from "node:fs/promises";
let script;
let css = "";
test.use({ locale: "en-US" });
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./inspection-pages.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
  for await (const file of glob(
    fileURLToPath(new URL("../dist/assets/*.css", import.meta.url)).replaceAll("\\", "/"),
  ))
    css += await readFile(file, "utf8");
});
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const context = (name) => ({
  systemPrompt: 100,
  toolDefs: 0,
  userMessages: 200,
  assistantMessages: 0,
  toolRequests: 0,
  toolResults: 0,
  topTools: [{ name, tokens: 300 }],
  topFiles: [],
  contextClosed: false,
  contextWindow: 1000,
  compactionThreshold: 800,
});
async function boot(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("http://inspection.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("http://inspection.test/");
  if (css) await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return errors;
}
test("session switch ignores late context and compaction results; occupancy uses model capacity", async ({
  page,
}) => {
  let finishAlpha;
  let finishCompact;
  await page.route("**/api/sessions/*/context", async (route) => {
    if (route.request().url().includes("/alpha/"))
      await new Promise((resolve) => {
        finishAlpha = resolve;
      });
    await json(
      route,
      context(route.request().url().includes("/alpha/") ? "alpha-tool" : "beta-tool"),
    );
  });
  await page.route("**/api/sessions/*/compact", async (route) => {
    await new Promise((resolve) => {
      finishCompact = resolve;
    });
    await json(route, { session_id: "beta" });
  });
  const errors = await boot(page);
  await expect(page.getByText("Loading context usage…")).toBeVisible();
  await page.getByRole("button", { name: "Select beta" }).click();
  await expect(page.getByText("beta-tool")).toBeVisible();
  finishAlpha();
  await expect(page.getByText("alpha-tool")).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveAttribute("max", "1000");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "300");
  await expect(page.getByText(/history is not supplied/)).toBeVisible();
  await page.getByRole("button", { name: "Request compaction", exact: true }).click();
  await expect.poll(() => !!finishCompact).toBe(true);
  await page.getByRole("button", { name: "Select alpha" }).click();
  finishCompact();
  await expect(page.getByText(/Compaction requested/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("topology exposes recovery, real symbols, path and keyboard inspector on mobile", async ({
  page,
}) => {
  let mode = "empty";
  await page.route("**/api/sessions/*/context", (route) => json(route, context("tool")));
  await page.route("**/api/cockpit/topology?*", (route) =>
    json(
      route,
      mode === "error"
        ? {}
        : mode === "empty"
          ? { nodes: [], edges: [] }
          : {
              nodes: [
                { id: "a", name: "Alpha", kind: "function", filePath: "src/alpha.ts" },
                { id: "b", name: "Beta", kind: "function", filePath: "src/beta.ts" },
              ],
              edges: [{ source: "a", target: "b", kind: "calls" }],
            },
      mode === "error" ? 503 : 200,
    ),
  );
  const errors = await boot(page);
  await page.getByRole("button", { name: "Open topology" }).click();
  await expect(page.getByText("No indexed symbols", { exact: true })).toBeVisible();
  await expect(page.getByText("ShellGuardian")).toHaveCount(0);
  mode = "error";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load code structure");
  mode = "data";
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: /Alpha function/ }).press("Enter");
  await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use as start" }).click();
  await page.getByLabel("Path end").selectOption("b");
  await expect(page.getByText("Alpha → Beta")).toBeVisible();
  await page.getByLabel("Impact depth").fill("3");
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByRole("button", { name: "Beta, function, src/beta.ts" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Beta", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Chinese" }).click();
  await expect(page.getByRole("heading", { name: "代码结构" })).toBeVisible();
  // Expected HTTP failure is recovery evidence, not a runtime JS error.
  expect(errors.filter((error) => !error.includes("503"))).toEqual([]);
});
test("memory inspection reads real scopes, opens documents and tests keyword recall without seeds", async ({
  page,
}) => {
  const topic = {
    name: "notes.md",
    title: "Actual saved notes",
    description: "",
    size: 80,
    modifiedAt: "2026-09-16T00:00:00Z",
  };
  await page.route("**/api/sessions/*/context", (route) => json(route, context("tool")));
  await page.route("**/memory", (route) =>
    json(route, { scopes: [{ scopeKey: "workspace-a", kind: "workspace" }] }),
  );
  await page.route("**/memory/scopes/*/files", (route) => json(route, { files: [topic] }));
  await page.route("**/memory/scopes/*/files/notes.md", (route) =>
    json(route, { file: topic, content: "# Notes\nRemember the release checklist." }),
  );
  const errors = await boot(page);
  await page.getByRole("button", { name: "Open memory" }).click();
  await page.getByRole("button", { name: /Actual saved notes/ }).click();
  await expect(page.locator("pre")).toContainText("Remember the release checklist.");
  await expect(page.getByText("coding-guidelines.md")).toHaveCount(0);
  await page.getByRole("button", { name: "Recall test", exact: true }).click();
  await page.getByRole("textbox", { name: "Recall query" }).fill("release checklist");
  await expect(page.getByRole("button", { name: /Actual saved notes/ })).toContainText("100%");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
