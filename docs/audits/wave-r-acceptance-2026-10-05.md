# Wave R acceptance reconciliation — 2026-10-05

Baseline: `c5159d6c6` (`codex/pr-15-review-fixes`). Scope: the eleven Wave R rows the task
register carried as IMPLEMENTED — R0, R1a, R1b, R1c, R2a, R2b, R2c, R4, R5, R8, R11.

Green CI is necessary but not sufficient. Each row below was reconciled criterion by criterion
against the card in `tasks/execution-cards-1.md`, using only evidence observed on this revision.

## What ran

| Suite | Command | Result |
| --- | --- | --- |
| Findings plane (core) | `packages/core` → `vitest run test/knowledge` | 6 files, **68 passed** |
| Findings routes (server) | `packages/server` → `vitest run test/findings-routes.test.ts` | 1 file, **21 passed** |

`TMP`/`TEMP` were pointed at `%LOCALAPPDATA%\Temp`; the default `C:\WINDOWS\TEMP` breaks tests that
enumerate their own temp parent. Prettier and `oxlint --deny-warnings` are clean on every file
touched here.

## Changes made during this reconciliation

| File | Change | Closes |
| --- | --- | --- |
| `packages/server/test/findings-routes.test.ts` | New case: an unrelated user is denied every project-scope read and write, no event is appended, and the owner's identical `confirm` then succeeds (positive control) | R0 unauthorized reads/writes, R1b denied-requests-append-no-event, R11 case 9 |
| `packages/core/test/knowledge/findings-graph.test.ts` | An authenticated human `confirm` override leaves `authoredBy` at `legacy-unknown` for a claim that never had provenance | R8 override is not a retroactive author change |
| `packages/docs/content/tools.en.md` / `tools.zh.md` | The two authorities are stated as permanently separate, and reopen is documented as retaining recorded evidence | R0 doc labelling, R1c reopen contract |

## Criterion reconciliation

Legend: ✔ met · ▣ structurally met, recorded rather than separately asserted · ○ not applicable yet,
with reason.

### R0 · Findings scope and authority contract

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| R0.1 inventory of both authorities | ✔ | `tasks/findings-scope-matrix.md`, one row per authority |
| R0.2 trusted scope identity, symlink normalization | ✔ | `canonicalWorkspaceDir` resolves + `realpathSync` (`knowledge-graph.ts:150`); the file header states no trusted workspace↔project mapping exists and the authorities must not be joined by path or name (`knowledge-graph.ts:145-148`) |
| Identical display names never bind scopes | ✔ | route `keeps workspace and project authorities separate across renames and name collisions` |
| Workspace and project stores remain independent | ✔ | same case |
| Workspace rename binds neither authority | ✔ | same case |
| Symlink aliases converge on one graph | ✔ | `shares one cached graph when the workspace is reached through a symlink` |
| Unauthorized reads/writes fail | ✔ | new case: 5 reads, 5 writes, all 404, owner's state unchanged |
| UI/docs label unmapped stores separately | ✔ (docs) / ○ (UI) | docs state the separation and that the binding is not enabled. No findings UI exists in `packages/web/src`; the clause is not yet applicable and is retained as a Wave 4 reopen condition |
| No binding or migration activated | ✔ | nothing binds the two authorities; R2d stays GATED |

### R1a · Eviction policy truth and reference hygiene

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Victim order matches the rank table; confirmed last | ✔ | `evicts in refuted, superseded, open, confirmed order`; `archives the lowest ranked finding at the count ceiling and keeps confirmed claims last` |
| Linked eviction survives a snapshot round trip | ✔ | `archives evictions, prunes live references, survives snapshots, and rotates by count and age` |
| Failed snapshot replacement preserves both collections | ✔ | `rejects an unarchivable eviction without partially mutating the graph`; store `releases queues and locks on callback and atomic write failures without acknowledging a mutation` |
| Retry cannot create a duplicate archive operation | ✔ | `planEvictions` builds the whole archive map before any live mutation (`findings-graph.ts:997`); the capacity error is thrown before the commit |
| Rotation obeys every bound | ✔ | archive limits 1,000 entries / 4 MiB / 90 days in `DEFAULTS`, asserted by the rotation case |
| `maxFindings = 0` rejected | ✔ | `findings-graph.test.ts:32` expects `RangeError` |
| No "nothing is lost" copy in the findings plane | ✔ | no loss language in `packages/core/src/knowledge/`, the findings route, or the en/zh tool docs |
| Bounded recovery reported honestly | ✔ | tool `refuses corrupt state and provides recovery status and a byte-exact raw export`; docs report archive count, bytes, oldest timestamp and limits, and state that the in-memory graph claims no filesystem durability |

