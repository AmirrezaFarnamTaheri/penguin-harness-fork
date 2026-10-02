# E4 — Durable cockpit event tail, gap signal and caught-up marker (2026-10-02)

E4 asks for a cockpit stream that survives the process, not just the socket: a restart must keep
the stream identity and the replay window, a client must be able to tell "caught up" from "you
missed a stretch", and an undeliverable frame must end the connection rather than be silently
skipped. This receipt records the contract (E4.1), the durable tail (E4.2), the convergence
signal at both boundaries (E4.3), and the restart fixtures with revert-and-see evidence (E4.4).

## Scope

| Item | Surface |
| ---- | ------- |
| E4.1 contract | Module doc of `packages/server/src/cockpit/event-log.ts` and the connect block of `packages/server/src/cockpit/ws.ts` |
| E4.2 durable tail | `packages/server/src/cockpit/event-log.ts` (file-backed log, atomic append/rewrite, bounded replay, explicit gap), `ws.ts` (`safeSend`, file wiring) |
| E4.3 convergence at the client boundary | `packages/web/test/cockpit-stream-resume.test.ts` (marker semantics) over the existing reconnect path; the separate resync control is residual |
| E4.4 fixtures | `packages/server/test/cockpit-durable-stream.test.ts` (14 cases) + the mutation table below |

All other Wave-1/2 packages remain open (E5, E10; I1–I6; F1–F18; G4), as do Waves 3–4.

## Baseline

- Parent commit `32856683` (E3, [acp-resume-2026-10-02.md](acp-resume-2026-10-02.md)); E2 receipt
  `fb3e3a6e` ([acp-defect-sweep-2026-10-02.md](acp-defect-sweep-2026-10-02.md)).
- Worktree state before this slice: `event-log.ts` memory-only, `safeSend` a silent skip,
  `ws.ts` with no `caught_up` frame and no project file. E4 was implemented on top of the E3
  contract, in the same worktree, uncommitted until the receipt commit.
- Linux x64, Node v22.22.3, pnpm 11.18.0, vitest 4.1.11.

## E4.1 — Contract

**Units.** One envelope = one broadcast JSON string, retained verbatim. The cockpit cursor is a
bare safe non-negative **integer**; the stream **generation** is a UUID read from the file header.
They are one space: `(generation, seq)` names a position, and a cursor is only ever valid against
the generation that issued it.

**Durability acknowledgement.** `publish`/`publishStamped` return only after the write path has
succeeded for that envelope; `durableCursor` names the highest seq that survives a restart and
never advances on a failed write. `cursor` remains the in-memory position (the live stream keeps
working during a persistence outage).

**File format.** `<projectDir(root, projectId)>/cockpit-stream.jsonl`: a JSON header line
(`{type:"cockpit_stream_header", version:1, generation}`) followed by one
`{seq, payload}` line per envelope. Appends are single `write(2)` calls; the file is 0600 inside
a 0700 directory. A file whose header is missing, foreign or another version is never adopted;
the next publish replaces it wholesale. Restore walks contiguous seq numbers from the **first
entry line it can read** (a compaction legitimately writes a window that starts above seq 1),
drops an unterminated tail, and treats a torn tail or a hole as "this file needs a rewrite": the
next successful publish replaces the file with header + retained tail + the in-flight envelope.
Compaction is the same rewrite via a temp file and a rename, triggered once the file would exceed
`COCKPIT_EVENT_LOG_COMPACT_AT_BYTES` (4 × `COCKPIT_EVENT_LOG_MAX_BYTES`, i.e. 2 MiB, against a
512 KiB / 512-entry memory window).

**Ordering at connect** (single synchronous block, before the socket joins the broadcast set):
replayed envelopes (if any) → `cockpit_resume` → `cockpit_init` (snapshot, stamped
`seq = convergedAt` captured after the replay is handed over) → `cockpit_caught_up
{projectId, generation, cursor, timestamp}` → `runtime.clients.add(ws)`. The marker is sent
**only** when the replay was contiguous. A gap (`cockpit_stream_gap`, reason
`outside_replay_window` when the cursor fell out of the window, `stream_generation_changed` when
the generation does not match) is followed by the snapshot and deliberately **no** marker: the
snapshot repairs current state, but the events that fell out cannot be recreated, so "caught up"
would be a false claim. A first-time client (no `since`) is current by construction and does get
the marker.

**Undeliverable frames.** `safeSend` returns a boolean and closes a client that is not OPEN or
exceeds the 64 KiB backpressure guard with code 1013 ("Try Again Later"), instead of skipping
the frame. A skipped frame is exactly the failure the resume protocol exists to prevent: the
client would keep a stale cursor, receive every later frame, and look current while missing the
middle. Closing is honest — the client reconnects with the cursor it actually applied, and the
replay fills the hole or reports the gap.

