# F17 + C8 — Evidence-based offline posture and the offline read/write/recovery flow (2026-10-02)

Before this package the app had no shared notion of whether its own server was reachable. A failed
request surfaced in whichever page made it, `navigator.onLine` was never consulted, and nothing in
the product distinguished three different facts: the device has no network link, the local server
is not answering, and one request just failed. F17 asks for a posture built from evidence; C8 asks
for the cached-chat behaviour that posture is allowed to claim.

## Scope

| Item | Surface |
| ---- | ------- |
| F17.1 posture + bounded probe | `packages/web/src/lib/connectivity.ts` (pure reducer + monitor) |
| F17.1/F17.2 provider | `packages/web/src/state/connectivity.tsx` (one probe, one posture, app-wide) |
| F17.2 rendering | `packages/web/src/components/layout/connectivity-banner.tsx`, mounted in `app-layout.tsx`, wrapped in `app.tsx` |
| F17.2 copy | `connectivity` section in `packages/web/src/lib/strings-en.ts` / `strings-zh.ts` |
| Unit evidence | `packages/web/test/connectivity.test.ts` (13 cases) |
| C8 flow | `packages/web/e2e/offline-recovery.spec.mjs` (3 tests) |

## C8.1 — What the "cache" actually is, and what a write does

**There is no client-side message store.** No IndexedDB, no localStorage transcript, no service
worker: the rendered conversation lives in React state for the tab's lifetime. That settles both
questions the card poses:

- *Cached content* = the conversation already rendered in an open tab. It survives any posture,
  and the app never replaces it with a spinner, an empty state, or an error card. This is the only
  availability claim the product can honestly make, and it is exactly what the banner copy says.
- *Attempted writes* do not queue. A send is `POST /api/sessions/:id/tasks`; if it fails, it fails
  with the normal error path and no retry is scheduled behind the user's back. The banner
  therefore never says "your message will be sent later" — there is nothing that would make that
  true.

The four states the card names are modelled explicitly, and the boundary between them is evidence:

| State | Established by | Banner | Writes |
| ----- | -------------- | ------ | ------ |
| Browser offline | `offline` event / `navigator.onLine === false` | "device appears to be offline" | blocked |
| Local server unreachable | ≥ 2 consecutive probe failures **while the link is up** | "cannot reach the local server" | blocked |
| Reconnecting | one failure; or the link returned and no probe has confirmed the server | "reconnecting" (only after a real outage) | allowed (unless an outage is being verified) |
| Recovered | a probe actually succeeded | "reconnected" for 3 s, then nothing | allowed |

Two deliberate asymmetries, both asserted:

1. **A single failed request never shows a banner.** It increments a counter; the banner needs
   `FAILURE_THRESHOLD` (2) consecutive probe failures.
2. **A `browser online` event is not recovery.** It moves the posture to `reconnecting` and keeps
   writes blocked until a probe answers. Clearing the banner requires a real success — this is the
   card's "clear the banner only after real recovery, not a browser-online event alone".

Failures observed while the device is offline do not count toward the server's failure run: a
request that failed because there was no link is the link's doing, not the server's.

## F17.1 — Bounded probe

`createConnectivityMonitor` is the only place that touches the network, and every bound the card
names is real:

| Bound | Implementation |
| ----- | -------------- |
| Per-attempt timeout | `probeTimeoutMs` (default 2500) aborts the signal; a probe that never settles is a **failure with evidence**, not a hang |
| Cancellation | `stop()` aborts the in-flight attempt, clears its timeout, and drops every timer; a late result is ignored (asserted) |
| Capped retries | `maxAutoAttempts` (default 6) then the monitor waits for a real signal — no infinite loop |
| Backoff | `backoffMs(attempt)`, capped at 15 s |
| Rate-limited manual retry | one manual retry per `minManualRetryIntervalMs` (1 s); refused retries report `in-flight`/`rate-limited` |
| Healthy probing | every `healthyProbeIntervalMs` (30 s), so an outage is noticed without a user request failing first |

The probe itself is `GET /api/health` with `cache: "no-store"`. It is the reachability question and
nothing else: a page fetch could fail for unrelated reasons, and — deliberately — **any HTTP answer
counts as reachable, including 401**, because an expired session still proves the machine is
answering. Reporting "server unreachable" for a login problem would be its own false statement.

