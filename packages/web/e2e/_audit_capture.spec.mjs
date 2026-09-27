/**
 * Throwaway audit capture for the shell / sidebar / dock review. Port 8941 only.
 * Mirrors dock.spec.mjs's project setup so the onboarding overlay does not swallow clicks.
 */
import { test, expect } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;
const U = "audituser";
const P = "password123";
const OUT = "e2e/_audit_shots";

async function configureProjectModel(request) {
  const projectId = (await (await request.get(`${BASE}/api/projects`)).json()).projects[0]
    .projectId;
  const put = await request.put(`${BASE}/api/projects/${projectId}/models`, {
    data: {
      defaultModel: { provider: "custom", modelId: "claude-4-8" },
      models: [
        {
          provider: "custom",
          modelId: "claude-4-8",
          apiKey: "sk-mock",
          baseUrl: MOCK,
          contextWindow: 200000,
        },
      ],
    },
  });
  expect(put.ok(), "put models").toBeTruthy();
  return projectId;
}

test("capture: shell, nav, section header, dock", async ({ page, request }) => {
  await provisionAndLogin(page.request, U, P);
  await configureProjectModel(page.request);
  await page.goto(`${BASE}/chat`);
  await expect(page.locator("aside")).toBeVisible();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: `${OUT}/01-shell-default.png` });

  // open all three tool groups (the fixture context runs locale zh-CN)
  for (const name of ["构建与知识", "评估与诊断", "模型与访问"]) {
    const b = page.getByRole("button", { name }).first();
    if ((await b.count()) && (await b.getAttribute("aria-expanded")) === "false") await b.click();
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-nav-groups-open.png` });

  const hrefs = await page
    .locator("nav[aria-label] a")
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  console.log("NAV_HREFS=" + JSON.stringify(hrefs));
  console.log("NAV_COUNT=" + hrefs.length);

  // the session-list section header's controls
  const ls = page.getByRole("button", { name: /列表设置|list settings/i }).first();
  if (await ls.count()) {
    await ls.click({ force: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/03-list-settings.png` });
    await page.keyboard.press("Escape");
  }

  // the dock: Ctrl+` then the add menu
  await page.keyboard.press("Control+`");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-dock-terminal.png` });
  await page.keyboard.press("Control+`");
  await page.waitForTimeout(600);

  const add = page.locator('[data-testid="dock-add"]').first();
  if (await add.count()) {
    await add.click({ force: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/05-dock-add-menu.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // collapsed rail
  const collapse = page.getByRole("button", { name: /折叠|collapse/i }).first();
  if (await collapse.count()) {
    await collapse.click({ force: true });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/06-collapsed-rail.png` });
  }
});
