# Add host-owned advisory Jev integration

- **Date:** 2026-09-25
- **Type:** feature
- **Scope:** `core`, `server`, `docs`

[中文版](2026-09-25-jev-advisory.zh.md)

PenguinHarness can now ask TypeSafe AI Jev for a bounded advisory observation when a model proposes a tool call. The integration uses the verified `@typesafe-ai/sdk` System One client and records its `choice`, `score`, and `noul` results through the existing pre-tool-use Trace event path.

## Details

- The advisor is host-composed through `createAgent({ jevAdvisor })`; the server enables it only with the explicit `PENGUIN_JEV_API_KEY` environment variable. Agent-writable configuration cannot choose the endpoint or credential.
- The default request contains tool metadata rather than argument values. Redacted argument values require an explicit host opt-in, requests have a hard deadline and local circuit breaker, and provider failures fall back to the existing tool path.
- The host transport pins the official HTTPS endpoint (loopback HTTP only for local test doubles), refuses redirects, treats protocol-invalid responses as circuit failures, and records only allowlisted diagnostics. Harness `PENGUIN_*` credentials are withheld from installable hooks and interactive terminals.
- Truncated tool output is redacted before it is persisted to the recovery archive. Doing so exposed that the credential redactor's URI rule retried its scheme scan at every position of a long run, making redaction quadratic in the input — 28 seconds on a 256 KiB capture, and never finishing on a full 8 MiB one. The rule now takes a boundary-guarded, length-bounded scheme, which keeps the same matches and makes the pass linear (16 ms on 8 MiB).
- Jev output is event-only: it cannot allow, deny, or replace the project command policy, Environment permission, or human approval callback. A disabled or unavailable advisor emits no decision.
- The Jev adapter is published from `@prismshadow/penguin-core/jev`, and configuration and SDK composition are documented bilingually.