## E4.2 — Change

| Path | Change |
| ---- | ------ |
| `packages/server/src/cockpit/event-log.ts` | New durability block: `COCKPIT_EVENT_LOG_FILE`, `COCKPIT_EVENT_LOG_FILE_VERSION`, `COCKPIT_EVENT_LOG_COMPACT_AT_BYTES`, `CockpitEventLogDisk`/`nodeCockpitEventLogDisk`, `CockpitEventLogOptions`; `restore`/`persist`/`rewriteTail`/`reportPersistFailure`; `durableCursor`/`persistenceErrors`/`filePath` getters; `reset()` rewrites the header with a new generation |
| `packages/server/src/cockpit/ws.ts` | `COCKPIT_BACKPRESSURE_CLOSE_CODE`; exported boolean `safeSend`; per-project file-backed log when `deps.root` is set (with an `onPersistError` log line); `streamHasGap`/`convergedAt` and the conditional `cockpit_caught_up` frame after `cockpit_init` |
| `packages/web/test/cockpit-stream-resume.test.ts` | One case pinning that `cockpit_caught_up` advances the cursor and must never clear `behind` on a socket that saw a gap |

Observable before/after: before, a drop lost every envelope older than the in-memory window and
a restart rotated the generation (every reconnect forced a resync); a backed-up client silently
missed frames. After, the retained window and generation survive the process, gaps are labelled
as gaps with no marker, and every undelivered frame ends the connection so the client can resume.

## Acceptance

| Criterion | Result | Evidence |
| --------- | ------ | -------- |
| Generation and cursor survive a process restart | **PROVED** | WS restart fixture: publish 1–2, connect, drop the runtime (`resetCockpitRuntimesForTesting()`), publish 3–4, reconnect with `since`/`generation` → `cockpit_resume` (same generation, `replayed: 2`), replayed deltas exactly `[3, 4]`, ordering `resume < init < caught_up`, no `cockpit_stream_gap`. Revert-and-see: mutation M1 (ack before write) turns the failure-containment case red; M6 (restore anchored at seq 1) turns seven cases red. |
| Clients distinguish caught-up from a gap | **PROVED** | Gap fixture: outside-window and foreign-generation connects each send `cockpit_stream_gap` and never `caught_up`; a first-time client does get `caught_up`. Mutation M4 (always send the marker) turns the gap case red. Client side: the marker advances the cursor and cannot clear `behind`. |
| A cursor cannot cross protocols | **PROVED** | Cockpit `parseSince` admits only a safe non-negative integer; a serialized ACP cursor (`{streamId, seq}`) is not a position, so the connection is a first connect (new foreign-cursor fixture: snapshot + marker, no `cockpit_resume`, no `cockpit_stream_gap`). On the other side, E3's log refuses anything that is not `{streamId, seq}` (malformed/foreign → `fresh`). No shared type, parser or conversion exists between the two spaces. |
| Bounded replay, explicit gap when a point is unavailable | **PROVED** | `CAP + 20` publishes then `since=1` → `outside_replay_window` with `missed: null`; 16,000 publishes keep the file ≤ `COMPACT_AT + 4 KiB` with at least one compaction inside the 512 KiB window (`min` observed size), and a reload still replays the newest tail; `since()` refuses malformed/future cursors rather than clamping. |
| No silent gaps on reconnect | **PROVED** | `safeSend` closes a backed-up client with 1013 and returns false; a closed socket returns false without pretending to send. Mutation M5 (silent skip) turns the backpressure case red. |
| E4.4 kill mid-event + server restart | **PROVED at the byte and runtime boundaries** | Torn tail: truncating the file mid-record is dropped by restore (`cursor` 2, `since(3)` = gap), and the next publish rewrites the file so a fresh reader walks it contiguously (mutations M2/M3 red). Failure burst: both write paths fail, `durableCursor` freezes at 1, the burst is reported once, the first success repairs the file to 4, the second outage leaves it there. The WS fixture covers the restart flow end to end. A subprocess SIGKILL harness is not present — see Residual work. |

### Cursor-space statement (E3 ↔ E4)

The two resume contracts are deliberately disjoint, and the acceptance criterion is satisfied by
construction plus a fixture on each side:

- **ACP (E3)** — cursor `{streamId, seq}` over outbound JSON-RPC lines; `seq` is 1-based and
  never resets; `generation` is recorded per record for diagnostics and is **not** part of the
  cursor; a foreign or malformed cursor is answered with `fresh`, never approximated.
