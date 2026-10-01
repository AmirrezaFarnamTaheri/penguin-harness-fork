# Implementation review and continuation — 2026-10-01

Scope remains Wave R and Waves 1–4. This record covers the reviewed boundaries and the
findings implementations added during this continuation. The full plan is not complete;
`tasks/plan.md` and `tasks/todo.md` remain the acceptance authority.

## Corrections to the latest implementations

| Task | Reviewed correction | Source |
|---|---|---|
| G3 | The offline resolver checks parent directories before opening a pinned skill, rejecting redirected skill directories as well as changed file bytes. A matching digest does not make a redirected source acceptable. | `scripts/skills/lock.mjs` |
| I2 | Command launches force both `shell: false` and `windowsHide: true`, even when a caller supplies conflicting runtime options. | `packages/core/src/environment/tools/command/spawn.ts` |
| D6 | Git snapshots verify blob object hashes, ignore inherited repository redirection and replacement objects, filter selected source paths before fetching blobs, and enforce aggregate byte limits without unsafe addition. The fixture now proves shared-object deduplication across commits. | `packages/core/src/codegraph/git-snapshot.ts` |

## Findings lifecycle and read-back

R1b implements `canTransition` and typed lifecycle rejections. Open findings can be confirmed,
refuted, or superseded; confirmed findings can be refuted or superseded. Repeating a status
change or moving a terminal claim through an ordinary lifecycle action is rejected before
mutation. Confirmation requires runtime or implementation evidence. An explicit human override
requires an authenticated user and a non-empty reason, and is recorded in the event. Tool
arguments cannot supply actor, method, override, or reopen authority. HTTP actor identities
come from authentication; tool actors come from host attribution, otherwise unknown.

New events carry copied actor metadata and the entry method. Legacy events remain readable
with unknown actors. Stored evidence and source objects are copied so later caller mutation
cannot silently change a claim or its evidence gate. Evidence identity includes its tier,
preventing documentation evidence from swallowing a later implementation report at the same
location.

R1c rejects non-live replacements, imported cycles, missing chain targets, and chains exceeding
64 hops with distinct typed supersession errors. Exactly 64 existing hops are accepted. A
matching report of a refuted claim creates a stable SHA-256 revision identity from canonical
claim/evidence data, with symmetric contradiction links. Replays create no duplicate claim;
the original falsification remains refuted. Reopening is a separate authenticated HTTP action
requiring a reason. Superseded claims cannot be reopened or rewritten by a matching report.
Contradiction links and reopen events survive snapshot round trips.

R4 validates GET enums against the shared core constants, rejects malformed percent-encoded
IDs and partial/unsafe integer filters, and maps only typed expected engine errors to client
errors. Unexpected engine errors remain 500 responses and leave the stored snapshot unchanged.

R8 exposes `authoredBy`, the attested author, status, and evidence tiers on query/snapshot
read-back. New findings persist their host-attested creator so event-log rotation and eviction do
not erase known authorship; older snapshots fall back to the original ingest event, then remain
unknown. The persisted creator field is omitted from the public read-back shape. Free-form source
labels cannot supply the author. Agent, user, system, and legacy fixtures cover both tool and HTTP
reads. Query bodies stay outside automatic briefings. English and Chinese tool docs describe the
durable provenance and bounded-history behavior.

Primary files: `packages/core/src/knowledge/types.ts`, `findings-graph.ts`,
`packages/core/src/environment/tools/knowledge-graph.ts`,
`packages/server/src/http/routes/findings.ts`, and `packages/docs/content/tools.{en,zh}.md`.

## Local verification

Earlier checkpoints cover the skill-lock, Git snapshot, command spawn, and Wave-R lifecycle tests.
The latest full core `test/knowledge` run passed 66 tests across 6 files; findings HTTP routes
passed 19/19; core and server typechecks, core ESM/declaration build, scoped core oxlint, Prettier,
docs-claims check, and `git diff --check` passed. The store suite includes 50 durable updates
across independent Node processes. A first grouped run exposed two old graph expectations
for dangling imported references; the tests were aligned to the documented cleanup contract, and
the complete findings run passed afterward. This is local worktree evidence, not a new exact-head
CI receipt.

This is local worktree evidence, not a new exact-commit CI receipt. Existing user edits were
preserved, and no commit, push, or third-party state change was performed.

## R11 lifecycle coverage map

The findings-plane battery now includes the two missing graph cases from the execution card:
100 seeded reports over 20 distinct claims replay without changing merged claim state, and a
snapshot round-trip preserves event sequence, type, actor, and method. The randomized replay
exposed and fixed inconsistent first-write normalization for tags, subjects, and source timestamps.

