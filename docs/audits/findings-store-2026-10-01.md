# Findings store implementation — 2026-10-01

R2a–R2c now have local implementations connected to both findings ingress paths. Their
exact-commit acceptance and dependency gates remain open; this is not a wave completion receipt.

## Authority and durable updates

`packages/core/src/knowledge/store.ts` introduces `FindingsStore` with explicit workspace or
project scope, one authority path, revision-bearing reads, and serialized updates. Canonical
parent paths converge symlink aliases without inventing a workspace/project binding. Store
leaves must be regular files; an opened descriptor is checked against the inspected inode.
Missing files start empty; inaccessible paths and damaged files do not.

The existing server lock implementation moved to `packages/core/src/internal/file-lock.ts`.
The generic server JSON store and the findings store share that implementation, including
ownership checks, heartbeat, dead-owner recovery and the SQLite recovery mutex. Findings
updates share one queue per canonical authority across store instances and release it on error.
Results are returned only after a successful atomic write. Callback failures and failed writes
leave the previous authority intact and do not leak an unsaved graph through the cache.

Tool mutations accept an optional expected `revision`. All HTTP finding mutations accept
`If-Match`, including quoted ETags. Stale mutations fail rather than overwriting newer state.
Content fingerprints invalidate cached snapshots after same-size external replacement. The
hydrated snapshot cache has eight entries; unchanged reads avoid repeated JSON parsing.

## Validation and capacity

`packages/core/src/knowledge/validation.ts` owns the report validator and field limits. Tool
and HTTP reports use it with host-supplied identity; malformed enums, arrays, evidence fields,
unsafe line numbers, and oversized strings are rejected. Evidence is rejected rather than
silently truncated. Validation does not trust request/model actor or source identity.

The serialized store warns at 24 MiB and refuses writes above 32 MiB or 5,000 live findings.
The continuation now commits full eviction records and operation IDs in the same atomic snapshot
as the live graph. The archive is limited to 1,000 entries, 4 MiB, and 90 days, with oldest-first
rotation. Eviction order is refuted, superseded, open, then confirmed, oldest within each rank.
Live related links are pruned; a superseded target retained only in the archive has an explicit
tombstone ID. Recovery status exposes archive count, bytes, oldest timestamp and limits. A failed
snapshot replacement leaves both live state and archive unchanged. High-water state appears in
recovery status and HTTP `X-Findings-High-Water` headers. Authenticated operators can still prune
terminal claims after acknowledging the action; pruning keeps a full backup and records actor and
reason.

An externally supplied file above the byte ceiling enters capacity recovery. Its revision is
hashed in bounded chunks, and raw pages remain exportable. Reset/restore backups use file
copying rather than loading an oversized file into a single buffer.

## Corruption and explicit recovery

The store validates UTF-8, snapshot version, full finding records, duplicate IDs, evidence,
event shapes and increasing sequences. A malformed record makes the scope read-only; it is
not silently skipped and persisted as a reduced graph. Valid legacy version-1 snapshots remain
readable with unknown actors where attribution is absent.

Corrupt bytes are preserved in uniquely named quarantine copies with the file's permission
bits. A failed quarantine keeps the original and still rejects normal mutation. Recovery
status includes scope, revision and the recovery reason. Raw export pages return base64 so
invalid UTF-8 and truncated JSON can be copied byte for byte.

HTTP reset, restore and prune require authentication, explicit acknowledgement, a current
revision and a non-empty reason. Agents have diagnostic/raw-export access but no recovery
mutation action. Reset/restore preserve the original bytes before replacement, and the new
snapshot records the operation, actor, reason, previous revision, backup and operation ID.
Malformed restore input is refused before changing the authority.

Deletion/recreation fixtures now assert file authority: removed findings are not resurrected
from an old cache. An unreadable workspace returns recovery failure instead of an empty query.

## Verification

- Core `test/knowledge`: **54 tests passed across 5 files**.
- Server findings routes and generic JSON-store lock recovery: **21 tests passed across 2 files**.
- Core typecheck, core ESM/declaration build, and server typecheck passed.
- `git diff --check` passed.

Fixtures cover 50 concurrent mutations through two instances for each authority kind, 50
mutations through two independent Node processes, same-size replacement, unchanged-read parse
caching, callback/write failure, corrupt/partial/unsupported snapshots, quarantine/read denial,
raw export, human reset/restore, preserved backups, high water, rejected oversized writes,
terminal pruning, the 5,000-confirmed-finding ceiling, bounded cache entries and a report with
every permitted field at its maximum length/count. HTTP checks cover corrupt-state refusal,
operator acknowledgement, revision conflict, common limits, raw export and recovery auditing.

