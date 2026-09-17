import { test, expect } from "@playwright/test";
import { login } from "./auth.mjs";

const SNAPSHOT = {
  success: true,
  data: {
    swarm: {
      agents: [{ id: "coder", role: "coder", status: "idle", tasksCompleted: 0 }],
      edges: [],
    },
  },
};

/** Real WS stream would overwrite a REST snapshot with the server's empty one; poll REST only. */
async function seedAgents(page) {
  await page.addInitScript(() => {
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        if (String(url).includes("/api/cockpit/stream")) setTimeout(() => this.close(), 0);
      }
    };
  });
  await page.route("**/api/cockpit/telemetry*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SNAPSHOT) }),
  );
}

test.beforeEach(async ({ page }) => {
  // The suite forces zh-CN; pin the app to English so assertions read the English dictionary.
  await page.addInitScript(() => localStorage.setItem("penguin.lang", "en"));
  await login(page.request, "admin", "penguin-2026");
  await page.goto("/cockpit");
  await expect(page.getByRole("heading", { name: "Workspace control" })).toBeVisible();
});

test("shows all twelve tools in grouped navigation", async ({ page }) => {
  for (const name of [
    "Run a task",
    "Activity",
    "Agent messages",
    "Run health",
    "Code structure",
    "Context usage",
    "Trace performance",
    "Memory",
    "API keys",
    "Command safety",
    "Snapshots",
    "Reviews & handoffs",
  ]) {
    await expect(page.getByRole("button", { name }).first()).toBeVisible();
  }
  for (const name of [
    "Context usage",
    "Snapshots",
    "Code structure",
    "Trace performance",
    "Run a task",
  ]) {
    await page.getByRole("button", { name, exact: true }).first().click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

test("task form keeps text on failed dispatch and reports the error", async ({ page }) => {
  await page.route("**/api/cockpit/swarm/run*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "Runtime unavailable" } }),
    }),
  );
  const goal = page.locator("textarea");
  await goal.fill("fix the flaky test");
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.getByRole("alert")).toContainText("Runtime unavailable");
  await expect(goal).toHaveValue("fix the flaky test");
  await expect(page.getByRole("button", { name: "Run task" })).toBeEnabled();
});

test("message form reports failure and preserves text", async ({ page }) => {
  await seedAgents(page);
  await page.reload();
  await page.getByRole("button", { name: "Agent messages" }).click();
  const recipient = page.getByRole("combobox");
  await expect(recipient).toBeVisible();
  await page.route("**/api/cockpit/mailbox/send*", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "bad", message: "Unknown agent" } }),
    }),
  );
  await recipient.selectOption("coder");
  await page.locator("textarea").fill("please rerun");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText("Unknown agent");
  await expect(page.locator("textarea")).toHaveValue("please rerun");
});

test("telemetry failure surfaces an explicit error, not a stale view", async ({ page }) => {
  await page.route("**/api/cockpit/telemetry*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "boom", message: "Request failed (HTTP 500)" } }),
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Request failed (HTTP 500)");
});
