import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";

let script;
let style;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./product-navigation.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
  const assets = new URL("../dist/assets/", import.meta.url);
  const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
  if (!css) throw new Error("Build the web app before running browser tests.");
  style = await readFile(new URL(css, assets), "utf8");
});
test.beforeEach(async ({ page }) => {
  await page.route("http://navigation.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  await page.goto("http://navigation.test/");
  await page.addStyleTag({ content: style });
  await page.addScriptTag({ content: script });
});

test("minimal defaults, keyboard disclosures, all existing routes and update notes", async ({
  page,
}) => {
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link")).toHaveCount(3);
  const build = nav.getByRole("button", { name: /^Build & knowledge/ });
  await expect(build).toHaveAttribute("title", "Skills Hub: Update available");
  await build.focus();
  await page.keyboard.press("Enter");
  await expect(build).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "Pipelines", exact: true })).toBeFocused();
  for (const name of ["Review & diagnostics", "Models & access"]) {
    await nav.getByRole("button", { name }).click();
  }
  await expect(nav.getByRole("link")).toHaveCount(19);
  const paths = await nav
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(new Set(paths).size).toBe(19);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/context-breakdown",
      "/models/keys",
      "/traces/flamegraph",
      "/benchmark",
      "/usage",
    ]),
  );
  expect(paths).not.toContain("/machines");
  await nav.getByRole("link", { name: "API keys", exact: true }).click();
  await expect(page.getByLabel("Current route")).toHaveText("/models/keys");
  await expect(page.getByLabel("Navigation callbacks")).toHaveText("1");
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
});

test("a deep-linked current page stays visible even when its group is closed", async ({ page }) => {
  const nav = page.getByRole("navigation");
  await page.getByRole("button", { name: "Open API keys directly" }).click();
  const group = nav.getByRole("button", { name: "Models & access" });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "API keys", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("link")).toHaveCount(4);
  await group.click();
  await group.click();
  await expect(nav.getByRole("link", { name: "API keys", exact: true })).toBeVisible();
  await group.focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "API keys", exact: true })).toBeFocused();
});

test("preferences survive remount, with localized labels and mobile touch targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Models & access" }).click();
  await page.getByRole("button", { name: "Chinese" }).click();
  await expect(page.getByRole("navigation", { name: "导航" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "模型与访问" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(nav.getByRole("link", { name: "API 密钥" })).toBeVisible();
  await nav.getByRole("button", { name: "模型与访问" }).click();
  const boxes = await nav
    .locator("a,button")
    .evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().height));
  expect(boxes.every((height) => height >= 44)).toBe(true);
  await expect(page.getByRole("link", { name: "Example conversation" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