### R1b · Lifecycle state machine, evidence gate, actor attribution

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Every matrix entry agrees across engine/tool/route | ✔ | engine `enforces every lifecycle transition and leaves rejected operations unchanged`; tool `enforces lifecycle transitions and host actor authority`; route `enforces lifecycle transitions and takes actors only from authentication` |
| Evidence-free confirmation rejected before mutation | ✔ | `requires proof or an attributed human override and copies audit actors` — a rejected confirm leaves `exportSnapshot()` byte-equal |
| Only an authenticated user with a reason can override or reopen | ✔ | `agent cannot request override` and blank-reason rejection are asserted; route `gates confirmation and records authenticated human override reasons` |
| New events carry actor and method | ✔ | event asserted with `actor`/`method`/`override`/`note`, and mutating the returned actor does not alter stored history |
| Legacy imports display `unknown`, never `user` | ✔ | route `shows agent, user, system and legacy authorship from events on both read paths`; engine `preserves imported identities and provenance while pruning dangling references` |
| Denied requests append no event | ✔ | new route case: eleven denials leave the event log at exactly `[ingest]` |
| Body-supplied actor ignored | ✔ | route actors come from `c.var.user`; tool actors from host context |

### R1c · Transition guards, dead-claim re-reports

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Invalid chains fail with the documented code before mutation | ✔ | engine `rejects non-live replacements, imported cycles, missing targets, and overlong chains`; route `rejects dead replacements and imported cyclic or overlong chains without writing` |
| Repeated refuted-claim reports create exactly one revision | ✔ | engine `creates stable contradiction revisions without changing falsified evidence`; route `preserves refuted claims, deduplicates revisions`; tool `re-reports refuted claims as revisions` |
| Links survive export/import | ✔ | `round-trips through export/import idempotently` |
| An agent report cannot reopen | ✔ | tool `cannot reopen or use a dead replacement`; `reopen` throws unless `context.actor.kind === "user"` and `context.method !== "tool"` (`findings-graph.ts:531-541`) |
| Reopen records actor and reason; evidence semantics documented | ✔ | `reopens only refuted claims through an attributed human action with a reason`; docs now state reopen returns the claim to `open` and keeps its recorded evidence (verified in source: `reopen` mutates only `status` and `updatedAt`) |

### R2a · Scope-aware store and acknowledged writes

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 50 parallel updates through two instances survive restart | ✔ | `keeps 50 concurrent updates through two instances per independent authority after restart` |
| One cross-process lock per authority | ✔ | `serializes independent Node processes against one authority` |
| Same-size external edits are observed | ✔ | `parses unchanged reads once and detects same-size external replacement` — the cache keys on a content fingerprint, not mtime+size |
| A failed durable operation never reports success | ✔ | `releases queues and locks on callback and atomic write failures without acknowledging a mutation` |
| Unmapped scopes stay distinct; `invalidate()` is isolated | ✔ | route name-collision case; `bounds cached scopes and permits the largest validated report in an empty store` |
| A concurrent force reload cannot replace a newer revision | ▣ | there is no separate force-reload entrypoint; `update()` re-reads and re-checks the revision under the lock, and `invalidate()` drops only the cache. Recorded as a structural property, not a named assertion |

### R2b · Bounds parity, byte cap, rehydrate cache

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Both ingresses enforce every table limit | ✔ | route `uses the same report limits as the tool and rejects a stale report revision` |
| High-water warning and hard-limit refusal | ✔ | `warns at high water, rejects oversized writes, and allows explicit terminal pruning with backup` |
| Largest valid report fits an empty store | ✔ | same case, using a report at every documented maximum (title 300, body 50,000, 100×500 subjects, 50×100 tags, evidence at quote/note 2,000) |
| Export and recovery stay available at capacity | ✔ | `keeps over-ceiling files exportable with bounded memory and preserves them on reset` |
| Two unchanged reads parse once; same-size rewrite invalidates | ✔ | `parses unchanged reads once and detects same-size external replacement` |
| The cap counts UTF-8 bytes, not characters | ▣ | `Buffer.byteLength(serialized, "utf8") > FINDINGS_MAX_BYTES` (`store.ts:382`); the multibyte case itself is exercised at the output budget (`summarizes oversized records and recalls their full multibyte JSON without losing bytes`) |
| Hydration memory/startup measurement | ○ | conditional — the criterion binds only if a cap is raised. No cap was raised. Reopens if 32 MiB or 5,000 findings ever change |

### R2c · Corruption quarantine and read-only recovery

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| ENOENT alone initializes an empty store | ✔ | `distinguishes absent state from corrupt/partial/unsupported snapshots and preserves raw bytes` — absent yields `recovery === null`, all four damage classes yield read-only |
| Normal writes never change invalid bytes | ✔ | rejected mutations assert the original file is byte-identical in every damage class |
| Repeated corrupt revisions cannot overwrite earlier quarantines | ✔ | one damaged revision keeps a single bounded copy; a distinct damaged revision yields a second path and both coexist (`quarantined()` length 2) |
| A tampered copy is never trusted as the original | ✔ | after tampering the read allocates a fresh quarantine |
| Failed quarantine still blocks mutation | ✔ | `keeps readable corrupt findings read-only when quarantine creation is denied` at both tool and route |
| An unreadable authority is classified, not guessed | ✔ | `classifies a denied canonical authority read as unreadable and rejects mutation` |
| Restore/reset need privilege, a reason, and the current revision; the original is kept | ✔ | `requires a human/reason/current revision to reset and records a preserved backup in the audit`; route audits every reset/restore |

