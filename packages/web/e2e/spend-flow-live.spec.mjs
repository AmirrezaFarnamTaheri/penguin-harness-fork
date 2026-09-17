import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./spend-flow-live.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    alias: {
      "@prismshadow/penguin-core/browser": fileURLToPath(
        new URL("../../core/src/browser.ts", import.meta.url),
      ),
    },
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

const report = {
  period: { label: "Recent sessions", start: "2026-09-01", end: "2026-09-17" },
  models: [{ id: "m1", label: "Model One", cost: 12 }],
  projects: [
    { id: "p1", label: "Project One", cost: 9 },
    { id: "p2", label: "Project Two", cost: 3 },
  ],
  links: [
    { model: "m1", project: "p1", cost: 9 },
    { model: "m1", project: "p2", cost: 3 },
  ],
  totalCostUsd: 12,
};

test("existing cost panel loads Sankey, exposes focus values and refreshes to empty", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  await page.route("http://spend.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  await page.route("**/api/projects/p1/gateway/spend-flow", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ limit: 50 });
    requests++;
    return route.fulfill({
      json: {
        report:
          requests === 1
            ? report
            : {
                ...report,
                models: [],
                projects: [],
                links: [],
                totalCostUsd: 0,
              },
      },
    });
  });
  await page.goto("http://spend.test/");
  await page.addScriptTag({ content: script });
  const chart = page.getByRole("region", { name: "Spend flow attribution", exact: true });
  await expect(chart.locator("[data-spend-link]")).toHaveCount(2);
  const first = chart.getByRole("img", { name: "Model One → Project One: $9.0000 USD (75%)" });
  await first.focus();
  await expect(first).toBeFocused();
  await expect(chart.locator('[aria-live="polite"]')).toHaveText(
    "Model One → Project One: $9.0000 USD (75%)",
  );
  await page.keyboard.press("Tab");
  await expect(chart.locator('[aria-live="polite"]')).toHaveText(
    "Model One → Project Two: $3.0000 USD (25%)",
  );
  await page.getByText("Model-to-project detail (2)", { exact: true }).click();
  await expect(page.getByText("m1 → p2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(chart.getByText("No positive recorded cost to plot.")).toBeVisible();
  await expect(chart.locator("svg")).toHaveCount(0);
  await expect(chart.getByText("Largest flow:", { exact: true })).toHaveCount(0);
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
});
