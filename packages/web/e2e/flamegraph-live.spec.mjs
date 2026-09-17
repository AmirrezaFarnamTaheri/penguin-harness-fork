import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./flamegraph-live.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

const traces = {
  files: [
    { index: 0, date: "2026-09-17", sizeBytes: 2048, mtime: "2026-09-17T10:00:00.000Z" },
    { index: 1, date: "2026-09-17", sizeBytes: 4096, mtime: "2026-09-17T11:00:00.000Z" },
  ],
};
const analysis = {
  elapsedMs: 700,
  apiMs: 700,
  toolMs: 200,
  tasks: [
    {
      taskIndex: 0,
      startTs: "2026-09-17T10:00:00.000Z",
      endTs: "2026-09-17T10:00:00.500Z",
      tokens: { cacheRead: 300, cacheWrite: 100, output: 50 },
      llmMs: 500,
      toolMs: 200,
    },
    {
      taskIndex: 1,
      startTs: "2026-09-17T10:00:01.000Z",
      endTs: "2026-09-17T10:00:01.200Z",
      tokens: { cacheRead: 10, cacheWrite: 10, output: 5 },
      llmMs: 200,
      toolMs: 0,
    },
  ],
  requests: [
    {
      beginTs: "2026-09-17T10:00:00.000Z",
      endTs: "2026-09-17T10:00:00.500Z",
      durationMs: 500,
      status: "completed",
      taskIndex: 0,
    },
    {
      beginTs: "2026-09-17T10:00:01.000Z",
      endTs: "2026-09-17T10:00:01.200Z",
      durationMs: 200,
      status: "error",
      taskIndex: 1,
    },
  ],
  toolCalls: [
    {
      toolCallId: "tc-1",
      name: "read_file",
      startTs: "2026-09-17T10:00:00.100Z",
      endTs: "2026-09-17T10:00:00.300Z",
      durationMs: 200,
    },
  ],
};

test("flamegraph page renders live session trace analysis", async ({ page }) => {
  await page.route("http://flame.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/sessions/sess-live/traces**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/analysis")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(analysis),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(traces),
    });
  });
  await page.goto("http://flame.test/");
  await page.addScriptTag({ content: script });

  await expect(page.getByRole("combobox", { name: "Live trace file" })).toBeVisible();
  await expect(page.getByText("Turn 1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Turn 2", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Tool: read_file", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Live session trace", { exact: true })).toBeVisible();
});

test("a failed trace listing keeps the page usable with the error shown", async ({ page }) => {
  await page.route("http://flame.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/sessions/sess-live/traces", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: "No trace files (HTTP 404)" } }),
    }),
  );
  await page.goto("http://flame.test/");
  await page.addScriptTag({ content: script });
  await expect(page.getByText("No trace files (HTTP 404)", { exact: true })).toBeVisible();
});
