# E2 — ACP eight-defect adjudication receipt (2026-10-02)

Eight historical defects were reported against `packages/core/src/kernel/acp.ts`
(793 lines) by the source audit referenced as `src §IV.8.2`. This receipt adjudicates each
one against the **current** code and tests, with a revert-and-see mutation for every row so
that a passing suite is not mistaken for coverage.

Baseline: `packages/core` at `9afb0f97`, Linux x64, Node v22.22.3, vitest 4.1.11.
Suite: `packages/core/test/acp-connection.test.ts` — 28 cases, grouped under eight
`// --- finding N` section comments, so each row's evidence is directly addressable.

## Verdict table

| # | Historical defect | Verdict | Current symbols | Named tests |
| - | ----------------- | ------- | --------------- | ----------- |
| 1 | Transport-error latch: a failed connection could never recover, and a replacement transport inherited the old failure | Confirmed (historical); repair present | `failTransport` (first cause kept, buffer dropped, pending rejected), `reattachTransport` (clears `failure`, bumps `generation`, counts `recoveries`, resets buffer/resync), generation-bound `writeLine`, `markTransportFailed` | `recovers end to end: fail, reattach a transport, serve again`; `gives in-flight requests a defined fate on reattach`; `records a transport the host already knows is dead`; `does not let a retired transport's late rejection fail its replacement` |
| 2 | Unbounded `lineBuffer` — a peer could grow memory without ever sending a delimiter | Confirmed; repair present | `maxFrameBytes` (8 MiB default), oversized-frame drop + `oversizedFrames` + `oversized-frame` diagnostic, resync to next newline, `maxResyncBytes` budget ×4, `maxFrameBytes` validation in the constructor | `enforces the frame bound at the boundary and resynchronises the stream`; `bounds an unterminated stream instead of growing the buffer`; `fails a stream that exceeds the resync budget, and recovers on reattach`; `refuses a frame limit that could not bound anything` |
| 3 | A response arriving after its request timed out vanished with no trace | Confirmed; repair present | `droppedLateResponses` + `late-response` diagnostic in `handleMessage` | `counts a response that arrives after its request timed out`; `reports every counted anomaly to the diagnostic sink` |
| 4 | Malformed input was swallowed with no record, and a handler's own `SyntaxError` was blamed on the peer | Confirmed; repair present | `dispatchLine` separates parse/normalisation failures from dispatch, counts `malformedFrames`, emits `malformed-frame`, never throws; handler errors become `-32603` responses | `counts malformed frames instead of swallowing them`; `contains valid JSON values that are not JSON-RPC objects`; `surfaces a handler's own SyntaxError instead of blaming the peer` |
| 5 | No write ordering; a failed write wedged the queue behind it; notification write errors were discarded | Confirmed; repair present | `writeTail` promise chain, generation binding per queued frame, tail swallows its own rejection, `notificationWriteFailures` + `notification-write-failed` diagnostic | `writes concurrent requests in the order they were issued`; `does not let a failed write wedge the frames queued behind it`; `does not move queued writes onto a replacement transport`; `makes a failed notification write observable without rejecting` |
| 6 | Notification handlers ran serially, so one slow handler stalled later frames in the same chunk | Confirmed; repair present | `handleChunk` dispatches without serialising, `Promise.allSettled` then rethrow-first; request handlers may issue outbound requests answered in the same chunk | `does not let a slow notification handler stall later frames in the same chunk`; `still lets a request handler be answered by a response in the same chunk` |
| 7 | Liveness either invented a protocol frame or reported a dead peer as healthy | Confirmed; repair present | `isHealthy` (open + activity clock + idle threshold, no probe), `whenIdle` (write tail + pending, re-checked in a loop) | `answers liveness from this end without putting anything new on the wire` |
| 8 | `dispose()` left a stale transport failure behind instead of reporting `closed` | Confirmed (observable half); repair present | `dispose` is terminal: state `closed`, `failure`/`lastFailureAt`/`lastFailureMessage` cleared, pending rejected with `AcpConnectionClosedError`, handlers cleared, nothing written to the peer | `dispose reports closed and stops the connection for good`; `dispose rejects in-flight requests and clears the idle wait` |

No row was refuted: every historical defect has a corresponding repair and at least one
dedicated test. Two documented pre-existing fixes are preserved and are not re-litigated
here: the protocol-safe `null` result for void handlers, and the bounded method census
(`keeps the protocol-safe null result for a void handler`, `keeps the method census bounded`).

## Revert-and-see evidence (per row)

Each mutation was applied to a working copy of `src/kernel/acp.ts`, the suite was run, and
the file was restored from a pristine copy. Observed failures:

| # | Mutation | Tests that failed |
| - | -------- | ----------------- |
| 1 | Keep the latched `failure` across `reattachTransport` | `recovers end to end…`; `does not let a failed write wedge the frames queued behind it` |
| 2 | Disable the `maxFrameBytes` branch in `handleChunk` | `enforces the frame bound…`; `bounds an unterminated stream…`; `fails a stream that exceeds the resync budget…` |
| 3 | Drop an unmatched response without counting or diagnosing it | `gives in-flight requests a defined fate on reattach…`; `counts a response that arrives after its request timed out`; `reports every counted anomaly to the diagnostic sink` |
| 4 | Remove the `malformedFrames` increment in `dispatchLine` | `counts malformed frames instead of swallowing them`; `contains valid JSON values that are not JSON-RPC objects` |
| 5 | Remove the `writeTail` chain (`Promise.resolve().then` instead) | `writes concurrent requests in the order they were issued` |
| 6 | Serialise the chunk loop **and** await notification handlers (the historical loop shape) | `does not let a slow notification handler stall later frames in the same chunk`; `still lets a request handler be answered by a response in the same chunk` |
| 7 | Make `isHealthy()` return `true` unconditionally | `answers liveness from this end without putting anything new on the wire` |
| 8 | Keep `lastFailureAt`/`lastFailureMessage` across `dispose()` | `dispose reports closed and stops the connection for good` |

Note on row 8: clearing the private `this.failure` cache is defensive — a mutation that kept
that field while still clearing the reported fields passed the suite, because `state`
(`closed`) is checked before `failure` on every public path and `getStats()` exposes only the
reported fields. The observable half of the defect (stale reported failure after dispose) is
the part asserted, and it is mutation-sensitive. No test was added for the private cache;
its clearing stays as belt-and-braces and is recorded here rather than asserted.

Row 6 additionally shows the suite's specificity: serialising only the notification handler
(without the serial loop) is *not* a defect in the current design — frames are dispatched
concurrently and `allSettled` collects them — so the historical shape required both changes
to reproduce, exactly as the mutation table records.

## Verification

```
cd packages/core
node ../../node_modules/vitest/vitest.mjs run test/acp-connection.test.ts   # 28 passed (28)
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json        # clean
```

The mutation runs used the same command; `git diff` was empty after restoring the file.

## Contract handoff

- The transport contract is unchanged by this sweep: it is the documented behavior of the
  current 28-case suite, now with a per-row adjudication. E3 (resume/cursor/replay) may
  consume it; no row demands a transport rewrite.
- Each row's repair is independently revertible: the mutations above are one-edit reversals
  and each broke only its own row's tests (plus the shared fixture cases noted in row 1).
- Residual: the private failure-cache clearing of row 8 is not directly observable (above);
  E3's replay work must not depend on `getStats()` reporting a post-dispose failure.
