/**
 * LLM request-failure recovery:
 *
 * 1. Provider quota exhaustion (403 insufficient_user_quota) is retryable: the mock rejects
 *    the first two requests, GenerativeModel classifies them as retryable, the engine
 *    rotates through three configured keys with exponential backoff (2s/4s). The 4s wait before
 *    retry #2 shows a live countdown whose seconds tick DOWN; clicking "retry now"
 *    (立即重试) skips the rest of the wait and the turn completes normally — no abort.
 * 2. Give-up: a conversation whose quota rejections never stop — clicking 放弃 on the
 *    countdown fires the ordinary abort; the engine's abort-during-backoff path ends the
 *    turn and the composer is immediately usable again.
 * 3. An authentication failure (401 invalid_api_key) marks the Session auth-dead but
 *    RECOVERABLE: only the model reference is fixed at creation — credentials come from the
 *    current Project config — so the notice points at the Models page, updating the key
 *    auto-unlocks the composer (live via the credentials_updated event; across reloads via
 *    the credentials-updated-vs-abort time gate), Retry is the manual escape hatch (and the
 *    dead state re-arms if the key is still bad), and New Session stays as the way out.
 */
import { test, expect } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;

/** Provision a user with a configured mock model and one session; returns ids for later config updates. */
async function makeSession(page, userId, apiKey = "sk-mock") {
  await provisionAndLogin(page.request, userId, "password123");
  const projects = await (await page.request.get(`${BASE}/api/projects`)).json();
  const projectId = projects.projects[0].projectId;
  await page.request.put(`${BASE}/api/projects/${projectId}/models`, {
    data: {
      defaultModel: { provider: "custom", modelId: "claude-4-8" },
      models: [
        {
          provider: "custom",
          modelId: "claude-4-8",
          apiKey,
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
  return { sessionId: sess.session.sessionId, projectId };
}

test("a quota-403 retries with a live countdown; 'retry now' skips the wait and the turn completes", async ({
  page,
}) => {
  const { sessionId } = await makeSession(page, "quotauser", "sk-mock-1,sk-mock-2,sk-mock-3");

  await page.goto(`${BASE}/chat/${sessionId}`);
  await page.getByPlaceholder(/输入消息/).fill("quota retry test");
  await page.getByRole("button", { name: "发送" }).click();

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${BASE}/api/sessions/${sessionId}/messages`);
        const { messages } = await response.json();
        return messages
          .filter((m) => m.payload.type === "request_end")
          .map((m) => ({
            status: m.payload.status,
            code: m.payload.error_code,
            message: m.payload.error_message,
          }));
      },
      { message: "quota rejection is classified as retryable, with its provider detail" },
    )
    .toContainEqual(
      expect.objectContaining({
        status: "retryable",
        message: expect.stringContaining("insufficient_user_quota"),
      }),
    );

  // One line for the whole ladder, advancing through the ordinals rather than stacking: the
  // What is stable is that there is exactly ONE retry line, and that it
  // has reached attempt 2 by the time the countdown below appears.
  const ladder = page.locator("p.text-amber-600", { hasText: "[重试]" });
  await expect(ladder).toHaveCount(1, { timeout: 20000 });
  await expect(ladder).toHaveText(/第 [2-9] 次重试/, { timeout: 20000 });

  // The 4s wait before retry #2: a live countdown (whole seconds, ticking down).
  const countdown = page.locator("p.text-amber-600", { hasText: /第 2 次重试，\d+ 秒后发起/ });
  await expect(countdown).toBeVisible({ timeout: 20000 });
  const readSecs = async () => {
    const txt = await countdown.textContent({ timeout: 500 }).catch(() => null);
    const m = txt === null ? null : /第 2 次重试，(\d+) 秒后发起/.exec(txt);
    return m ? parseInt(m[1], 10) : null;
  };
  const first = await readSecs();
  expect(first).not.toBeNull();
  // Poll until the displayed seconds DECREASE (a live ticker, not a static label).
  let second = first;
  for (let i = 0; i < 12 && second !== null && second >= first; i++) {
    await page.waitForTimeout(300);
    second = await readSecs();
  }
  expect(second).not.toBeNull();
  expect(second).toBeLessThan(first);

  // "Retry now" skips the remaining wait. The transient "retrying" label can be
  // replaced by the next response before the browser observes it, so check the
  // request record instead of polling that brief visual state.
  await page.getByRole("button", { name: "立即重试" }).click();
  await expect
    .poll(
      async () => {
        const { messages } = await (
          await page.request.get(`${BASE}/api/sessions/${sessionId}/messages`)
        ).json();
        return messages.filter((m) => m.payload.type === "request_begin").length;
      },
      { timeout: 1500 },
    )
    .toBeGreaterThanOrEqual(3);

  // Attempt 3 succeeds: the final answer streams in.
  await expect(page.getByText("Quota recovered; the answer is 42.")).toBeVisible({
    timeout: 20000,
  });

  // No abort: the run recovered, the composer stays usable.
  await expect(page.getByText(/已中断/)).toHaveCount(0);
  await expect(page.getByPlaceholder(/输入消息/)).toBeEnabled();

  // Trace: both quota rejections recorded as retryable request_end events — the reconnect
  // path — carrying the real failure detail (the Cost center's errors panel reads it from
  // here) and the announced backoff ladder; no abort event.
  const msgs = await (await page.request.get(`${BASE}/api/sessions/${sessionId}/messages`)).json();
  const retries = msgs.messages.filter(
    (m) => m.payload.type === "request_end" && m.payload.status === "retryable",
  );
  expect(retries.length).toBe(2);
  for (const retry of retries)
    expect(retry.payload.error_message).toContain("insufficient_user_quota");
  expect(retries.map((retry) => retry.payload.retry_in_ms)).toEqual([2000, 4000]);
  expect(msgs.messages.some((m) => m.payload.type === "abort")).toBe(false);
});

test("'give up' on the countdown aborts the backoff: the turn ends and the composer is usable again", async ({
  page,
}) => {
  const { sessionId } = await makeSession(page, "giveupuser");

  await page.goto(`${BASE}/chat/${sessionId}`);
  await page.getByPlaceholder(/输入消息/).fill("quota giveup test");
  await page.getByRole("button", { name: "发送" }).click();

  // The mock rejects every request: by the first 2s wait the countdown (and its
  // inline controls) are on screen.
  await expect(page.getByRole("button", { name: "放弃" })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "放弃" }).click();

  // The ordinary abort lands mid-backoff: the engine's abort-during-backoff path ends the
  // turn (abort line + the waiting notice flips to "stopped"), and the composer is
  // immediately usable again.
  await expect(page.getByText(/已中断/)).toBeVisible({ timeout: 10000 });
  await expect(page.locator("p.text-amber-600", { hasText: /尝试后放弃/ })).toBeVisible();
  await expect(page.getByPlaceholder(/输入消息/)).toBeEnabled();
});

test("an auth-401 marks the Session dead but recoverable: Models CTA, key update auto-unlocks, Retry re-arms", async ({
  page,
}) => {
  // The mock rejects the provisioned key (`sk-auth-bad`) with a 401 and accepts any other.
  const { sessionId, projectId } = await makeSession(page, "authuser", "sk-auth-bad");

  await page.goto(`${BASE}/chat/${sessionId}`);
  await page.getByPlaceholder(/输入消息/).fill("auth dead test");
  await page.getByRole("button", { name: "发送" }).click();

  // Fatal authentication is represented by request_end itself; no abort record follows it.
  await expect(page.getByText(/模型 API 认证失败/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/模型请求错误/)).toBeVisible();

  // Action-only notice (per review: tell the user what to do, no explanations) and the
  // composer disabled with the matching placeholder.
  await expect(page.getByText(/请在模型配置页更新该模型的 API key/)).toBeVisible();
  await expect(page.getByPlaceholder(/模型认证失败/)).toBeDisabled();

  // Trace: the credentials failure is the request's own terminal status (no abort code —
  // "auth" is a stop reason now); the abort event only carries the prose reason.
  const msgs = await (await page.request.get(`${BASE}/api/sessions/${sessionId}/messages`)).json();
  const authEnd = msgs.messages.find(
    (m) => m.payload.type === "request_end" && m.payload.error_code === "auth",
  );
  expect(authEnd).toBeTruthy();
  expect(authEnd.payload.status).toBe("fatal");
  expect(authEnd.payload.error_message).toContain("invalid x-api-key");
  expect(msgs.messages.some((m) => m.payload.type === "abort")).toBe(false);

  // Reload: the state is rebuilt from Trace replay (the abort event is persisted) and the
  // key has not changed, so the session stays dead.
  await page.reload();
  await expect(page.getByText(/模型 API 认证失败/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByPlaceholder(/模型认证失败/)).toBeDisabled();

  // Primary CTA targets the Models page — where the credential is actually fixed.
  await page.getByRole("button", { name: "打开模型配置" }).click();
  await expect(page).toHaveURL(/\/models$/);
  await page.goBack();
  await expect(page.getByText(/模型 API 认证失败/)).toBeVisible({ timeout: 15000 });

  // Secondary escape: New Session still jumps to a usable fresh draft.
  await page.getByRole("button", { name: "新建会话" }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
  const draftInput = page.getByPlaceholder(/输入消息/);
  await expect(draftInput).toBeVisible();
  await expect(draftInput).toBeEnabled();
  await page.goBack();
  await expect(page.getByText(/模型 API 认证失败/)).toBeVisible({ timeout: 15000 });

  // Retry (escape hatch) WITHOUT fixing the key: the composer re-enables for one more
  // attempt, the mock rejects again, and the dead state re-arms.
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText(/模型 API 认证失败/)).toHaveCount(0);
  const input = page.getByPlaceholder(/输入消息/);
  await expect(input).toBeEnabled();
  await input.fill("auth dead test again");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(/模型 API 认证失败/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByPlaceholder(/模型认证失败/)).toBeDisabled();

  // PRIMARY PATH: update the model's key (as the Models page would). The server
  // invalidates the Project's cached runtimes and publishes credentials_updated to this
  // open tab — the composer unlocks WITHOUT a reload and WITHOUT clicking Retry.
  const put = await page.request.put(`${BASE}/api/projects/${projectId}/models`, {
    data: {
      defaultModel: { provider: "custom", modelId: "claude-4-8" },
      models: [
        {
          provider: "custom",
          modelId: "claude-4-8",
          apiKey: "sk-auth-good",
          baseUrl: MOCK,
          contextWindow: 200000,
        },
      ],
    },
  });
  expect(put.status()).toBe(200);
  await expect(page.getByText(/模型 API 认证失败/)).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByPlaceholder(/输入消息/)).toBeEnabled();

  // The SAME conversation continues on the new key (the rebuilt runtime re-reads the
  // Project config): the send completes and the notice stays gone.
  await page.getByPlaceholder(/输入消息/).fill("auth dead test after fix");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("Auth restored; hello again.")).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/模型 API 认证失败/)).toHaveCount(0);

  // Reload AFTER the success: the per-session acknowledgement survives a reload, and a
  // later auth failure receives a new item id so the composer can still lock again.
  await page.reload();
  await expect(page.getByText("Auth restored; hello again.")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/模型 API 认证失败/)).toHaveCount(0);
  await expect(page.getByPlaceholder(/输入消息/)).toBeEnabled();
});
