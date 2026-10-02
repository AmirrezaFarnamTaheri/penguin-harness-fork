# E3 — ACP connection resume: contract, implementation and fixtures (2026-10-02)

E3 asks for a reconnect that converges either by bounded replay or by an explicit fresh
snapshot — never by silently continuing from wherever retention happens to start. This
receipt records the contract (E3.1), the implementation (E3.2), the state mapping (E3.3) and
the fixtures plus revert-and-see evidence (E3.4).

## Scope

| Item | Surface |
| ---- | ------- |
| E3.1 contract | This document, and the module doc of `packages/core/src/kernel/acp-resume.ts` |
| E3.2 implementation | `packages/core/src/kernel/acp-resume.ts` (new), `kernel/index.ts` (exports), `kernel/acp.ts` (shares the UTF-8 length helper) |
| E3.3 state mapping | `acpResumeBanner` in the same module (core side); UI wiring has no consumer yet — see Residual work |
| E3.4 fixtures | `packages/core/test/acp-resume.test.ts` (19 cases) + the mutation table below |

## Baseline

- Parent commit `fb3e3a6e`; the frozen E2 transport contract
  ([acp-defect-sweep-2026-10-02.md](acp-defect-sweep-2026-10-02.md)) — `AcpConnection` owns
  transport generations, rejects in-flight requests on reattach, and deliberately does not
  replay.
- Linux x64, Node v22.22.3, vitest 4.1.11.
- ACP currently has **no production host in this repository**: `kernel/acp.ts` is exported
  through the zero-dependency `./kernel` subpath and consumed only by its own tests. The
  resume layer is therefore implemented and proven at the same boundary, without inventing a
  host (see Residual work for the reopen condition).

## E3.1 — Contract

**Identity.** A cursor is `{streamId, seq}`. `streamId` names the logical record stream and is
stable across transport replacements; a cursor is only ever valid against the stream that
issued it. `generation` (the `AcpConnection` transport epoch) is recorded per record for
diagnostics and is deliberately *not* part of the cursor: the consumer's position must not
depend on which socket carried the bytes.

