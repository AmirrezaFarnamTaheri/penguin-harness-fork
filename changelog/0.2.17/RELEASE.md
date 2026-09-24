# PenguinHarness fork 0.2.17

This release consolidates the bug-swarm repairs and follow-up correctness fixes developed since v0.2.16. It improves reliability across the agent runtime, provider handling, sandbox boundaries, the web cockpit, and release tooling.

## Changes

- Hardened agent and filesystem behavior around shell exit status, malformed input, path handling, graph re-indexing, and removed directories. Added regression coverage for discovered edge cases.
- Improved LLM quota and rate-limit classification, key cooldown and rotation, pricing data, context accounting, tool-call identifiers, and speculative decoding behavior.
- Tightened sandbox egress and escalation handling, credential redaction, untrusted-content boundaries, and audit behavior.
- Prevented stale asynchronous web responses from overwriting state after project or locale changes. Improved chat recovery, compaction, installation-scoped browser state, mobile warning and approval layouts, and cockpit handoff visibility.
- Improved CLI interruption, argument validation, and language-shell error reporting.
- Strengthened release-tag validation, generated interface checks, benchmark-data verification, installer tests, documentation, and cross-platform test coverage.

## Scope

This is a fork release. Desktop installers are unsigned. The fork workflow does not publish the upstream npm packages, OSS mirror, or Docker images.

## Install

Download this fork's GitHub Release assets for Linux or macOS (x64/arm64), or Windows (x64). Platform archives include the required runtime; the universal archive requires Node.js 24 or newer.
