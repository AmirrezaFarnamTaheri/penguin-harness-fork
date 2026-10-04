# Delivery plan — Phase R and Waves 1–4

Updated: 2026-10-04. Objective: complete every existing task and its acceptance criteria.
Current work branch: `codex/pr-15-review-fixes`.
Reviewed baseline: `9f589c721a7cf09c9fb7ec116319161e76218f7c`, PR #15.
Local review fixes and this documentation refresh await commit and candidate acceptance.

## Start here

1. [Todo](todo.md): canonical task state, dependencies, and evidence.
2. [Work orders](work-orders.md): current incidents and actionable repair packages.
3. [Implementation guide](implementation-guide.md): execution and acceptance procedure.
4. Read the whole selected card: [R/1](execution-cards-1.md), [2](execution-wave-2.md),
   [3](execution-wave-3.md), or [4](execution-wave-4.md).
5. Apply [contracts](contracts.md), [findings scope](findings-scope-matrix.md), and
   [CodeGraph/Serena guidance](tooling-guide.md).

## Current source and release state

| Item | Observed state | Required next action |
| --- | --- | --- |
| Main | PR #12 merged at `fc44861a4730a43c58d9accdbc9e15ee27003d8b` | Preserve base compatibility |
| PR #13 | Draft, `09b36f788333393de48268939df99d57f5e580fa` | Reconcile contained changes after #15 merge |
| PR #14 | Draft, `73ab5144bcaa2a5ba191acb551dfb6011cefbddf`; contains #13 | Reconcile contained changes after #15 merge |
| PR #15 | Ready, reviewed head `9f589c721a7cf09c9fb7ec116319161e76218f7c`; contains #14 | Commit repairs, pass new candidate gates, merge |
| Five review repairs | Local implementation present | Complete [PRR-01–05](work-orders.md#review-repair-orders) acceptance |
| Dependency audit | One high desktop build-dependency advisory | Resolve [SEC-01](work-orders.md#sec-01) |

At the reviewed PR #15 head, 25 checks succeeded and 2 were skipped; none failed.
[CI run 37151015054](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37151015054)
and auxiliary checks certify their recorded source, not the changed working tree.
Read the [review receipt](../docs/audits/open-pr-review-2026-10-04.md) for scope and limitations.

The 2026-10-04 audit advertises a fix at `>=4.2.1`, but the registry lookup for 4.2.1 returns
package-not-found. Keep the release audit gate open until a compatible fix is published or an
explicit owner adjudication is recorded. A suppressed finding is not a patched dependency.

## Scope and phase outcomes

All 150 original task IDs remain in [todo.md](todo.md). Operational repairs are additional work.
Its summary counts recorded states and does not grant new acceptance.

| Phase | Required outcome | Mandatory checkpoint evidence |
| --- | --- | --- |
| R | Scoped, durable, attributable, bounded, recoverable findings | Identity matrix, lifecycle/store proof, output contracts, defect-detection battery |
| 1 | Foundation fixes and provenance/capture helpers reach consumers | Error corpus, focus/deletion flows, TLS/applicability and runtime claims |
| 2 | Runtime, transport, security, and recovery compose correctly | Retry/output bounds, recall privacy, cockpit errors, credentials and offline recovery |
| 3 | Code intelligence, memory, configuration, and UI meet measured gates | AST quality/resources, scoped findings, configuration rollback, platform/accessibility |
| 4 | Turn, cost, permission, evaluation, fleet, and export planes compose | Permission traces, checklists, strategic demos, restart/export artifacts, visual decisions |

IMPLEMENTED means acceptance/review remains. OPEN can include existing code worth completing.
VERIFIED evidence is scoped to its recorded revision; revisit affected boundaries after changes.
Conditional requirements retain their explicit scope, decision evidence, and reopen conditions.

## Immediate execution sequence

1. Finish this requested documentation refresh and reconcile IDs, links, status, and changelog.
2. Accept all five review repairs: honest Session deletion, incomplete-tail masking, durable
   pressure refusal, serialized override authority, and current process-group ownership.
3. Resolve SEC-01 through a published compatible remediation or explicit security adjudication.
4. Review the actual diff, commit, and push the corrected consolidated PR #15 candidate.
5. Await the exact candidate's required CI and review gates. Fix failures before merging.
6. Merge #15 preserving the contained stack's history; reconcile #13/#14 rather than accepting
   their stale failing heads independently.
7. Resume R/1/2 acceptance gaps and ready Wave 3/4 implementation. Inspect existing code and
   receipts first, name the missing criterion, then finish the real producer-to-consumer path.
8. Close phases only after every scoped criterion and shared closure gate is accepted.

The active human request governs verification frequency. Batch permitted checks after coherent
changes; avoid repeated full suites during implementation. This plan does not authorize tests
beyond the current request. Candidate CI supplies the requested merge gate.

## Dependencies

Principal chains:

- R0 → R2a → lifecycle, bounded output, durable persistence, and recovery.
- A2/A3 → A1; A3 → A4; B2 → B1 → B3.
- E2 → E3 → E4; E8/E9 → notification consumers.
- D1 → D2 → D4a → D4b → D5/D8 → D9 → D10 → D3.
- C2 → C3 → C4 → C5 → C6.
- H3 → H1; H1/H2/H3 → H4 → K3.
- K5 → K14a → K14b; K8 → K11a → K11b.
- A5/A9 → K1a → K1b → K13.

Rows/cards define exact integration gates. Discovery can establish a separately accepted producer
subcontract; it cannot bypass authorization, privacy, migration, resource, license, or evidence gates.
R2d needs trusted workspace↔project binding. C8/F17 share offline composition. ACP resume and
cockpit SSE cursors have distinct contracts. Sensitive K1a/K2/K4/F13a consumers need the relevant
I1 redaction contract. K17 automated findings consume R0/R2a/R1b/R8. C11 needs a persisted
source-content revision seam. G8 diagnostics can precede product badges.

## Ownership and prioritization

A package names task ID, numbered card package, actual files, prerequisite evidence, observable
outcome, acceptance cases, and rollback. Shared exports, default config/kernel history, findings
store/graph, route composition, redactors, protocol state, and browser mocks have one integration
owner. Preserve concurrent edits and deliberate user state.

Choose ready work by benefit, risk reduction, dependencies unlocked, confidence, and effort
including prerequisites. Data loss, credential disclosure, false success, and release failures
take priority. Keep all five phase queues visible. Use parallel owners only when the active
instructions authorize delegation and their files do not conflict.

For each slice update the row, receipt, current order, and changelog. Update
`docs/status-ledger.json` only when the actual runtime claim changes. A new export alone does
not establish production integration.

## Document authority

| Document | Authority | Update trigger |
| --- | --- | --- |
| Plan | Scope, sequence, phase checkpoints | Objective or architecture changes |
| Todo | One status record per task | Implementation, dependency, or acceptance changes |
| Work orders | Current repair and implementation packages | Priority, blocker, CI, or owner changes |
| Cards/contracts | Detailed requirements and decisions | Evidenced contract changes |
| [Review map](review-map.md) | PR #12 requirement provenance | Mapped requirement adjudication |
| [Audits](../docs/audits/) | Dated observations and evidence | New evidence |
| [Changelog](../CHANGELOG.md) | Released history and explicitly unreleased behavior | User-visible changes |

Retired planning copies are removed from the checkout; pinned Git history preserves provenance.
The [refresh receipt](../docs/audits/documentation-refresh-2026-10-04.md) lists removed paths.
Keep dated audits and published release details. Do not create a competing live status ledger.

## Shared closure

Every task needs criterion-by-criterion evidence or an explicitly authorized conditional
disposition with scope and reopen condition. Required candidate CI, audit, review, claims,
migration, and rollback gates must pass. Clean run-owned debris and stop owned processes before
reporting completion. The overall objective stays open while any required item remains.
