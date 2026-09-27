/**
 * Throwaway measurement for the sidebar IA review: does the nav evict the session list?
 * Port 8941 only.
 */
import { test, expect } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;
const U = "measureuser";
const P = "password123";

async function configureProjectModel(request) {
  const projectId = (await (await request.get(`${BASE}/api/projects`)).json()).projects[0]
    .projectId;
  await request.put(`${BASE}/api/projects/${projectId}/models`, {
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
  return projectId;
}

for (const height of [720, 900, 1080]) {
  test(`measure: sidebar at ${height}px tall, groups collapsed vs open`, async ({ page }) => {
    await provisionAndLogin(page.request, U, P);
    await configureProjectModel(page.request);
    await page.setViewportSize({ width: 1280, height });
    await page.goto(`${BASE}/chat`);
    await expect(page.locator("aside")).toBeVisible();
    await page.waitForTimeout(1200);

    const read = async (label) => {
      const m = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        if (!aside) return null;
        const box = aside.getBoundingClientRect();
        // the scroller that holds nav + session list
        const scrollers = [...aside.querySelectorAll("*")]
          .filter((el) => el.scrollHeight > el.clientHeight + 1)
          .map((el) => ({
            cls: (el.className || "").toString().slice(0, 60),
            scrollH: el.scrollHeight,
            clientH: el.clientHeight,
            overflow: el.scrollHeight - el.clientHeight,
          }));
        // the session-list section header (the object under study)
        const header = [...aside.querySelectorAll("span")].find(
          (s) => s.textContent === "Session" || s.textContent === "SESSION",
        );
        const hrect = header ? header.getBoundingClientRect() : null;
        return {
          asideTop: Math.round(box.top),
          asideBottom: Math.round(box.bottom),
          headerTop: hrect ? Math.round(hrect.top) : null,
          headerVisible: hrect ? hrect.top < box.bottom && hrect.bottom > box.top : null,
          scrollers,
        };
      });
      console.log(`MEASURE h=${height} ${label} => ` + JSON.stringify(m));
      return m;
    };

    const closed = await read("groups-closed");
    for (const name of ["构建与知识", "评估与诊断", "模型与访问"]) {
      const b = page.getByRole("button", { name }).first();
      if ((await b.count()) && (await b.getAttribute("aria-expanded")) === "false") await b.click();
    }
    await page.waitForTimeout(400);
    const open = await read("groups-open");
    console.log(
      `SUMMARY h=${height} closedHeaderVisible=${closed?.headerVisible} openHeaderVisible=${open?.headerVisible}`,
    );
  });
}
