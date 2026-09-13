# User-experience analysis: PenguinHarness 0.2.12 candidate

## Startup and loading

- React mounting waits for install-scope initialization, whose request can wait up to three seconds. During that interval the page is blank and exposes no status announcement.
- Static route imports require users to download and parse code for unrelated administration and company pages at initial load.

## Accessibility findings

1. Shared custom selects lack expected listbox keyboard navigation, focus management, and typeahead across at least 33 call sites.
2. The mobile Sheet declares an ARIA modal but does not move or trap focus, allowing keyboard interaction with obscured content.
3. Toast success and error messages have no live-region semantics, so asynchronous outcomes are silent to screen-reader users.

## Resilience findings

- Authentication initialization treats every `/api/me` failure as logged out instead of showing a retryable connection or server error.
- Auto-approved remote-image reads use unrestricted fetch, allowing private-network requests and buffering an unbounded chunked response before enforcing the five-megabyte limit. This is both a security and availability release blocker.

## Priority

- Block release on the remote-image SSRF/memory path and on silent public search fallback unless the product explicitly documents and accepts those behaviors.
- Treat modal focus, select keyboard behavior, and toast announcements as blockers for a WCAG-conforming release.
- Route splitting and a visible bootstrap shell are high-value follow-ups with measurable startup impact.
