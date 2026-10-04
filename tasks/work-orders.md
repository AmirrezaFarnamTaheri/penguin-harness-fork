# Work orders — current delivery queue

Updated: 2026-10-04. Work branch: `codex/pr-15-review-fixes`.
Reviewed PR #15 head: `9f589c721a7cf09c9fb7ec116319161e76218f7c`.
The active request is: refresh documents first, fix reviewed defects, merge, then complete
Phase R and Waves 1–4. [Todo](todo.md) is the status authority; cards define full acceptance.

## Current release incident

PR #15 includes the changes in #13 and #14. Its reviewed head has green CI, but five defects
remain in the [2026-10-04 review](../docs/audits/open-pr-review-2026-10-04.md). All five repairs
are now accepted against the local working tree — see the
[PRR acceptance receipt](../docs/audits/prr-acceptance-2026-10-04.md) — but they are not yet
certified on a candidate SHA, because nothing has been pushed.
A separate high dependency advisory keeps SEC-01 open.

Deliver one corrected consolidated candidate; preserve stack history. Do not merge the earlier
failing heads independently. Review the changed source and exact candidate checks before merge.

Any verification of these repairs from the server or web package must rebuild core *through pnpm*
(`pnpm --filter @prismshadow/penguin-core build`). `packages/server` resolves core through a pnpm
injected snapshot, and neither `tsup` nor `pnpm install` refreshes it — a stale snapshot makes
every cross-package suite pass against pre-repair core while reporting a runtime error that reads
like a product defect.

## Documentation-first order

1. Rewrite plan, todo, work orders, and English/Chinese changelog summaries.
2. Preserve every original task ID, card criterion, selected contract, and dated receipt.
3. Remove superseded planning copies and replace inbound references with current cards or pinned history.
4. Check ID counts, checkbox/state agreement, local links/anchors, references to removed files,
   and formatting. This is document inspection, not runtime acceptance.
5. Record changed/removed files and evidence limits in the refresh receipt.
6. Resume the five repair orders below; update documents with actual results.

## Review repair orders

One integration owner holds the shared redactor, pressure store, Session deletion route/runtime,
swarm coordinator, and guardian. Never overwrite another owner's concurrent edits.

<a id="prr-01"></a>

### PRR-01 — Honest Session deletion after bounded cancellation

**Parents:** E10, E6. **Files:** core swarm coordinator; server Session runtime and deletion route.

1. Track raw handler completion independently of executor deadline races. Cancel owned queued
   and active work and retain the per-Session cancellation latch.
2. Abort the Session runtime before removing its files. Retain pending/failed cleanup state across
   deletion retries; retry failed disposal without forgetting the runtime.
3. Return typed 503 pending/failed errors when cleanup is unresolved. Retain row, files, and
   deletion guard; return deletion success only after confirmed cleanup.
4. Retain pending cleanup outcomes despite bounded history eviction. Shutdown must include
   removed runtimes still awaiting cleanup.
5. Accept cooperative cancellation, uncooperative handler timeout, late settlement, disposal
   rejection/retry, and recreation refusal. Confirm no cleanup writes recreate removed files.

**Local state:** accepted 2026-10-04; see [receipt](../docs/audits/prr-acceptance-2026-10-04.md).
**Rollback:** revert the coordinator/runtime/route slice together; retain defect evidence.

<a id="prr-02"></a>

### PRR-02 — Credential masking for incomplete JSON trace tails

**Parent:** I1. **Files:** shared credential redactor and its trace read/export consumers.

1. Recognize sensitive JSON field names through the shared sensitive-key policy.
2. Mask complete values, short opaque credentials, escaped field names, and a quoted value cut
   at EOF, including a trailing escape character.
3. Preserve ordinary fields and valid structured trace rendering. Do not expose raw fallback bytes.
4. Accept complete/incomplete read and download paths using the same sentinel matrix.

**Local state:** accepted 2026-10-04; see [receipt](../docs/audits/prr-acceptance-2026-10-04.md).
**Rollback:** revert the masking rule independently; keep disclosure finding open until repaired.

