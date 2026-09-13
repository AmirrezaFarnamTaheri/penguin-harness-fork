# Repository review hardens startup, accessibility, dependencies and publishing

- **Date:** 2026-09-13
- **Type:** fix
- **Scope:** `core`, `web`, `server`, `ci`, `tooling`

[中文版](2026-09-13-repository-review-hardening.zh.md)

The release review corrected frontend startup and keyboard behavior, updated the test toolchain, and added regression coverage for npm registry response handling.

## Network tool boundaries

- Remote image reads use the existing HTTP client that validates destinations, pins DNS resolution and revalidates redirects. Its streaming byte limit applies before the image is buffered.
- Oversized HTTP responses reject through the normal error path, including responses rejected from their declared length.
- Search failures report the configured SearXNG error without silently sending the query to another provider.

## Web startup and recovery

- Route modules load on demand behind visible loading states and a retryable error boundary, reducing the initial JavaScript entry chunk while keeping failed module loads recoverable.
- Install-scope reconciliation shows a localized status instead of a blank page while startup waits for the server.
- Authentication initialization distinguishes an invalid session from a network or server failure. Confirmed `401` responses still lead to sign-in; other failures remain retryable without discarding the current session state.

## Keyboard and status behavior

- Shared select menus gained roving focus, arrow, Home, End and Escape handling, disabled-option skipping, and explicit trigger-to-listbox relationships.
- The mobile sheet moves focus inside, contains Tab navigation while open, and returns focus to its opener after closing.
- Toast errors use assertive announcements; informational and successful results use polite announcements while retaining a keyboard-accessible dismiss button.

## Release and dependency checks

- npm publishing validates the registry's version-list schema and stops on connection failures or malformed responses instead of treating them as permission to publish.
- CI exercises the registry-response classifier, including exact version matches, missing versions and invalid payloads.
- The test stack moved to Vitest 4.1.11. The prepared lockfile reported no known dependency advisories after the update.
