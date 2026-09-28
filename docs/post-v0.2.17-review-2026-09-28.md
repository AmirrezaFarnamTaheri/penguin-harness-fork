# Review of commits after v0.2.17

> **Release follow-up:** This initial review was extended for v0.2.18. See [the updated release assessment](release-v0.2.18-assessment.md) for the final fixes, verification, product-layer decisions, and release boundaries.

Reviewed branch: `release/0.2.17`, from tag `v0.2.17` through `0ce506ce4` (14 commits; 405 changed files). This review focused on changed execution paths and their boundaries: server identity, cockpit replay, verification sharing, model-key labels, multi-select, and test infrastructure. It combined diff inspection, targeted reproductions, regression tests, the package test suites, type checking, linting, formatting, localization checks, and a browser run. The size of the change set means this is not a claim that every line has been manually audited.

## Confirmed findings and corrections

| Priority | Finding | Correction and evidence |
| --- | --- | --- |
| P1 | A CLI or desktop client could trust a live process on the stored port without proving it was the same server. That made credential submission and stop operations vulnerable to stale or replaced lock state. | Added strict identity validation of root ID, PID, and port for clients and destructive commands, while preserving the startup coordination path. Identity and lock tests passed. |
| P1 | Cockpit replay treated a cursor ahead of the current log as caught up. After a server restart, a browser could silently miss telemetry and display a healthy stream. | Added per-log generation IDs and explicit gap frames; the browser keeps its behind state after a gap until a valid resumption. Replay tests passed. |
| P1 | A waiter could inherit a verification result before the owner checked whether its inputs changed during execution. An invalidation could also race a completed run back into cache. | Completed freshness and generation checks before resolving waiters; invalidation now blocks late reuse and retention. Sharing tests and the full core suite passed. |
| P2 | Replacing a cached verification answer retained the old byte count, potentially violating the configured memory budget. A zero-entry limit still retained one item. | Recalculate replacement bytes, evict to fit, and refuse retention at a zero-entry limit. Bound tests passed. |
| P2 | Two model keys with the same shortened prefix and suffix received indistinguishable labels. | Disambiguated display masks in the health and naming paths without exposing full keys. Model-key tests passed. |
| P2 | Bulk archive silently discarded failed requests and cleared selection, leaving users unable to see or retry partial failures. | Added a localized failure notice and retained failed rows for retry. All four multi-select browser tests passed, including a forced partial failure. |
| P3 | `recentDecisions(0)` and `recentEvents(0)` returned the full history instead of an empty result. | Corrected the zero-limit behavior and added regressions. |
| P3 | Static source-scanning tests parsed the same large files repeatedly and timed out under workspace-wide test load. | Reused parsed syntax trees and increased the timeout only for the expensive scans. The web suite passed when rerun alone. |
| P3 | An unreleased changelog entry repeated a word. | Proofread and corrected the entry. |

## Verification

- Core: 4,786 passed; server: 2,337 passed; web: 2,524 passed; CLI: 438 passed. The suites include their documented skips.
- Browser multi-select: 4 passed against a built web app and live server, including partial-failure retry.
- Type checking passed after rebuilding the server declarations consumed by the CLI; lint, localization parity, formatting, audit at the high severity threshold, and `git diff --check` passed.
- A concurrent workspace test invocation had five web timeouts under load. The web suite then passed alone after the scan changes. The entire concurrent workspace invocation has not been repeated after that correction.

## Next steps

1. Review the local patch as a single change set, including the strict identity behavior for users who connect to older server versions.
2. Run the full workspace test command in CI at its normal concurrency, plus release packaging and installation smoke checks on supported platforms.
3. Commit and merge the reviewed patch once those gates pass. Use a release candidate to verify cockpit reconnects and multi-select retry in a deployed environment before publishing another version.

The four pre-existing untracked `tools/measure-q*.mts` files were preserved. Generated browser test output and dependency cache were cleaned; existing build outputs were left in place.
