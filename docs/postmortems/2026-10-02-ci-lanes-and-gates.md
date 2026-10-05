# 2026-10-02 — CI lanes and repository gates during the CI-01…CI-04 repair

This is the filled example for [TEMPLATE.md](TEMPLATE.md); it adds no new claims, it cites the
existing receipts ([`docs/audits/ci-repair-2026-10-02.md`](../audits/ci-repair-2026-10-02.md),
[`tasks/work-orders.md`](../../tasks/work-orders.md#current-release-incident),
[`tasks/todo.md`](../../tasks/todo.md)) rather than editing them.

- **Status:** closed 2026-10-02, with one recorded flake and its reopen condition.
- **Severity / impact:** release blocking for the repository — the aggregate `ci` job failed, so no
  candidate head could be merged or tagged. No user data or runtime behavior was affected; the
  affected surface was the test/CI evidence itself.
- **Affected version / scope:** unreleased work after v0.2.18, branch
  `arena/01a0fd8a-penguin-harness-fork`. Incident head named by the orders:
  `dcebeb20adb0aa0e246016a264eda11b67dea38d` (CI run
  [36986918261](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/36986918261)).
  Repair heads: `09b36f78` (fixtures), `b8c74439` (browser spec), `a882cda4` (gate repair),
  `85b6799c` (first full repair run), `ee07fcff` (docs head, same code tree).
- **Detection:** CI itself, on the incident head — four failing cases plus the gate failures that
  followed; the first repair run (37038239523) exposed the two repository gates.

## Timeline (UTC where the source records UTC; local sandbox time is UTC+3:30)

| Time | Source | Observation |
| --- | --- | --- |
| 2026-10-02, first observed run | `tasks/work-orders.md` | Run 36986918261 on `dcebeb20`: prettier, typecheck, build, audit, Ubuntu core/server, all rest-platform lanes, web/CLI, installer and runtime lanes passed; four cases failed and the aggregate `ci` job failed with them. |
| 2026-10-02 | `docs/audits/ci-repair-2026-10-02.md` | CI-01 fixture split, CI-02 watcher fix, CI-03/CI-04 browser-spec repairs land at `09b36f78` / `b8c74439`; run 37038239523 turns those four lanes green and reveals `typecheck` and `style (prettier)` failures in the new fixture code. |
| 2026-10-02 | same | Gate repair at `a882cda4` (one non-null assertion under `noUncheckedIndexedAccess`, two files formatted); run 37040347326 created but never picked up — the predecessor's aggregate job sat queued. |
| 2026-10-02 18:00:19 | same | The stuck aggregate job 110948311260 is cancelled, releasing the branch concurrency group. |
| 2026-10-02 | same | Run 37047995122 (`85b6799c`): 19/20 jobs green — every repaired lane passes; `e2e-browser` fails (job 110974077981, exit 1 after ~8.5 min) and the aggregate reports it. The log was unreachable from the working sandbox, and the lane has no retries, so the failing spec could not be identified. |
| 2026-10-02 | same | Run 37049972446 (`ee07fcff`, code tree identical): 21/21 jobs green, including `e2e-browser` 110980641658 and `typecheck` 110980641451; `Skill Integrity` 37049972427 green. |

## Causes and contributing factors

- **Root causes (three, one per repair):**
  1. The findings-store denial fixture injected a denial against a path string that did not match the
     canonical authority the store opens on macOS (`/var` → `/private/var`) and Windows
     (short/case-normalized names), so a denial surfaced as corrupt content.
  2. The non-recursive watcher fallback depended on a *named* `fs.watch` event; on macOS the
     notification arrives unnamed, so a real nested-directory change did not invalidate the graph.
  3. The browser quota case encoded the legacy retry ladder, while the shipped pool policy rotates
     at 50 ms on the first round — the spec asserted a countdown the policy cannot produce.
- **Contributing factors:** the fixtures were authored without a runnable workspace, so no local
  typecheck/prettier ran before CI (this produced the two gate failures on top of the incident);
  the browser lane has no retries and cannot run in the sandbox, so a red browser job can only be
  read from the run page; one earlier documentation-only head had no code difference, which made a
  flake hard to distinguish from a regression until both were compared.
- **Explicitly not a cause:** individual error. Nothing here is attributed to a person, and the
  gate failures are recorded as process gaps (no local run possible that day), not carelessness.

## Response

1. Four repair orders (CI-01…CI-04) were written before any edit, each naming its parent contracts
   and its own acceptance evidence.
2. Fixtures and specs were repaired in the order above; each repair was verified on the lane that
   had failed, and macOS/Windows lanes were treated as the arbiter for platform semantics.
3. The gate failures were repaired separately from the incident fixes, at `a882cda4`.
4. The stuck aggregate job was cancelled to release the concurrency group; the repaired lineage then
   ran, and the single red browser lane on `85b6799c` was recorded as a flake (identical code tree,
   no retries) once `ee07fcff` ran green.

## Follow-ups

| Action | Owner | Due / reopen condition | Linked work | Completion condition |
| --- | --- | --- | --- | --- |
| Keep CI-01…CI-04 verified | wave-3 CI orders | Reopen any order if a later lane on a shared tree contradicts its receipt | `tasks/work-orders.md#ci-01`…`#ci-04`; `tasks/todo.md` CI rows | The order's receipt cites an observed passing run per platform lane |
| Repair the unidentified `e2e-browser` failure if it recurs | next owner of the browser lane | Reopen on the next red `e2e-browser` with an identical code tree | [J4 — scheduled retry:0 flake lane](../../tasks/execution-wave-3.md#j4) (owner of first-attempt failures and flake attribution) | The failing spec is read from the run page and repaired with its own evidence; retries never mask it |
| Make local gates runnable before a CI push in this environment | environment owner | Reopen if a future head again reaches CI with unformatted or untypechecked new files | [T0.3 workspace guard](../../tasks/execution-cards-1.md#t0.3) + [workspace guide](../contributing-workspace.md) | A green local typecheck + prettier run is recorded in the push's receipt before CI is cited |
| Verify repaired-head runs exactly (no inferred green) | release owner | Every future closure | this template's release checklist | The run link names the same SHA as the closure statement |

## Raw proof

- Run [36986918261](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/36986918261)
  — incident head `dcebeb20`, four failing cases, aggregate `ci` failed.
- Run [37038239523](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37038239523)
  — `b8c74439`: repaired lanes green (`test (core)` 110941636677, `test-macos (core)` 110941636736,
  `test-windows (core)` 110941636849, `e2e-browser` 110941636766); `typecheck` and `style (prettier)`
  red.
- Run [37040347326](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37040347326)
  — `a882cda4`: created, never picked up (queued aggregate job 110948311260 later cancelled).
- Run [37047995122](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37047995122)
  — `85b6799c`: 19/20, `e2e-browser` 110974077981 red.
- Run [37049972446](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37049972446)
  — `ee07fcff`: 21/21 green (`e2e-browser` 110980641658, `typecheck` 110980641451); `Skill Integrity`
  37049972427 green.
- `docs/audits/ci-repair-2026-10-02.md` — the lane-by-lane repair receipt this example cites.

## Rollback

- Each repair is independently revertible per file (`findings-store.test.ts`;
  `code-graph-watcher.ts` + test; `cockpit-telemetry.spec.mjs`; `llm-errors.spec.mjs` +
  `mock-llm.mjs`; the `a882cda4` assertion and formatting). The release owner decides if a
  post-merge contradiction requires a revert instead of a forward fix.

## Acceptance evidence

- The four platform/browser lanes pass on `b8c74439` (run 37038239523) and again on `85b6799c`
  (run 37047995122); the exact-candidate closure is run 37049972446 on `ee07fcff` — 21/21 jobs.
- `tasks/todo.md` records CI-01…CI-04 as VERIFIED against run 37038239523 with the gate repair
  receipt at `a882cda4`; this example adds no new verification and does not restate a lane as green
  from a different SHA.
- Reopen condition: a red lane with the same code tree, or any lane contradicting the receipts
  above, reopens the affected order.
