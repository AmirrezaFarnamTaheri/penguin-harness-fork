# Workspace dependency audit follow-up — 2026-10-02

The merged PR #12 audit was clean on its recorded head. A fresh audit on this follow-up worktree
found 22 advisories after the registry's advisory data changed: 13 high and moderate Axios/fast-uri
findings, plus 9 findings across vulnerable `brace-expansion` versions in Electron Builder's
transitive dependency graph.

`pnpm audit --fix=update` resolved Axios to 1.20.0 and fast-uri to 3.1.8. `pnpm audit --fix=override`
added version-aware overrides for the vulnerable `brace-expansion` ranges, and
`pnpm install --lockfile-only` applied them across the workspace lockfile. The lockfile install
passed supply-chain policy checks for all 27 workspace projects.

After those changes, `pnpm audit --json` exited successfully and reported zero info, low, moderate,
high, or critical findings; `pnpm audit --audit-level high` also reported no known vulnerabilities.
The audited scope is the current workspace lockfile; this receipt does not replace the desktop
packaging checks or CI on the follow-up commit.
