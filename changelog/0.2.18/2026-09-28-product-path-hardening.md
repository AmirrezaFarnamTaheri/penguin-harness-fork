# Harden product paths after the cross-layer review

- **Date:** 2026-09-28
- **Type:** fix
- **Scope:** `core`, `server`, `web`, `cli`, `desktop`

[中文版](2026-09-28-product-path-hardening.zh.md)

Follow-up review findings were fixed in the runtime paths that the product actually uses, with regression coverage for failures at package and process boundaries.

## Details

- Research verification reserves its estimated token cost before work starts and settles that reservation conservatively on success or failure. Resource release checks current process ownership, serializes concurrent work, and avoids applying stale sweep results to a replacement resource.
- Provider-health updates carry one-use selection receipts so an older asynchronous result cannot overwrite newer state. Cockpit event replay resumes from the last contiguous cursor when the live stream has a gap.
- Image reads reject supported extensions whose headers do not provide verifiable dimensions. Shell command detection preserves operators inside quoted values and handles Windows paths.
- ACP transport generations isolate retired connections from replacement connections. Server event payloads retain their assigned sequence and measure UTF-8 bytes correctly.
- CLI lifecycle handling, accessible interaction paths, artifact previews, calendar and ticket controls, session recovery, and visible tool summaries received focused corrections.