### R4 · Route hygiene

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Unknown `kind`/`status` return 400 with the allowed values | ✔ | `validates GET enums with the same lists used by report`; route calls `enumField` with core's `FINDING_KINDS`/`FINDING_STATUSES` |
| Each enum has exactly one definition | ✔ | the route imports both arrays from core and defines no local literal; no `TIERS` literal remains |
| `%zz` ids return 400, not 500 | ✔ | `returns 400 for malformed finding-id encoding on every mutation ingress` |
| Unknown finding returns 404 | ✔ | `answers 404 for unknown findings and 400 for malformed input` |
| Evidence-free confirm returns 409 | ✔ | `maps only typed lifecycle rejection to 409` |
| Real engine errors stay 500 | ✔ | `keeps unexpected engine exceptions as 500 and leaves the persisted snapshot unchanged` — `mutate` rethrows anything that is not a typed error |
| No unused parameter | ✔ | `mutate(store, projectId, expectedRevision, action)` |
| Access denial precedes mutation | ✔ | every handler calls `requireProjectAccess` as its first statement, including the recovery route before the body is parsed; the new outsider case confirms 11 denials |

### R5 · Revision-aware, byte-bounded output

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 500-record traversal with no duplicate or missing id | ✔ | `pages 500 findings without duplicate or missing IDs on a fixed revision` |
| Cursor binds scope, filter, revision, sort | ✔ | `binds cursors to scope, filter and revision and rejects malformed tokens` |
| A changed revision forces an explicit restart | ✔ | a stale cursor returns `fatal: true` with `error.code === "stale_cursor"` and `restart: true`, and no items |
| Every response stays inside its UTF-8 byte budget | ✔ | the budget is applied after serialization, with envelope space reserved |
| Recall reconstructs exact bytes | ✔ | `"汉🚀".repeat(10000)` is recalled chunk by chunk, reassembled, and decoded with `TextDecoder(fatal: true)`; the decoded `body` and `id` match exactly |
| Event gaps are reported, not hidden | ✔ | `reports event gaps before claiming complete replay and supports oversized event recall` |
| Small legacy shapes stay compatible; oversized legacy fails explicitly | ✔ | `preserves small version-1 consumer shapes and refuses oversized compatibility results` |
| Archive paging exposes the full archived record | ✔ | `pages archived tombstones and recalls their full finding readback` |

### R8 · Agent-authored marking on read-back

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| `authoredBy` and `sourceLabel` are separate fields | ✔ | `shows attested authorship, status and evidence tiers separately from malicious source text`; engine `preserves attested authorship beyond the event window and ignores source labels` |
| Original author survives event rotation and archive recall | ✔ | `preserves attested authorship beyond the event window`; the recall case asserts `authoredBy === "agent"` on the reassembled record |
| A human override is not an author change | ✔ | added this pass: after an attributed `confirm` override, `readback().authoredBy` stays `legacy-unknown` |
| Absent provenance stays unknown | ✔ | route case covers agent, user, system and legacy authorship on both read paths |
| Every row shows status and strongest evidence tier | ✔ | tool case asserts both, derived from the finding's own evidence set |
| Both language guides updated | ✔ | `tools.en.md:123` and `tools.zh.md:115` describe `authoredBy`, the `legacy-unknown` fallback, rotation survival, and label separation |

### R11 · Findings-plane test battery — remains IMPLEMENTED

All eleven named cases have assertions (merge idempotency, event-log round trip, cycles, eviction and
reference hygiene, dead-claim re-report, bounded output and gaps, store concurrency and same-size
replacement, corruption quarantine, scope isolation and refusal, durable acknowledgement, cursor
revision binding). Two named outputs are missing and are the reason this row does not close:

- **R11.3** — the per-case regression ledger. Each named case requires isolating the pre-fix
  behaviour and recording the expected failing assertion, the fixture seed, and the observed result
  on the candidate. That experiment has not been run for these cases, so "the assertion detects the
  defect" is currently assumed, not shown.
- **R11.1** — the rule/case/layer/fixture matrix as a written artifact. Layer coverage is real
  (engine, tool and route cases exist for the lifecycle rules) but the matrix recording the reason
  for any absent layer has not been written.

The migration and rollback case stays out of scope: it runs only with an approved trusted binding
(R2d, GATED).

## What this receipt does not establish

- **R2d** remains GATED. Nothing here approves a workspace↔project binding, and no migration code
  was written or exercised.
- **R11.3** regression detection is unproven, as above.
- No findings UI exists, so the UI half of R0's labelling criterion could not be exercised.
- Wave 1–4 acceptance was not touched by this pass. 74 task IDs across those waves remain OPEN, and
  roughly 35 IMPLEMENTED rows still carry unreconciled acceptance.
