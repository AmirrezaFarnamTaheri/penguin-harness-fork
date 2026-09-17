import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir } from "node:fs/promises";

let script;
let style;
const screenshots = new URL("../../../artifacts/context-review/context/", import.meta.url);
const response = (scenario = "ready") => ({
  systemPrompt: 14693,
  toolDefs: 12201,
  userMessages: 723,
  assistantMessages: 379,
  toolRequests: 2691,
  toolResults: 48413,
  total: 79100,
  topTools: [
    { name: "read_file", tokens: 30000 },
    { name: "exec_command", tokens: 21104 },
  ],
  topFiles: [
    {
      path: "packages/web/src/features/chat/chat-page.tsx",
      tokens: 24000,
      ops: { read: 3, edit: 1, write: 0 },
    },
  ],
  contextClosed: scenario === "compacted",
  contextWindow: scenario === "unknown" ? null : 240000,
  compactionThreshold: scenario === "unknown" ? null : 225000,
  occupancyTokens: ["compacted", "unknown"].includes(scenario)
    ? null
    : scenario === "estimated"
      ? 83000
      : 79100,
  occupancyStale: scenario === "compacted",
  occupancyRecordedAt: ["compacted", "unknown"].includes(scenario) ? null : "2026-09-17T00:00:00Z",
});
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
test.use({ locale: "en-US", timezoneId: "UTC" });
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./context-visual.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = bundle.outputFiles[0].text;
  const assets = new URL("../dist/assets/", import.meta.url);
  const name = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
  if (!name) throw new Error("Build the web app first so screenshots use production CSS.");
  style = await readFile(new URL(name, assets), "utf8");
  await mkdir(screenshots, { recursive: true });
});
async function boot(page, scenario = "ready", dark = false) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://context.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html lang="en" class="${dark ? "dark" : ""}"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>`,
    }),
  );
  await page.route("**/api/sessions/*/context", (route) => json(route, response(scenario)));
  await page.goto(`http://context.test/?scenario=${scenario}`);
  await page.addStyleTag({ content: style });
  await page.addScriptTag({ content: script });
  return errors;
}
async function capture(page, name, info) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = fileURLToPath(new URL(`${name}.png`, screenshots));
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("441k accumulated spending never becomes 100% context occupancy", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = await boot(page);
  const hud = page.getByRole("region", { name: "Session status" });
  await expect(hud.getByRole("button", { name: /Context 33%/ })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("max", "240000");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "79100");
  await hud.getByRole("button", { name: "Session details" }).click();
  await expect(hud.getByText("79,100 / 240,000", { exact: true })).toBeVisible();
  await expect(page.getByText(/441,000|441\.0k|Context 100%/)).toHaveCount(0);
  await capture(page, "regression-spending-vs-occupancy", info);
  expect(errors).toEqual([]);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const theme of ["light", "dark"]) {
    for (const scenario of ["ready", "compacted", "unknown", "estimated"]) {
      test(`${viewport.name} ${theme} ${scenario}`, async ({ page }, info) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const errors = await boot(page, scenario, theme === "dark");
        await expect(page.getByRole("heading", { name: "Measured context usage" })).toBeVisible();
        if (["compacted", "unknown"].includes(scenario)) {
          await expect(page.getByRole("progressbar")).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Context unavailable" })).toBeVisible();
        } else {
          await expect(page.getByRole("progressbar")).toHaveAttribute(
            "value",
            scenario === "estimated" ? "83000" : "79100",
          );
        }
        await capture(page, `${viewport.name}-${theme}-${scenario}`, info);
        expect(errors).toEqual([]);
      });
    }
  }
}

test("error recovery and a session switch do not keep previous data", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await boot(page);
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.route("**/api/sessions/beta/context", (route) =>
    json(route, { error: "Trace temporarily unavailable" }, 503),
  );
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load context");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await capture(page, "mobile-error-recovery", info);
  await page.route("**/api/sessions/beta/context", (route) =>
    json(route, { ...response(), occupancyTokens: 42000 }),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "42000");
  expect(errors).toEqual([]);
});
