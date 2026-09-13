# Observability assessment: PenguinHarness 0.2.12 candidate

## Existing strengths

- Trace data separates API and tool time.
- HMR swaps have explicit bounded draining behavior and focused concurrency coverage.
- Release publication now fails on npm registry transport and response errors instead of treating them as unpublished versions.

## Gaps

1. Failed, timed-out, retried, and aborted LLM attempts discard provider-reported usage snapshots. Spend is undercounted during retry storms even when a provider already reported billable tokens.
2. The frontend build reports oversized chunks but CI has no compressed initial-bundle budget, so regressions remain warnings.
3. Authentication initialization maps network and server failures to a logged-out state, hiding a service-health failure behind the login screen.
4. A SearXNG failure silently changes provider to DuckDuckGo while rendering the results as SearXNG, making search provenance and privacy behavior inaccurate.

## Recommended measurements

- Record attempt-scoped LLM usage with terminal status and attempt number on every completion path.
- Track initial gzip/brotli entry size in CI with a stated budget.
- Separate authentication 401, network failure, and 5xx metrics.
- Record the actual search provider and fallback decision in tool results and traces.
