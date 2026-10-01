# Waves 1 and 2 implementation evidence

This ledger records local implementation progress. Both wave checkpoints remain open.
Full package suites, browser acceptance, release evidence and required human reviews are
separate gates; focused checks do not establish those broader results.

## Server boundaries

| Task | Implementation | Evidence and remaining scope |
|---|---|---|
| E5 | HTTP sync/async and WebSocket swarm requests reject non-simulation when no trusted execution handler exists. Configured handlers are passed into the coordinator. | `test/cockpit-ws.test.ts`: real configured execution, sync/async rejection and socket rejection before acknowledgement; focused cockpit suites passed. |
| E6 | Cockpit errors carry `{error:{code,message}}`, with `success:false`; unexpected exceptions use the shared safe error serializer. Successful response fields remain intact. | `test/cockpit-integrity.test.ts`: malformed JSON, invalid project id, and five unsuccessful task outcomes; existing key/mailbox success and failure coverage. Frontend `readResponse` already accepts structured errors. |
| E7 | Spend-flow session/project identifiers are limited to valid ids of at most 128 characters. Display paths have a 4,096-character cap and reject controls, malformed surrogates, encoded bytes, traversal and non-normalized separators. | `test/gateway-validation.test.ts`: invalid/overlong identifiers, Windows/POSIX path cases and valid Unicode display paths. The sink remains display metadata. |
| E8 | Public `/health` and `/api/health` liveness, with `/ready` under both aliases, run before cookie authentication. Readiness checks SQLite and optional fast dependency-status callbacks without exposing errors or config. | `test/health.test.ts`: both application mounts, serving database, closed database, dependency degradation and recovery. |
| E1 | Both factories construct a guarded coordinator with session identity. Async and sync factories require explicit absolute roots; snapshot construction requires supplied instances, and WebSocket attachment validates its root before registering listeners. | Missing/relative-root rejection, independent roots, shared async/sync identity, reap/recreate, HTTP and socket/resume checks: 75 passed across five suites. Test hosts now explicitly inject their workspace roots. |

Commands: `pnpm --filter @prismshadow/penguin-server exec vitest run
test/health.test.ts test/gateway-validation.test.ts test/cockpit-ws.test.ts
test/cockpit-integrity.test.ts`; server typecheck is recorded separately in the task tracker.

## Retry policy integration in progress

`llm/retry-policy.ts` now owns the engine's ordinary-turn attempt budget for providers that
advertise an account pool. The model supplies opaque account identities and rate-limit
metadata; grace retries prefer the previous eligible account without bypassing cooldown.
Countdown and sleep consume the same cached decision. Partial output cannot reset this
budget, and a fully cooling pool waits for eligibility rather than rotating at 50 ms.
An explicit `retryPolicyVersion: "legacy"` provides local rollback without a state migration.

The policy branch table and runtime timer checks cover exhaustion, partial output, one grace
receipt, cooldown waiting, cancellation and legacy rollback. The engine/provider/policy/runtime
checkpoint passed 200 checks; two additional provider checks prove opaque metadata and actual
same-account routing without cooldown bypass. Compaction now consumes the same selected policy
under its own request budget; unusable summaries and transport failures share that budget.
The compaction/runtime checkpoint passed 57 checks, and the updated policy/runtime/compaction
checkpoint passed 79 checks, including the short-hint branch that covers the entire pool
cooldown while preserving one grace receipt. ProxyPool manages
eligibility and health; it does not itself send requests or run a retry loop. Final exact-commit
and wave checkpoints remain open.

## Credential writes and ZIP imports

H3's shared atomic writer now creates a UUID-named temporary file exclusively (`wx`) at
0600, inherits the destination's regular-file permissions unless a mode is supplied, changes
permissions on the descriptor, flushes before rename, and deletes only temporary files it owns.
An exclusive-create collision cannot erase another writer's file. Fault fixtures cover write,
chmod, sync, close and rename; each preserves the original bytes and removes the owned temp.
The grouped atomic suites passed 11 checks, with four POSIX permission/symlink checks skipped
on this Windows host. Core typecheck passed. Native POSIX receipts and Windows ACL semantics
remain part of final platform acceptance; a requested Node mode is not proof of a Windows DACL.

