# Recovery execution plan

## Decision
Restore in this existing Git working tree, based on origin commit `98f626008`. Do not restart implementations or overwrite the 49 preserved web paths.

## Guardrails
- No destructive operations, repository moves, resets, or checkout over preserved files.
- Preserve original traces and extracted artifacts.
- Never stage this recovery plan, the two original plan documents, or `hport_inventory.json` / `hport_deep_files.json`.
- Historical test results are not proof that the restored tree passes.

## Next executable steps
1. Restore one missing non-web source file from its recorded contents; verify it byte-for-byte against that artifact.
2. Restore that task's dependent files and tests; run its documented focused checks before committing only its files.
3. Repeat for missing tasks in dependency order. Mine traces only when a specific missing file requires it.
4. Finish the in-flight tasks and run repository gates sequentially.
5. Report remaining blockers honestly, including T44's missing benchmark provenance and the unexplained original repository deletion.

## Status
- [x] Restoration direction selected; plan written in recovery workspace.
- [x] First missing non-web file restored and content verified: `packages/desktop/src/utility-process-stop.ts`, SHA-256 matches recorded artifact.
- [x] T30 desktop restoration: `a555e11f`; 196 desktop tests passed / 17 skipped, desktop typecheck passed after declared dependency builds. Use canonical `D:/GitHub` casing for Vitest mocks and session-owned TEMP/TMP for esbuild fixtures.
- [ ] Task-level recovery and tests complete. Done so far: T30 desktop shutdown (commit a555e11f), T8 memory-search server surface (commit 32f1fa0d) — both focused-tested, typechecked, prettier/oxlint clean. Queue: T39, T46, T35, T38, T36, T37, T33, T34, T43, T10b (web-only tasks survived in the preserved tree), T29 (kernel-generational test — parent-authored, mining traces).
- Replay discipline: restore only files missing from the tree; apply recorded edits oldest-first with unique-anchor checks; revise test files with their recorded follow-up edits before judging results; focused tests + package tsc + scoped prettier/oxlint before each commit; commit only that task's files.
- [ ] Full repository gates complete.
