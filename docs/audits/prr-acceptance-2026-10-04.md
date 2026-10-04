# PRR-01–05 acceptance — 2026-10-04

## Scope

Phase R / release repair work orders PRR-01 through PRR-05, all five packages. No package is
remaining in this slice.

| Order | Repair | New suite |
| --- | --- | --- |
| PRR-01 | Session deletion is honest about unresolved cleanup | `packages/core/test/prr-01-swarm-handler-tracking.test.ts`, `packages/server/test/prr-01-session-deletion-honesty.test.ts` |
| PRR-02 | Credential masking for incomplete JSON trace tails | `packages/core/test/prr-02-credential-tail-masking.test.ts` |
| PRR-03 | Preserve low-disk refusal when override persistence fails | `packages/core/test/prr-03-04-pressure-override-authority.test.ts` |
| PRR-04 | Serialize durable, single-use pressure overrides | `packages/core/test/prr-03-04-pressure-override-authority.test.ts` |
| PRR-05 | Validate current process-group ownership | `packages/core/test/prr-05-guardian-ownership.test.ts`, plus a platform-contract correction in `packages/core/test/parent-death-guardian.test.ts` |

The repairs themselves were already implemented on this branch before this slice. What this slice
adds is the acceptance evidence the 2026-10-04 [review](open-pr-review-2026-10-04.md) recorded as
outstanding: no new test suite had been written or run for any of the five.

## Baseline

- Branch `codex/pr-15-review-fixes`, HEAD `ba7f17f7f`, clean tree at start.
- Reviewed PR #15 head `9f589c721a7cf09c9fb7ec116319161e76218f7c` is the repair baseline.
- Windows 11 Pro 10.0.26200, Node v26.1.0, pnpm 11.18.0 (at `~/AppData/Roaming/npm/pnpm.cmd`),
  vitest 4.1.11, tsup for the core build.

## Change

Tests, plus one gap the acceptance gates closed in product source.

**Product source changed in exactly one place, and not in any of the five repairs.**
`packages/web/src/lib/strings-en.ts` and `strings-zh.ts` gained `errors.byCode.session_cleanup_pending`
and `errors.byCode.session_cleanup_failed`. The PRR-01 repair returns those two codes, and
`check:i18n` requires every server error code to have a message in both languages — so the repair
as it stood would have failed the i18n gate. Without an entry the web client falls back to a
generic internal-error string, which is precisely the false-success message F1 was about removing.
Both languages describe the retry, not the failure.

**The five repairs themselves are untouched.** `git diff --stat -- packages/core/src packages/server/src`
is empty, and every product file was restored byte-for-byte from a copy taken before each mutation.
Other files changed:

- `packages/core/test/parent-death-guardian.test.ts` — the manager-wiring case asserted the pid
  file is populated on every platform. PRR-05 made `refreshGuardian` platform-gated alongside
  `guardSession`, so on win32 (where `guardianSupported()` is false and the documented gap is the
  Job Object) the case now asserts the platform's actual contract instead: no watchdog is started,
  no pid file is written, nothing is published to sweep. Without this the repair had silently
  regressed the Windows core lane. Its `afterEach` also gained `maxRetries`/`retryDelay`, because
  the case now completes on Windows instead of failing early and leaking the spawned command, and
  the killed child can still hold the scratchpad when removal starts.
- The workspace's core snapshot was rebuilt (below). That is generated output, not source.

## Environment finding — every server-level test had been blind to all five repairs

`packages/server` resolves `@prismshadow/penguin-core` through a pnpm **injected snapshot**, not
the workspace source. The snapshot's `dist/` was built on 2026-10-02 and contained none of the five
repairs. The first server run failed with

```
TypeError: runtime.coordinator.abortTasksForSession is not a function
```

which reads like a product defect but is the stale snapshot: the method exists in core source and in
`packages/core/dist`, just not in the copy the server imports.

Neither `tsup` nor `pnpm install --offline --frozen-lockfile` refreshes it — the install printed
"Already up to date" in 395 ms and left the snapshot stale. The step that works, and the one
`syncInjectedDepsAfterScripts: [build]` exists for, is building core *through pnpm*:

```
"$APPDATA/npm/pnpm.cmd" --filter @prismshadow/penguin-core build
```

After that the snapshot carries `abortTasksForSession`, `json_credential_string`,
`write_pressure_override_unavailable` and `GUARDIAN_OWNER_ENV`. **Any server-side or web-side
acceptance of these five repairs before this point would have been vacuous**, and the same trap
applies to every future cross-package change until the candidate is built the same way.

## Acceptance

PRR-01 — Session deletion after bounded cancellation

1. Raw handler completion tracked independently of the executor race — proved. `settled` stays
   pending past a 20 ms step deadline and the 100 ms grace window while a handler that ignores its
   abort signal is still running, and resolves only when that handler returns.
2. Cleanup state retained across retries; failed disposal retried without forgetting the runtime —
   proved. `hasPendingSessionCleanup` is true while unresolved; a second `beginSessionDeletion`
   after `dispose-failed` re-runs `dispose` (attempts 1 → 2).
