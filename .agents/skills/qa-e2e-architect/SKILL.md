---
name: qa-e2e-architect
description: End-to-End (E2E) testing architecture using Playwright and Cypress covering Page Object Model (POM), multi-tab interactions, visual regression, network interception, and headless CI runs.
---

# QA E2E Architect

Architect robust, reliable, and maintainable end-to-end browser tests using Playwright and modern testing standards.

## Core Architectural Patterns

### 1. Page Object Model (POM)
- Encapsulate page elements and user interactions in dedicated Page Objects.
- Keep test specs readable and focused on assertions and business flows rather than low-level CSS selectors.

### 2. Resilient Locators
- Prefer user-visible locators:
  - `page.getByRole('button', { name: 'Submit' })`
  - `page.getByLabel('Username')`
  - `page.getByPlaceholder('Search...')`
  - `page.getByTestId('chat-input')`
- Avoid brittle CSS paths (`div > div.col-md-4:nth-child(2) > span`).

### 3. Network Mocking & State Hydration
- Intercept and mock backend API routes (`page.route('**/api/v1/sessions', route => route.fulfill({ status: 200, json: [...] }))`) to test edge cases (500 errors, rate limits, empty states) without backend dependencies.
- Persist storage states (`storageState: 'auth.json'`) to bypass repeated authentication flows.

### 4. Flakiness Prevention
- Rely on web-first auto-waiting assertions: `await expect(page.locator('.status')).toBeVisible()`.
- Never use arbitrary `page.waitForTimeout(3000)`.
- Use locator filters (`locator.filter({ hasText: '...' })`) to pinpoint dynamic list items.
