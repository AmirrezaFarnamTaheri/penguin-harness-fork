# Dependency audit refresh — 2026-10-03

## Scope and baseline

This is a refresh of the release dependency-audit gate after the Phase R R14a/R14b
receipts. It is not a replacement for those historical receipts and does not change a package
manifest or the lockfile.

- Repository head at inspection: `ec20a0c148a801591cb291b50236072ae9424744`.
- Lockfile SHA-256: `9811492ee195182322b5524e0d26fcdc09df6cae4d3b0bc85ea5be0a23ab89c0`.
- Environment: Linux x64, Node `v22.22.3` (below the repository's `>=24` engine), pnpm `11.18.0`.
- The audit command completed despite the engine warning; no dependency files were modified.

## Finding

`corepack pnpm audit --audit-level high` exits 1 with one high advisory:

| Field | Result |
| --- | --- |
| Advisory | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp), CVE-2026-93748 |
| Package / locked version | `http-cache-semantics@4.2.0` |
| Severity | High (CVSS 8.7) |
| Lockfile path | `packages__desktop > electron-builder > app-builder-lib > @electron/get > got > cacheable-request > http-cache-semantics`; a second path passes through `dmg-builder` |
| pnpm audit classification | `dev: true`, `optional: false`, `bundled: false` |
| Vulnerable range | `<=4.2.0` |
| Upstream fix | None published as of this audit refresh |

The GitHub Advisory Database describes a cross-user response disclosure through client
`max-stale` handling and currently lists **no patched versions**. The npm registry query
`corepack pnpm view http-cache-semantics version versions --json` reports `4.2.0` as the latest
published release; querying `http-cache-semantics@4.2.1` returns `ERR_PNPM_PACKAGE_NOT_FOUND`.
The advisory JSON consumed by pnpm advertises `>=4.2.1`, but that release is not present in the
registry, so a version override would not produce a valid install.

## Decision and gate

Do not add an override to a nonexistent release, silently suppress the advisory, or claim the
full audit is clean. R14a's historical Electron-binary repair remains supported by its recorded
receipt; this newly published finding is a separate, currently unresolved desktop build-chain
audit gate. R14b's undici floors remain present in the lockfile, and this audit reports no undici
finding.

The finding is classified as **GATED** pending either a compatible upstream patched release or a
reviewed builder/dependency path that removes the vulnerable package. The lockfile marks this as a
dev dependency, but repo-specific exploitability and any temporary exception still require an
explicit security/release-owner decision. The shared release audit gate therefore remains open.

## Reopen / close criteria

Recheck when `http-cache-semantics` publishes a patched release or a compatible
`electron-builder`/`@electron/get` update removes the affected chain. Close only after the resolved
lockfile no longer contains the vulnerable path (or an explicitly approved, time-bounded
exception records its scope and owner), `pnpm audit --audit-level high` produces the accepted
result, and the desktop packaging matrix still passes. Preserve this receipt and the old
Electron/undici evidence; do not retroactively rewrite those historical results.
