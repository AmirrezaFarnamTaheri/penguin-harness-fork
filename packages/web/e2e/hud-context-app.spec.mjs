import { test, expect } from "@playwright/test";
import { login, ADMIN_ID, ADMIN_PASSWORD } from "./auth.mjs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Actual production app route and stream reducer; only recorded usage is deterministic.
test("chat HUD uses last request occupancy, not cumulative session spending", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("penguin.lang", "en"));
  await login(page.request, ADMIN_ID, ADMIN_PASSWORD);
  const projects = await (await page.request.get("/api/projects")).json();
  const projectId = projects.projects[0].projectId;
  const model = await page.request.put(`/api/projects/${projectId}/models`, {
    data: {
      defaultModel: { provider: "custom", modelId: "claude-4-8" },
      models: [{ provider: "custom", modelId: "claude-4-8", contextWindow: 240000 }],
    },
  });
  expect(model.ok(), await model.text()).toBe(true);
  const created = await page.request.post(
    `/api/projects/${projectId}/agents/default_agent/sessions`,
    {
      data: { provider: "custom", modelId: "claude-4-8" },
    },
  );
  expect(created.ok(), await created.text()).toBe(true);
  const sessionId = (await created.json()).session.sessionId;
  const counts = (total) => ({ total, cache_read: 0, cache_write: total - 1000, output: 1000 });
  const messages = [
    {
      timestamp: "2026-09-17T00:00:00Z",
      type: "response_item",
      payload: { type: "text", role: "user", text: "Context regression" },
    },
    { timestamp: "2026-09-17T00:00:01Z", type: "event_msg", payload: { type: "request_begin" } },
    {
      timestamp: "2026-09-17T00:00:02Z",
      type: "event_msg",
      payload: { type: "token_usage", request: counts(79100), session: counts(441000) },
    },
    {
      timestamp: "2026-09-17T00:00:03Z",
      type: "response_item",
      payload: { type: "text", role: "assistant", text: "Recorded request complete." },
    },
    {
      timestamp: "2026-09-17T00:00:04Z",
      type: "event_msg",
      payload: { type: "request_end", status: "completed" },
    },
  ];
  await page.route(`**/api/sessions/${sessionId}/messages*`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ messages }),
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/chat/${sessionId}`);
  // A project without a model credential may open a real startup dialog; dismiss it if so.
  const credential = page.getByRole("dialog", { name: "No model credential configured" });
  if (await credential.isVisible().catch(() => false)) {
    await credential.getByRole("button", { name: "Later" }).click();
  }
  const hud = page.getByRole("region", { name: "Session status" });
  await expect(hud.getByRole("button", { name: "Context 33%", exact: true })).toBeVisible();
  await expect(hud).not.toContainText("Context 184%");
  const dir = new URL("../../../artifacts/context-review/actual-app/", import.meta.url);
  await mkdir(dir, { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL("hud-context-regression.png", dir)),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
