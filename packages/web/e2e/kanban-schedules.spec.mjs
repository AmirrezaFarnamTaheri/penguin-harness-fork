import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test.use({ locale: "en-US" });
let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./kanban-schedules.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
    loader: { ".css": "empty" },
  });
  script = result.outputFiles[0].text;
});

async function boot(page, role = "owner") {
  const errors = [],
    unexpected = [],
    writes = [];
  let item = {
    name: "daily",
    prompt: "Review the build",
    enabled: true,
    startAt: "2099-01-01T09:00:00Z",
    period: "30m",
    status: "active",
    queued: false,
  };
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("http://kanban-schedules.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="root"></div></body></html>',
    }),
  );
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const reply = (body) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (
      req.method() === "PUT" &&
      path === "/api/projects/test/agents/default_agent/schedules/daily"
    ) {
      const body = req.postDataJSON();
      writes.push(body);
      item = { ...item, ...body, status: body.enabled ? "active" : "disabled" };
      return reply(item);
    }
    if (path === "/api/me") return reply({ user: { userId: "owner" } });
    if (path === "/api/projects")
      return reply({ projects: [{ projectId: "test", name: "Test", role }] });
    if (path === "/api/projects/test/agents")
      return reply({ agents: [{ agentId: "default_agent", name: "Default" }] });
    if (path === "/api/projects/test/agents/default_agent/config")
      return reply({
        config: { schedules: { enabled: true, prompt: "Schedules", inTemplate: true } },
      });
    if (path === "/api/projects/test/agents/default_agent/schedules")
      return reply({ schedules: [item], invalidFiles: [] });
    if (path === "/api/projects/test/kanban/tasks") return reply({ tasks: [], total: 0 });
    if (path === "/api/projects/test/kanban/drafts") return reply({ drafts: [] });
    if (path === "/api/projects/test/models") return reply({ models: [], defaultModel: null });
    unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({ status: 404, body: "Unexpected fixture request" });
  });
  const mount = async () => {
    await page.goto("http://kanban-schedules.test/");
    await page.addScriptTag({ content: script });
    await expect(page.getByRole("row").filter({ hasText: "daily" })).toBeVisible();
  };
  await mount();
  return { errors, unexpected, writes, mount };
}

test("task board edits and toggles the real schedule API and reloads the saved values", async ({
  page,
}) => {
  const probe = await boot(page);
  const row = page.getByRole("row").filter({ hasText: "daily" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("textarea").fill("Review the release build");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(probe.writes[0]).toMatchObject({
    prompt: "Review the release build",
    enabled: true,
    period: "30m",
  });
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(row.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  expect(probe.writes[1]).toMatchObject({
    prompt: "Review the release build",
    enabled: false,
    period: "30m",
  });
  await probe.mount();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("dialog").locator("textarea")).toHaveValue(
    "Review the release build",
  );
  expect(probe.writes).toHaveLength(2);
  expect(probe.errors).toEqual([]);
  expect(probe.unexpected).toEqual([]);
});

test("members see scheduled tasks but cannot edit or enable them", async ({ page }) => {
  const probe = await boot(page, "member");
  const row = page.getByRole("row").filter({ hasText: "daily" });
  await expect(row.getByRole("button")).toHaveCount(0);
  expect(probe.writes).toEqual([]);
  expect(probe.errors).toEqual([]);
  expect(probe.unexpected).toEqual([]);
});