**Units.** A record is one outbound JSON-RPC line; replay is line-based and byte-identical to
the original send. `seq` is 1-based, increases by exactly 1 per record, and never resets for a
new generation. Retention is bounded by records (default 512) and bytes (default 2 MiB, UTF-8
length — the same unit the transport's frame bound uses).

**Acknowledgement timing.** The consumer acknowledges when 64 records are pending or every
250 ms, whichever comes first, and always immediately before a reconnect. Acks are monotonic
per stream: a regression, an ack beyond the newest produced seq, or an ack naming another
stream is refused without changing state.

**Expiry and old generations.** Acknowledged records are dropped at once (an ack is
processing evidence). Evicting an unacknowledged record is counted (`droppedRecords`), and the
highest evicted seq is remembered (`droppedBeforeSeq`). A resume whose cursor falls at or
below that watermark — or whose cursor is malformed, foreign, or ahead of anything produced —
is answered with `fresh` and a reason (`expired`, `unknown-stream`, `unknown-cursor`,
`no-cursor`). A short suffix is never substituted for a lost prefix. A record larger than the
byte bound is dropped immediately and counted the same way, so the hole is at the record's own
seq rather than at the front of the log.

**Duplicate suppression.** Replay starts after `max(cursor.seq, ackedSeq)`. Acknowledged
records are never re-sent, and the number skipped is reported on the plan
(`skippedAcknowledged`) rather than silently absorbed. Records the consumer may have received
but never acknowledged are re-sent on purpose — a duplicate is cheap, a skipped record is
loss — and the consumer suppresses exact duplicates. The consumer's watermark advances only on
contiguous delivery: a jump is reported as `gap` and the watermark stays put, so no ack can
claim processing of a record that was never received; recovery from a gap is an explicit
`resync` against an authoritative position, which refuses to regress.

**Cursor-space separation.** The ACP cursor is `{streamId, seq}` over ACP records. The
cockpit's SSE cursor (E4) is a different space, with no conversion between them; passing one
where the other is expected fails the `streamId`/shape check rather than being approximated.

## E3.2 — Implementation

`AcpReplayLog` (producer): `append(line, generation)`, `acknowledge(cursor)`,
`resume(cursor | null)`, plus retention and loss accounting. `AcpResumeConsumer` (consumer):
`receive`, `resync`, `acknowledge`, `maybeAcknowledge` (the policy above), plus
`lastDelivered`. `acpResumeBanner` maps a plan or a consumer gap onto the UI state.

Reconnect jitter mirrors the repository ladder (`reconnectDelayMs` in
`engine/context-engine.ts`): `min(1 s × 2^(N−1), 30 s)` plus a seed-derived jitter of up to
50%, re-clamped to the ceiling. It is mirrored rather than imported so the `./kernel` subpath
stays zero-dependency (a browser bundle that wants the transport must not pull the engine);
the module doc marks the formula as a shared contract to keep in step.

## E3.3 — State mapping

`AcpResumeBanner` is `live` | `behind{eventsBehind}` | `resync`. A number appears **only** when
a replay actually carries that many records; a fresh snapshot, or a gap observed by the
consumer, yields `resync` with no count at all, because the true size of a gap is unknowable
to the side that can see only the retained tail. The fixtures assert both directions,
including the fabricated-count mutation below.

## Acceptance

| Criterion | Result | Evidence |
| --------- | ------ | -------- |
| No silent loss | PASS | expired-cursor, oversized-record and eviction tests; mutation M1 turns four tests red |
| No stale-generation acceptance | PASS | foreign-stream and beyond-newest refusals at the log; resync refuses regression; mutations M2/M6 |
| No fabricated backlog count | PASS | banner fixtures; mutation M3 |
| Duplicate-safe replay | PASS | `skippedAcknowledged` reporting, duplicate suppression on the consumer, convergence fixture; mutation M4 |
| Bounded memory | PASS | retention fixtures (32 records / 4 KiB under 2,000 appends; 2,000 = retained + dropped); mutation M5 |
| Deterministic reconnect ladder | PASS | jitter bounds, non-decreasing ladder, seed reproducibility/spread |

## E3.4 — Fixtures and revert-and-see evidence

`packages/core/test/acp-resume.test.ts` — 19 cases: suffix replay at partial/newest/zero
positions; first-attach fresh; foreign cursor and foreign ack refusal; beyond-newest and
malformed cursors; expired cursor across an eviction hole; oversized-record drop; retention
bounds under sustained appends; ack drop-once plus `skippedAcknowledged`; ack regression /
future / foreign refusals; a real `AcpConnection` reattach proving generation changes while
seq does not; duplicate suppression and gap-hold on the consumer; resync regression refusal;
ack policy (64 records or 250 ms); banner count/no-count; reconnect ladder; a convergence
fixture that disconnects mid-replay, resumes at a handshake boundary, outruns retention
(explicit `expired` + resync), and then continues without loss; and re-send-of-unacknowledged.

Each acceptance-critical rule was mutated (one edit, restored afterwards):

| Mutation | Intent | Tests that failed |
| -------- | ------ | ----------------- |
| Serve a suffix across an eviction hole | silent loss | expired-cursor, oversized-record, banner, convergence (4) |
| Accept a foreign stream's cursor | stale acceptance | foreign-cursor refusal (1) |
| Fabricate a count for `gap`/fresh | fabricated backlog | banner, convergence (2) |
| Replay including the cursor's own record | duplicates | suffix replay, generation fixture, banner (3) |
| Remove `evictToBounds` | unbounded memory | expired-cursor, retention bounds, banner, convergence (4) |
| Accept a forward jump instead of `gap` | ack claims unreceived records | gap-hold case (1) |

## Verification

```
cd packages/core
node ../../node_modules/vitest/vitest.mjs run test/acp-resume.test.ts test/acp-connection.test.ts  # 47 passed
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json                               # clean
node <prettier store>/bin/prettier.cjs --check packages/core/src/kernel/acp-resume.ts \
  packages/core/src/kernel/acp.ts packages/core/src/kernel/index.ts \
  packages/core/test/acp-resume.test.ts                                                            # clean
```

## CI

Lane: `test (core)` plus the macOS/Windows core shards (the fixtures are platform-independent;
nothing here touches the filesystem). Exact-commit runs are queued on GitHub — see the note in
[ci-repair-2026-10-02.md](ci-repair-2026-10-02.md#ci): the `ci` aggregate job of the previous
run sat queued for ~40 minutes and the newer runs wait behind the PR's concurrency group.

## Compatibility

- Additive: one new module plus two exports through the existing `./kernel` subpath; the
  transport file gains one exported helper (`utf8Length`) that is not re-exported publicly.
- Rollback: disable resume by calling `resume(null)` — every reconnect then reports
  `fresh`/`no-cursor` and the host requests an authoritative snapshot, which is the documented
  degraded mode. Removing the module entirely affects nothing else yet.
- No production behavior changes: nothing in the repository consumes ACP yet.

## Residual work

- **UI wiring (E3.3 consumer side) is not done and cannot be honestly done here**: no package
  renders ACP state, so there is nothing to wire `acpResumeBanner` into. Reopen condition: the
  first production ACP host (the process/socket owner) lands — it must render `behind`/`resync`
  from this mapping, keep its cursor per stream, and ack per the policy above. E4 is the
  cockpit's own SSE cursor space and must not share this type.
- The jitter formula is mirrored from `engine/context-engine.ts`; if that ladder changes, this
  one must follow (recorded in both module docs).
- Exact-commit CI gate remains pending for the reasons above.
