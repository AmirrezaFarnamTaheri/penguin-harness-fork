import { expect, test } from "@playwright/test";
import { ADMIN_ID, ADMIN_PASSWORD, login } from "./auth.mjs";

test("a temporary identity failure stays retryable, then a confirmed 401 opens sign-in", async ({
  page,
}) => {
  let meRequests = 0;
  await page.route("**/api/me", async (route) => {
    meRequests += 1;
    if (meRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable", message: "Restarting" } }),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto("/chat");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
});

test("an authenticated deep link loads its route chunk", async ({ page }) => {
  await login(page.request, ADMIN_ID, ADMIN_PASSWORD);
  await page.goto("/models");
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByRole("heading", { name: "模型" }).first()).toBeVisible();
});