<a id="prr-03"></a>

### PRR-03 — Preserve low-disk refusal when override persistence fails

**Parent:** I7. **Files:** write-pressure policy and tool-output archive boundary.

1. Keep a valid below-50-MiB measurement distinct from unavailable probing.
2. Treat grant/consume read, lock, or write failure as unavailable override authority.
3. Return block with measured bytes and a typed diagnostic; never convert durable authorization
   failure into the archive's probe-unavailable warning.
4. Accept ENOSPC/EACCES/corrupt-store refusal and no false durable consumption acknowledgement.
   Preserve ordinary unavailable-probe warnings and named policy exemptions.

**Local state:** accepted 2026-10-04; see [receipt](../docs/audits/prr-acceptance-2026-10-04.md).
**Rollback:** revert the policy/boundary slice together.

<a id="prr-04"></a>

### PRR-04 — Serialize durable, single-use pressure overrides

**Parent:** I7. **Files:** pressure override store and authenticated grant/consume boundaries.

1. Canonicalize the store root and reject nonplain/symlink authority files.
2. Lock the complete reload → validate → mutate → atomic-save transaction across instances/processes.
3. Generate globally unique override IDs; retain trusted Session/producer/tool-call/volume binding.
4. Fail closed on unreadable/malformed authority. Discard cached grants after authority failure.
5. Accept concurrent grant preservation, exactly one consumption, no consumed-grant resurrection,
   restart behavior, corrupt ledger refusal, and failed-save state preservation.

**Local state:** accepted 2026-10-04; see [receipt](../docs/audits/prr-acceptance-2026-10-04.md).
**Rollback:** revert the store transaction slice independently without resetting durable records.

<a id="prr-05"></a>

### PRR-05 — Validate current process-group ownership

**Parent:** E10. **Files:** command Session manager and parent-death guardian; existing fixture contract.

1. Attach a random command ownership nonce to spawned POSIX groups and inherited descendants.
2. Persist signed group records atomically. Refresh on both registered and pending exits.
3. Retain surviving owned descendants after their group leader exits; drop dead groups.
4. On parent death, inspect current group members for the nonce before negative-PGID signalling.
   Reject unsigned/unprovable groups; never fall back to a bare PID.
5. Accept recycled unrelated groups, surviving owned descendants, ordinary exit/kill cleanup,
   and parent-death behavior. Keep the Windows Job Object gap explicit.

**Local state:** accepted 2026-10-04; see [receipt](../docs/audits/prr-acceptance-2026-10-04.md). Commands that strip the inherited
ownership environment cannot be safely authorized for guardian signalling; document that limit.
**Rollback:** revert the guardian/manager/fixture protocol slice together.

<a id="sec-01"></a>

## SEC-01 — Desktop build dependency audit gate

**Observed 2026-10-04:** `http-cache-semantics@4.2.0`, high
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
Both locked paths run through desktop `electron-builder > app-builder-lib > @electron/get >
got > cacheable-request`. The audit reports one high, zero critical.

1. <a id="sec-01.1"></a>Record the locked dependency paths, package classification, advisory, and
   current registry availability. **Done** — see the 2026-10-04 receipt below.
2. <a id="sec-01.2"></a>Prefer a published compatible patched transitive release. Record integrity
   and exact resolved paths; never pin a nonexistent release. **Contradicted 2026-10-04:** no
   patched release exists. `4.2.1` is still unpublished; `4.3.0` shipped 2026-10-04T02:56Z but
   does not contain the fix, and adopting it would silence the audit without remediating.
3. <a id="sec-01.3"></a>If unavailable, assess compatible builder/dependency replacement and actual
   caching behavior. Cross-major overrides require compatibility evidence, not an audit-only change.
   **Done** — no published builder line removes the chain; the vulnerable code is provably
   uninstantiated in this repository.
4. <a id="sec-01.4"></a>No suppression without explicit owner adjudication recording scope, expiry,
   risk, and reopen condition. Keep the release gate open while adjudication is absent.
   **Outstanding** — this is the only remaining decision, and it requires a named owner.
