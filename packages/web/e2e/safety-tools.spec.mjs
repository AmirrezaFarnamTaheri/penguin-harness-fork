import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./safety-tools.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function boot(page, view) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://tools.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (path === "/api/projects")
      return json(route, { projects: [{ projectId: "alpha", name: "Alpha" }] });
    if (path.endsWith("/agents")) return json(route, { agents: [] });
    if (path.includes("command-policy")) return json(route, { enabled: false, rules: [] });
    if (path === "/api/cockpit/keys") return json(route, { reports: [] });
    return json(route, {});
  });
  await page.goto(`http://tools.test/?view=${view}`);
  await page.addScriptTag({ content: script });
  return errors;
}

test("policy load failure cannot be mistaken for enabled defaults or saved; retry loads the real policy", async ({
  page,
}) => {
  await boot(page, "guardian");
  await page.route("**/command-policy", (route) => json(route, { error: "Offline" }, 503));
  await page.reload();
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("alert")).toContainText("Could not load the command policy");
  await expect(page.getByRole("button", { name: "Save Policy" })).toBeDisabled();
  await expect(page.getByText("block-root-rm")).toHaveCount(0);
  await page.route("**/command-policy", (route) =>
    json(route, {
      enabled: false,
      rules: [{ name: "server-rule", pattern: "test", enabled: true }],
    }),
  );
  await page.getByRole("button", { name: "Retry loading policy" }).click();
  await expect(page.getByText("server-rule", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Policy" })).toBeEnabled();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
});

test("demo key mutations and rotation update visibly; demo probes send no provider request", async ({
  page,
}) => {
  const errors = await boot(page, "keys");
  const probes = [];
  page.on("request", (request) => {
    if (request.url().includes("/keys/probe")) probes.push(request.url());
  });
  await page.getByRole("button", { name: "Demo Mode", exact: true }).click();
  const row = page.getByText("sk-proj-...8a1c", { exact: true }).locator("../../..");
  await row.getByRole("button", { name: "Pause for 60 seconds" }).click();
  await expect(row.getByText(/Cooldown \(/)).toBeVisible();
  await row.getByRole("button", { name: "Make available" }).click();
  await expect(row.getByText("Healthy", { exact: true })).toBeVisible();
  await page.getByLabel("Demo rotation for gpt-4o").selectOption("least-leases");
  await expect(page.getByLabel("Demo rotation for gpt-4o")).toHaveValue("least-leases");
  await row.getByRole("button", { name: "Probe", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Key probe (local demo)" })).toBeVisible();
  expect(probes).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("key load HTTP errors offer recovery rather than reporting no configured keys", async ({
  page,
}) => {
  await boot(page, "keys");
  await page.route("**/api/cockpit/keys?*", (route) => json(route, {}, 503));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await expect(page.getByText("No API key pools configured")).toHaveCount(0);
  await page.route("**/api/cockpit/keys?*", (route) => json(route, { reports: [] }));
  await page.getByRole("button", { name: "Retry loading keys" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("embedded snapshots retain create/export actions and export parseable state, not a fake archive", async ({
  page,
}) => {
  const errors = await boot(page, "snapshots");
  await page.getByRole("button", { name: "Create Checkpoint", exact: true }).click();
  await page.getByLabel("Checkpoint label", { exact: true }).fill("Regression checkpoint");
  await page.getByRole("button", { name: "Save checkpoint", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Regression checkpoint", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.json$/);
  const data = JSON.parse(await readFile(await file.path(), "utf8"));
  expect(data.snapshot.label).toBe("Regression checkpoint");
  expect(data.state.systemPrompt).toBeTruthy();
  expect(errors).toEqual([]);
});

test("embedded trace selector and keyboard span inspection work on narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await boot(page, "traces");
  await page.getByLabel("Sample trace", { exact: true }).selectOption("trace-codebase-indexing");
  const span = page.getByRole("button", { name: /Tool: write_to_file/ });
  await span.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close Inspector" })).toBeVisible();
  await expect(page.getByText("span-tool-save-index", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("coordination tab switches retain locally composed messages", async ({ page }) => {
  await boot(page, "consensus");
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByRole("button", { name: "Compose demo message", exact: true }).click();
  await page.getByLabel("Event type", { exact: true }).fill("regression:message");
  await page.getByRole("button", { name: "Add demo message" }).click();
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByText("regression:message", { exact: true })).toBeVisible();
});
