import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./snapshots-live.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

const snapshots = {
  currentVersion: 3,
  snapshots: [
    {
      version: 1,
      fileName: "v1.tar.gz",
      sizeBytes: 1024,
      mtimeMs: 1700000000000,
      isCurrent: false,
    },
    {
      version: 2,
      fileName: "v2.tar.gz",
      sizeBytes: 2048,
      mtimeMs: 1700000600000,
      isCurrent: false,
    },
    { version: 3, fileName: "v3.tar.gz", sizeBytes: 4096, mtimeMs: 1700001200000, isCurrent: true },
  ],
};

test("snapshots page renders the live on-disk archive list", async ({ page }) => {
  const requests = [];
  await page.route("http://snapshots.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/projects/proj-live/agents/default_agent/snapshots**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshots),
    });
  });
  await page.goto("http://snapshots.test/");
  await page.addScriptTag({ content: script });

  const live = page.getByRole("region", { name: "On-disk snapshots" });
  await expect(live).toBeVisible();
  await expect(live.getByText("v1.tar.gz", { exact: true })).toBeVisible();
  await expect(live.getByText("v3.tar.gz", { exact: true })).toBeVisible();
  await expect(live.getByText("3 archives on disk · current Agent State version v3")).toBeVisible();
  await expect(live.getByText("current", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "Checkpoints" })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test("a failed snapshots request surfaces the error without losing the demo", async ({ page }) => {
  await page.route("http://snapshots.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/projects/proj-live/agents/default_agent/snapshots**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "not_found", message: "Snapshots unavailable (HTTP 404)" },
      }),
    }),
  );
  await page.goto("http://snapshots.test/");
  await page.addScriptTag({ content: script });
  await expect(
    page
      .getByRole("region", { name: "On-disk snapshots" })
      .getByText("Snapshots unavailable (HTTP 404)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Checkpoints" })).toBeVisible();
});
