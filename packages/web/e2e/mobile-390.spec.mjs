import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse the real workspace page with LocaleProvider, ProjectProvider and SessionsProvider.
// Build web first. WEB_390_ASSETS_DIR optionally selects a freshly built scratch assets dir.
let script, css;
test.use({
  viewport: { width: 390, height: 844 },
  locale: "en-US",
  reducedMotion: "reduce",
});
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./workspace-visual.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
    loader: { ".css": "empty" },
  });
  script = bundle.outputFiles[0].text;
  const assets = process.env.WEB_390_ASSETS_DIR
    ? resolve(process.env.WEB_390_ASSETS_DIR)
    : fileURLToPath(new URL("../dist/assets/", import.meta.url));
  const names = (await readdir(assets)).filter((name) => /^index-.*\.css$/.test(name));
  expect(names, "Build web first; exactly one production stylesheet is required").toHaveLength(1);
  css = await readFile(resolve(assets, names[0]), "utf8");
});

test("populated workspace fits 390px without a horizontal document scrollbar", async ({
  page,
}, testInfo) => {
  const errors = [],
    unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("penguin.lang", "en"));
  await page.routeWebSocket("**/api/cockpit/stream?*", () => {});
  await page.route("http://workspace-visual.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
      });
    if (path === "/api/projects")
      return json({ projects: [{ projectId: "alpha", name: "Release workspace" }] });
    if (path === "/api/projects/alpha/agents")
      return json({ agents: [{ agentId: "default_agent", name: "Release agent" }] });
    if (path === "/api/projects/alpha/agents/default_agent/sessions")
      return json({ sessions: [], counts: { active: 0, archived: 0, subagent: 0, schedule: 0 } });
    if (path === "/api/events") return route.fulfill({ status: 204 });
    if (path === "/api/cockpit/telemetry")
      return json({
        success: true,
        data: {
          swarm: {
            agents: [
              {
                id: "release-reviewer",
                name: "Ada",
                role: "reviewer",
                status: "waiting_approval",
                tasksCompleted: 2,
                currentTask: "Review the retry patch and confirm failure recovery before handoff.",
              },
            ],
            edges: [],
          },
          mailbox: {
            "release-reviewer": {
              queueDepth: 0,
              pendingReplyCount: 0,
              lease: { leaseState: "idle" },
            },
          },
          replay: { events: [] },
        },
      });
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, body: "Unexpected fixture request" });
  });
  await page.goto("http://workspace-visual.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Workspace control" })).toBeVisible();
  await expect(page.getByText("Live updates", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Agents", exact: true })).toContainText(
    "release-reviewer",
  );
  await expect(page.getByRole("combobox", { name: "Tool", exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "What should the agents do?" })
    .fill("Review the retry patch and confirm failure recovery before handoff.");
  await page.evaluate(() => document.fonts.ready);

  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const scrolling = document.scrollingElement;
    window.scrollTo(1000, 0);
    const horizontalScrollOffset = window.scrollX;
    window.scrollTo(0, 0);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentScrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      scrollingWidth: scrolling.scrollWidth,
      scrollingClientWidth: scrolling.clientWidth,
      horizontalScrollOffset,
      overflowX: getComputedStyle(root).overflowX,
      offenders: [...document.querySelectorAll("body *")].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > innerWidth || rect.left < 0)
          ? [
              {
                tag: element.tagName,
                className: element.className,
                left: rect.left,
                right: rect.right,
              },
            ]
          : [];
      }),
    };
  });
  const layoutPath = testInfo.outputPath("390px-layout.json");
  const screenshotPath = testInfo.outputPath("390px-workspace.png");
  await writeFile(layoutPath, JSON.stringify(layout, null, 2));
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
  await testInfo.attach("390px-layout", { path: layoutPath, contentType: "application/json" });
  await testInfo.attach("390px-workspace", { path: screenshotPath, contentType: "image/png" });
  expect(layout.viewport).toEqual({ width: 390, height: 844 });
  expect(layout.documentScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(390);
  expect(layout.scrollingWidth, "No horizontal document scroll range").toBeLessThanOrEqual(
    layout.scrollingClientWidth,
  );
  expect(layout.horizontalScrollOffset, "Attempted horizontal scroll must not move the page").toBe(
    0,
  );
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