I3's shared ZIP preflight reads central-directory attributes before decompression on both skill
and hook imports. It rejects symbolic links regardless of creator OS, unsafe and reserved paths,
case/Unicode-normalized duplicates, malformed directories, and unsupported ZIP64/multi-volume
formats. End-record selection matches the decompressor, so an ambiguous comment cannot make
the two checks read different directories. Existing count/inflated-size limits remain active.
The grouped archive/import suites passed 49 checks, including first-install refusal on both
routes, normalized collisions and offset byte views. Two focused overwrite-refusal checks also
passed: a refused archive preserves the installed skill/hook files and bytes. Server typecheck
passed after these final assertions.

G1 extends the existing Skill Integrity workflow, whose strict corpus audit already validates
frontmatter, local references and taxonomy reporting. A change-aware 80-line gate now rejects
new long skills and growth in legacy long skills. Its CI artifact lists every existing long
skill with a line count and SHA-256; the current corpus has 2,120 such skills and is triaged as
existing debt rather than being truncated wholesale. Four behavior cases pass locally; the
workflow gate still needs its full run.

G3 adds a deterministic lock over each canonical skill's repository-relative source and
SHA-256, an offline resolver that refuses unpinned or changed sources, and a `verify` step in
Skill Integrity. Pin/verify/drift, missing/unpinned sources and path-shaped names are covered
locally; the generated full-corpus lock and exact-head workflow result still need review.

The continuation review also requires plain parent directories in the resolver, so replacing
the pinned skill directory with a symlink/junction is refused even when its file bytes match.
The skill-lock suite now passes five tests.

I2 validates the final executable path after any confinement rewrite, rejects shell metacharacter
and control-character paths before spawn, and centralizes `windowsHide: true` for command
launches. Normal Windows paths with spaces, drive letters, both separators and `(x86)` pass.
Three focused checks and core typecheck pass on this Windows host; full exact-head evidence is
still pending.

The reviewed launch wrapper additionally forces `shell: false`; conflicting runtime options
cannot enable shell parsing or expose a Windows console. The broader continuation, including
D6 snapshot boundaries and Wave R lifecycle work, is recorded in
[the implementation review](implementation-review-2026-10-01.md).

## Streaming primitives

The frame parser now exposes open/finished/failed states, latches UTF-8 errors and rejects
over-limit frames even when another marker arrives in the same network chunk. Seven focused
cases pass. This closes an additional gap in the stricter A6 execution card beyond the
original five reference shapes.

The A5 snapshot utility emits explicit reset events for deep rewrites, suppresses transient
prefix deletion, keeps a 24-rune tail and partial details/quote markers, clamps UTF-16 offsets
at surrogate boundaries, and flushes reasoning before content. Five focused cases pass,
including 500 seeded sequences of 30 edits each with reconstructed-view and UTF-8 assertions.
A4's branch/runtime and A5's property evidence are local receipts; both task rows remain open
until the exact-commit acceptance gate is met.
It is an exported primitive awaiting a snapshot-producing provider adapter; the machine
status ledger records that distinction.

Rollback is per module or route. Existing endpoint success payloads and stored user data
need no migration. Disabling readiness callbacks leaves the database probe active. Disabling
swarm host handlers returns the documented simulation-only boundary.

## Wave 1 banner-frame scope correction

The checkout has six compact notice modules using the shared `STREAM_BANNER_FRAME` token:
attached-files, goal, handoff, org-trigger, scheduled, and skills. The inherited nine-module list
also included three different disclosure surfaces: the harness output card, the MCP connect
step, and the step banner itself. Those have independent interaction and layout contracts, so
the task now explicitly excludes them. `packages/web/test/stream-banner-frame.test.ts` renders
all compact notices and pins their exact class lists, including the separate handoff and model
switch variants. It also pins the harness card and process-step/MCP shells to their disclosure
classes. The focused suite passes 3/3 tests, and the web typecheck is green; full web-suite and
exact-head Wave 1 acceptance remain open.

