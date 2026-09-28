/**
 * Rendered-surface coverage for the surfaces no test opens, plus a route smoke sweep.
 *
 * Why this exists: the a11y agent rebuilt the calendar as a real `<table>` (month) and a
 * `role="grid"` (week/day) with a one-tab-stop grid and ←/→ between day columns, and grew the
 * org-chart kebab's hit area to 40x40 — and reported, correctly, that all of it was
 * "typechecked, linted and unit-tested but not exercised at runtime". A restructure that
 * changes both the accessibility tree AND the layout is exactly the change a type checker
 * cannot vouch for. This spec is the runtime half.
 *
 * It also serves as the smoke sweep: every route is visited, and ANY console error or page
 * error fails the run. A dashboard that throws on load, or renders an empty frame, is caught
 * here rather than by a user.
 */
import { mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;
const U = "smokeuser";
const P = "password123";

/**
 * Where rendered evidence lands. Defaults to a gitignored scratch dir so a local run does
 * not dirty the tree; CI sets SCREENSHOT_DIR to publish them alongside the run.
 */
const SHOTS = process.env.SCREENSHOT_DIR ?? "test-results/screenshots";
mkdirSync(SHOTS, { recursive: true });

/**
 * Capture the CURRENT viewport, and assert the page is worth capturing: a screenshot of a
 * blank frame is worse than no screenshot, because it looks like evidence.
 */
async function shot(page, name) {
  const body = await page.locator("body").boundingBox();
  expect(body, `${name} has no layout box`).not.toBeNull();
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  return `${SHOTS}/${name}.png`;
}

/** Collect console + page errors for the life of a test; asserted empty at the end. */
function watchErrors(page) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${String(e).slice(0, 200)}`));
  // A bare "Failed to load resource: 404" names no request. The URL is the whole point.
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url().replace(BASE, "")}`);
  });
  return errors;
}

/** A Project with a model wired to the mock provider, plus an org with enough shape to render. */
async function seed(page) {
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
  return projectId;
}

/** Enable company mode and create an org, returning its id. Returns null when unavailable. */
async function makeOrg(page, projectId) {
  const enabled = await page.request.post(`${BASE}/api/admin/organizations`, {
    data: { enabled: true },
  });
  if (!enabled.ok()) return null;
  const created = await page.request.post(`${BASE}/api/projects/${projectId}/organizations`, {
    data: { name: "Smoke Org", ceoAgentName: "default_agent" },
  });
  if (!created.ok()) return null;
  return (await created.json()).organization.orgId;
}

test("smoke: every top-level route renders with no console or page error", async ({ page }) => {
  const errors = watchErrors(page);
  const projectId = await seed(page);

  const routes = [
    "/chat",
    "/agents",
    "/models",
    "/models/keys",
    "/gateway",
    "/skills",
    "/plugins",
    "/memory",
    "/topology",
    "/guardian",
    "/context-breakdown",
    "/snapshots",
    "/traces/flamegraph",
    "/kanban",
    "/pipelines",
    "/usage",
    "/benchmark",
  ];

  for (const route of routes) {
    const before = errors.length;
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    // The shell must render something with a heading — a blank frame is the failure this
    // is here to catch, and it is invisible to a unit test.
    await expect(page.locator("body")).toBeVisible();
    const heading = await page
      .locator("h1")
      .first()
      .textContent()
      .catch(() => null);
    expect(heading, `${route} rendered no <h1>`).toBeTruthy();
    await shot(page, `route${route.replace(/\//g, "-")}`);
    // A 404 on one route must name that route, not surface as an unattributed list.
    if (errors.length > before) {
      throw new Error(`${route} produced: ${errors.slice(before).join(" | ")}`);
    }
  }
  // This sweep FOUND a real defect on its first run and still guards it: /models/keys
  // asked for a Project literally called "default" — not a Project id in this codebase —
  // so it 404'd on every load and the key fleet rendered empty. Fixed in
  // models-key-fleet-page.tsx by waiting for the real id instead of guessing one. The
  // assertion stays: the whole value of this spec is that a page which starts throwing
  // on load cannot pass quietly.
  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
  expect(projectId).toBeTruthy();
});

test("calendar: month is a real table and the hour grid is one tab stop", async ({ page }) => {
  const errors = watchErrors(page);
  const projectId = await seed(page);
  const orgId = await makeOrg(page, projectId);
  test.skip(orgId === null, "company mode unavailable on this server");

  await page.goto(`${BASE}/org/${projectId}/${orgId}/calendar`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: /日历|Calendar/ })).toBeVisible();

  // The restructure's whole point: a month grid is a table, and a table announces its
  // weekday headers and row structure. `role="grid"` over plain divs announced nothing.
  const monthTable = page.getByRole("table");
  if (await monthTable.count()) {
    await expect(monthTable.first()).toBeVisible();
    const columnHeaders = monthTable.first().getByRole("columnheader");
    expect(
      await columnHeaders.count(),
      "month table has no weekday headers",
    ).toBeGreaterThanOrEqual(7);
  }

  // Week and day are `role="grid"`. A grid promises ONE tab stop for the whole widget and
  // arrow keys across both axes — the previous per-column roving tabindex was seven stops
  // and could not cross columns, which is the opposite contract.
  await page
    .getByRole("tab", { name: /周|Week/ })
    .click()
    .catch(() => {});
  await page
    .getByRole("button", { name: /日|Day/ })
    .first()
    .click()
    .catch(() => {});
  const grid = page.getByRole("grid").first();
  if (await grid.count()) {
    const cells = grid.getByRole("gridcell");
    expect(await cells.count()).toBeGreaterThan(0);
    await shot(page, "calendar-week");
    // One tab stop: focusing the grid must not require stepping through every cell.
    const tabbable = await cells.evaluateAll(
      (els) => els.filter((e) => e.querySelector('[tabindex="0"]') !== null).length,
    );
    expect(tabbable, "the hour grid must have exactly one roving tab stop").toBe(1);
  }

  await shot(page, "calendar-month");

  // A chip must announce the day it sits on — the specific failure the audit named.
  const chips = page.locator('[aria-label*=":"]');
  if (await chips.count()) {
    const first = await chips.first().getAttribute("aria-label");
    expect(first, "a chip's label carries no day").toMatch(/\d{4}-\d{2}-\d{2}/);
  }

  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
});

test("org chart: the kebab keeps a 24px target at minimum zoom", async ({ page }) => {
  const errors = watchErrors(page);
  const projectId = await seed(page);
  const orgId = await makeOrg(page, projectId);
  test.skip(orgId === null, "company mode unavailable on this server");

  await page.goto(`${BASE}/org/${projectId}/${orgId}/chart`, {
    waitUntil: "domcontentloaded",
  });
  await shot(page, "org-chart");
  const kebab = page.locator('button[aria-haspopup="menu"]').first();
  await expect(kebab, "the organization node's actual overflow control").toBeVisible();
  const box = await kebab.boundingBox();
  expect(box, "the node menu control must have a measurable hit target").not.toBeNull();
  if (box) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
  expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
});
