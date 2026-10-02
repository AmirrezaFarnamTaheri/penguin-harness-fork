# Dispatch orders and immediate priorities

This file turns [todo.md](todo.md) into concrete assignments. Re-evaluate priorities after a
completed package, changed dependency, new CI result, or user correction. All five phases may
run concurrently under the ownership and dependency rules in [plan.md](plan.md).

## Current release incident

Observed on 2026-10-02: PR #13 head `dcebeb20adb0aa0e246016a264eda11b67dea38d`,
[CI run 36986918261](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/36986918261)
completed with failure. Prettier, typecheck, build, audit, Ubuntu core/server, all server/rest
platform lanes, web/CLI, installer and runtime lanes passed. The four failing cases below are
the first repair orders. The aggregate `ci` job failed because its required lanes failed.

<a id="ci-01"></a>

## CI-01 — Findings denied-I/O classification on macOS and Windows

**Parent contracts:** R2c, R11. **Owner boundary:** one worker owns the store failure fixture;
production edits, if reproduced, remain with the findings persistence owner.

1. <a id="ci-01.1"></a>**CI-01.1:** inspect `packages/core/test/knowledge/findings-store.test.ts`, especially
   `fails closed when reading or quarantining is denied`, and the actual read/quarantine calls
   in `packages/core/src/knowledge/store.ts`. Record which injected operation and error code each
   platform executes. CI at line 227 expected `unreadable` and received `corrupt`.
2. <a id="ci-01.2"></a>**CI-01.2:** isolate denied read from successfully read corrupt content and from denied
   quarantine. Give each branch its own fixture and exact expected recovery reason; confirm
   whether the cause is test injection, platform I/O behavior, or production classification.
3. <a id="ci-01.3"></a>**CI-01.3:** repair the reproduced cause while preserving fail-closed writes, original bytes,
   raw export behavior, and audited recovery. Prove no denied operation returns mutation success.
4. <a id="ci-01.4"></a>**CI-01.4:** attach focused evidence and the macOS/Windows core job receipts on the candidate
   SHA. Keep R2c/R11 open until their other criteria also pass.

**Done:** the two platform lanes pass this case with distinct, meaningful failure branches;
changing the expected string alone is insufficient without the I/O-path proof.
**Rollback:** independently revert the fixture/production repair; retain the branch adjudication.

<a id="ci-02"></a>

## CI-02 — Nested-directory watcher fallback on macOS

**Parent contracts:** R6, codegraph resource discipline. **Owner boundary:** watcher source and
`packages/core/test/code-graph-watcher.test.ts`; no concurrent edits to those files.

1. <a id="ci-02.1"></a>**CI-02.1:** trace the non-recursive fallback's directory registration, file-change callback,
   debounce, invalidation, and disposal. The named nested-directory observation case timed out
   in `waitFor` after 4,000 ms on macOS; cite its source at the candidate revision.
2. <a id="ci-02.2"></a>**CI-02.2:** prove the watcher is subscribed before the fixture mutation. Distinguish missing
   subscription/event from a legitimate bounded debounce; inspect platform event semantics.
3. <a id="ci-02.3"></a>**CI-02.3:** repair the lost registration/event or deterministic test synchronization, as
   indicated by the reproducer. Preserve single-flight scans, watcher closes, capped caches,
   subdirectory coverage and disposal/cancellation behavior.
4. <a id="ci-02.4"></a>**CI-02.4:** verify the focused watcher suite and macOS core lane. Record why any timeout change
   matches an observed contract rather than hiding lost events.

**Done:** an actual nested-file change invalidates the graph in the fallback mode; cleanup
closes every watcher created by the case. **Rollback:** revert this watcher slice independently.

<a id="ci-03"></a>

## CI-03 — Quota retry countdown and retry-now browser flow

**Parent contracts:** A3, A4; user-visible retry recovery.
**Owner boundary:** `packages/web/e2e/llm-errors.spec.mjs` and its own mock scenario; coordinate
mock-file ownership before editing `packages/web/e2e/mock-llm.mjs`.

1. <a id="ci-03.1"></a>**CI-03.1:** capture the request-end `attempt`/`retry_in_ms` sequence, browser arrival times,
   reconnect-line state, and mock request count. The attempt-2 countdown locator at line 92 is
   absent at failure; the local focused run also failed after the recovery answer arrived.
2. <a id="ci-03.2"></a>**CI-03.2:** trace the engine budget through `ReconnectItem` and `ReconnectLine`. Determine
   whether the countdown is never rendered, rendered with a different contract, or missed by
   test synchronization. Record this before editing source or expectations.
