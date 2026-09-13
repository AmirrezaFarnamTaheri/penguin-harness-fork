import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test("a stale unauthorized identity response cannot overwrite a newer identity", async ({
  page,
}) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./auth-state.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  await page.route("http://identity.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div>',
    }),
  );
  let firstRequest;
  let requestCount = 0;
  await page.route("http://identity.test/api/me", async (route) => {
    if (++requestCount === 1) {
      firstRequest = route;
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { userId: "current-user" },
        previewIsolated: true,
        desktopMode: false,
        sessionVia: "cookie",
        uploadLimits: {},
        companyMode: false,
      }),
    });
  });
  await page.goto("http://identity.test/");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await expect.poll(() => requestCount).toBe(1);
  await page.getByRole("button", { name: "Refresh identity" }).click();
  await expect(page.getByLabel("Identity")).toHaveText("current-user");
  await firstRequest.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "unauthorized", message: "Expired request" },
    }),
  });
  // A subsequent refresh settles after the stale response and confirms the provider remained usable.
  await page.getByRole("button", { name: "Refresh identity" }).click();
  await expect(page.getByLabel("Identity")).toHaveText("current-user");
});