3. Typed 503 on unresolved cleanup, with row/files/guard retained — proved. A handler outlasting the
   route's 5 s budget returns 503 `session_cleanup_pending`, the scratchpad file is still on disk and
   the Session is still listed; a retry after the handler finishes returns 204 and the file is gone.
4. Pending outcomes survive bounded history eviction; shutdown includes retained runtimes — proved.
   40 unrelated Sessions churn the 32-slot outcome history and the retained one is still reported;
   shutdown retries a retained runtime's failed disposal.
5. Cooperative cancellation, uncooperative timeout, late settlement, disposal retry, recreation
   refusal — proved. Recreating a Session under an unresolved guard is refused with 409; after
   `endSessionDeletion` it works again. Cleanup writes do not recreate removed files.

PRR-02 — Credential masking for incomplete JSON trace tails

1. Sensitive JSON field names recognised through the shared sensitive-key policy — proved, including
   an escaped name (`api\u004bey`) that only decodes to `apiKey` via the shared normaliser.
2. Complete values, short opaque credentials, escaped field names, values cut at EOF, and a tail
   ending on a trailing escape — proved. Every case asserts the *sentinel* is gone plus a control
   proving the same secret under an ordinary field name survives, so the field-name rule and not a
   vendor token pattern is what fired. The short sentinel is under the generic rule's 8-character
   bound, so it can only be caught by the field-name rule.
3. Ordinary fields and valid structured rendering preserved; no raw fallback bytes — proved. A
   complete credential record still parses as JSON with only the secret replaced; ordinary lines are
   byte-identical; a torn line still goes through the text rules.
4. Same sentinel matrix on the read and download paths — proved. `redactTraceContent` is the single
   implementation behind `TraceService.readFileRaw`, which serves both.

PRR-03 — Preserve low-disk refusal when override persistence fails

1. A valid below-50-MiB measurement stays distinct from an unavailable probe — proved.
2. Grant/consume read, lock or write failure is unavailable override authority — proved with real
   faults, not stubs: ledger path under a regular file (ENOTDIR), corrupt JSON, and a read-only
   ledger whose atomic replacement fails (EPERM).
3. Block preserved with measured bytes and a typed diagnostic; no false durable consumption —
   proved. `signal: write_pressure_override_unavailable`, `freeBytes` is the real measurement, and
   the ledger on disk still shows the grant unconsumed after the failed consume.
4. ENOSPC/EACCES/corrupt refusal; ordinary unavailable-probe warnings and exemptions preserved —
   proved. A `null` reading still warns `write_pressure_probe_unavailable` with `freeBytes: null`,
   and the archive refuses both producers while leaving the destination untouched.

PRR-04 — Serialized durable single-use overrides

1. Canonical store root; nonplain and symlinked authority rejected — proved (directory in the
   ledger's place, and a symlink via a Windows junction, since `symlink(...,'file')` needs
   elevation here).
2. Reload → validate → mutate → atomic save under one lock across instances — proved by the
   concurrency cases below, plus canonical-path resolution so `dir/./file` and `dir/file` serialize
   together.
3. Globally unique override ids with trusted binding — proved. 25 sequential grants across
   per-request store instances produce 25 distinct UUIDs.
4. Fail closed on unreadable/malformed authority; cached grants discarded after failure — proved.
   Corrupt, wrong-schema and duplicate-record ledgers all refuse; after a failed save the store's
   cache is empty and the next call rejects rather than admitting.
5. Concurrent grant preservation, exactly one consumption, no resurrection, restart, failed-save
   preservation — proved. Two concurrent grants both survive; five concurrent consumers yield
   exactly one; a grant saving concurrently cannot un-consume an unrelated record; a new store
   reads prior grants from disk.

PRR-05 — Validate current process-group ownership

1. Random ownership nonce on spawned groups, inherited by descendants — covered on POSIX by the
   real-process case; on this host the env-var contract is pinned in the source and the record
   format is exercised directly.
2. Signed group records persisted atomically, refreshed on registered and pending exits — proved
   for the record format: `pid:nonce` lines, whole-generation replacement, no `.tmp` residue.
3. Surviving owned descendants retained, dead groups dropped — POSIX-gated; the manager-side
   reconciliation is exercised by the existing E10.1 wiring suite.
4. Ownership proved from current group members before any negative-PGID signal; unsigned and
   unprovable groups refused; no bare-PID fallback — proved. The signed-line pattern is pinned, the
   member-ownership check is pinned, and every `process.kill(` call in the program is enumerated and
   asserted to be either the group-form SIGKILL or a signal-0 liveness probe.
5. Recycled unrelated groups, surviving descendants, ordinary exit/kill cleanup, parent death —
   POSIX-gated (`skipIf(!guardianSupported())`); Windows keeps the documented Job Object gap.