G5's executable skill scripts contain no `rejectUnauthorized: false`; the remaining search hits
are verification-enabled examples or historical removed lines in `local.patch` files. The BGM
downloader now uses Node's built-in `fetch`, which keeps default certificate validation and accepts
custom roots through `NODE_EXTRA_CA_CERTS`. A direct HTTPS download from `https://example.com/`
returned 713 bytes with TLS verification enabled; its temporary output was removed. The separate
`bgm.js` ccMixter API path still uses the skill's declared Axios dependency and was not part of this
downloader smoke. G5's exact-commit checkbox remains open.

The full web integration run reached 2,531 passing tests and exposed two i18n parity failures:
nine literal server error codes were missing from both locale catalogs. English and Chinese
messages have now been added; `vitest run test/i18n-parity.test.ts` passes 2/2. The full web suite
then passed 2,533/2,533 tests across 207 files.

## Findings retention and output continuation

R1a now archives full evictions, operation ids, and timestamps inside the same atomic snapshot
as live records. Retention is capped at 1,000 entries, 4 MiB, and 90 days; recovery status exposes
archive counts and limits, while the tool offers paged archive reads and recall. Live references
to evicted records are pruned, and archived supersession targets use a tombstone id. Graph and
store fixtures cover rotation, restart, rank order, link cleanup, and a failed snapshot write.

R5 now provides version-2 UTF-8-byte-bounded pages for query, snapshot, events, and archive,
with hashed scope/filter/revision cursors, latest event sequence, explicit stale/gap errors,
oversized-record summaries, byte-exact recall chunks, and explicit version-1 compatibility.
The lock contention fast path passes the independent-process store fixture (50 durable writes).
Current focused results: full core `test/knowledge` 66/66 across 6 files; findings HTTP routes
19/19; core/server typechecks, core build, scoped core lint/format, and docs-claims check passed.
The R11 randomized replay and event-log round-trip cases are included; the replay fixed canonical
first-report tags, subjects, and source timestamps.
The initial grouped attempt also exposed two graph
assertions that expected dangling imported references to survive; those tests now match the cleanup
contract and the full knowledge suite is green. Static-quality, exact-commit, and human-review
gates remain open.

## Wave 2 output spill and recall

B1 injects a read-only `recall_output` tool into Sessions with a scratchpad. The model sees an
opaque id and `{recallId,sizeBytes,tokenCount}` metadata, never the archive path. It reads pages of
at most 12,000 UTF-16 code units; callers continue with `next_offset`. New ids are 32 hex digits,
while existing 12-digit ids remain readable. Stored text is credential-redacted, capped per entry
and per Session, retained for 30 days, and loaded again when the Environment is recreated. At
capacity, new saves fail instead of removing an issued id before expiry. Concurrent saves now
serialize their capacity check and write so one Session cannot oversubscribe its configured bound.

The tool contract is UTF-8 text, not arbitrary binary. Coverage includes NUL/control characters,
CRLF, multibyte and astral text, paged reconstruction, configured 40 KiB boundaries, fatal output
with long stderr, disabled spilling, wrong-Session ids, archive failure, restart, and expiry. A
failure stays uncompressed with bounded head/tail and its terminal reason inline; archive recall
does not replace that evidence. The focused B1 pair passes 44/44 tests, and the core typecheck
passes on 2026-10-02. The task remains unchecked until review and exact-commit acceptance pass.

## PR #12 status

The repository's PR #12 merged into `main` on 2026-09-30 at
`fc44861a4730a43c58d9accdbc9e15ee27003d8b`. Its exact-head CI record remains historical evidence;
the working tree's follow-up changes require their own review and checks.
