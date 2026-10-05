# Open PR review — 2026-10-04

## Repair follow-up

The user authorized repairs and merge after this review. The five findings have implementation
changes on `codex/pr-15-review-fixes`; CI and merge are pending at the time of this update.

- F1: Session deletion returns a named 503 and retains its guard/resources while work or disposal
  remains incomplete. Retained runtimes allow disposal retries. Swarm deletion tracks underlying
  handlers as well as the executor, including handlers that outlive a deadline race.
- F2: Known JSON credential string assignments are masked even when the tail ends inside a value
  or escape. This rule also covers short opaque values and encoded field names.
- F3: A durable override-consumption error preserves the measured block and records an explicit
  override-unavailable diagnostic.
- F4: Override mutations acquire the existing canonical filesystem transaction lock, reload
  authority under the lock, and persist before release. Invalid authority clears cached grants;
  new grant receipts use UUIDs.
- F5: Commands receive unique ownership nonces inherited by descendants. The guardian requires
  a current group member carrying that nonce before signalling a group, and refuses unverifiable
  ownership. Registered exits reconcile the guard; fully exited groups are removed while surviving
  descendant groups remain covered. PID-file publication uses an atomic replacement.

Existing guardian fixtures were adapted to the signed ownership protocol. No new test suites
were added or local suites run for this repair. CI must validate the pushed candidate before merge.
The original review below is preserved as the diagnosis, not a claim that its findings remain open.

## Original recommendation

Request changes. PR #15 has green CI, but the runtime issues below remain in its reviewed head.
PRs #13 and #14 also have failing checks. This is a local review; no review, comment, merge,
or branch change was submitted to GitHub.

## Reviewed revisions and CI

