# I7 — Pressure-aware policy for nonessential writes (2026-10-03)

## Scope

Packages completed: **I7.1** (`e60a84e3`, formatted in `1c4f9aaa`), **I7.2** (`fb206f18`),
**I7.3** (`38c809f2`, `d3fda49d`), **I7.4** (the fixtures of the three packages; no separate
commit).

Packages remaining: **the production injection** (see Residual work) — no host constructs the
gate yet, so the policy is implemented and enforced at the boundary but off until a host wires it.
Card status: **IMPLEMENTED** (not `VERIFIED`): I7.1, I7.3 and I7.4 are complete with evidence,
I7.2's enforcement exists and is tested end-to-end, and the wiring that turns it on in a running
server is the remaining package.

## Baseline

Starting SHA `6fa92c62` (working tree clean, remote in sync at each commit). Node `v22.22.3`,
pnpm `11.18.0`, Linux x64 (sandbox uid 1001).

Before this card, the only pressure surface was observational, and deliberately so: the header of
`packages/core/src/agent/resource/pressure-probe.ts` states "This observes. It never gates", and
`agent/resource/index.ts` repeats the invariant. Nothing anywhere refused a write for lack of disk
space; the truncation archive (`truncated-tool-output-archive.ts`) wrote `.log` files and the recall
store wrote recallable copies with only *capacity* bounds (200 entries / 64 MiB / 30 days), never a
free-space check. The `penguin-harness-fork` checkout under test had a `resource_pressure` tool and
`ResourcePressureProbe` reporting `freeBytes` from `statfs` (`bsize * bavail`), in bytes.

## Change

1. **I7.1 — policy as data** (`packages/core/src/internal/write-pressure-policy.ts`). The probe's
   directory invariant ("observe, never gate") is preserved by putting the policy somewhere else,
   as the guardrail for the harness's *own nonessential* writes:
   - thresholds `PRESSURE_WARN_BELOW_BYTES = 209_715_200` (200 MiB) and
     `PRESSURE_BLOCK_BELOW_BYTES = 52_428_800` (50 MiB), written as the explicit byte products the
     card asks for and asserted as literal numbers. The probe already reports bytes, so no unit
     conversion happens at the boundary; comparison is strictly below, so at exactly 200 MiB
     neither rule fires and at exactly 50 MiB the warning fires while the stricter block rule has
     not;
   - exactly **two** blockable producers (`tool-output-archive`, `recall-store`) and a
     sixteen-entry exemption table with a reason each: seven read-only tools, `write_file` /
     `edit_file` (`user-work`), `run_subagent` / `input_subagent` (`delegated`), `exec_command` /
     `input_command` (`unresolvable-destination`, warn-only), and — by construction, because these
     are what relieve pressure — `session-delete`, `archive-eviction`, `session-export`
     (`frees-space` / `export`). An id that is not in the table is *allowed*, not blocked: this is
     a guardrail for two known producers, not a gate on whatever a future tool does;
   - three ways to have no valid measurement — no probe, an errored path, a reading for a
     different volume, or a non-number — all `warn`, never `block`, and all report
     `freeBytes: null`. "No measurement" and "zero bytes free" are different answers; a measured
     zero *does* block, and is reachable only through the measured path.