5. <a id="sec-01.5"></a>Close only after the high-severity audit is accepted and required desktop
   packaging checks pass on the candidate. **Not met** — `pnpm audit --audit-level high` exits 1.

**State:** GATED. No override or suppression applied. Only sec-01.4 remains, and it is an
ownership decision rather than an engineering one.

Current investigation: [2026-10-04 reachability receipt](../docs/audits/sec-01-http-cache-semantics-2026-10-04.md).
Historical investigation: [2026-10-03 receipt](../docs/audits/dependency-audit-2026-10-03.md);
its "no patched release published" statement is superseded by the 2026-10-04 registry recheck.
Rollback restores the compatible graph and leaves this gate visible.

## Earlier CI repairs — retained history

These orders are accepted at their recorded candidates. They are not current red lanes.
[Receipt](../docs/audits/ci-repair-2026-10-02.md) retains exact platform/job evidence.

<a id="ci-01"></a>
<a id="ci-01.1"></a><a id="ci-01.2"></a><a id="ci-01.3"></a><a id="ci-01.4"></a>

- **CI-01 / R2c/R11:** distinguish denied read, corrupt bytes, and denied quarantine; preserve
  fail-closed mutation. Run 37038239523's core platform lanes accepted the repair.

<a id="ci-02"></a>
<a id="ci-02.1"></a><a id="ci-02.2"></a><a id="ci-02.3"></a><a id="ci-02.4"></a>

- **CI-02 / R6:** nested-directory watcher fallback; retain event-driven state assertions and
  owned watcher cleanup. The 10-second removal bound was revalidated at run 37149941481.
  Reopen on a new missing event rather than increasing the wait automatically.

<a id="ci-03"></a>
<a id="ci-03.1"></a><a id="ci-03.2"></a><a id="ci-03.3"></a><a id="ci-03.4"></a>

- **CI-03 / A3/A4:** retry countdown and retry-now browser interaction accepted at run
  37038239523. Preserve the recovered answer, trace ladder, and usable composer.

<a id="ci-04"></a>
<a id="ci-04.1"></a><a id="ci-04.2"></a><a id="ci-04.3"></a><a id="ci-04.4"></a>

- **CI-04 / E1:** disconnected HTTP fallback and unmount cleanup accepted in that browser lane.
  Preserve repeated outage polling, WS recovery, and no post-unmount requests.

## Implementation queue after release repairs

| Phase | Next concrete work | Integration prerequisite |
| --- | --- | --- |
| R | Reconcile each R1/R2/R4/R5/R8/R11 acceptance criterion against current receipts | Scoped identity, durable authority, and recovery |
| 1 | Finish F1/F3/F6, G5, J11 consumer/receipt gaps | Existing foundation contracts and current claims |
| 2 | Accept I1/E6/E9, E2 adjudication, B1 and F18 consumer proof | Shared error, redaction, recall, and protocol contracts |
| 3 | D1/D2 baseline → D4 chain; C1 scoped findings flow; H4 configuration integration | Frozen quality/resource gates and accepted store/config contracts |
| 4 | K5 → K14a/b permission plane; K16a/b compatibility mapping; A7/A8 foundations | Existing controls stay authoritative; sensitive data uses I1 |

For an OPEN task, read its whole card and current source before deciding what code is absent.
Split a broad card into its existing numbered packages. Deliver working success, failure,
cancellation, cleanup, compatibility, and restart branches together at the real consumer.
No placeholder, silent defer, or exported-but-unconsumed helper closes a task.

## Priority decision record

Choose by benefit, risk reduction, dependencies unlocked, confidence, and total effort including
prerequisites. Record one selected package, actual file ownership, unmet contract, acceptance
artifact, and rollback before edits. Data loss, credential disclosure, false success, and release
failures take priority over cosmetic/speculative work. Re-evaluate after each accepted package.

Before merge record candidate SHA, CI run/jobs, audit disposition, and review repair acceptance.
After merge record main/PR states, then continue the remaining register. No work order alone
permits extra tests or external actions beyond the active human authorization.
