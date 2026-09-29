import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { provisionAndLogin } from "./auth.mjs";

const BASE = process.env.BASE_URL;
const MOCK = process.env.MOCK_URL;
const USER = "a11yuser";
const PASSWORD = "password123";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const TAB_CANDIDATES =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

async function scan(page, surface) {
  const { violations, incomplete } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const report = {
    surface,
    wcagTags: WCAG_TAGS,
    violations: violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        html: node.html,
        summary: node.failureSummary,
      })),
    })),
    incompleteRules: incomplete.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
    })),
  };
  await test.info().attach(`axe-${surface}.json`, {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });

  const serious = report.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  console.info(
    `[axe] ${surface}: ${report.violations.length} violations ` +
      `(${serious.length} critical/serious), ${report.incompleteRules.length} incomplete rules`,
  );
  if (report.incompleteRules.length > 0) {
    console.info(
      `[axe-incomplete] ${surface}: ${report.incompleteRules
        .flatMap((rule) =>
          rule.nodes.map(
            ({ target, html, failureSummary }) =>
              `${rule.id}: ${target.join(" ")} <${html.replace(/\s+/g, " ").slice(0, 180)}> ` +
              `(${failureSummary ?? "manual review required"})`,
          ),
        )
        .join("; ")}`,
    );
  }
  expect(serious, `${surface} critical/serious axe findings: ${JSON.stringify(serious)}`).toEqual(
    [],
  );
  return report;
}

async function auditKeyboardFocus(page, surface, scopeSelector = null) {
  const readFocus = () =>
    page.evaluate(
      ({ selector, scope }) => {
        const root = scope ? document.querySelector(scope) : document;
        if (!root) throw new Error(`Keyboard audit scope not found: ${scope}`);
        const candidates = Array.from(root.querySelectorAll(selector)).filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            element.tabIndex >= 0 &&
            !element.closest("[inert]") &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
        const active = document.activeElement;
        const style = active instanceof HTMLElement ? getComputedStyle(active) : null;
        const label =
          active instanceof HTMLElement
            ? active.getAttribute("aria-label") ||
              active.getAttribute("title") ||
              active.innerText?.trim().replace(/\s+/g, " ").slice(0, 80) ||
              active.tagName.toLowerCase()
            : "no active element";
        const outlineVisible = Boolean(
          style &&
          style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) > 0 &&
          style.outlineColor !== "transparent",
        );
        const shadowVisible = Boolean(style && style.boxShadow !== "none");
        return {
          index: candidates.indexOf(active),
          label,
          visibleFocusIndicator: outlineVisible || shadowVisible,
          expectedCount: candidates.length,
        };
      },
      { selector: TAB_CANDIDATES, scope: scopeSelector },
    );

  const initialFocus = await readFocus();
  const expectedCount = initialFocus.expectedCount;
  expect(expectedCount, `${surface} has visible keyboard stops`).toBeGreaterThan(0);

  // Chat deliberately autofocuses its composer. Walk backward from the current focus to the
  // first stop, then forward through the page; this validates every real Tab stop without
  // assuming that Tab wraps at the document boundary or altering focus with script.
  let firstFocus = initialFocus;
  if (firstFocus.index < 0) {
    await page.keyboard.press("Tab");
    firstFocus = await readFocus();
  } else {
    for (let step = 0; firstFocus.index > 0 && step < expectedCount; step += 1) {
      await page.keyboard.press("Shift+Tab");
      firstFocus = await readFocus();
      if (firstFocus.index < 0) break;
    }
    if (firstFocus.index === 0 && initialFocus.index === 0) {
      // A pointer-focused first control is not evidence of :focus-visible. Move away and back
      // with keys so its indicator is tested in the same way as the rest of the sequence.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      firstFocus = await readFocus();
    }
  }

  const seen = new Set();
  const missingIndicators = [];
  const focusTrace = [];
  const remember = (focus) => {
    if (focus.index < 0) return;
    seen.add(focus.index);
    focusTrace.push({ index: focus.index, label: focus.label });
    if (!focus.visibleFocusIndicator) missingIndicators.push(focus.label);
  };

  expect(firstFocus.index, `${surface} reaches its first Tab stop`).toBe(0);
  remember(firstFocus);
  for (let step = 0; step < Math.min(expectedCount, 300); step += 1) {
    await page.keyboard.press("Tab");
    const focus = await readFocus();

    if (focus.index < 0 || seen.has(focus.index)) break;
    remember(focus);
  }

  console.info(
    `[keyboard] ${surface}: reached ${seen.size}/${expectedCount} visible Tab stops; ` +
      `${missingIndicators.length} missing visible focus indicators`,
  );
  expect(seen.size, `${surface} exposes keyboard focus`).toBeGreaterThan(0);
  expect(
    seen.size,
    `${surface} keyboard-reaches every visible Tab stop; order: ${JSON.stringify(focusTrace)}`,
  ).toBe(expectedCount);
  expect(missingIndicators, `${surface} controls with no visible keyboard focus ring`).toEqual([]);
}

test("chat, sidebar, and settings pass WCAG scans and keyboard focus checks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem("penguin.lang", "en"));
  await provisionAndLogin(page.request, USER, PASSWORD);

  const projectsResponse = await page.request.get(`${BASE}/api/projects`);
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = await projectsResponse.json();
  const projectId = projects.projects[0]?.projectId;
  expect(projectId).toBeTruthy();

  const modelsResponse = await page.request.put(`${BASE}/api/projects/${projectId}/models`, {
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
  expect(modelsResponse.ok(), "configure mock model for the accessibility session").toBeTruthy();

  const sessionResponse = await page.request.post(
    `${BASE}/api/projects/${projectId}/agents/default_agent/sessions`,
    { data: { provider: "custom", modelId: "claude-4-8" } },
  );
  expect(sessionResponse.ok()).toBeTruthy();
  const { session } = await sessionResponse.json();

  await page.goto(`${BASE}/chat/${session.sessionId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  await scan(page, "chat-sidebar-light");
  await auditKeyboardFocus(page, "chat-sidebar");

  // The actual settings dialog owns theme selection. Scanning after changing the theme checks
  // real dark-mode tokens rather than merely emulating a dark OS preference.
  await page.getByRole("button", { name: USER }).last().click();
  await page.getByRole("button", { name: "System settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Appearance" }).click();
  await scan(page, "settings-light");
  await auditKeyboardFocus(page, "settings-dialog-light", '[role="dialog"]');
  await page.getByRole("button", { name: "Dark", exact: true }).first().click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(250);
  await scan(page, "settings-dark");
  await auditKeyboardFocus(page, "settings-dialog", '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The routed Agent settings page is a separate, dense product surface from system settings.
  await page.goto(`${BASE}/agents/default_agent`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1").first()).toBeVisible();
  await scan(page, "agent-settings-dark");
  await auditKeyboardFocus(page, "agent-settings");

  // WCAG 2.2 AA's target-size rule runs in the axe scans above; this mobile pass catches
  // responsive controls whose rendered target changes with the compact sidebar layout.
  await page.goto(`${BASE}/chat/${session.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  await scan(page, "chat-sidebar-mobile-dark");
  await auditKeyboardFocus(page, "chat-sidebar-mobile-dark");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow, "mobile accessibility surface has no horizontal overflow").toBe(false);
});
