# Documentation refresh — 2026-10-04

## Scope and baseline

Requested order: update documents first, rewrite the changelog and clean plan/todo, remove
stale documents, then finish review repairs, merge, and complete Phase R and Waves 1–4.
Baseline: PR #15 head `9f589c721a7cf09c9fb7ec116319161e76218f7c`.
Work branch: `codex/pr-15-review-fixes`. This receipt describes uncommitted documentation and
runtime repairs; no new candidate CI or merge is claimed.

## Current document authority

- [Plan](../../tasks/plan.md): current scope, sequence, dependencies, phase checkpoints.
- [Todo](../../tasks/todo.md): all 150 original IDs and one current state per task.
- [Work orders](../../tasks/work-orders.md): five current review repairs, audit gate, next queue.
- [Execution cards](../../tasks/execution-cards-1.md): detailed contracts retained, with separate
  Wave 2/3/4 card files and current-status routing.
- [Implementation guide](../../tasks/implementation-guide.md) and
  [tooling guide](../../tasks/tooling-guide.md): execution, evidence, CodeGraph/Serena discipline.
- [English changelog](../../CHANGELOG.md) and [Chinese changelog](../../CHANGELOG.zh.md): concise
  published summaries and explicitly unreleased changes with acceptance limits.

## Reconciliation

| Phase | Total | VERIFIED | IMPLEMENTED | OPEN | GATED | N/A |
| --- | --- | --- | --- | --- | --- | --- |
| R | 21 | 9 | 11 | 0 | 1 | 0 |
| 1 | 12 | 6 | 5 | 0 | 0 | 1 |
| 2 | 29 | 2 | 27 | 0 | 0 | 0 |
| 3 | 50 | 1 | 13 | 36 | 0 | 0 |
| 4 | 38 | 0 | 0 | 38 | 0 | 0 |
| Total | 150 | 18 | 56 | 74 | 1 | 1 |

These are preserved recorded states, not new verification. The refresh fixes checkbox/state
agreement, removes the stale statement that I1 lacks trace/export integration, and ties I1/I7/E10
to their new review repairs. R2d remains gated and G7 retains its N/A decision.
Current PR #15 includes #14 and #13; historical failing checks are not the current candidate's
checks. Old CI orders retain their scoped receipts and anchors.

## Removed superseded planning documents

The following tracked planning copies no longer serve as executable instructions. Their original
source remains in [the reviewed baseline's Git tree](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/tree/9f589c721a7cf09c9fb7ec116319161e76218f7c).
Inbound archive references now use that pinned revision. Current numbered cards and contracts
remain in the working tree; historical architecture proposals are not silently activated.

| Removed path | Current authority / retained provenance |
| --- | --- |
| `tasks/archive/plan-v3-2026-10-02.md` | Current plan/contracts; review map links pinned historical adjudication |
| `tasks/archive/todo-v3-2026-10-02.md` | Current 150-ID task register; progress receipts retained |
| `tasks/archive/execution-cards-2-v3-2026-10-02.md` | Current Wave 2/3/4 cards; pinned original source |
| `docs/plans/2026-09-15-001-feat-model-gateway-chat-enhancements-plan.md` | Historical product proposal in Git; current numbered tasks govern new work |
| `docs/superpowers/plans/2026-09-14-backend-cockpit-suite.md` | Historical cockpit proposal in Git; current server/product contracts govern |
| `docs/superpowers/plans/2026-09-17-penguin-harness-all-tracks.md` | Historical track proposal in Git; current Phase R/Waves 1–4 register governs |

Published release details, dated audits, policies, user-owned materials, `.codegraph/`, and
per-machine instructions are retained. No historical test receipt is rewritten as current proof.
No task requirement is dropped because its old planning copy was removed.

## Release and tool observations

The 2026-10-04 dependency audit returned one high advisory for
`http-cache-semantics@4.2.0` in the desktop build chain and advertised `>=4.2.1` as patched.
The registry query for 4.2.1 returned `ERR_PNPM_PACKAGE_NOT_FOUND`; SEC-01 remains gated.
No dependency suppression or nonexistent-version override was applied.

CodeGraph is exposed; the existing index must be preserved and freshness warnings obeyed.
Serena and context-mode tools are not exposed in the current catalog. The tooling guide explains
their intended use when available and the current-source fallback; it does not promise tool
availability, orchestration, automatic rollback, or runtime correctness from static edges.

## Acceptance and remaining work

Document inspection must confirm the unchanged 150-ID set, state counts and checkbox agreement,
valid local paths/anchors, no local references to removed planning files, and formatting.
Results are recorded below after inspection. Runtime tests were not run for this rewrite.

The five review repairs still need candidate acceptance; corrected-head CI, dependency audit
disposition, merge, and 74 OPEN tasks remain. The 56 IMPLEMENTED tasks retain their specific
acceptance/review requirements. This refresh does not complete any phase.

## Rollback

Restore affected documents from the reviewed baseline together if the authority routing fails.
The removed files are recoverable from that pinned Git revision. Preserve new defect receipts
and the user's current objective; do not restore competing live status authority.
