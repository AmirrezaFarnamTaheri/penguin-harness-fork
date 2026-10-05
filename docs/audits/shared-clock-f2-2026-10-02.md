# F2 — Shared UI clock (2026-10-02)

A relative-time label that owns its own `setInterval` is a small thing that adds up: twenty running
cards meant twenty timers, a tab restored after ten minutes repainted everything one second later
with a number that had been wrong for ten minutes, and one cooldown countdown drifted because it
decremented per tick instead of reading a clock. This package gives the app one ticker.

## F2.1 — Inventory (deliverable)

Every timer in `packages/web/src` was classified. "Display ticker" means the interval exists to
repaint a *relative-time label*; "data poller" means it exists to fetch. Only display tickers are in
scope for migration — a poller's cadence is a network policy, not a clock reading.

| Site | Cadence | Kind | Semantics before | After |
| ---- | ------- | ---- | ---------------- | ----- |
| `features/chat/live-duration.tsx` | 1000 ms | display ticker | `Date.now()` into state, per component; cleared on unmount | shared clock, 1000 ms |
| `features/chat/chat-page.tsx` `SessionElapsed` | 1000 ms **while a Task runs** | display ticker | hand-patched re-anchor (`setNow(Date.now())` on entering the running state) because the first tick was a second away | shared clock with `enabled: taskOpen`; the clock's immediate notification is the re-anchor |
| `features/chat/message-item.tsx` `ReconnectLine` | 250 ms until the announced wait elapses | display ticker (bounded) | self-clearing interval; per-attempt re-anchor on `item.attempt` | shared clock with `enabled` + `resetKey: item.attempt`; unsubscribes itself once elapsed |
| `features/models/models-key-pools.tsx` | 1000 ms | display ticker | `Date.now()` into state; cooldown read the clock again during render | shared clock |
| `features/models/key-health-card.tsx` | 1000 ms while a cooldown is live | display ticker | **per-tick decrement** (`prev - 1000`), i.e. elapsed-by-accumulation: drifts while throttled, and does not converge after sleep | absolute deadline + shared clock reading |
| `features/company/calendar-page.tsx` | 60 000 ms | display ticker | `Date.now()` into state | shared clock, 60 s cadence (shares the same timer as the 1 s labels) |
| `features/consensus/mailbox-bureau.tsx` | 1000 ms unless the live feed supplies entries | display ticker | bumped a counter to force a re-render, then re-read `Date.now()` during that render (two different readings for one label) | shared clock value used for lease state and remaining seconds |
| `features/agent/use-cockpit-telemetry.ts` | backoff-scheduled | data poller | self-scheduling fetch with backoff | unchanged |
| `features/api-tracker/api-tracker-panel.tsx` | 5000 ms | data poller | auto-refresh fetch | unchanged |
| `features/chat/chat-page.tsx` (process poll) | `PROCESS_POLL_MS` | data poller | — | unchanged |
| `features/context/context-breakdown-page.tsx`, `dock/dock-terminal.ts`, `messaging/*`, `models/models-page.tsx` (OAuth poll), `schedules/schedule-panel.tsx`, `terminal/terminal-list.ts`, `lib/use-desktop-update.ts` | various | data pollers | — | unchanged |

Wall clock vs monotonic: the shared clock deliberately exposes **wall clock** (`Date.now()` epoch
ms). Elapsed is computed as `now - sinceMs` from server timestamps, so a timezone change — which does
not move epoch milliseconds — cannot affect a duration, and a backward clock correction is clamped by
`elapsedSince` instead of rendering `-3s`. Monotonic semantics were not adopted: the labels are
anchored to server timestamps in the same clock domain, and a monotonic clock would render them
against a different origin.

## F2.2 — The abstraction

`packages/web/src/lib/ui-clock.ts` (no React import — one timer per *page*, not per tree):

- `createUiClock({now, setIntervalFn, clearIntervalFn, documentRef})` → `{now, subscribe, elapsedSince, subscriberCount, activeTimerCount, dispose}`.
- **One timer, several cadences**: the interval runs at the smallest cadence any live subscriber
  asked for; each subscriber is only notified when *its* cadence has elapsed. A 60 s label and a
  1 s label share one timer.
- **Immediate first notification** on subscribe, so a first render is never stale — this is what the
  old chat-page code hand-patched.
- **Visibility wakeup**: `visibilitychange → visible` notifies every subscriber whose cadence has
  elapsed, so labels converge on resume rather than at the next boundary. While hidden the timer is
  left alone (the browser throttles it); second-guessing that is how a shared clock silently stops.
- **Last-subscriber cleanup**: the timer is cleared when the last subscriber leaves; repeated
  mount/unmount cycles leave zero timers.
- **Cadence floor** `MIN_CLOCK_CADENCE_MS = 250` — a shorter request is raised, not honoured into a
  busy loop.
