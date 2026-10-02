# Postmortem template and release/incident checklists (J9) — receipt

**Package:** J9 (Wave 3) — reusable postmortem template, actionable incident/release checklists, and
a filled example. **Date:** 2026-10-03 (Asia/Tehran).

## Scope

- **Parent task:** J9, all four sub-requirements (J9.1 fields, J9.2 checklists, J9.3 filled example,
  J9.4 review/validation).
- **Deliverables:** `docs/postmortems/TEMPLATE.md` and
  `docs/postmortems/2026-10-02-ci-lanes-and-gates.md`, plus this review receipt and the updated
  `tasks/todo.md` row.
- **Not in scope:** editing any historical receipt or task card (the example cites them unchanged),
  and re-adjudicating the CI-01…CI-04 repairs — their state remains what `tasks/todo.md` records.

## Baseline

- Starting HEAD `3f227739` (J8 packed the constitution and the H5 receipt), Node `v22.22.3`,
  pnpm `11.18.0`.
- Before this package the repository had receipts (`docs/audits/`) and dispatch orders
  (`tasks/work-orders.md`), but no reusable incident record format and no release checklist: the
  release rules lived as prose inside `.github/CONTRIBUTING.md#working-rules`, and the 2026-10-02
  CI incident existed only as a work-order preamble plus a repair receipt.

## Change

| Path | Change |
| --- | --- |
| `docs/postmortems/TEMPLATE.md` (new) | Copy-me postmortem with eleven required fields (timeline **with timezone**, affected version/scope incl. exact SHA, impact, detection, causes vs contributing factors, response, raw proof, follow-ups with owner/condition, rollback, acceptance evidence), an incident checklist, a release checklist, and the five review negatives |
| `docs/postmortems/2026-10-02-ci-lanes-and-gates.md` (new) | Filled example: the 2026-10-02 CI-lane/gate incident, with a sourced timeline, three root causes plus contributing factors (no blame), the response sequence, four owner-bearing follow-ups, raw proof links, rollback, and the exact-candidate acceptance run |

## J9.1 / J9.2 — Fields and checklists

- Fields: every row of the template's *Required fields* table maps 1:1 to a heading or a table
  column in the filled example (timeline and timezone, affected SHA/scope, impact, detection,
  causes/contributing factors, response, raw proof, follow-ups, rollback, acceptance evidence).
- Checklists: the **incident checklist** (10 items) and the **release checklist** (7 items) each
  name the evidence line that closes them; release items point at the canonical rules in
  `CONTRIBUTING.md#working-rules` instead of restating them, so the doc cannot drift from the
  release process. Every checklist item is checkable from a linked artifact except the manual smoke
  notes, which name what to record.

## J9.3 — Filled example

The example is the current incident, built only from already-recorded facts:
`tasks/work-orders.md#current-release-incident` (run 36986918261 on `dcebeb20`),
`docs/audits/ci-repair-2026-10-02.md` (fixtures `09b36f78`, spec `b8c74439`, gate repair
`a882cda4`, runs 37038239523 / 37040347326 / 37047995122 / 37049972446), and `tasks/todo.md`.
Observed facts and hypotheses are kept apart: the red `e2e-browser` job on `85b6799c` is labelled a
flake **because** the identical code tree passed on `ee07fcff`, and the sample names the reopen
condition instead of asserting a cause. The example states explicitly that it does not edit or
extend the receipts it cites.

## J9.4 — Review

| Check | Result |
| --- | --- |
| Every field present and non-empty in the example | Proved — all eleven fields appear with sourced content |
| Every follow-up has an owner | Proved — four rows, each with a named owner role |
| Every follow-up has a due date or reopen condition | Proved — each row states one (`next red e2e-browser with an identical code tree`, `every future closure`, …) |
| Every follow-up links a concrete task/work order | Proved — `tasks/work-orders.md#ci-01`…`#ci-04`, `tasks/execution-wave-3.md#j4`, `tasks/execution-cards-1.md#t0.3` + `docs/contributing-workspace.md` |
| Every follow-up names a checkable completion condition | Proved — each row has a completion condition column (observed run per lane, spec read and repaired, local gate run recorded) |
| Checklist review | Proved — both checklists were walked against the example; the release checklist's items map to the documented release rules and each names its evidence |
| Link/anchor/path grounding | Proved — 9 links, 4 anchors, 9 paths resolve (command below) |
| Negative: blame-only cause | Absent — causes are technical; the document states explicitly that nothing is attributed to a person and records the gate failures as a process gap |
| Negative: ownerless action | Absent — table above |
| Negative: missing affected SHA | Absent — `dcebeb20` (incident), `09b36f78`, `b8c74439`, `a882cda4`, `85b6799c`, `ee07fcff` (repair heads) |
| Negative: broken proof link | Absent — 9/9 resolve, including the four run links and the receipt |
| Negative: inferred green CI | Absent — every CI statement cites a run and the SHA it ran on; run 37040347326 is recorded as *never picked up*, not green, and closure uses run 37049972446 on `ee07fcff` |

## Verification

| Command | Result |
| --- | --- |
| `node links.mjs . docs/postmortems/TEMPLATE.md docs/postmortems/2026-10-02-ci-lanes-and-gates.md --absent …` (J8 Appendix A checker) | `checked 9 links, 4 anchors, 9 paths in 2 files` — OK |
| `pnpm --dir packages/docs exec vitest run test/content.test.ts` (card baseline) | 1 file, 7 tests passed |
| `prettier --check docs/postmortems/*.md` | clean |

## CI

- Package head committed and pushed on `arena/01a0fd8a-penguin-harness-fork`; the GitHub checks for
  that exact SHA are authoritative and are not claimed green here. No CI job runs this receipt.

## Compatibility

- Docs-only change; no runtime, API, or on-disk behavior. The template is additive: existing
  receipts and work orders keep their formats, and the example cites rather than rewrites them.
- Rollback: delete the two `docs/postmortems/` files and revert the `tasks/todo.md` row.

## Acceptance

| Criterion | Result |
| --- | --- |
| Template includes timeline, impact, detection, causes, follow-up owner | Proved |
| Template + example carry incident and release checklists with owner, condition, exact-candidate CI, rollback, acceptance evidence | Proved |
| Filled example distinguishes observed facts, hypotheses, and pending repairs | Proved — the flake is a labelled hypothesis with a reopen condition |
| Every follow-up points at a concrete task/work order with a checkable completion condition | Proved |

## Residual work

- **The five negatives are review-time rules, not a gate.** No script validates a future postmortem;
  the J8 grounding checker is the only automated link check used here. Reopen with J12 (PR
  annotations) or a new package if a checked postmortem template is wanted.
- **Release checklist is a document, not a workflow step.** It closes nothing automatically; the
  release owner still reads it. If the release process grows a scripted preflight, this checklist is
  its requirement source.
- **The `e2e-browser` flake remains unattributed** (log unreachable at the time). Its owner path is
  J4, which is still OPEN; this receipt does not close J4.
