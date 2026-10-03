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
closes every watcher created by the case. **Status update (2026-10-03):** the 4,000 ms native
directory-removal wait timed out in run `37148746240`; it was widened to 10,000 ms while retaining
the event-driven state-transition assertion. Focused `code-graph-watcher.test.ts` passes 15/15,
and exact CI run `37149941481` passes the macOS core job `111281442461` and aggregate `ci`
`111283961443` (21/21 jobs). CI-02 is revalidated as VERIFIED; no production watcher code
changed. The earlier failure remains in the [follow-up receipt](../docs/audits/ci-repair-2026-10-02.md#reopened-ci-02). **Rollback:**
revert this watcher slice independently.

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

<a id="sec-01"></a>

## SEC-01 — Newly reported, unpatched `http-cache-semantics` advisory

**Detected:** 2026-10-03 during the requested all-wave refresh. At detection, the latest PR #15 CI
run `37146286795` had passed its required jobs on `ec20a0c1`, but the CI workflow does not run
`pnpm audit`; the full local audit is a separate release gate. The later exact candidate run
`37149941481` passed 21/21 CI jobs without changing dependency files, so it does not resolve this
finding.

1. <a id="sec-01.1"></a>Trace the current locked path and package classification. Both paths go
   through desktop `electron-builder` (`app-builder-lib` or `dmg-builder`) and then
   `@electron/get > got > cacheable-request > http-cache-semantics@4.2.0`; pnpm marks the finding
   `dev: true`, `optional: false`, `bundled: false`.
2. <a id="sec-01.2"></a>Check the advisory and package registry before proposing an override. The
   GitHub Advisory Database lists no patched release; pnpm's registry query reports 4.2.0 as
   latest and 4.2.1 as not found. Do not force a nonexistent version or change majors blindly.
3. <a id="sec-01.3"></a>Check compatible builder updates before proposing a lock change. Registry-listed
   `electron-builder@26.17.0` (within the current `^26.16.1` range) still selects
   `@electron/get@^3`; its `3.1.0` line retains `got@11 > cacheable-request`, while the
   `@electron/get@4` line also retains vulnerable `http-cache-semantics@^4.2.0`. `@electron/get@5.1.0`
   removes `got` but is outside the builder's declared range; a cross-major override is not
   accepted as a compatibility fix.
   Full evidence is in the [audit receipt](../docs/audits/dependency-audit-2026-10-03.md).
4. <a id="sec-01.4"></a>Keep the audit gate visible while investigating compatible removal. Any temporary
   suppression needs an explicit security/release-owner decision with scope, expiry, and a
   tracking/reopen condition; a suppressed finding is not a patched dependency.
5. <a id="sec-01.5"></a>After an upstream patch or accepted compatible replacement is available, record
   the resolved lockfile path, rerun the high-severity audit, and exercise the desktop package
   matrix before closing this order.

**Done:** the vulnerable path is gone or resolves to a published patched release, the audit
result is accepted, and desktop packaging remains compatible. **Current disposition:** GATED;
no override or suppression has been applied. **Rollback:** if the alternative breaks packaging,
restore the last known-compatible dependency graph and keep release blocked until a reviewed fix
or explicit time-bounded exception is accepted.

## Parallel dispatch after assigning the incident owners

These are candidate streams, not declarations that their code is missing. Inspect the current
implementation and choose the highest-ROI ready package within each stream.

| Phase     | Next valuable packages                                                             | Entry/exit constraint                                                              |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Operations | SEC-01 compatible remediation/adjudication; monitor CI-02 native watcher stability | No dependency suppression without explicit owner approval; re-open CI-02 on recurrence |
| R         | R2c/R11 acceptance reconciliation (quarantine-denied ingress tests now pass); R1/R2/R4/R5/R8 proof gaps | R11 defect-detection ledger and wider card criteria remain open; keep scopes distinct |
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