3. <a id="ci-03.3"></a>**CI-03.3:** implement the demonstrated UI/state fix or stable synchronization with the real
   retry event. Retain one visible line per ladder, a decreasing countdown, working retry-now,
   and the final recovered answer. Use the policy's announced jitter; retain bounded delay checks.
4. <a id="ci-03.4"></a>**CI-03.4:** prove retry-now sends before the scheduled wait expires, preserve both retryable
   trace records/provider detail, and prove the composer remains usable with no abort record.

**Done:** the complete browser interaction passes in the full E2E lane and focused replay.
The previous speculative locator-order change was reverted and supplies no completion evidence.
**Rollback:** revert one test/UI slice; preserve trace compatibility and the policy budget.

<a id="ci-04"></a>

## CI-04 — Cockpit disconnected fallback and unmount cleanup

**Parent contracts:** E1, E3/E4 composition; cockpit HTTP/WS transport lifecycle.
**Owner boundary:** `packages/web/e2e/cockpit-telemetry.spec.mjs` and the traced telemetry owner;
coordinate shared cockpit state files with the protocol worker.

1. <a id="ci-04.1"></a>**CI-04.1:** inspect `disconnected fallback polls repeatedly and stops after unmount`.
   CI at line 297 expected transport `http` but received `ws`. Map the disconnect trigger,
   reconnect timer, HTTP fallback activation and transport indicator transitions.
2. <a id="ci-04.2"></a>**CI-04.2:** distinguish an unperformed socket disconnect from an actual fallback bug. Make
   the fixture deterministically establish the disconnected state before asserting HTTP mode.
3. <a id="ci-04.3"></a>**CI-04.3:** preserve repeated bounded polling during the outage, transition back to WS after
   real recovery, and cancel polls/listeners/timers on unmount. Prove no post-unmount request.
4. <a id="ci-04.4"></a>**CI-04.4:** record focused and full browser-job results on the candidate SHA; document the
   observed timing boundaries and transport state, rather than treating an immediate read as a wait.

**Done:** repeated fallback polls are observed and then cease after unmount; the indicator agrees
with the real transport. **Rollback:** revert the transport lifecycle slice independently.

## Parallel dispatch after assigning the incident owners

These are candidate streams, not declarations that their code is missing. Inspect the current
implementation and choose the highest-ROI ready package within each stream.

| Phase | Next valuable packages                                                             | Entry/exit constraint                                                             |
| ----- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R     | R2c/R11 denied-I/O repair; R1/R2/R4/R5/R8 acceptance reconciliation                | Persistence/lifecycle owners coordinate; preserve distinct scopes                 |
| 1     | F1/F3/F6, G5, J11 receipt and integration gaps                                     | Reuse shipped/local work; resolve the remaining criterion before expanding scope  |
| 2     | I1 trace/export routing; E6/E9 contract audit; E2 adjudication; B1 acceptance      | Keep one shared error/redaction/recall contract and complete actual consumers     |
| 3     | D7/H7 acceptance, D6 snapshot boundary; D1/D2 baseline; C1 scope-aware flow        | D10 promotion waits for measured gates; design/fixtures can start independently   |
| 4     | K14a permission adapter note; K16a compatibility mapping; A7/A8 baseline contracts | Specific prerequisites govern integration; existing controls remain authoritative |

With four available agent slots, one coordinator and three disjoint work owners are the default
dispatch shape. Reassign a freed slot across phases after its receipt is integrated. Keep all
five queues visible; use prerequisite bundles instead of forcing one worker into every phase.

## Priority decision record

Before dispatch, record each ready candidate's benefit, risk reduction, dependencies unlocked,
confidence in that estimate, effort including prerequisites, and files held by another owner.
Use ordinal points 1–5 for benefit/risk/effort and 0–1 for confidence; the score is
`(benefit + risk reduction + dependencies unlocked) × confidence / total effort`.
The points are planning estimates with a reason, not measured product outcomes. Active data loss,
credential disclosure, accepted-but-unexecuted actions and release failures take priority over
cosmetic or speculative work regardless of a noisy score. Break ties by more unlocked tasks,
smaller ownership boundary, then lower task ID.

Count the entire prerequisite bundle when scoring a blocked high-value task. Implement a
lower-ROI dependency first when it is the cheapest path to the higher-value outcome. A ready
package must have an owned file boundary, available prerequisite contract, and observable exit
criterion. If it lacks one, dispatch its bounded discovery package first and record the result.
