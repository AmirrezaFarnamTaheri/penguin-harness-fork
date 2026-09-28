# v0.2.18 release assessment

## Scope

This follow-up covers the post-v0.2.17 corrections promoted into active product paths and the release preparation for 0.2.18. It supplements [the initial forensic review](post-v0.2.17-review-2026-09-28.md). The initial review covered the 14 committed changes through `0ce506ce4` (405 changed files); follow-up review added runtime accounting, provider selection, process ownership, image decoding, command parsing, cockpit replay, CLI lifecycle, and product UI boundaries. This documents tested paths and meaningful findings; it does not claim that every line of the repository was manually audited.

## Findings fixed

| Priority | Issue | Fix and verification |
| --- | --- | --- |
| P1 | Research verification referenced a reservation value outside its scope, breaking repository type checking. Successful verification also released its reserved estimate without recording spend, and failure could strand the reservation. | Use the concrete reservation estimate, book it conservatively after success or failure, and let errors propagate only after settlement. Core tests and repository type checking passed. |
| P1 | MCP resource teardown could terminate a process without current ownership evidence, and an in-flight release could affect a resource registered later under the same ID. | Require a matching owned-process guard, serialize lifecycle operations, snapshot sweep candidates, and apply cooldown only to the same resource identity. Resource tests passed. |
| P1 | Image bytes with a supported extension but unreadable dimensions could reach a downstream decoder. | Reject the image before decoder handoff when dimensions cannot be verified. Image and dimension tests passed. |
| P2 | A late provider-health response could overwrite state from a newer selection. | Attach one-use receipts to selections and ignore stale outcomes; retain compatibility for callers that do not yet pass receipts. Provider tests passed. |
| P2 | A live cockpit stream could silently miss events after a sequence gap. | Detect gaps and reconnect from the last contiguous cursor so the server can replay missed events. Server and web replay tests passed. |
| P2 | Quoted command text containing shell operators was split as multiple commands; Windows paths were parsed inconsistently. | Replace naive operator splitting with quote-aware scanning and add Windows-path and escaped-operator tests. |
| P2 | An older ACP transport failure could poison a replacement connection. | Bind send operations and failure handling to connection generations. ACP regression tests passed. |
| P2 | Malformed evaluation metadata, excessive reservation churn, unbounded history bytes, and incomplete browser/CLI interaction states could produce misleading results or stale UI. | Validate evaluation inputs, account for bounded late settlements, enforce archive byte limits, and correct accessible focus, keyboard, lifecycle, and preview paths with focused regression coverage. |

## Product integration decisions

The fixes were applied to the product paths that already own the relevant work: research accounting, MCP lifecycle, ACP transport, image reads, provider health, server cockpit event replay, browser telemetry, and CLI/server lifecycle. UI changes were wired through actual chat, calendar, ticket, sidebar, and artifact preview flows.

The `WorkRouter`, `OperationShareRegistry`, `SpendCeiling`, and `JevSurfaceAdvisor` foundations remain unactivated. There is no current production composition with the allocator, data invalidation boundaries, persistent user/project budget policy, or user-visible advisory consumer needed to make them safe. Activating them without those contracts would add split-brain routing, stale shared data, unbounded spend expectations, or unused provider calls. The research budget changes are wired to the existing research loop, but still use conservative estimates where the verifier exposes no measured token usage.

## Verification

- Core: 4,805 passed, 29 skipped.
- Server: 2,339 passed, 54 skipped.
- Web: 2,525 passed.
- CLI: 438 passed, 10 skipped.
- Desktop: 196 passed, 17 skipped.
- Docs: 53 passed; landing: 71 passed.
- Repository-wide type checking, core/server/web/CLI production builds, lint, Prettier, localization parity, skill integrity (2,567 skills with zero errors or warnings), and release-publishing regression tests passed.
- Four browser multi-select E2E cases passed earlier against a built web app and live server, including partial failure and retry.
- The prior recursive Windows workspace test command failed with `spawn UNKNOWN`; per-package test commands passed. Linux pull-request CI remains the cross-platform aggregate gate.
- The first pull-request CI run found three release-gate issues: the core build identity constant still held 0.2.17, a compaction test expected an exact retry delay despite intentional seeded jitter, and a WebSocket acknowledgement wait was too short under the Windows shard's load. The core version now matches all package manifests; retry assertions honor the bounded jitter; and the socket test waits longer and distinguishes a resume from an explicit gap. Local CLI identity, compaction, and cockpit-resume checks pass; the corrected cross-platform CI run is required before tagging.
- A paid live-provider E2E assertion was inconclusive after retries and was not repeated. It is not presented as a local pass.
- The web build reports a chunk above 500 KB after minification. The build succeeds; chunk splitting is a follow-up performance opportunity, not a release blocker in this change.

## Release boundary

This is a fork release. Its release workflow can create GitHub assets, but workflow conditions intentionally disable upstream npm publishing, the OSS mirror, and Docker publishing for this fork. Desktop installers are unsigned. The release is prepared as 0.2.18 and must only be tagged after its pull-request checks pass and the release commit is on the fork's current `main` line.
