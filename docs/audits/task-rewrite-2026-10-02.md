# Task-document rewrite receipt — 2026-10-02

## Scope and baseline

Repository: `D:/GitHub/penguin-harness-fork`; branch: `codex/wave-1-2-hardening`.
Starting HEAD: `dcebeb20adb0aa0e246016a264eda11b67dea38d`.
This slice changes planning documents and agent guidance. It does not claim implementation
completion for any feature or repair order.

The original 150 task IDs and 16 checked states are preserved. Current acceptance remains in
[todo.md](../../tasks/todo.md): 16 VERIFIED, 32 IMPLEMENTED, 99 OPEN, 1 PARTIAL, 1 GATED,
and 1 N/A. VERIFIED receipts retain their historical scope; current release is still blocked.

## Deliverables

- [Plan](../../tasks/plan.md): parallel five-phase scheduling, dependency bundles, ownership,
  checkpoints and exact-revision release gates.
- [Task index](../../tasks/todo.md): one canonical current state per original task.
- Execution cards: 33 R/W1 cards with 99 packages; 29 W2 cards with 109 packages; 50 W3 cards
  with 200 packages; 38 W4 cards with 149 packages. Total: 150 cards and 557 packages.
- [Repair orders](../../tasks/work-orders.md): four CI cases with 16 numbered repair packages.
- [Implementation guide](../../tasks/implementation-guide.md): current-source discovery,
  complete consumer integration, proportionate authorized verification and evidence receipts.
- [Tool guide](../../tasks/tooling-guide.md): observed CodeGraph/Serena behavior, freshness and
  fallback rules, plus identified primary documentation for the other supplied tool names.
- Contracts, findings scope matrix and PR #12 review map: separate authorities, source/license
  boundaries, selected budgets, conditional producer gates and historical review provenance.
- Archived v3 plan, index and compressed cards: historical requirements retained and formatted;
  these are historical documents, not current dispatch instructions.

## Checks performed

Read-only structural analysis established:

- 150 original IDs present exactly once; no extra, missing or duplicate task ID.
- All 16 checked IDs match the historical index.
- 150 task anchors and 557 package anchors cover the execution cards.
- No duplicate explicit anchors or unresolved local Markdown paths/anchors in active task docs.
- No cycle in the indexed task-reference dependency graph. Conditional producer alternatives
  still require the card's contract; this check does not prove their runtime correctness.
- No root Vitest invocation remains in active task documents. Package-directory commands retain
  the owning runner's timeout, isolation and retry settings.
- Prettier 3.9.4, loaded from the existing workspace, used the repository configuration to format
  the documents. Formatted changes were applied through native patches; no package was installed.

The CLI formatter shim was unavailable to one worker, so final formatting used the existing
Prettier library. Final library checks covered active documents and historical snapshots.
No production tests, builds or dependency changes ran for this documentation slice.

## Evidence and limitations

The current failed CI is
[run 36986918261](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/36986918261)
on the starting SHA. Passing format/type/build lanes there are historical CI facts; the new
documentation's local formatting check does not turn its failing platform/browser lanes green.

CodeGraph MCP returned source; a worker's CLI query failed with a schema-version uniqueness
error. Serena was available earlier and absent from the later inspected catalog. Guidance
records both conditions and does not assume a healthy index, successful edit or installed server.

Three workers produced disjoint card volumes; follow-up reviews found and repaired status
duplication, stale section references, disk-policy exemptions, offline probe/i18n requirements,
skill-exception expiry, mobile keyboard coverage and package-runner commands.

The full five-phase objective remains open. No new task was verified by rewriting its card.
Future completion needs the criterion-by-criterion evidence and current required CI/review.

## Cleanup

Ran `rtk proxy node scripts/clean-workspace.mjs`, inspected the report, then ran `--apply`.
Both returned “Nothing to clean.” No persistent process, generated dist/target output or
runtime artifact was created. User-owned `.codegraph/` and collage material were preserved.
