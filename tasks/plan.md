# Absorption and hardening plan — v4

Baseline: 2026-10-02; repository `D:/GitHub/penguin-harness-fork`; branch
`codex/wave-1-2-hardening`; PR #13 head `dcebeb20adb0aa0e246016a264eda11b67dea38d`.
Re-check HEAD and changed files before execution. The user's objective is to complete Phase R
and Waves 1–4 in parallel, choosing the highest-ROI available work, including prerequisites
from other phases.

## Start here

1. Read [todo.md](todo.md) for canonical task state and prerequisites.
2. Read [work-orders.md](work-orders.md) for current incidents, assignments and ROI ranking.
3. Read [implementation-guide.md](implementation-guide.md) before claiming a package.
4. Read the selected card and the [contracts.md](contracts.md) decisions it uses.
5. Use [tooling-guide.md](tooling-guide.md) for CodeGraph/Serena navigation and editing.

| Document                                            | Authority                                                       | Update trigger                                |
| --------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| This plan                                           | Scope, phase outcomes, scheduling and checkpoints               | Objective/architecture changes                |
| [Task index](todo.md)                               | One work-state record per task                                  | Implementation or acceptance evidence changes |
| [Work orders](work-orders.md)                       | Dispatch and current incident evidence                          | A package completes or priority changes       |
| [R + Wave 1 cards](execution-cards-1.md)            | Review/foundation requirements and numbered packages            | Contract/decomposition changes                |
| [Wave 2 cards](execution-wave-2.md)                 | Resilience, security and server contracts                       | Corresponding contract changes                |
| [Wave 3 cards](execution-wave-3.md)                 | Expansion and promotion contracts                               | Corresponding contract changes                |
| [Wave 4 cards](execution-wave-4.md)                 | Strategic/control/product contracts                             | Corresponding contract changes                |
| [Contracts](contracts.md)                           | Architecture, budgets and Q1–Q8 decisions                       | Evidence justifies a decision revision        |
| [Scope matrix](findings-scope-matrix.md)            | Findings authority and authorized binding                       | Identity/persistence changes                  |
| [Review map](review-map.md)                         | Historical PR #12 review labels mapped to retained requirements | A requirement's adjudication changes          |
| [Runtime claims ledger](../docs/status-ledger.json) | Machine-checked shipped/experimental claims                     | Actual runtime claim changes                  |
| [Audits](../docs/audits/)                           | Source, review, test, benchmark and CI receipts                 | A receipt is produced                         |
| [v3 archive](archive/plan-v3-2026-10-02.md)         | Historical requirements/adjudications                           | Provenance lookup; current cards govern work  |

[execution-cards-2.md](execution-cards-2.md) is retained as a routing pointer. Historical
collage/cluster labels identify investigations; they are not completion evidence. Source-transfer
and license boundaries remain in [the source policy](../docs/policies/porting-and-refusals.md).

## Current evidence and release state

PR #12 merged on 2026-09-30 as `fc44861a4730a43c58d9accdbc9e15ee27003d8b`.
Its complete CI receipt applies to head `68148d15baf95a941cc98a7d3b41086b1b2a6ae7`;
see [the historical receipt](../docs/audits/pr-12-ci-2026-09-30.md).