- Restart only when the required cadence *changes*: a restart per subscribe would reset the interval
  phase and make N mounts produce N out-of-phase ticks.
- `sharedUiClock()` is the module-level instance (page-scoped), with
  `setSharedUiClockForTesting()` as the seam.

`packages/web/src/lib/use-ui-clock.ts` is the React binding: `useUiClock(intervalMs, {enabled,
resetKey})` returns the wall-clock reading. `enabled: false` unsubscribes entirely (the header's
elapsed chip ticks only while a Task runs); `resetKey` re-subscribes when the thing being timed
changes, which is how the per-attempt re-anchor is preserved.

## F2.3 — Migrated consumers

Seven inventoried display tickers, listed above. No formatting or localization code was touched:
`humanizeDurationLive`, `humanizeDuration`, `formatCooldown`, `formatCooldownTimer` and
`S.chat.reconnect` are called exactly as before. Where the old code carried a load-bearing comment
about its re-anchor (`SessionElapsed`, `ReconnectLine`), the replacement mechanism is named at the
same site rather than deleted.

Two behaviour notes, both deliberate and both improvements the card's acceptance names:

- `key-health-card` now shows a cooldown that *converges*: the report's `cooldownRemainingMs` is
  turned into an absolute deadline once, and the label is `deadline - now`. Decrementing per tick was
  wrong across throttling and sleep by construction.
- `key-health-card` and `ReconnectLine` no longer tick when there is nothing live to show.

One observation left unfixed on purpose: `models-key-pools` computes
`cooldownRemainingMs - (clock.now() - now)` — an elapsed-since-last-tick subtraction that is ≈0, so
its breakdown countdown barely moves. That arithmetic predates this package and changing it would
change displayed numbers; it is recorded here as a follow-up rather than silently altered. Its
*timer* is on the shared clock, which is what this card covers.

## F2.4 — Proof

`packages/web/test/ui-clock.test.ts` — 12 cases, all with injected clock/timers/visibility (the web
suite is node-environment by policy, so there is no fake-DOM dependency):

| Card negative | Case |
| ------------- | ---- |
| duplicate/orphan timers | 4 subscribers across 2 cadences → `activeTimerCount() === 1`; joining an existing cadence does not restart the timer |
| last unmount | 5 subscribe/unsubscribe cycles → timer count returns to 0, `setIntervalFn` registry empty |
| hidden tab | hidden + 10-minute wall-clock jump → no notifications; `visible` → immediate convergence with exactly the jumped delta |
| clock jump | backward 8 s → `elapsedSince` = 0 (never negative); forward 20 s → converges to the new reading |
| timezone change | epoch milliseconds unchanged → elapsed unchanged |
| duplicate mount | repeated subscribe/unsubscribe with self- and sibling-unsubscribe mid-iteration → no notification after removal |
| sub-minimum cadence | 10 ms request raised to 250 ms |
| source pins | no `setInterval(() => setNow(Date.now()))` anywhere in `src`; each of the seven inventoried views imports the hook; `ui-clock.ts` does not import React |

Verification commands:

```
cd packages/web
node ../../node_modules/vitest/vitest.mjs run test/ui-clock.test.ts test/format.test.ts \
  test/header-stats.test.ts            # 12 + the card's named suites, all green
node ../../node_modules/vitest/vitest.mjs run          # 210 files / 2578 tests passed
node ../../typescript/bin/tsc --noEmit -p packages/web/tsconfig.json   # clean
```

The two failures the migration first produced (`mailbox-bureau-live`, `cockpit-task-handoffs`, both
`react-dom/server` renders of the mailbox bureau) were a temporal-dead-zone read of the clock value
before its hook call — fixed by hoisting the call above its first use, which is also the correct hook
ordering. They are noted because the pre-existing tests rendered the *component*, not the source, and
caught a real ordering mistake: evidence that this change is covered by the existing suite.

## Compatibility

- No public prop, string, or format changed; no consumer of `LiveDuration` was touched.
- `setInterval` still runs at the same effective cadence per label, so no visual timing change.
- The clock is page-scoped state, not React state: two React roots (the app and a modal portal)
  share one timer, which is the point.
- Rollback: revert the seven consumer files to a local timer; `ui-clock.ts`/`use-ui-clock.ts` can
  stay unused without effect. The source pins in the test suite are the only thing that would then
  fail, deliberately.

## Residual work

- `features/models/key-health-card.tsx` reaches for `sharedUiClock().now()` when the report arrives
  to fix the deadline; that read is inside an effect, so it is the clock's current value rather than
  a render-time read. If a future package makes the shared clock React-context-provided, that call
  site moves with it.
- `models-key-pools`'s ≈0 countdown arithmetic (above) is left as observed, not changed.
- No monotonic-clock mode: the card's sleep/jump cases are covered in the wall-clock domain the
  labels are anchored to. If a label ever needs to survive a *user* clock change without moving,
  that is a new card.