| PR                                                                          | Head                                       | Base                       | Latest observed checks             |
| --------------------------------------------------------------------------- | ------------------------------------------ | -------------------------- | ---------------------------------- |
| [#13](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/pull/13) | `09b36f788333393de48268939df99d57f5e580fa` | `main`                     | 20 success, 4 failure, 1 skipped   |
| [#14](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/pull/14) | `73ab5144bcaa2a5ba191acb551dfb6011cefbddf` | `codex/wave-1-2-hardening` | 14 success, 11 failure, 2 skipped  |
| [#15](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/pull/15) | `9f589c721a7cf09c9fb7ec116319161e76218f7c` | `main`                     | 25 success, 2 skipped; no failures |

Counts include aggregate checks and CodeRabbit. They describe observed results, not independent
certification. Heads were rechecked and unchanged during this review.

- [PR #13 CI](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37023730229):
  style, typecheck, browser e2e, and aggregate CI failed. The typecheck log identifies
  `test/code-graph-watcher.test.ts(265,20): TS2532`. Browser output includes missing page
  headings. Core/server platform suites passed at this revision.
- [PR #14 CI](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37079275599):
  style, server tests on Ubuntu/macOS/all Windows shards, Windows core/rest, browser e2e,
  and aggregate CI failed. Its separate audit check also failed. Style logs identify the
  deliberately malformed YAML fixtures being parsed by Prettier. Failure causes for the
  other lanes were not all established from logs in this review.
- [PR #15 CI](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37151015054):
  observed style, typecheck, platform tests, browser e2e, packaging, and aggregate CI passed.
  Its audit, build, and container checks also passed.

## Findings

### F1 — P1: Preserve Session resources when cancellation or disposal has not completed

Applies to #14 and #15. Location in #15:
[sessions.ts:735](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/packages/server/src/http/routes/sessions.ts#L735).

DELETE waits for swarm/Session work with a five-second race. If the timer wins, it only logs
a warning and continues. A `dispose-failed` outcome likewise only logs a warning. The route
then removes traces, scratchpad, and the Session row and returns 204. A handler still stopping
can continue writing after its resources and control surface have disappeared. The coordinator
also bounds handler waiting through a deadline/grace race; executor completion alone does not
prove a handler that ignored cancellation has stopped.

Required correction: retain the deleting state and recoverable resources until owned work is
confirmed stopped. Return an explicit bounded cleanup failure or pending outcome on timeout or
failed disposal. Completion must track the underlying handlers/processes, not just the outer
executor's race. Do not report successful deletion while cleanup is incomplete.

Acceptance case: hold a handler beyond the deletion deadline after abort, and separately reject
disposal. Neither case may return ordinary deletion success or remove resources the unfinished
work can still use. Completing cleanup must allow a later deletion to finish.

### F2 — P1: Redact credentials when a JSONL tail ends inside a quoted value

Applies to #14 and #15. Location in #15:
[credential-redactor.ts:90](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/packages/core/src/internal/credential-redactor.ts#L90).

The JSONL fallback at line 306 calls `redactCredentials` after JSON parsing fails. The generic
assignment pattern now accepts a quoted field name, but its quoted-value alternatives require
a closing quote. Its unquoted alternative excludes a leading quote. Therefore a tail such as
`{"apiKey":"opaque-example-secret` has no matching value alternative and retains the secret.
`TraceService.readFileRaw` applies this fallback to downloaded trace content, so a torn trace
can expose an opaque credential. The earlier complete-value/missing-brace fix does not cover
this different truncation boundary.

Required correction: redact known credential assignments through the end of an unterminated
quoted value, including escape boundaries. Keep ordinary unaffected lines unchanged.

Acceptance case: trace downloads with tails cut inside a credential value, inside an escape,
and immediately after the field separator must expose no credential prefix. Include short
opaque values that do not match a vendor token pattern.

### F3 — P1: Keep a known pressure block when override persistence fails

Applies to the production wiring in #15. Location:
[truncated-tool-output-archive.ts:795](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/packages/core/src/environment/truncated-tool-output-archive.ts#L795).

With a measured reading below 50 MiB, `evaluateWritePressure` calls `overrides.consume`.
Consumption saves its durable state; an ENOSPC/EACCES failure can reject that operation.
`admitWrite` catches every gate rejection and converts it to `blocked: false` with a
probe-unavailable warning. The probe actually succeeded and established a block; the failure
was recording authorization consumption. Archive writes are therefore attempted without a
durably consumed override, precisely under the disk-pressure conditions this feature handles.

Required correction: distinguish unavailable measurements from authorization-store failures.
A failed durable consume must preserve the known block and produce a distinct diagnostic.
Never describe a persistence failure as an unavailable pressure measurement.

Acceptance case: inject a valid low-space reading and a grant whose consumption save fails.
Both archive producers must refuse the write, leave destination content intact, and avoid
claiming successful override consumption.

### F4 — P2: Serialize durable override grant and consume transactions

Applies to the override implementation in #14 and its production use in #15. Location in #15:
[write-pressure-policy.ts:338](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/packages/core/src/internal/write-pressure-policy.ts#L338).

`grant` and `consume` each read the complete ledger, change an instance-local Map, and replace
the file without a shared transaction lock. The HTTP route creates a new store per request;
the live gate owns another store for that same path. A concurrent grant can load an unconsumed
record, let the gate consume/save it, then overwrite that consumption when saving its own
grant. The first grant becomes usable again. Concurrent grants can also discard each other's
records. Atomic file replacement prevents torn files, but does not serialize read/modify/write.

Required correction: lock by canonical ledger path across instances/processes, reload inside
the lock, then persist the mutation before releasing it. Reject unreadable/corrupt authority
instead of admitting stale cached grants. Generate durable unique override IDs; the per-instance
counter currently restarts for each route request.

Acceptance case: interleave grant/consume and two grants through separate store instances.
Every grant must survive unrelated updates, each grant must admit exactly one write, and the
ledger must never resurrect a consumed record or assign duplicate receipt identities.

### F5 — P2: Remove stale registered-command identities from the guardian

Applies to #14 and #15 on POSIX. Location in #15:
[session-manager.ts:387](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/packages/core/src/environment/tools/command/session-manager.ts#L387).

Registration removes a command from `pendingGuarded`. Its exit callback therefore no longer
refreshes the guardian through the conditional at line 372; the persistent exit listener
only notifies the UI. The registry retains exited rows, and `refreshGuardian` includes their
`session.pid` without checking terminal state. That getter retains the child's original PID.
Consequently the guardian can retain a dead group ID indefinitely. Removing the plain-PID
kill fallback reduced risk, but after OS reuse a new unrelated process group can have that
same numeric ID and be targeted by the guardian when the harness dies.

Required correction: reconcile guardian ownership on registered exits and preserve identities
only for groups still owned by the Session. Account for surviving descendants; simply dropping
every group when its leader exits would create a different orphan-process bug. Do not treat a
historical registry row as proof of current OS ownership.

Acceptance case: exit a registered command while retaining its UI row, then exercise guardian
reconciliation. A fully terminated group must leave the sweep set; a surviving owned descendant
must remain covered without allowing a reused unrelated group identity to be swept.

## Branch overlap and merge order

PR #15 contains PR #14's head as an ancestor: their merge base is exactly
`73ab5144bcaa2a5ba191acb551dfb6011cefbddf`. Relative to main, #15 changes 398 files,
including 142 package source files. Its title understates the accumulated scope. The delta
from #14 is 52 files, including CI repairs, Session cleanup, connectivity recovery, and I7.

Choose either sequential delivery (#13, then #14, then the remaining #15 delta) or a reviewed
consolidated #15. Update descriptions and dependencies before merging so reviewers can see
which accumulated changes are being accepted. Do not merge all three as independent features.
No PR was retargeted, closed, or merged during this review.

## Older comments that should not be repeated unchanged

Current #14/#15 source already handles queued-task cancellation, validates a supplied swarm
owner Session/project, removes the guardian's plain-PID kill fallback, releases never-registered
pending commands on exit, redacts credential-bearing trace keys, and treats failed archive
eviction honestly. Connectivity includes a slow recovery probe and monitor restart generation.
These corrections do not eliminate the distinct remaining cases in F1–F5.

## Repair follow-up — 2026-10-04

All five findings have local implementations on `codex/pr-15-review-fixes`:

- F1: retain raw swarm-handler completion and deletion cleanup ownership; return typed 503
  pending/failed responses, preserve files, retry disposal, and include retained runtimes at shutdown.
- F2: mask short and incomplete quoted JSON credential values, including trailing escapes.
- F3: preserve measured low-disk refusal when durable override authorization fails.
- F4: lock canonical reload/validate/mutate/save transactions, generate unique IDs, and discard
  cached authority on ledger failure.
- F5: atomically persist nonce-bound POSIX groups and inspect current members before signalling;
  preserve surviving owned descendants and refuse unprovable ownership.

The existing guardian parent-death fixture is adapted to the signed ownership protocol.

**Acceptance completed 2026-10-04** — see the
[PRR acceptance receipt](prr-acceptance-2026-10-04.md): 63 core cases (4 POSIX-only skipped) and 68
server cases, plus eight revert-and-see mutations confirming each suite fails without its repair.
Two things the acceptance surfaced:

- **PRR-05 had regressed the Windows core lane.** `refreshGuardian` became platform-gated, so on
  win32 the existing E10.1 wiring case no longer found a populated pid file. That case now asserts
  the platform's actual contract — no watchdog started, nothing published to sweep — instead of the
  POSIX behaviour, and its temp-dir cleanup gained retries.
- **Every server-level test had been running against a stale injected snapshot of core**, so none
  of these five repairs was reachable from the server package at all. Core must be rebuilt *through
  pnpm* (`pnpm --filter @prismshadow/penguin-core build`) before any cross-package verification;
  neither `tsup` nor `pnpm install` refreshes that snapshot.

Candidate CI remains pending — nothing has been pushed — and the POSIX-only real-process guardian
cases have not executed on any platform. Windows Job Object coverage and commands that strip the
inherited ownership environment remain explicit limits. Follow
[current work orders](../../tasks/work-orders.md#review-repair-orders).

## Method and limits

This was a risk-focused static review of all three open PRs' scope, pinned source, latest CI,
branch ancestry, and available review comments. It was not a line-by-line certification of all
398 files. Findings are source-derived failure paths; no new tests, builds, or dependency
installations were run. Acceptance cases above are follow-up requirements, not passing results.

CodeGraph was consulted for orientation. Remote PR source was read from pinned Git objects,
because the checkout/index differs from the later PR heads. Serena and context-mode tools were
not exposed in the current tool catalog; no tool configuration or index was changed.

Fetching PR refs succeeded, but automatic Git repack/commit-graph maintenance reported a full
disk. No destructive Git repair was attempted. The required workspace cleanup removed one
45-byte Playwright output directory after a report. Existing dist/target, user materials, and
the CodeGraph index were preserved.