PR #13's baseline has passing formatting, typecheck, build, audit, Ubuntu core/server, all
server/rest platform lanes, web/CLI, installer and runtime jobs. Its required
[CI run 36986918261](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/36986918261)
failed macOS and Windows core and browser E2E. The four failing cases have concrete
[repair orders](work-orders.md#current-release-incident). Release remains blocked while
independent discovery and reversible packages across all phases remain schedulable.

Existing implementations and historical completed tasks are retained in the index. A helper's
existence, a focused pass, or this rewrite does not prove a wider task. Reconcile current source
and every required criterion before extending or closing it.

## Scope and five phase outcomes

The original inventory contains 150 task IDs; four CI IDs are operational repair orders linked
to existing contracts. Every original task remains represented. Promotion add-ons now belong
to their execution wave.

| Phase                  | Outcome                                                                                         | Required checkpoint artifacts                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| R — review absorptions | Findings are scoped, durable, attributable, bounded and recoverable                             | R0 identity matrix; R1/R2 lifecycle/store proof; R4/R5 contracts; R11 battery; [review-label adjudication](review-map.md)  |
| 1 — foundations        | Quick fixes, capture/provenance helpers, docs and skill safeguards work in their stated scope   | A2/A3/B2 acceptance; focus/banner/deletion proof; TLS/applicability receipts; J11 claims gate                              |
| 2 — core hardening     | Typed failures, bounded retries/output, actual cockpit operations, safe imports and credentials | A1 corpus; A4 branch table; B1 recall/privacy; B3 savings/drop table; E2 eight-item table; security/offline recovery proof |
| 3 — expansion          | Optional AST and scoped knowledge/memory/config/UI meet measured gates                          | D10 quality/resource table; findings/briefing demo; recall baseline; configuration rollback; platform/a11y receipts        |
| 4 — strategic/product  | Turn, cost, permission, evaluation and export planes compose with existing controls             | K4/K2/K3 demos; permission trace; versioned verification; export/restart artifacts; Q6 visual decision                     |

Completion requires every card's deliverables and criteria. A conditional item first produces
its decision evidence; a rejected promotion retains the proven default and records disposition
and reopen conditions. A missing dependency keeps the unmet requirement visible and routes
work to that prerequisite. The full objective remains open until all five phase audits pass.

## Scheduling across phases

Wave labels group scope; they are not serial barriers. Readiness comes from dependency contracts,
file ownership, observability, and the task's specific promotion/authorization gate.

1. Refresh incidents, source and candidate state at HEAD.
2. Rank available packages with the [ROI procedure](work-orders.md#priority-decision-record).
3. Score a valuable task together with its smallest unmet prerequisite bundle, even across phases.
4. Run disjoint packages concurrently. Discovery, fixtures and design can progress while an
   integration prerequisite is still being completed.
5. Integrate a dependent consumer after its required producer contract is accepted. Production
   promotion and release await the specified evidence, license and CI gates.
6. Integrate the receipt and choose again. Keep all five queues visible until they close.

Principal chains: R0 → R2a → storage/lifecycle/output; A2/A3 → A1 and A3 → A4;
B2 → B1 → B3; E2 → E3 → E4; D1 → D2 → D4a → D4b → D5/D8 → D9 → D10 → D3;
C2 → C3 → C4 → C5 → C6; H3 → H1 and H1/H2/H3 → H4 → K3;
K5 → K14a → K14b; K8 → K11a → K11b; A5/A9 → K1a → K1b → K13.
The task index/card names exact gates. A package may consume a separately accepted subcontract
without waiting for unrelated packages in that parent.

C8/F17 share an offline integration group; develop fixtures/banner concurrently. ACP and cockpit
SSE cursors are distinct and meet through an explicit UI composition contract. R2d activates
only after trusted workspace↔project binding exists; shared store code does not establish it.

Sensitive persistence/display in K1a/K2/K4/F13a integrates only after I1's relevant redaction
contract is accepted. K17 auto-findings consume R0/R2a/R1b/R8 and remain open. C11 consumes a
persisted source-content revision seam; G8 doctor work can precede its G2/G6 product badges.
These gates preserve parallel discovery while preventing incomplete producers from reaching users.

## Ownership and integration

Claim one task package and its actual paths before edits. Parallel workers share the checkout,
preserve each other's changes, and hand a reproducer to the owner when another file needs repair.
One integration owner holds overlapping edits to:

- `packages/core/src/index.ts`
- `packages/core/src/state/default-config.ts`
- `packages/core/src/state/kernel-history.ts`
- `packages/core/src/knowledge/findings-graph.ts`
- `packages/core/src/knowledge/store.ts`
- Shared server route composition, redactors and protocol state
- Shared browser mocks and fixtures

A package normally changes one to three files at one observable boundary. Split work spanning
more than five files or unrelated persistence/protocol boundaries into numbered packages while
preserving the parent outcome. Package completion differs from task completion. Default/export
changes include kernel-hash and tool-alias updates when their guards require them.

## Acceptance and release

The [implementation guide](implementation-guide.md) owns the evidence procedure. Each card
names its positive, negative, fault, cancellation and compatibility cases. Map every criterion
to a meaningful existing test, justified new coverage, measurement, review or artifact.

A phase checkpoint closes after its required task criteria and evidence are accepted, with
explicit conditional dispositions. Checkpoints govern acceptance/promotion, not permission to
investigate another phase. Shared release requires the candidate SHA, all required CI lanes,
dependency audit, required review, truthful runtime/docs claims, compatible migration/rollback
evidence and process/artifact cleanup. A prior SHA or another platform cannot close a red lane.

Capture fixture/corpus hash, revisions, command, OS/runtime, repeated samples where required,
raw artifacts and the decision. Freeze budgets before candidate runs. Numeric limits and
rationale live in [contracts.md](contracts.md), including B3/Q3, D10/Q4 and F10/Q6.
Stateful rollout first reads old snapshots, preserves the authority, rehearses failure/rollback
on copied fixtures, then widens after counts/hashes and restart behavior agree. A denied durable
write preserves the acknowledged prior state and remains observable to its caller.
