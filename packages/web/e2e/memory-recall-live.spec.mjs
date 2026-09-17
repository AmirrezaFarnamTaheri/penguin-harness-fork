import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./memory-recall-live.fixture.tsx", import.meta.url))],
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
async function mount(page, fail = false) {
  page.on("pageerror", (error) => console.error("Fixture error:", error.message));
  page.setDefaultTimeout(10000);
  await page.route("http://memory.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/projects/p1/agents/default_agent/memory**", (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith("/search")) {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: { code: "http_error", message: "Search unavailable" } },
        });
      body = {
        query: url.searchParams.get("q"),
        results: [
          {
            scopeKey: "user",
            fileName: "db.md",
            relevance: 1,
            tokens: 46,
            snippet: "Fresh server snippet",
          },
        ],
      };
    } else if (url.pathname.endsWith("/files/db.md"))
      body = { content: "postgresql saved document" };
    else if (url.pathname.endsWith("/files"))
      body = { files: [{ name: "db.md", title: "Database", size: 40, modifiedAt: "2026-09-17" }] };
    else body = { scopes: [{ scopeKey: "user", kind: "user" }] };
    return route.fulfill({ json: body });
  });
  await page.goto("http://memory.test/");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Recall test", exact: true }).click();
}
test("inspection queries server and clears matches when input clears", async ({ page }) => {
  await mount(page);
  await page.getByRole("textbox", { name: "Recall query" }).fill("postgresql");
  await expect(page.getByText("Fresh server snippet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Database.*100%/ }).click();
  await expect(page.getByText("postgresql saved document", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Recall query" }).fill("");
  await expect(page.getByText("Fresh server snippet", { exact: true })).toHaveCount(0);
});
test("failed search is explicit and does not silently use local matches", async ({ page }) => {
  await mount(page, true);
  await page.getByRole("textbox", { name: "Recall query" }).fill("postgresql");
  await expect(page.getByRole("alert")).toContainText("Search unavailable");
  await expect(page.getByRole("button", { name: /Database.*100%/ })).toHaveCount(0);
});