## F17.2 — Rendering, copy and rollback

- The banner lives in the app shell above `<main>` (not inside any page), renders `null` when the
  banner field is `none` (the common case costs no layout), and exposes
  `data-connectivity-posture` / `data-connectivity-banner` for the E2E assertions.
- Accessibility: `role="alert"` + `aria-live="assertive"` for the two failure postures,
  `role="status"` + `polite` for reconnecting/recovered; the retry control is a real `<button>`
  with an accessible name, a `title` carrying the reason when it is unavailable, and Enter/Space
  activation (asserted in the browser flow).
- Copy (en + zh, through the existing dictionaries) states what is true: content already loaded
  stays readable; sending is unavailable until the server answers. No copy promises delivery.
- **Rollback:** the banner is a read-only consumer of the provider. Removing it from
  `app-layout.tsx` hides the notice; the provider keeps running, and nothing about the cached
  conversation or the send path depends on it.

## C8.2/C8.3 — Browser flow and measurement

`packages/web/e2e/offline-recovery.spec.mjs`, three tests:

1. **offline: cached transcript stays readable, sends fail honestly, recovery is probe-proven.**
   Seeds a session through the API, renders a turn, captures `pageerror` for the whole run, counts
   `POST .../tasks` requests, then: `setOffline(true)` → measures the cached-render window
   (start = the offline event dispatch, end = the transcript text confirmed visible) and asserts
   **< 100 ms** on the same seeded state every run; `data-connectivity-banner="browser-offline"`;
   attempted write while offline adds at most one request and **no queued resend** fires over the
   next second; `setOffline(false)` with `**/api/**` aborted → the banner becomes
   `reconnecting`/`server-unreachable` and must **not** become `none`/`recovered`; the retry button
   is reachable and activatable by keyboard; `unroute` → the banner clears only after a real probe,
   and the transcript is still there. Ends by navigating away (unmount cancellation) and asserting
   **zero page errors**.
2. **no false alarm.** Healthy server → no banner rendered at all over 3 s; a single aborted
   `/api/projects/**` request changes nothing.
3. **offline reload.** With `**/api/**` aborted, a reload must not invent a cached conversation it
   does not have: the transcript marker and the composer are both absent (no false "you can send"
   state). When the API returns, the app reaches a usable state again without a hard reload, and
   the run reports no page errors.

## Verification

```
cd packages/web
node ../../node_modules/vitest/vitest.mjs run test/connectivity.test.ts   # 13 passed
node ../../node_modules/vitest/vitest.mjs run                            # 208 files, 2547 passed
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json    # clean
node --check e2e/offline-recovery.spec.mjs                              # syntax (browser run is CI's)
```

Mutations (each restored byte-identical afterwards, all red):

| Mutation | Intent | Cases that failed |
| -------- | ------ | ----------------- |
| Threshold drops to a single failure | transient failure becomes an outage | 3 |
| `browser-online` treated as recovery | banner clears without a probe | 2 |
| Failures counted while the device is offline | link failures blamed on the server | 1 |
| Writes blocked on the first transient failure | one hiccup disables sending | 1 |

Two bugs this package found in its own first draft, recorded because they are the kind that pass
review: the reducer's `clearRecoveredNotice` was deleted by a refactor and the resulting
`ReferenceError` inside the success path was caught by the monitor and reported as a *probe
failure* (a green-looking "unreachable" state from a code error); and `clearTimer` was calling
`clearTimeout(fn)` instead of `clearTimeout(handle)`, leaving a stale backoff timer alive after
`stop()`.

## CI

The browser receipt is CI's `e2e-browser` job (Playwright chromium cannot install in this sandbox —
ECONNRESET). Head `a392554f`; the run's verdict is recorded in
[ci-repair-2026-10-02.md](ci-repair-2026-10-02.md) once the runner picks it up.

## Residual work

- **No client-side transcript cache** is a product decision, not an oversight: the offline reload
  case asserts the honest consequence (nothing is shown) rather than building a cache to make the
  test prettier. Reopen condition: a desktop/mobile requirement for reading history without the
  server — that is a persistence feature with its own scope, not a connectivity fix.
- The probe is a 30 s heartbeat, so an outage that starts *between* beats is reported on the next
  failing user request or the next beat, whichever comes first. Acceptable for a local server;
  reopen if the product ever talks to a remote one.
