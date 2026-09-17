import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./guardian-audit.fixture.tsx", import.meta.url))],
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
const receipt = (sessionId, timestamp) => ({
  payloadHash: sessionId,
  projectId: "alpha",
  agentId: "agent",
  sessionId,
  timestamp,
  type: "tool_call",
  eventHash: "b7f2c9e1" + "a".repeat(56),
});
async function boot(page, audit) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://tools.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (path.endsWith("/audit/receipts")) return audit(route, path);
    if (path === "/api/projects")
      return json(route, {
        projects: [
          { projectId: "alpha", name: "Alpha" },
          { projectId: "beta", name: "Beta" },
        ],
      });
    if (path.endsWith("/agents")) return json(route, { agents: [] });
    if (path.endsWith("/command-policy")) return json(route, { enabled: false, rules: [] });
    return json(route, {});
  });
  await page.goto("http://tools.test/");
  await page.addScriptTag({ content: script });
  return errors;
}

test("mounted Guardian feed refreshes empty to populated to empty without claiming causality", async ({
  page,
}) => {
  let receipts = [];
  const paths = [];
  const errors = await boot(page, (route, path) => {
    paths.push(path);
    return json(route, { receipts, truncated: receipts.length > 0 });
  });
  const graph = page.getByRole("region", { name: "Chronological audit receipts" });
  await expect(graph).toContainText("No verified audit receipts");
  receipts = [receipt("newest", 1700000001000), receipt("older", 1700000000000)];
  await page.getByRole("button", { name: "Refresh audit receipts" }).click();
  await expect(graph.locator("li")).toHaveCount(2);
  await expect(graph.locator("li").first()).toContainText("newest");
  await expect(graph.locator("time").first()).toHaveAttribute(
    "datetime",
    "2023-11-14T22:13:21.000Z",
  );
  await expect(graph).toContainText("b7f2c9e1");
  await expect(graph).not.toContainText("b7f2c9e1a");
  await expect(graph).not.toContainText("→");
  await expect(page.getByText("Newest recorded entries first", { exact: false })).toContainText(
    "not proof of causality",
  );
  await expect(page.getByText("Older receipts may be outside this bounded view.")).toBeVisible();
  receipts = [];
  await page.getByRole("button", { name: "Refresh audit receipts" }).click();
  await expect(graph).toContainText("No verified audit receipts");
  await expect(graph.locator("li")).toHaveCount(0);
  expect(paths).toEqual(Array(3).fill("/api/projects/alpha/audit/receipts"));
  expect(errors).toEqual([]);
});

test("surfaces a feed error and recovers on refresh", async ({ page }) => {
  let failing = true;
  const errors = await boot(page, (route) =>
    failing
      ? json(
          route,
          { error: { code: "audit_unavailable", message: "Verification unavailable" } },
          503,
        )
      : json(route, { receipts: [], truncated: false }),
  );
  await expect(page.getByRole("alert")).toContainText("Could not load audit receipts.");
  await expect(page.getByRole("alert")).toContainText("Verification unavailable");
  await expect(page.getByText("No verified audit receipts", { exact: false })).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "Refresh audit receipts" }).click();
  await expect(page.getByText("No verified audit receipts", { exact: false })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("switching projects discards a late response from the previous project", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let alphaStarted;
  const started = new Promise((resolve) => {
    alphaStarted = resolve;
  });
  const errors = await boot(page, async (route, path) => {
    if (path.includes("/alpha/")) {
      alphaStarted();
      await pending;
      return json(route, { receipts: [receipt("stale-alpha", 1700000000000)], truncated: false });
    }
    return json(route, { receipts: [], truncated: false });
  });
  await started;
  await page.getByRole("button", { name: "Switch to beta" }).click();
  await expect(page.getByText("No verified audit receipts", { exact: false })).toBeVisible();
  const oldResponse = page.waitForResponse("**/alpha/audit/receipts");
  release();
  await oldResponse;
  await expect(page.getByText("stale-alpha", { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});
