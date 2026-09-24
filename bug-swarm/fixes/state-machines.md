# Bug Swarm — State Machines Fixer Log

Owner: fixer (state-machines). Files touched: the 9 listed below only (source + their tests).
Brief: `bug-swarm/findings/core-agent.md` (records 3–11, 13).

Every fix below was **differentially verified**: the source file was reverted to its pre-fix
state and its test file re-run, and each new test *failed* without the fix and passes with it
(compactor included, after the test was corrected — see note on #2). Full suite and core
typecheck results are at the bottom.

| # | File | Bug | Fix (one line) | Test added | Before → After |
|---|------|-----|---------------|-----------|----------------|
| 1 | agent/task-watchdog.ts | health *reads* flipped the watchdog terminal | `checkHealth()` is now a pure read; only `heartbeat()` persists the terminal transition | test/task-watchdog.test.ts (new, 3 tests) | polling `isHealthy()` aborted an otherwise-healthy run and wedged it terminal → health checks cannot mutate state; only heartbeats terminate |
| 2 | agent/context-compactor.ts | the folded summary (`role: "user"`) was countable as a turn | tag summaries with a `compaction-summary-` id prefix and skip them in `recentTurnStart` | test/context-compactor.test.ts (+2 tests) | a summary could occupy a `keepRecentTurns` slot, protecting only N−1 real turns → a summary never counts as a turn |
| 3 | agent/turn-ledger.ts | overflow eviction spliced the events of unacknowledged turns | `trimRecords()` refuses to evict past the projection watermark; `pruneStaleAcks()` drops absorbed acks | test/turn-ledger.test.ts (+2, 1 reworked) | blind splice orphaned turns from `pendingProjections` and stalled the watermark → unacked turns stay replayable; acked ones still compact |
| 4 | agent/quorum-consensus.ts | a settled topic could be refuted/re-endorsed; proposer could self-refute | endorse and refute both reject a `settled` standing; refute also rejects `refuted` and excludes the proposer | test/quorum-consensus.test.ts (+2 tests) | `settledAt` and `refutedAt` could both be set → settle and refute are mutually exclusive; no self-refutation |
| 5 | agent/kanban.ts | terminal and non-in_progress tasks could be re-claimed; review claims never reclaimed | refuse to claim terminal tasks; live-lease guard in any state; reclaim expired claims in any non-terminal state, preserving the lane | test/kanban.test.ts (+2 tests) | a `done`/`failed`/`review` task could be handed a fresh lease and a dead reviewer's claim stuck forever → terminal tasks are unleasable; any expired claim is releasable |
| 6 | agent/mailbox.ts | `poll()` ignored the lease `pollAndLease()` enforces; broker resurrected per-subscriber state | `poll()` returns null while a lease holds; delivery accounting writes only while the subscriber is still registered | test/mailbox.test.ts (+2 tests) | mixing the two APIs double-processed a reserved message, and a delivery outliving its unsubscribe re-created dead bookkeeping → the lease fences both paths; death is final |
| 7 | internal/merge-queue.ts | producer count could go negative, hanging the consumer; a second consumer clobbered the first's wakeup | clamp deregister at zero and count underflows in `producerUnderflows`; FIFO waiter queue with `signalAll()` on close | test/internal/merge-queue.test.ts (new, 6 tests) | a double deregister drove `producers` below zero so `next()` awaited forever → underflow is clamped and surfaced; every waiter is woken exactly once |
| 8 | agent/swarm-coordinator.ts | shared AbortController + deadline race; catch path hard-coded `rounds: 0` | one controller per step; a grace window prefers the handler's real outcome; catch returns `rounds: currentRound` | test/swarm-coordinator.test.ts (+3 tests) | a step landing microseconds late was reported `timed_out` and one slow step aborted every step's in-flight work → the real outcome wins; failures report the round reached |
| 9 | agent/loop-detector.ts | cycle match keyed on tool name only; history window hard-coded to 20 | match `toolName` **and** `inputHash`; window sized `max(maxRepeats, maxCycleLength × 3)` | test/loop-detector.test.ts (+2 tests) | distinct-argument alternation was flagged as an infinite cycle and a configured long cycle could never fire → arguments are part of the key; the window fits the configured limits |

## Note on bug 2 (context-compactor)

The finding's mechanism is real but its reach was narrower than stated. `recentTurnStart` scans
the pool backwards and a compaction summary is only ever emitted at the *front* of the pool, so
the scan reaches it last: with fewer real turns than `keepRecentTurns` the scan returns 0 with or
without the summary in the count, and with enough real turns it stops before ever reaching it.
Differential verification on the front-positioned summary confirmed the fix was inert there —
the retention window does not shrink across repeated compaction, verified over three rounds.

The test added for #2 therefore places the summary *mid-list* — the case where counting it does
matter and where the fix is genuinely load-bearing. That test fails without the fix. The code
change is kept because it makes the turn count correct by construction instead of relying on the
positional invariant; the docstring now says so plainly.

## Verification

- **Per-file**: each of the 9 test files passes individually.
- **Differential**: reverting each source file to its pre-fix state makes exactly its new tests
  fail (1 watchdog: 3, 2 compactor: 1, 3 ledger: 1, 4 quorum: 2, 5 kanban: 2, 6 mailbox: 1,
  7 merge-queue: 3 — including the pre-fix hang, 8 swarm: 3, 9 loop-detector: 1). No test that
  passes with the fix passes without it.
- **Full core suite**: `node ../../node_modules/vitest/vitest.mjs run --passWithNoTests` —
  206 test files passed, 2 skipped; **3806 tests passed**, 29 skipped, 0 failed (~66s).
- **Core typecheck**: `tsc --noEmit -p packages/core/tsconfig.json` — **0 errors**, exit 0.
- Formatting: all touched files run through `prettier --write` (unchanged after).
