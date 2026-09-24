/**
 * The LLM stream drops mid-way through writing tool arguments (AgentHub judges the "stream
 * incomplete" → malformed): that tool_call was never committed into AgentHub's history — the
 * engine never dispatches it and never emits a paired output; reconnect resends the same input
 * verbatim. The frontend settles the broken tool card as soon as the settle reason arrives (no
 * more running timer) and shows a retry hint line (with the attempt count). After a successful
 * retry, subsequent tool calls appear and complete as normal.
 */
import { test, expect } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;

test("a malformed tool_call settles unpaired; the retry line shows and the retry succeeds", async ({
  page,
}) => {
  await provisionAndLogin(page.request, "maluser", "password123");
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
  const sessionId = sess.session.sessionId;

  await page.goto(`${BASE}/chat/${sessionId}`);
  await page.getByPlaceholder(/输入消息/).fill("bad stream test");
  await page.getByRole("button", { name: "发送" }).click();

  // The retried exec_command finishes → final answer, proving the retry and the following
  // tool call complete normally.
  await expect(page.getByText("Command finished; the result looks as expected.")).toBeVisible({
    timeout: 20000,
  });

  // Retry hint line: set to "retry attempt 1 started" once request_begin arrives.
  await expect(page.getByText(/已发起第 1 次重试/)).toBeVisible();

  // The partial tool_call never entered the committed history, so it must not be persisted or
  // paired with an output. The failed request is represented by request_end(malformed).
  const msgs = await (await page.request.get(`${BASE}/api/sessions/${sessionId}/messages`)).json();
  const malformedCalls = msgs.messages.filter(
    (m) => m.payload.type === "tool_call" && m.payload.stop_reason === "malformed",
  );
  expect(malformedCalls, "uncommitted partial tool_call is absent from history").toHaveLength(0);
  const retryEnd = msgs.messages.find(
    (m) => m.payload.type === "request_end" && m.payload.status === "malformed",
  );
  expect(retryEnd, "request_end(malformed) recorded").toBeTruthy();

  // The incomplete call is not committed, so no phantom tool card or spinner may remain.
  await expect(page.locator('[role="status"]')).toHaveCount(0);
});
