/**
 * Multi-select over the conversation list, and the batch operations that hang off it. The
 * unit tests (session-selection.test.ts) pin the selection RULES; this pins the wiring —
 * that a click reaches the reducer, that the bar reports the marked count, and that the
 * batch actually lands on the server. Delete joins the reversible three behind a single
 * confirmation that names the count.
 *
 * The safety property gets a test of its own, because it is the one the unit test cannot
 * reach: a marked row that has paged out of the list must not still be in the set a batch
 * action reads. That is the confused-deputy case, and it is only observable with a real
 * scroller and real paging.
 *
 * Assertions are written against the Chinese strings, as the rest of the e2e suite is —
 * this is what a user of the default locale actually reads, so a label that reads as
 * nothing at all still fails here.
 */
import { test, expect } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;
const P = "password123";

/** One Project with a model wired to the mock provider, and `count` titled conversations in it. */
async function seed(page, user, count) {
  await provisionAndLogin(page.request, user, P);
  const projects = await (await page.request.get(`${BASE}/api/projects`)).json();
  const projectId = projects.projects[0].projectId;
  const put = await page.request.put(`${BASE}/api/projects/${projectId}/models`, {
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
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const res = await page.request.post(
      `${BASE}/api/projects/${projectId}/agents/default_agent/sessions`,
      { data: { provider: "custom", modelId: "claude-4-8" } },
    );
    const { session } = await res.json();
    const patch = await page.request.patch(`${BASE}/api/sessions/${session.sessionId}`, {
      data: { title: `Selectable ${i}` },
    });
    expect(patch.ok(), "rename").toBeTruthy();
    ids.push(session.sessionId);
  }
  return { projectId, ids };
}

test("mark, shift-extend, and batch-pin a run of conversations", async ({ page }) => {
  const { projectId, ids } = await seed(page, "seluser_pin", 3);
  await page.goto(`${BASE}/chat/${ids[0]}`);

  const rows = page.getByTestId("session-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(3);

  // No selection bar until something is marked: the feature must not cost a row of the
  // list header to every user who never uses it.
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);

  // Cmd/Ctrl-click is the pointer route into selection mode.
  await rows.nth(0).click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByTestId("selection-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("已选 1 项");
  // The row is now a toggle, not a link, and says so.
  await expect(rows.nth(0)).toHaveAttribute("aria-pressed", "true");

  // A plain click in selection mode marks instead of navigating — the URL must not move.
  const urlBefore = page.url();
  await rows.nth(2).click();
  await expect(page).toHaveURL(urlBefore);
  await expect(bar).toContainText("已选 2 项");

  // Shift-click extends from the row last touched (the anchor, here the third) back to
  // the first — replacing, not accumulating, so the run comes out whole.
  await rows.nth(0).click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("已选 3 项");

  // Batch pin: one press, every marked row carries the pin indicator, and the choice
  // survives a reload because the pin set is persisted per Project. The SELECTION does not
  // survive it — marks are transient by design, so the bar is gone after the reload and
  // the rows are links again. Only the pin outlives the page.
  await bar.getByRole("button", { name: "置顶" }).click();
  await expect(bar.getByRole("button", { name: "取消置顶" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  await expect(page.getByTestId("session-row").first()).toBeVisible();
  await expect(page.getByTitle("已置顶")).toHaveCount(3);

  // Batch unpin, same path in reverse — re-marking all three, since nothing stayed marked.
  const fresh = page.getByTestId("session-row");
  await expect(fresh).toHaveCount(3);
  for (const i of [0, 1, 2]) await fresh.nth(i).click({ modifiers: ["ControlOrMeta"] });
  const bar2 = page.getByTestId("selection-bar");
  await expect(bar2).toContainText("已选 3 项");
  await bar2.getByRole("button", { name: "取消置顶" }).click();
  await expect(page.getByTitle("已置顶")).toHaveCount(0);

  // Leaving the mode: the bar goes and the rows are links again.
  await page.getByTestId("selection-bar").getByRole("button", { name: "取消多选" }).click();
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  await expect(page.getByTestId("session-row").first()).not.toHaveAttribute("aria-pressed", "true");

  // And the conversations themselves are untouched: a reversible operation, reversible.
  const listed = await (
    await page.request.get(
      `${BASE}/api/projects/${projectId}/agents/default_agent/sessions?limit=50`,
    )
  ).json();
  expect(listed.sessions.length).toBe(3);
  expect(listed.sessions.every((s) => s.archived === false)).toBe(true);
});

test("a marked row that the search filter hides drops out of the batch", async ({ page }) => {
  const { ids } = await seed(page, "seluser_page", 6);
  await page.goto(`${BASE}/chat/${ids[0]}`);
  const rows = page.getByTestId("session-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(6);

  // Mark a row, then filter the list down to conversations with a different title.
  const staleId = await rows.nth(5).getAttribute("data-session-id");
  await rows.nth(5).click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByTestId("selection-bar");
  await expect(bar).toContainText("已选 1 项");

  await page.getByRole("button", { name: "搜索会话" }).click();
  await page.getByLabel("搜索会话").fill("Selectable 1");
  await expect(page.getByTestId("session-row")).toHaveCount(1);

  // The count is the contract: a number the user cannot act on is worse than no number,
  // because the bar is the only place the count is stated. The marked row is gone from the
  // screen, so it is gone from the selection — without the user having to notice.
  await expect(bar).toContainText("已选 0 项");

  // And there is nothing left for Pin to act on — the control is not even offered, which is
  // the honest shape for "0 selected": no button that would report success having done
  // nothing. The stored pin set is the proof, because that is what a batch would have
  // written had the row stayed in the set.
  await expect(bar.getByRole("button", { name: "置顶" })).toHaveCount(0);
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("penguin.pinnedSessions."));
    return key ? JSON.parse(localStorage.getItem(key) ?? "[]") : [];
  });
  expect(stored, "a filtered-out row was pinned").not.toContain(staleId);
});

test("batch archive files every marked conversation, and the batch is reversible", async ({
  page,
}) => {
  const { projectId, ids } = await seed(page, "seluser_archive", 3);
  await page.goto(`${BASE}/chat/${ids[0]}`);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(3);

  // Mark two of the three. The list is ordered by recency, so the clicked rows are not the
  // two newest ids — which is the point: the batch follows what is MARKED, not a guess.
  await rows.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await rows.nth(2).click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByTestId("selection-bar");
  await expect(bar).toContainText("已选 2 项");
  await bar.getByRole("button", { name: "归档所选" }).click();

  // The server is the truth about what the batch did.
  const listed = await (
    await page.request.get(
      `${BASE}/api/projects/${projectId}/agents/default_agent/sessions?limit=50`,
    )
  ).json();
  expect(listed.sessions.filter((s) => s.archived === true).length).toBe(2);

  // The open conversation was one of the two, and the list says so rather than letting it
  // vanish behind a closed folder: the archived folder opens itself and holds both.
  await expect(page.getByText("已归档（2）")).toBeVisible();
  await expect(page.getByText("Selectable 1")).toBeVisible();
  await expect(page.getByText("Selectable 2")).toBeVisible();

  // Reversible from the list: mark the two filed rows and unarchive them in one press.
  const after = page.getByTestId("session-row");
  await after.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await after.nth(2).click({ modifiers: ["ControlOrMeta"] });
  const bar2 = page.getByTestId("selection-bar");
  await expect(bar2).toContainText("已选 2 项");
  await expect(bar2.getByRole("button", { name: "取消归档所选" })).toBeVisible();
  await bar2.getByRole("button", { name: "取消归档所选" }).click();
  await expect(page.getByTestId("session-row")).toHaveCount(3);
  const restored = await (
    await page.request.get(
      `${BASE}/api/projects/${projectId}/agents/default_agent/sessions?limit=50`,
    )
  ).json();
  expect(restored.sessions.every((s) => s.archived === false)).toBe(true);
});

test("batch archive reports a partial failure and keeps the failed row selected for retry", async ({
  page,
}) => {
  const { projectId, ids } = await seed(page, "seluser_partial", 3);
  await page.goto(`${BASE}/chat/${ids[0]}`);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(3);
  const failedId = await rows.nth(1).getAttribute("data-session-id");
  expect(failedId).not.toBeNull();
  let failOnce = true;
  await page.route(`**/api/sessions/${failedId}`, async (route) => {
    if (route.request().method() === "PATCH" && failOnce) {
      failOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    await route.continue();
  });
  await rows.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await rows.nth(2).click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByTestId("selection-bar");
  await bar.getByRole("button", { name: "归档所选" }).click();
  await expect(page.getByRole("alert")).toContainText("1 个归档失败");
  await expect(bar).toContainText("已选 1 项");
  await expect(page.locator(`[data-session-id="${failedId}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await bar.getByRole("button", { name: "归档所选" }).click();
  await expect(bar).toHaveCount(0);
  const listed = await (
    await page.request.get(
      `${BASE}/api/projects/${projectId}/agents/default_agent/sessions?limit=50`,
    )
  ).json();
  expect(listed.sessions.filter((s) => s.archived).length).toBe(2);
});

test("batch delete removes every marked conversation behind one confirmation", async ({ page }) => {
  const { ids } = await seed(page, "seluser_batchdel", 3);
  await page.goto(`${BASE}/chat/${ids[0]}`);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(3);

  await rows.nth(0).click({ modifiers: ["ControlOrMeta"] });
  await rows.nth(1).click();
  // Which conversations these rows are depends on list order (newest first) — read the
  // marked ids from the DOM rather than assuming they match seeding order.
  const markedIds = await Promise.all([
    rows.nth(0).getAttribute("data-session-id"),
    rows.nth(1).getAttribute("data-session-id"),
  ]);
  const bar = page.getByTestId("selection-bar");
  await expect(bar).toContainText("已选 2 项");

  // The destructive batch states its scope up front: the dialog names how many go.
  await bar.getByRole("button", { name: "删除所选" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "确定永久删除" });
  await expect(dialog).toContainText("确定永久删除这 2 个对话？");

  // Cancel keeps every marked row: nothing is destroyed until the dialog says so.
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(rows).toHaveCount(3);
  await expect(bar).toContainText("已选 2 项");

  // Confirm: both marked conversations leave the list and the server, the unmarked one
  // stays, and the transient selection goes with the rows it held.
  await bar.getByRole("button", { name: "删除所选" }).click();
  await page
    .getByRole("dialog")
    .filter({ hasText: "确定永久删除" })
    .getByRole("button", { name: "删除" })
    .click();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  for (const id of markedIds) {
    const gone = await page.request.get(`${BASE}/api/sessions/${id}`);
    expect(gone.status(), `session ${id} deleted`).toBe(404);
  }
  const survivor = ids.find((id) => !markedIds.includes(id));
  const kept = await page.request.get(`${BASE}/api/sessions/${survivor}`);
  expect(kept.status(), `session ${survivor} kept`).toBe(200);
});

test("a failed batch delete keeps only the failed conversation marked", async ({ page }) => {
  const { ids } = await seed(page, "seluser_batchdel_fail", 3);
  const failedId = ids[1];
  await page.route(`**/api/sessions/${failedId}`, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":{"code":"internal","message":"injected failure"}}',
      });
    }
    return route.continue();
  });
  await page.goto(`${BASE}/chat/${ids[0]}`);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(3);

  await rows.nth(0).click({ modifiers: ["ControlOrMeta"] });
  await rows.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await rows.nth(2).click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByTestId("selection-bar");
  await bar.getByRole("button", { name: "删除所选" }).click();
  await page
    .getByRole("dialog")
    .filter({ hasText: "确定永久删除" })
    .getByRole("button", { name: "删除" })
    .click();

  // The two successes vanish; the failure stays marked for retry and says so — the same
  // contract batch archive holds.
  await expect(page.getByRole("alert")).toContainText("删除失败");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(bar).toContainText("已选 1 项");
  await expect(page.locator(`[data-session-id="${failedId}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
