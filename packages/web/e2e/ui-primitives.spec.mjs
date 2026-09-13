import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";

let fixtureScript;
let fixtureStyle;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./ui-primitives.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  fixtureScript = result.outputFiles[0].text;
  const assets = new URL("../dist/assets/", import.meta.url);
  const stylesheet = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
  if (!stylesheet) throw new Error("Build the web app before running browser tests.");
  fixtureStyle = await readFile(new URL(stylesheet, assets), "utf8");
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: fixtureStyle });
  await page.addScriptTag({ content: fixtureScript });
});

test("shared select menus support composite keyboard navigation", async ({ page }) => {
  const select = page.getByRole("button", { name: "Flavor" });
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "One" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Three" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(select).toContainText("Three");
  await expect(select).toBeFocused();

  const menu = page.getByRole("button", { name: "Mode" });
  await menu.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("option", { name: /Alpha/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: /Beta/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sheet" })).toBeFocused();
});

test("Sheet moves and contains focus, then restores its opener", async ({ page }) => {
  const opener = page.getByRole("button", { name: "Open sheet" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Editor" });
  await expect(dialog).toBeVisible();
  const close = dialog.locator("button").first();
  await expect(close).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Last sheet action" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  const nestedSelect = dialog.getByRole("button", { name: "Sheet flavor" });
  await nestedSelect.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "One", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(nestedSelect).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("toasts expose live semantics and remain dismissible", async ({ page }) => {
  await page.getByRole("button", { name: "Show error" }).click();
  const error = page.getByRole("alert");
  await expect(error).toHaveAttribute("aria-live", "assertive");
  await expect(error).toHaveText("Could not save");
  await error.getByRole("button").click();
  await expect(error).toBeHidden();

  await page.getByRole("button", { name: "Show success" }).click();
  const status = page.getByRole("status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("Saved");
});