These local receipts do not substitute for the exact-commit CI or supported-host evidence
required by `tasks/plan.md`. POSIX permission bits are preserved; Windows DACL behavior is not
proved by a Node mode value on this host.

## Remaining scope

R0's review gate remains open. R1a's local implementation includes bounded graph rotation,
preflighted archive capacity, link cleanup, same-snapshot persistence, and snapshot-write rollback.
R5 provides version-2 query/snapshot/events/archive envelopes, revision-bound cursors, latest event
sequence, gap and recall handling, explicit v1 compatibility, and a 500-record contract fixture.
R8 now persists host-attested creator identity so bounded event rotation does not erase known
authorship while keeping the stored creator field out of the public read-back shape. The full core
`test/knowledge` suite passes (66 tests across 6 files), the HTTP findings route suite passes 19
tests, core/server typechecks and core build pass, and scoped core lint/format and docs-claims checks
are green. R11's exact-commit evidence and broader wave gates remain
open. R2d remains inactive
without the plan's trusted binding; workspace and project authorities remain independent. All
remaining Wave 1–4 tasks stay in scope.

## Continuation: R1a archive and R5 pages

This continuation supersedes the earlier statements above that R1a had no durable eviction
archive and that confirmed records were never evicted. The current graph retains confirmed
records last and writes evicted records into the same snapshot as the live graph. The finite
archive is available through paged archive reads and full-record recall. Snapshot write failure
keeps the prior live graph and archive together.

R5 emits a version-2 envelope for query, snapshot, events and archive actions. Its cursors bind the
scope, revision, normalized filters, and stable identity; envelopes include the latest event
sequence. Oversized findings and events use recall IDs with base64 JSON chunks. Explicit version 1
keeps legacy small consumer shapes. The process-contention fast path now passes the 50-write
independent Node-process fixture; all three focused core findings files pass across the grouped
run and graph rerun, and the HTTP findings route file passes 19 tests. Core typecheck and build
also pass after the final graph changes. R11's named test cases and lifecycle coverage map are
complete locally; exact-commit quality/CI and review gates remain open.

At the end of the preceding continuation, the rebuilt core `dist/` was retained for the server.
Workspace cleanup report and apply both found nothing disposable; user data and existing Rust
caches were preserved. All processes started for those checks exited. That continuation made no
commit, push or external-resource change.

## Follow-up — quarantine-denied ingress coverage (2026-10-03)

**Scope:** R2c's cross-ingress recovery contract, specifically the case where reading damaged
bytes succeeds but exclusive quarantine creation is denied. This is an additional acceptance
slice, not closure of R2c or R11.

**Baseline/candidate:** committed baseline `ec20a0c148a801591cb291b50236072ae9424744`; final
candidate `fe633e0ffeacbc1b0b92dc56b01169a4cc8800d8` adds tests in
`packages/core/test/knowledge/knowledge-graph-tool.test.ts` and
`packages/server/test/findings-routes.test.ts` (plus an independent watcher-test timeout
adjustment). Local environment: Linux x64, Node `v22.22.3`, pnpm `11.18.0`; Node is below the
repository's `>=24` engine. The first candidate CI run
[37148746240](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37148746240)
passed Linux/Windows core and server tests, but failed a separate macOS watcher-removal wait.
After the isolated wait adjustment, exact run
[37149941481](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/actions/runs/37149941481)
passed all 21 jobs, including core, server, macOS/Windows, and aggregate `ci`.

**Change and acceptance:** both ingress tests inject `EACCES` only for the canonical authority's
`.quarantine-*` exclusive open, prove the injection fired, and assert that recovery remains
read-only with `reason: corrupt` and `quarantineError`, no quarantine path is claimed, a report
is refused, the bounded raw export remains available, and the original bytes are unchanged.
The tool test passed as part of the focused core group. The HTTP test is included in server
typecheck; its local Vitest run could not resolve the generated `@prismshadow/penguin-core`
package entry from the injected workspace snapshot, but the exact candidate's `test (server)` CI
job passed.

**Verification:** direct Vitest run for `findings-store.test.ts`,
`knowledge-graph-tool.test.ts`, and `findings-output-contract.test.ts` passed **31/31**; the
knowledge tool file passed **12/12**, including the new denied-quarantine case. Direct core build
and core/server/web TypeScript checks passed. Prettier and `git diff --check` passed. Browser E2E
was not run locally; the repository instruction is to rely on CI for it.

**Residual:** exact candidate CI is green, but R11's isolated defect-detection ledger, R0's
review gate, all remaining R2c criteria, and human review are still open. The affected authority
and bindings remain unchanged.