A property worth recording: a record written **without** a nonce is dropped entirely by
`parseGuardedPids` rather than published as an unprovable group. The guarded-process list and the
shipped guardian therefore agree on fail-closed. (Separately, an oversized pid such as
`99999999999999999999` still passes the `Number.isInteger(pid) && pid > 1` filter; that filter is
unchanged by this repair and such a pid cannot resolve to a live group, so no signal is sent. Noted,
not changed — outside PRR-05's scope.)

## Verification

Exact commands, run from the package directory:

| Command | Result |
| --- | --- |
| `packages/core: vitest run test/prr-01… test/prr-02… test/prr-03-04… test/prr-05… test/parent-death-guardian.test.ts` | 63 passed, 4 skipped (67), stable over 3 consecutive runs |
| `packages/server: vitest run test/prr-01… test/session-manager.test.ts test/session-delete-scratchpad.test.ts test/session-processes.test.ts test/pressure-override-route.test.ts` | 68 passed (68), stable over 2 consecutive runs |
| `packages/core: vitest run test/credential-redactor.test.ts test/redaction-completions.test.ts test/prr-02…` | 43 passed (43) |
| `packages/core: vitest run test/write-pressure-policy.test.ts test/write-pressure-boundary.test.ts test/prr-03-04…` | 67 passed (67) |
| `packages/core: vitest run test/shell-guardian.test.ts test/agent/shell-guardian-evasion.test.ts test/prr-05… test/parent-death-guardian.test.ts` | 113 passed, 4 skipped (117) |
| `packages/core: tsc --noEmit -p tsconfig.json` | clean |
| `packages/server: tsc --noEmit -p tsconfig.json` (after `gen:ifaces`, which reported the catalog unchanged) | clean |
| `packages/web: tsc --noEmit -p tsconfig.json` | clean |
| `node scripts/check-i18n.mjs` | passed (en ↔ zh) |
| `packages/web: vitest run test/i18n-parity.test.ts` | 2 passed |
| `node scripts/check-doc-claims.mjs` | passed |
| `oxlint --deny-warnings packages/core/test packages/server/test` | 0 warnings, 0 errors over 477 files |
| `prettier --check` on every touched file | clean |

The 4 skipped cases are the POSIX-only real-process guardian cases, skipped by the same
`skipIf(!guardianSupported())` gate the existing E10.1 suite uses.

### Revert-and-see

Every repair was mutated back to its pre-repair behaviour and the suites rerun, so each result
below shows the tests fail without the repair rather than merely passing with it.

| Repair | Mutation | Red |
| --- | --- | --- |
| PRR-01 core | `settled` awaits the executor only | 2 / 5 |
| PRR-01 route | 503 throws reverted to warn-and-continue | 1 / 9 |
| PRR-01 runtime | retained entry and disposal retry removed | 5 / 9 |
| PRR-02 | `json_credential_string` rule made unmatchable | 7 / 13 |
| PRR-03 | consume-failure catch returns the probe-unavailable warning | 6 / 26 |
| PRR-04 | `withFileLock` removed from the transaction | 5 / 26 |
| PRR-05 | guardian's member-ownership check removed | 1 / 15 |
| PRR-05 | signed-line parser reverted to the lenient form | 4 / 15 |

Each mutation was reverted immediately and the working tree confirmed clean against HEAD before
the next one; the product sources carry no residue from this slice.

## CI

None. Nothing has been pushed: the working tree carrying these suites is local, and the candidate
CI gate for PR #15 remains open. Per the plan, VERIFIED here means complete *scoped* acceptance on
this recorded working tree; the required candidate run is still a shared closure gate, and the
POSIX-only PRR-05 cases have not executed anywhere.

## Compatibility

- `parseGuardedPids` still accepts the legacy bare-`pid` line form, so a pid file written by an
  older build stays readable; only the newly written format gains the nonce.
- The override ledger's on-disk shape is unchanged (`{schemaVersion: 1, records: [...]}`). PRR-04
  adds validation of that shape — a ledger with a foreign `schemaVersion` is now refused rather
  than parsed — so a ledger written by a future version is a refusal, not a silent empty store.
  Existing valid ledgers are unaffected; ids move from a per-instance counter to UUIDs, which is
  an internal identity with no external consumer.
- `writeGuardedPids` gains an optional third argument. Existing two-argument callers keep their
  behaviour, writing unsigned records, which both readers now drop rather than publish.
- Deletion now answers 503 `session_cleanup_pending` / `session_cleanup_failed` in situations that
  previously answered 204. That is the intended correction — a client that treated 204 as "gone"
  was told so while a handler could still write — and it is the one behaviour change in this slice
  visible outside the process. Both codes now carry localized messages in `en` and `zh`, which the
  repair was missing.

## Residual work

1. **Push and run candidate CI.** Until then none of this is certified on a SHA, and the POSIX
   PRR-05 real-process case (recycled group spared, owned group swept) has still never executed.
2. **Rebuild core through pnpm on any machine that verifies cross-package behaviour**, or the
   server/web suites will pass against pre-repair core. Recorded in the workspace run notes.
3. **SEC-01** remains GATED and untouched by this slice; the high desktop build-dependency
   advisory is still open.
4. **PRR-05's Windows gap** is unchanged and still explicit: the Job Object path is not implemented,
   so a command that strips the inherited `PENGUIN_GUARDIAN_OWNER` cannot be safely authorised for
   guardian signalling and is not covered by any test here.