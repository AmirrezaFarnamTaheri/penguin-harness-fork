import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./time-travel-slider.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

function analysis(count) {
  return {
    tasks: Array.from({ length: count }, (_, taskIndex) => ({
      taskIndex,
      startTs: `2026-09-17T10:00:0${taskIndex}.000Z`,
      endTs: `2026-09-17T10:00:0${taskIndex}.900Z`,
      tokens: { cacheRead: 10, cacheWrite: 2, output: 3 },
    })),
    requests: Array.from({ length: count }, (_, taskIndex) => ({
      taskIndex,
      beginTs: `2026-09-17T10:00:0${taskIndex}.000Z`,
      endTs: `2026-09-17T10:00:0${taskIndex}.400Z`,
      status: taskIndex === 1 ? "error" : "completed",
    })),
    toolCalls: count
      ? [
          {
            toolCallId: "read-1",
            name: "read_file",
            startTs: "2026-09-17T10:00:00.500Z",
            endTs: "2026-09-17T10:00:00.700Z",
          },
        ]
      : [],
  };
}

async function mount(page, failOldFile = false) {
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://replay.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/sessions/**/traces**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, method: route.request().method() });
    if (path.endsWith("/analysis")) {
      if (failOldFile && path.includes("/0/analysis"))
        return route.fulfill({
          status: 503,
          json: { error: { code: "http_error", message: "Trace unavailable" } },
        });
      return route.fulfill({
        json: analysis(path.includes("replay-b") ? 0 : path.includes("/0/analysis") ? 1 : 2),
      });
    }
    return route.fulfill({
      json: { files: path.includes("replay-b") ? [{ index: 7 }] : [{ index: 0 }, { index: 1 }] },
    });
  });
  await page.goto("http://replay.test/");
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("slider")).toHaveValue("2");
  return { requests, errors };
}

test("scrubs a recorded prefix, updates diagnostics and clears the inspector without executing requests", async ({
  page,
}) => {
  const { requests, errors } = await mount(page);
  const timeline = page.getByRole("region", { name: "Execution timeline" });
  const slider = page.getByRole("slider", { name: "Recorded trace turn" });
  const latest = page.getByRole("button", { name: "Latest recorded" });
  await timeline.getByRole("button", { name: /Turn 2/ }).click();
  const requestCount = requests.length;
  await slider.focus();
  await slider.press("ArrowLeft");
  await expect(slider).toHaveValue("1");
  await expect(page.getByText("Turn 2", { exact: true })).toHaveCount(0);
  await expect(timeline.getByText("Tool: read_file", { exact: true })).toBeVisible();
  await expect(page.locator("dl").first()).toContainText("Failed spans0");
  const prefix = await timeline.innerHTML();
  await latest.click();
  await expect(timeline.getByText("Turn 2", { exact: true })).toBeVisible();
  await slider.focus();
  await slider.press("ArrowLeft");
  expect(await timeline.innerHTML()).toBe(prefix);
  await slider.press("Home");
  await expect(slider).toHaveValue("0");
  await expect(timeline.getByRole("button")).toHaveCount(0);
  await latest.click();
  await expect(slider).toHaveValue("2");
  expect(requests).toHaveLength(requestCount);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(errors).toEqual([]);
});

test("file and session changes reset replay; empty records never fall back to samples", async ({
  page,
}) => {
  const { requests, errors } = await mount(page);
  await page.getByRole("slider").focus();
  await page.getByRole("slider").press("Home");
  await page.getByRole("combobox", { name: "Live trace file" }).selectOption("0");
  await expect(page.getByRole("slider")).toHaveValue("1");
  await expect(page.getByRole("slider")).toHaveAttribute("max", "1");
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(page.getByRole("slider")).toBeDisabled();
  await expect(page.getByText("No recorded turns to replay.")).toBeVisible();
  await expect(page.getByText("Turn 1", { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      requests.some((request) => request.path === "/api/sessions/replay-b/traces/7/analysis"),
    )
    .toBe(true);
  expect(requests.some((request) => /replay-b\/traces\/[01]\//.test(request.path))).toBe(false);
  expect(errors).toEqual([]);
});

test("failed analysis clears the old trajectory", async ({ page }) => {
  await mount(page, true);
  await page.getByRole("combobox", { name: "Live trace file" }).selectOption("0");
  await expect(page.getByText("Trace unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("slider")).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Execution timeline" }).getByRole("button"),
  ).toHaveCount(0);
});