- **Cockpit (E4)** — cursor is one integer over broadcast envelopes; the UUID generation **is**
  part of the stream identity (a generation mismatch is a gap, and `missed` is `null` because the
  distance between two processes is not a number this server may state); a value that is not a
  safe non-negative integer is not accepted as a cursor at all.
- There is no conversion, no shared type, and no shared parser. Reusing one where the other is
  expected yields "first connect" (cockpit) or `fresh` (ACP), never a plausible-looking position.

## Verification

```
cd packages/server
node ../../node_modules/vitest/vitest.mjs run test/cockpit-durable-stream.test.ts   # 14 passed
node ../../node_modules/vitest/vitest.mjs run test/cockpit-                        # 8 files, 79 passed
cd ../web
node ../../node_modules/vitest/vitest.mjs run test/cockpit-stream-resume.test.ts    # 15 passed
cd ../..
node node_modules/typescript/bin/tsc --noEmit -p packages/server/tsconfig.json      # clean
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.json         # clean
node node_modules/.pnpm/prettier@3.9.4/node_modules/prettier/bin/prettier.cjs --check \
  packages/server/src/cockpit/event-log.ts packages/server/src/cockpit/ws.ts \
  packages/server/test/cockpit-durable-stream.test.ts packages/web/test/cockpit-stream-resume.test.ts  # clean
```

Each acceptance-critical rule was mutated (one edit, suite re-run, file restored from a pristine
copy — never committed):

| Mutation | Intent | Cases that failed |
| -------- | ------ | ----------------- |
| Acknowledge `durableCursor` before the write | durability ack lies | failure containment + bursts (1) |
| Ignore the repair flag (always append) | write behind a hole | torn tail ×2, failure containment (3) |
| Do not mark a torn tail | crash tail fused with the next record | torn tail ×2 (2) |
| Always send `cockpit_caught_up` | false caught-up after a gap | gap never claims caught_up (1) |
| Backpressure is a silent skip | silently dropped frame | closes a backed-up client (1) |
| Anchor restore at seq 1 | compaction window unreadable | adopt/torn/compaction/failure/caps/restart (7) |

## CI

Candidate head: the receipt commit on this branch. The exact-commit run will be created behind the
branch's concurrency group, which is currently held by the stuck aggregate `ci` job recorded in
[ci-repair-2026-10-02.md](ci-repair-2026-10-02.md#ci); historical run/job URLs stay in that
receipt. E4 is `IMPLEMENTED`, not `VERIFIED`, until its own head has a required-check verdict.

## Compatibility

- **Payload contract preserved.** Replayed envelopes are the retained bytes — already carrying
  their `seq` — forwarded verbatim; nothing is re-serialized. The snapshot keeps its existing
  fields and gains `seq`/`generation` (additive).
- **No `deps.root`** (shared-coordinator path, test harnesses): the log stays memory-only and the
  session-fatal behavior is unchanged; only `deps.root` hosts get the file.
- **Old clients** ignore the unknown `cockpit_caught_up` type; the client reducer reads `cursor`
  for control messages, which is pinned by the web fixture. Unknown-but-newer frames never move
  the cursor backwards.
- **Rollback.** The card's rollback is a full snapshot on every reconnect with visible status and
  durable history kept for recovery. Snapshots still happen on **every** connect, so removing the
  replay/marker frames degrades to the documented behavior; `cockpit-stream.jsonl` is read by
  nothing but this module, so leaving it in place is safe and deleting it is also safe (the next
  publish replaces it).
- **Scope ownership.** All durability code stays in `packages/server/src/cockpit`; ACP was not
  touched by E4.

## Residual work

- **E4.3's resync control** (an operator-visible "resync now" action) is not built. The reconnect
  path already performs authoritative snapshot loading and fresh-tail consumption, and this
  receipt proves the recovery half (reconnect from the gap's own cursor → `cockpit_resume`,
  `missed: 0`). Reopen condition: a cockpit UI resync control is specified; it must reuse the
  gap's `cursor` and the generation, and must never clear `behind` by itself.
- **Process-level kill fixture (E4.4).** The crash is modeled at the exact byte boundary
  (truncated record) plus a dropped runtime; a harness that SIGKILLs a real server subprocess is
  not present. Reopen condition: a release gate asks for process-level kill evidence.
- **Compaction changes the file's base.** After a rewrite the file may start above seq 1; a client
  older than the base is told `outside_replay_window` with `missed: null`. This is intended and
  documented, but it means the durable window is bounded by the file, not by the whole history.
- Exact-commit CI gate remains pending (see CI).
