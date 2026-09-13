# Release publishing rejects unsafe tags and registry failures

- **Date:** 2026-09-13
- **Type:** process
- **Scope:** `ci`, `tooling`

[中文版](2026-09-13-release-publishing-hardening.zh.md)

Release tag values were moved from inline shell interpolation into step environment variables, and npm publication now distinguishes an unpublished version from a failed or malformed registry response.

## Details

- Release and npm stamping fail clearly when no tag is available.
- Existing package versions remain idempotent and are skipped during retry runs.
- Registry connectivity and response errors stop publication instead of being mistaken for missing package versions.