| Lifecycle rule | Core graph | Knowledge tool | HTTP route |
|---|---|---|---|
| Transition matrix and rejection without mutation | `findings-graph.test.ts` — `enforces every lifecycle transition and leaves rejected operations unchanged` | `knowledge-graph-tool.test.ts` — `enforces lifecycle transitions and host actor authority` | `findings-routes.test.ts` — `enforces lifecycle transitions and takes actors only from authentication` |
| Evidence gate and reasoned user override | `findings-graph.test.ts` — `requires proof or an attributed human override and copies audit actors` | `knowledge-graph-tool.test.ts` — same lifecycle/host-actor case; tool callers cannot request user overrides | `findings-routes.test.ts` — `gates confirmation and records authenticated human override reasons` |
| Replacement liveness, cycle and depth guards | `findings-graph.test.ts` — `rejects non-live replacements, imported cycles, missing targets, and overlong chains` | `knowledge-graph-tool.test.ts` — `re-reports refuted claims as revisions and cannot reopen or use a dead replacement` | `findings-routes.test.ts` — `rejects dead replacements and imported cyclic or overlong chains without writing` |
| Refuted re-report and separate reopen action | `findings-graph.test.ts` — `creates stable contradiction revisions without changing falsified evidence`; `reopens only refuted claims through an attributed human action with a reason` | `knowledge-graph-tool.test.ts` — tool reports remain unable to reopen | `findings-routes.test.ts` — `preserves refuted claims, deduplicates revisions, and requires a reason to reopen` |
| Attested actors, legacy unknown, and untrusted source labels | `findings-graph.test.ts` — `preserves attested authorship beyond the event window and ignores source labels` | `knowledge-graph-tool.test.ts` — `shows attested authorship, status and evidence tiers separately from malicious source text` | `findings-routes.test.ts` — `shows agent, user, system and legacy authorship from events on both read paths` |
| Event replay and snapshot persistence | `findings-graph.test.ts` — `snapshot round-trip preserves the events log` | `knowledge-graph-tool.test.ts` — `lifecycle actions update status and events replay the history` | `findings-routes.test.ts` — `runs the lifecycle: confirm, supersede, events replay` |

The tool layer deliberately has no reopen or human-override operation; the refusal is covered in
its host-authority tests. Scope and authorization are checked separately by the HTTP suite's
`keeps workspace and project authorities separate across renames and name collisions` case,
including 404 responses for an unrelated user. R0's contract approval remains an external review
gate and does not enable cross-authority migration.

## Remaining work

D7 now has a complete local storage boundary in `packages/core/src/codegraph/graph-store.ts` and
is exported through the codegraph package. `TopologyEngine.saveSnapshot` delegates persistence
to the store; the store owns JSON encoding, schema versioning, SHA-256 integrity, topology
validation, byte limits, and atomic replacement. Unsupported schema versions are reported as
rebuildable misses. Fixtures cover round-trip, future-version rebuild, checksum corruption,
invalid graph references, cancellation preserving existing bytes, and concurrent readers during
replacement. The focused graph-store plus atomic-write suites pass (13/13), and core typecheck
passes. The todo checkbox remains open for exact-commit review. The shared atomic writer now retries
transient Windows reader locks with a bounded delay and retains atomic rename semantics.

H7 now uses bounded Levenshtein matching against the active Commander's registered command and
option names. Registered option arity prevents unknown flag values from selecting an unrelated
command vocabulary. It emits only a unique nearby known spelling, suppresses unknown input and
inline values from parser errors, and leaves paths, ambiguous matches and distant tokens unsuggested.
The focused CLI usage suite passes 10/10 and CLI typecheck passes. The H7 checkbox remains open
until exact-commit review.

R1a now has a local atomic bounded archive, eviction/reference hygiene, archive summaries and
recall, with capacity-preflight and snapshot-write fault fixtures. Core graph, store, output, and
HTTP route checks pass locally; typecheck/build are green. R2a–R2c now have connected local implementations and receipts in the
[findings-store ledger](findings-store-2026-10-01.md); their dependency/review and exact-commit
acceptance gates remain open. R2d follows the plan's explicit trusted-binding prerequisite; independent workspace
and project authorities must not be merged by guessed names or paths. R5 paging/cursors and its
contract fixture are implemented and the focused route/core findings checks pass. R0's review gate,
exact-commit wave acceptance, and remaining static quality gates remain open. R11's named local
coverage and lifecycle mapping are complete in the worktree; exact-head evidence remains open.

The existing Wave 1–4 unchecked rows remain in scope, including G3/I2 final acceptance and
D6 integration/acceptance beyond the reviewed snapshot reader. F6 now has an exact rendered-class
regression test for the six compact notice modules and the three excluded disclosure shells; the
focused test, full web suite (2,533/2,533), web typecheck, scoped oxlint and Prettier pass. F6's
local acceptance is complete; its tracker stays open under the exact-commit rule. Broader Wave 1
acceptance remains open. None of these waves is declared complete by local checks alone.

The core `dist/` build used by the server is retained. The workspace cleanup report found
nothing disposable; its apply pass was also run. User data and existing Rust build caches
are preserved. All test/typecheck/build processes started for this review have exited;
no development server was launched.
