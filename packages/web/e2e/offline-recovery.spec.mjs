/**
 * C8 + F17.3 — offline posture, cached conversation and honest recovery.
 *
 * What this spec can honestly assert in a browser, and why:
 *
 *   - The app has NO client-side message store. "Cached content" is therefore exactly what the
 *     product can promise: the conversation already rendered in an open tab stays readable while
 *     the network is gone, and the app never replaces it with a spinner or an empty state. The
 *     measurement below takes that promise literally — start time is the moment the offline event
 *     is dispatched, end time is the moment the transcript's own text is confirmed visible — and
 *     asserts the < 100 ms target on the same seeded state every run.
 *   - Sends are not queued in this product, so the spec asserts the two things that follow: an
 *     attempted send while offline does not produce a duplicate request, and the failure surfaces
 *     as a normal error path with no unhandled rejection anywhere in the page.
 *   - Server restoration is proven by a real probe: the banner clears only after `/api/health`
 *     answers again, which is asserted by watching the banner leave its `reconnecting` state.
 */
import { expect, test } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;
const U = "offlineuser";
const P = "password123";

/** The seeded conversation, created through the API so the spec starts from rendered content. */
async function seedSession(page) {
  await provisionAndLogin(page.request, U, P);
  const projects = await (await page.request.get(`${BASE}/api/projects`)).json();
  const projectId = projects.projects[0].projectId;
  await page.request.put(`${BASE}/api/projects/${projectId}/models`, {
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
  const sess = await (
    await page.request.post(`${BASE}/api/projects/${projectId}/agents/default_agent/sessions`, {
      data: { provider: "custom", modelId: "claude-4-8" },
    })
  ).json();
  return sess.session.sessionId;
}

/** Provider responses whose user text we can find again after the network is gone. */
const PROMPT = "OFFLINE-CACHE-MARKER: summarise the release checklist";

test("offline: cached transcript stays readable, sends fail honestly, recovery is probe-proven", async ({
  page,
  context,
}) => {
  const sessionId = await seedSession(page);

  // Capture page errors for the whole run: an unhandled rejection is a failure of this spec.
  // Keep the current phase with each error so CI tells us which offline/recovery transition
  // produced it instead of only reporting that the final array was non-empty.
  const pageErrors = [];
  let phase = "open chat";
  page.on("pageerror", (error) => pageErrors.push(`[${phase}] ${error.name}: ${error.message}`));

  // Count sends so a duplicate is detectable, and let the seeded turn complete.
  const sendRequests = [];
  page.on("request", (request) => {
    // A send is POST /api/sessions/:id/tasks (the composer creates a Task).
    if (request.method() === "POST" && /\/api\/sessions\/[^/]+\/tasks/.test(request.url())) {
      sendRequests.push(request.url());
    }
  });

  await page.goto(`${BASE}/chat/${sessionId}`);
  const composer = page.getByPlaceholder(/输入消息/);
  await composer.waitFor();
  phase = "seeded send";
  await composer.fill(PROMPT);
  await page.getByRole("button", { name: "发送" }).click();
  // The user's own message is on screen (this is the content that must survive the outage).
  await expect(page.getByText("OFFLINE-CACHE-MARKER", { exact: false }).first()).toBeVisible();
  const workHeader = page.locator("[data-group-header]");
  await expect(workHeader).toBeVisible({ timeout: 30_000 });
  // Don't take the app offline while the first Task is still streaming: the recovery path may
  // legitimately rebuild the transcript from persisted history after an SSE resync.
  await expect(workHeader.getByText("运行完毕").first()).toBeVisible({ timeout: 30_000 });

  // ---- browser-offline: cached content readable, measured from the offline event ----
  phase = "browser offline";
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const measureStart = Date.now();
  await expect(page.getByText("OFFLINE-CACHE-MARKER", { exact: false }).first()).toBeVisible();
  const cachedRenderMs = Date.now() - measureStart;
  expect(cachedRenderMs, "cached transcript remains rendered within the 100ms target").toBeLessThan(
    100,
  );

  const banner = page.locator("[data-connectivity-banner]");
  await expect(banner).toHaveAttribute("data-connectivity-banner", "browser-offline");
  // The copy never promises delivery later; it says what is true (content readable).
  await expect(banner).toContainText("已加载的内容仍可阅读");

  // ---- attempted write while offline: no duplicate, no unhandled rejection ----
  phase = "offline write";
  const sendsBefore = sendRequests.length;
  await composer.fill("OFFLINE-WRITE-ATTEMPT");
  const sendButton = page.getByRole("button", { name: "发送" });
  await sendButton.click({ force: true });
  await page.waitForTimeout(500);
  // The offline attempt either never left the page or failed; either way exactly one request is
  // accounted for, and no queued retry fires later.
  expect(sendRequests.length - sendsBefore).toBeLessThanOrEqual(1);
  const sendsAfterAttempt = sendRequests.length;
  await page.waitForTimeout(1000);
  expect(sendRequests.length, "no queued resend while offline").toBe(sendsAfterAttempt);

  // ---- browser back online, server still unreachable: banner must not clear ----
  phase = "server still unreachable";
  // Install the failure route before returning the browser link: context.setOffline(false) emits
  // an `online` event too, and that event immediately starts the monitor's health probe.
  await page.route("**/api/**", (route) => route.abort("failed"));
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(banner).toHaveAttribute(
    "data-connectivity-banner",
    /reconnecting|server-unreachable/,
    {
      timeout: 20_000,
    },
  );
  // Give the monitor two probe cycles: the banner still must not claim the server is reachable.
  await page.waitForTimeout(3000);
  await expect(banner).not.toHaveAttribute("data-connectivity-banner", "none");
  await expect(banner).not.toHaveAttribute("data-connectivity-banner", "recovered");

  // ---- keyboard access to the retry control ----
  phase = "manual retry";
  const retry = banner.getByRole("button", { name: "立即重试" });
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter"); // activates; a refused retry must not throw or navigate

  // ---- server restoration: only a real probe clears the banner ----
  phase = "server recovery";
  await page.unroute("**/api/**");
  await expect(banner).toHaveAttribute("data-connectivity-banner", "recovered", {
    timeout: 20_000,
  });
  // The banner unmounts when its posture is healthy; there is no rendered `none` attribute.
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  // And the transcript is still there, never having been replaced by an error state.
  try {
    await expect(page.getByText("OFFLINE-CACHE-MARKER", { exact: false }).first()).toBeVisible();
  } catch (error) {
    const bodyText = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .slice(0, 500);
    const assertion = error instanceof Error ? error.message : String(error);
    throw new Error(
      `recovery lost the rendered transcript at ${page.url()}; body: ${bodyText}; page errors: ${pageErrors.join(" | ") || "(none)"}; assertion: ${assertion}`,
    );
  }

  // ---- unmount cancellation: leaving the page stops probing without noise ----
  phase = "navigate away / unmount";
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(1000);
  if (pageErrors.length > 0) {
    throw new Error(`OFFLINE_PAGE_ERRORS ${JSON.stringify(pageErrors).slice(0, 1200)}`);
  }
});

test("offline the banner never appears while the server is reachable (no false alarm)", async ({
  page,
}) => {
  const sessionId = await seedSession(page);
  await page.goto(`${BASE}/chat/${sessionId}`);
  await page.getByPlaceholder(/输入消息/).waitFor();

  const banner = page.locator("[data-connectivity-banner]");
  // A healthy server: the probe succeeds and no banner is rendered at any point.
  await page.waitForTimeout(3000);
  await expect(banner).toHaveCount(0);

  // A single aborted request must not be mistaken for an outage either: the probe endpoint is
  // untouched, so the posture stays healthy and nothing appears on screen.
  await page.route("**/api/projects/**", (route) => route.abort("failed"));
  await page.waitForTimeout(50);
  await page.unroute("**/api/projects/**");
  await page.waitForTimeout(1000);
  await expect(banner).toHaveCount(0);
});

test("offline reload: no invented cached conversation, and the app recovers when the API returns", async ({
  page,
}) => {
  const sessionId = await seedSession(page);
  await page.goto(`${BASE}/chat/${sessionId}`);
  await page.getByPlaceholder(/输入消息/).waitFor();

  // The server stops answering its API (the static shell is still served, which is what a reload
  // under an outage looks like when the front end is already on the machine).
  await page.route("**/api/**", (route) => route.abort("failed"));
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.reload({ waitUntil: "domcontentloaded" });

  // This product keeps no client-side message store, so the honest post-reload state is "nothing
  // loaded" — NOT a stale transcript presented as current, and NOT a composer implying a send
  // would work. The assertion is deliberately about absence of a false claim.
  await page.waitForTimeout(1500);
  await expect(page.getByText("OFFLINE-CACHE-MARKER", { exact: false })).toHaveCount(0);
  await expect(page.getByPlaceholder(/输入消息/)).toHaveCount(0);

  // The API returns: the app must reach a usable state again without a manual hard reload.
  await page.unroute("**/api/**");
  await page.waitForTimeout(5000);
  await expect(page.getByPlaceholder(/输入消息/)).toHaveCount(1, { timeout: 20_000 });
  expect(pageErrors, "no unhandled page errors across the offline reload").toEqual([]);
});