2. **I7.2 — enforcement at the boundary** (`fb206f18`). `TruncatedToolOutputArchive` takes an
   optional `writePressure` gate and consults it **before the first filesystem call**, so a refused
   write cannot create the archive directory, write a `.log`, or leave a partial entry: the recall
   store returns `{status:"failed", code:"PRESSURE_BLOCKED"}`, the truncation capture returns
   `PRESSURE_BLOCKED` on the existing `[output archive failed: …]` line, and an id that was never
   issued does not resolve. A warning rides back on the save result as `WritePressureWarning`
   (`signal`, `reason`, `volumePath`, `freeBytes: null` when unmeasured) and becomes a
   `[disk pressure <signal>: … bytes free; …]` line in the note the model reads, on both the
   truncation and the compression paths. A gate that *throws* becomes a warning with no
   measurement, never a refusal — the policy must not lose a write because its own probe
   misbehaved, and must not claim a number it does not have. `createProbeWritePressureGate` is the
   production gate: the probe's TTL-cached report for one volume, bound to one Session, with the
   write key built from the caller's own tool call id. `Environment` threads the tool call id into
   both save sites and accepts the gate from its config; omitting it is the previous behavior
   exactly (the card's rollback is removing the injection). The `resource_pressure` tool and the
   probe are untouched — no threshold, no verdict, no new field.
3. **I7.3 — the override is an authenticated, recorded, scoped action.**
   `PressureOverrideStore` keyed by `(sessionId, producerId, toolCallId, volumePath)`, single-use
   (`consume` records `consumedAt`); `grant` persists the record atomically (0600) and `consume`
   re-reads before deciding, so a grant made by the surface that authenticated the human is neither
   missed nor handed to two writes, and a restart cannot resurrect a used one. Reading is
   fail-closed toward refusal: a missing file is an empty store, a corrupt one is ignored, and an
   entry missing any field (including `grantedBy`) is not a grant. The grant is issued by
   `POST /api/sessions/:sessionId/pressure-overrides` (`d3fda49d`), which **derives** its scope
   rather than accepting it: the Session from the authenticated resolution, the volume from that
   Session's own scratchpad, the record written into that scratchpad through the shared
   `sessionPressureOverridePath` convention; the request can name only the producer (from the
   inventory) and the tool call. A payload-shaped `force` / `overrideId` field has nowhere to
   enter: `evaluateWritePressure` has no parameter a tool argument can reach, and the test asserts
   this by driving the decision with such an object in scope.
4. **I7.4 — the fixtures** are the test files of the three packages above: `write-pressure-policy.test.ts`
   (threshold matrix at exact byte values including both boundary readings, the three
   unavailable-measurement paths, the exemption fixture asserted entry by entry, override
   single-use / non-widening / unforgeable, durability), `write-pressure-boundary.test.ts`
   (blocked writes leave the destination untouched, warned writes proceed and are observable, a
   throwing gate warns and saves, no gate means no warning, plus two Environment end-to-end cases
   that assert the pressure line and the `PRESSURE_BLOCKED` code in the model-visible output while
   the bounded text survives), and `pressure-override-route.test.ts` (grant shape and location,
   refusals, cross-Session and cross-user scope, and a real archive under a 1-byte reading where
   the granted call is stored, the same call again is blocked, and an unnamed call is blocked).

## Acceptance

| Criterion | Result |
| --- | --- |
| Warn below 200 MiB and block below 50 MiB, with the stricter rule not fired at either threshold | **Proved.** `209_715_200` and `52_428_800` asserted as literal byte values; 209 715 201 / 209 715 200 / 209 715 199 → allow / allow / warn; 52 428 801 / 52 428 800 / 52 428 799 → warn / warn / block; measured 0 → block. |
| I7.1 inventory of targeted nonessential writes and their volumes, byte units explicit, existing warning preserved as a separately named signal | **Proved.** `WRITE_PRODUCER_INVENTORY` (2 blockable + 16 exempt) asserted entry by entry against the fixture; units documented as `bsize * bavail` bytes and pinned by `PRESSURE_THRESHOLD_UNIT`; the existing capacity warning (`ARCHIVE_FULL`, the archive's own bound) is a different code and signal and is unchanged — `write_pressure_low` and `write_pressure_blocked` are new, separately named. |
| Read-only operations, export, deletion, cleanup and recovery remain available | **Proved.** The exemption matrix drives all of `read_file`, `recall_output`, `write_file`, `edit_file`, `session-delete`, `archive-eviction`, `session-export`, `run_subagent`, `exec_command` under a 1-byte reading and asserts `allow` for each; each exemption is enumerated by name in the fixture. |
| I7.2 enforce at the trusted write boundary, measured target volume, observable warning when the probe is unavailable; never invent zero free bytes or claim a threshold refusal without a valid measurement; `resource_pressure` stays observational | **Proved (boundary) / incomplete (production injection).** The boundary is the archive, enforced before any filesystem mutation, tested end-to-end through `Environment`; the volume must match the write key exactly (a reading for another path warns), and every unavailable shape yields `freeBytes: null` and `warn`. The probe module and `resource_pressure` tool are byte-identical in this change set. What is *not* done: no production caller constructs the gate, so a running server still behaves as before — recorded as the remaining package. |
| I7.3 user override is authenticated, recorded, scoped to the write; model payload fields cannot forge it or widen another Session's allowance | **Proved.** The grant comes only from the authenticated route (other users' Sessions 404; another Session of the same user gets its own scratchpad record), carries `grantedBy` / `grantedAt` / `reason`, is consumed exactly once (in-process and across a restart), and cannot be widened by editing a request (scope is derived) or by payload (`force`/`overrideId` inert). |
| I7.4 above/at/below thresholds, wrong-volume readings, unavailable probes, exemptions, forged/valid override, and denied writes do not mutate destinations | **Proved.** All named matrix rows covered; the "does not mutate" claim is asserted by `readdir` failing `ENOENT` on the destination root after a blocked write and by the index still reporting `missing` for an id that was never issued. |
| No hidden global disk-policy flip, no loss of the recovery path | **Proved.** The policy is per-archive and opt-in (`writePressure` omitted = previous behavior, asserted), it refuses only the two convenience writers, and the recovery path (`session-export`, deletion, eviction, `recall_output` reads) is exempt by construction. |
| Rollback: disable without changing the probe or pressure-tool behavior | **Proved.** Removing the `writePressure` injection restores the previous behavior exactly (asserted by the no-gate case); the probe module and the `resource_pressure` tool are unchanged. |

## Verification

| Command (cwd) | Result |
| --- | --- |
| `node …/vitest.mjs run test/write-pressure-policy.test.ts` (packages/core) | 29 passed |
| `node …/vitest.mjs run test/write-pressure-boundary.test.ts` (packages/core) | 10 passed |
| `node …/vitest.mjs run test/environment test/truncated-tool-output-archive.test.ts test/archive-eviction-failure.test.ts test/recall-page.test.ts` + the two policy suites (packages/core) | 198 passed across 9 files |
| `node …/vitest.mjs run test/pressure-override-route.test.ts test/recall-route.test.ts` (packages/server) | 11 passed |
| `node …/vitest.mjs run test/recall-route.test.ts test/pressure-override-route.test.ts test/authz.test.ts` (packages/server) | 18 passed |
| `node node_modules/typescript/bin/tsc --noEmit -p packages/{core,server}/tsconfig.json` | clean (re-run after the revert recovery; core rebuilt, `dist` synced into the three store dirs, server rebuilt) |
| `prettier --check` on every touched file | clean |

Mutation checks (each reverted after; suite re-run green):

- **policy (8 killed):** each threshold comparison made inclusive (2 cases red), an unavailable
  reading turned into a block (7 red), the exemption table ignored (1 red), the override key
  narrowed to the session (1 red), single-use dropped (1 red), an unmeasured decision reported as
  zero bytes (6 red), the probe's error branch ignored (1 red).
- **boundary (3 killed):** every warning carrier removed (3 red), the block decision ignored
  (3 red), the errored probe path treated as a measured reading (2 red).
- **route (4 killed):** any producer accepted (1 red), a blank tool call accepted (1 red), the
  volume hard-coded instead of derived per Session (3 red), the grant left in memory (3 red).
- **Two attempted mutations were observationally equivalent and are recorded rather than claimed
  as kills:** moving the gate call from before the id derivation to just before the `writeFile`
  (the mutant still refuses before any write, so the destination stays untouched), and appending
  `|| 0` to the errored sample's `freeBytes` (already 0). Both were rejected as mutations because
  no behavioral difference exists to observe; the equivalent code paths are covered indirectly by
  the block/warn cases.

## CI

Candidate heads: `e60a84e3` (I7.1), `fb206f18` (I7.2), `38c809f2` (I7.3 store), `d3fda49d`
(I7.3 route). All pushed to `arena/01a0fd8a-penguin-harness-fork`. At the time of writing, the
workflow runs for the head are **pending** (CodeRabbit's own check is `pass`; all CodeRabbit
review comments are marked `✅ Addressed in commits 0e392e1 to 4bb7050`). No CI verdict is claimed
here for these four commits; this receipt is IMPLEMENTED, which requires exactly the local evidence
recorded above.

## Compatibility

- **Old readers/clients:** no route, tool or CLI behavior changes when the gate is absent; the
  archive's result types gain an optional `warning` field (additive). `recall_output` behavior is
  unchanged. The new route is additive.
- **Scope ownership:** the policy is core's; the probe stays observational; the override record is
  the Session's own file in its own scratchpad, so deleting a Session removes its grants with the
  rest of the scratchpad.
- **`docs/status-ledger.json` deliberately unchanged:** no existing claim's status changes, and the
  new consumption shape (a package-specifier consumer in the server route, a same-file caller in
  the tool) is not representable by the ledger's runtime-chain model — the same decision recorded in
  the F18 receipt.
- **Rollback:** remove the `writePressure` injection (or the route) — no persisted format depends
  on the policy, and the override file is inert when no gate reads it.

## Residual work

- **I7.2 production injection (owner: `packages/core/src/agent.ts`, next package).** The gate must
  be constructed with the Session's data root and Session id and passed to `Environment`. The open
  design question the package must answer, not paper over: which path the probe measures. The
  harness's layout puts the Session scratchpad under the data root, so measuring the data root is
  correct for the default layout, but a host that mounts or symlinks a scratchpad elsewhere would
  be measuring the wrong volume. Two candidate answers — resolve the nearest existing ancestor of
  the scratchpad and measure that, or state the same-volume assertion as a host contract — are
  named here so the package decides explicitly; the warn-not-block fallback keeps either safe in
  the meantime.
- **Volume-level end-to-end (owner: `packages/server`).** No test drives the route's grant through
  a live `Agent`'s archive; the pieces are covered separately (route → store → gate → boundary).
- **`recall_expired`-style UX (owner: `packages/web`).** A warned or refused archive write is
  visible to the model and in the tool result; no dedicated UI surface exists or was required by
  the card.
- **Next work package:** the card after I7 in the roadmap, to be picked from the remaining
  unblocked OPEN rows (the previous batches closed I1, I4, E10, G4, C8, F17, F8, F2, H2, D6, I6, B4,
  A1, B3, F18, G2, H1, J2).

## Follow-up (2026-10-03): the two route codes needed UI messages

Discovered while verifying J4: `pnpm check:i18n` (a step of the required CI `style` job) was red on
this lineage because the route added here introduced two literal `HttpError` codes
(`pressure_producer_invalid`, `pressure_tool_call_invalid`) that the required-checker
`scripts/check-i18n.mjs` reads out of `packages/server/src/` — and neither web dictionary carried a
message for them. The route's own tests passed, and the parity gate was not part of this receipt's
run set, so the gap reached the branch instead of failing here.

Repaired in the same session: messages for both codes added to `packages/web/src/lib/strings-en.ts`
and `packages/web/src/lib/strings-zh.ts`; `pnpm check:i18n` now reports "i18n parity check passed".
Recorded as an addendum rather than a rewrite of the receipt above: the I7 implementation is
unchanged, and the acceptance table's "route 4/4" evidence still holds.

## Follow-up (2026-10-03): production Agent composition and live grant path

This follow-up supersedes the earlier residual that named I7.2 production injection and left the
probe path as an open design question. The implementation now uses the exact Session scratchpad
path; it does not substitute the Workspace or data root.

### Production wiring and integration evidence

- `Agent.createSession` computes the Session scratchpad path once and passes it to both
  `Environment` and `createSessionWritePressureGate`. The gate's default `ResourcePressureProbe`
  measures that exact path, and the same path is its volume key and the base for
  `sessionPressureOverridePath`.
- The unavailable-measurement behavior remains warn-only: the Agent wiring test verifies the
  missing target produces `write_pressure_probe_unavailable`, the exact Session volume path, and
  `freeBytes: null`.
- The policy composition test persists a matching grant at the production override path, admits
  its first low-space write, then blocks the replay after the durable single-use grant is consumed.
- The server route test now drives an authenticated `tool-output-archive` grant through a live
  Agent-created Session and its actual Environment archive. With the measured Session volume
  deterministically set below the block threshold, the granted archive write is saved; the live
  gate refuses a retry and an unrelated call, then a fresh gate confirms the durable grant is
  consumed. The existing archive destination is byte-for-byte unchanged. The fake probe is
  test-only; the production factory still constructs the real statfs probe. The test reaches the
  archive through a test-only private-field cast; no production API was widened.
- Boundary review found that a refused truncation-archive write returned before releasing its
  serialization queue, which could strand later writes after capacity recovered. The release now
  runs in an outer `finally`; a regression test blocks one write, restores admission, and verifies
  the next write completes.

### Local checks for this follow-up

| Check | Result |
|---|---|
| Core tests: `agent.test.ts` + `write-pressure-policy.test.ts` | **69 passed** |
| Core tests: `write-pressure-boundary.test.ts` + `truncated-tool-output-archive.test.ts` | **24 passed**, including post-refusal archive recovery |
| Server test: `pressure-override-route.test.ts` | **4 passed**, including the live Agent/archive case |
| Core TypeScript check | **passed** (`tsc --noEmit -p tsconfig.json`) |
| Server TypeScript check | **passed** (`tsc --noEmit -p tsconfig.json`) |
| Core package build | **passed** (ESM and declaration build) |
| Prettier check on changed TypeScript source and tests | **passed** (Markdown is excluded by repository config) |
| `git diff --check` | **passed** |
| Oxlint with `--deny-warnings` | **not verified**: the native process aborted in `oxc_allocator` with a Tokio worker panic before emitting diagnostics, including with `--threads=1` |

Verification ran under Node **v24.21.0**, obtained with `npm exec --package=node@24`, because the
sandbox's default Node v22.22.3 is below the repository's `>=24` engine requirement. Corepack
provided pnpm 11.18.0. The server route test needed a core package build first; the workspace install
was completed with `--frozen-lockfile --ignore-scripts` after the initial Node 22 install attempt
could not fetch native `node-pty` build headers. No native PTY process is used by these focused
checks.

The **97 focused core/server tests and local type/build/format checks do not constitute full CI**.
This follow-up is an uncommitted candidate on `arena/01a10111-penguin-harness-fork`; no CI result or
review approval is claimed for it. Candidate CI, review, and the repository-wide check matrix remain
open. The write-pressure thresholds, exemption inventory, and observational `resource_pressure`
contract were not changed in this follow-up.
