# Web accessibility audit — 2026-09-30

## Scope and method

The Playwright/Chromium audit uses `@axe-core/playwright` 4.13.0 with WCAG 2.0 A/AA,
WCAG 2.1 A/AA, and WCAG 2.2 AA tags. It exercises the chat and sidebar, system settings,
and Agent settings. Settings are switched to dark mode through the product UI. A 390 × 844
chat pass checks the mobile layout and WCAG 2.2 target sizes. The keyboard audit starts from
the page's current focus, uses Shift+Tab to reach the first stop, then traverses forward using
real Tab key events; it does not synthesize focus on individual controls or assume document
Tab wrapping.

## Results

| Surface | Axe violations | Axe manual-review items | Keyboard stops | Missing visible focus | Other checks |
| --- | ---: | ---: | ---: | ---: | --- |
| Chat + sidebar, light, desktop | 0 | 1 `color-contrast` rule | 43/43 | 0 | — |
| System settings, light | 0 | 1 `color-contrast` rule | 27/27 | 0 | Dialog focus stays scoped |
| System settings, dark | 0 | 1 `color-contrast` rule | 27/27 | 0 | Escape closes dialog |
| Agent settings, dark | 0 | 1 `color-contrast` rule | 43/43 | 0 | — |
| Chat + sidebar, dark, mobile | 0 | 0 | 22/22 | 0 | No horizontal overflow; target-size checks pass |

The `color-contrast` rule remains incomplete where Axe cannot determine whether very short
content is text or where the session timestamp is overlapped by its hover-action layer. These
are not reported violations. The remaining cases were checked as follows:

- The one-character SVG Agent avatar is decorative (`aria-hidden`) and its generated light and
  dark inks are selected to meet 4.5:1 across every hue. `packages/web/src/lib/avatar.ts`
  documents the calculation; `packages/web/test/avatar.test.ts` checks all 360 hues.
- The 11 px session timestamp now uses `text-gray-600` in light mode and `dark:text-gray-400`.
  Across the row's base and active backgrounds, the minimum checked contrast is 6.10:1 in
  light mode (`#4b5563` on `#e5e7eb`) and 5.78:1 in dark mode (`#9ca3af` on `#1f2937`). Both
  exceed the 4.5:1 text requirement. Axe still marks this node incomplete because the adjacent
  action layer overlaps it.

## Findings fixed

- Named the two Settings switches so assistive technology can identify them.
- Increased contrast for the chat command hint, empty-chat greeting, model label, Agent ID,
  segmented controls, workspace count, and session timestamp in the affected themes.
- Added a persistent `:focus-visible` ring to the chat composer textarea.
- Increased the segmented S/M/L controls to meet the checked target-size threshold.
- Made the E2E runner stop before launch if it cannot create its isolated temporary data folder.

## Reproduction

Run `packages/web/e2e/run.sh a11y.spec.mjs` from `packages/web` with the workspace's supported
Node and pnpm versions. The test creates and removes isolated temporary server data. The regular
web suite and typecheck are also required before accepting follow-up changes.

The audit covers the listed surfaces and states; it is not a claim that every route, browser,
screen reader, or user preference has been manually certified.
