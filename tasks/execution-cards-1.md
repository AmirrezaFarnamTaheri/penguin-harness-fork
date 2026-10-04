# Execution Cards — Vol. 1: Wave R + Wave 1

Documentation reconciled on 2026-10-04. Current status and release gates are in
[todo.md](todo.md) and [work-orders.md](work-orders.md); these requirements and historical
observations do not certify the changed working tree.

Companion to [plan.md](plan.md) (architecture, readiness, sources) and [todo.md](todo.md)
(canonical checklist and current work-state authority). Historical verification below is
evidence for its recorded revision, never a new completion declaration from this rewrite.

Phase R and Waves 1–4 may run in parallel. Select the highest-ROI ready task from any wave,
including prerequisites that unlock valuable work elsewhere. Reserve overlapping files, agree
shared contracts, and obey each card's gate before dependent integration, activation, or closure.
A wave label does not impose a blanket wait for another wave to finish. Inventory, interface,
and fixture packages can proceed when their own inputs are available.

Each ordered package ends with an observable output; acceptance and failure/rollback criteria
remain beside the task. Verification commands and fixtures are instructions for a future
authorized implementation run, not claims that this documentation edit ran them. Cards also
follow the [implementation-guide evidence procedure](implementation-guide.md) and
[plan acceptance and release gates](plan.md#acceptance-and-release). Locate current symbols before editing: inherited audit
line numbers and dependency versions describe their dated evidence. Later-wave cards have one
owner in [execution-wave-2.md](execution-wave-2.md),
[execution-wave-3.md](execution-wave-3.md), and [execution-wave-4.md](execution-wave-4.md).

---

<a id="r0"></a>

## R0 · Findings scope and authority contract

**Gate:** Ready for contract/fixture work; approval gates authority binding and migration activation.

**Inventory:** Tool writes `<realpath(workspace)>/.penguin/knowledge/findings-graph.json`; server
routes write `projectDir(config.root, projectId)/.findings_graph.json`. The project DB row has no
workspace path. These remain separate authorities by default; a trusted mapping may later establish
that they describe the same logical project. The full matrix is
`tasks/findings-scope-matrix.md`; it includes scope key, owner, path, readers/writers, auth check,
backup, equivalence proof, and unmapped behavior. Core resolves existing workspace paths before
keying its cache, preventing symlink aliases from creating competing in-memory graphs.

**Decision:** Derive canonical scope ids from trusted project/workspace metadata, never a
model-supplied path. Resolve and normalize symlinks before comparison; verify ownership on
every HTTP read/write. A missing/ambiguous mapping keeps the two scopes separate with visible
labels. Record a migration manifest fixture for same, different, corrupt, and missing files.

**Exit:** The cross-layer fixture proves that two projects sharing a display name are distinct,
workspace and project stores remain independent, workspace rename does not bind either authority,
symlink aliases converge on one graph, and an unrelated user cannot read or write the project
scope. Any future path rebinding is explicit and audited. Local store work may proceed against this
contract, but no authority binding or migration may be activated until the contract is approved in
the PR; local implementation alone does not satisfy that review gate.

**Ordered work packages:**

1. <a id="r0.1"></a>**R0.1 — Inventory both authorities.** Enumerate tool/server paths, owners, readers, writers, permission checks, backups, and absence of a workspace field on ProjectRow. **Output:** the completed findings-scope-matrix with one row per authority and explicit unmapped behavior.
2. <a id="r0.2"></a>**R0.2 — Define trusted scope identity.** Specify metadata provenance, realpath/symlink normalization, rename/deletion behavior, inaccessible/shared-workspace handling, and ownership checks. **Output:** a scope-id contract and same/different/corrupt/missing-file migration manifest fixtures.
3. <a id="r0.3"></a>**R0.3 — Prove isolation at both entrypoints.** Exercise same display names, workspace rename, symlink aliases, owner/member access, and unrelated users against the contract. **Output:** a tool/route assertion table with the expected authority and permission result for every case.

**Acceptance:** every authority has an owner and permission boundary; identical names never bind scopes; aliases share one workspace cache; unauthorized reads/writes/bindings fail; UI/docs label unmapped stores separately. Binding activation additionally requires explicit approval of the contract in the PR.

**Failure / rollback:** an ambiguous mapping, guessed path, or unauthorized access keeps binding disabled. Revert scope-resolution changes to separate labelled authorities; retain both original byte streams and mapping evidence.

<a id="r1a"></a>

## R1a · Eviction policy truth & reference hygiene

**Gate:** Integration/closure requires R2a durable transactions; victim/rotation fixtures can be prepared in parallel.

**Invariant:** Live graph is bounded; archived history is recoverable only within the published
retention window. The archive is stored in the same authority snapshot, not as a separate 32 MiB
backup; bounded rotation can discard older entries. Remove
“nothing is lost” from comments and product copy.

**Build:** Keep rank order `refuted → superseded → open → confirmed`, oldest `updatedAt` first
inside a rank. Store the full victim, an operation id, and archive time in the same version-1
snapshot as active records. Bound the archive to 1,000 entries, 4 MiB, and 90 days. One atomic
snapshot replacement commits both collections; a failed write leaves both unchanged, so retries
cannot create a duplicate archive operation. Clean `related` references and replace an archived
`supersededBy` target with a resolvable tombstone id. Expose archived records through bounded
archive pages and recall; report count, bytes, oldest time, and limits through recovery status.

**Tests:** rank order and confirmed-last; linked eviction and snapshot import; disk-full or
atomic-snapshot replacement failure after eviction; restart/retry idempotency; rotation and the
documented recoverability limit; `maxFindings = 0` rejection. Use a small graph cap to force the
branch without adding thousands of records; retain one full-cap fixture for the durable store.

**Rollback:** Preserve the old snapshot and archive bytes; disabling the feature must not make
new-format snapshots unreadable. Do not delete an archive while rolling back a code change.

**Ordered work packages:**

1. <a id="r1a.1"></a>**R1a.1 — Encode victim selection and archive bounds.** Implement ranked, oldest-first selection and archive limits of 1,000 entries, 4 MiB, and 90 days in version-1 snapshots. **Output:** deterministic victim/rotation fixtures, including confirmed-last and maxFindings = 0 rejection.
2. <a id="r1a.2"></a>**R1a.2 — Commit eviction as one store transaction.** Archive the full victim with operation id/time, clean related links, and resolve supersededBy through a tombstone before replacing the snapshot. **Output:** an atomic live/archive mutation with restart/retry identity fixtures.
3. <a id="r1a.3"></a>**R1a.3 — Expose bounded recovery honestly.** Add archive pages/recall and count, bytes, oldest time, and limits to recovery status; distinguish an in-memory export from filesystem durability. **Output:** recovery examples and updated retention copy.

**Acceptance:** victim order matches the rank table; no live related/supersededBy reference dangles; failed snapshot replacement preserves both collections; retries archive one logical victim; rotation obeys every bound; bounded history is described accurately.

**Failure / rollback:** duplicate archive operations, dangling references, or success after disk/write failure block activation. Restore the prior transaction implementation while retaining readable new snapshots, the old snapshot, and archive bytes.

---

<a id="r1b"></a>

## R1b · Lifecycle state machine, evidence gate, actor attribution

**Gate:** Integration/closure requires R1a archive/lifecycle compatibility; define the frozen matrix and attribution seam in parallel with R2a.

**Goal:** Transitions become enumerated, gated, attributed — the audit protocol as code.

**Data shapes:**

```ts
export type ActorKind = "user" | "agent" | "system" | "unknown";
export interface Actor {
  kind: ActorKind;
  id: string;
}
export interface FindingEvent {
  seq;
  type;
  findingId;
  at;
  note?;
  actor?: Actor;
  method?: "tool" | "route" | "engine";
} // optional only for legacy reads
export type LifecycleErrorCode =
  | "illegal_transition"
  | "evidence_gate"
  | "replacement_not_live"
  | "cycle"
  | "dangling_replacement"
  | "chain_too_deep";
export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}
export function canTransition(from: FindingStatus, to: FindingStatus): boolean;
```

**Transition matrix (encode as a frozen record; this table is the spec):**

| from \ to  | open                                                              | confirmed         | refuted           | superseded           |
| ---------- | ----------------------------------------------------------------- | ----------------- | ----------------- | -------------------- |
| open       | —                                                                 | ✔ (evidence gate) | ✔                 | ✔ (replacement live) |
| confirmed  | ✖ (use reopen)                                                    | —                 | ✔ (falsification) | ✔ (replacement live) |
| refuted    | ✔ **only** via an authenticated, reasoned user `reopen` operation | ✖                 | —                 | ✖                    |
| superseded | ✖                                                                 | ✖                 | ✖                 | — (immutable)        |

**Evidence gate:** `confirm(id, opts)` where `opts = { note?, actor, override?: boolean }`;
requires `finding.evidence.some((e) => e.tier === "runtime" || e.tier === "implementation")` —
otherwise it rejects unless `override === true`, `opts.actor.kind === "user"`, and `note` is a
non-empty string after trimming. Reject before mutating the finding or appending an event; the
override reason is recorded as the transition note. A blank or missing reason never bypasses the
evidence gate.

**Actor plumbing:** routes build `actor = { kind: "user", id: c.var.user.userId }`; the tool
uses host-attested `ctx.attribution`. If it is absent, record `legacy-unknown`/unattributed and
deny privilege-bearing overrides. Never convert missing attribution to `system`. Body-supplied
actors are ignored. New confirm/refute/supersede/reopen/link events include actor + method;
legacy snapshots with absent actor remain readable and display `unknown`, not `user`.

**Build steps:** 1) types + `canTransition` + `LifecycleError`; 2) gate check in `confirm`; 3) `assertTransition` at the top of `confirm/refute/supersede/reopen`; 4) actor on events; 5) thread `actor` through tool + routes (R4 shares the call sites); 6) `reopen(id, actor, reason)`
as a distinct user action; 7) keep an old-snapshot import fixture.

**Tests:** `rejects confirming an evidence-free finding` · `user override records the actor` ·
`illegal transitions throw typed codes` (table-driven over the matrix) · `events name the actor` ·
`tool ignores body-supplied actor` · `agent cannot request override` · `legacy actor stays unknown`
(route + tool layers). Verify that the route requires the right project access for each action.

**Ordered work packages:**

1. <a id="r1b.1"></a>**R1b.1 — Freeze the lifecycle contract.** Implement shared Actor/enums, canTransition, and typed LifecycleError codes from the matrix above. **Output:** an exhaustive from/to decision table consumed by engine, tool, and route fixtures.
2. <a id="r1b.2"></a>**R1b.2 — Guard mutations before events.** Put transition/evidence checks before writes and add distinct reasoned user reopen; require trimmed non-empty override reasons. **Output:** guarded confirm/refute/supersede/reopen methods and rejection snapshots with unchanged graph/event sequence.
3. <a id="r1b.3"></a>**R1b.3 — Carry trusted attribution end to end.** Derive route users from authentication and tool actors from host context, record unknown for missing legacy attribution, and ignore body actors. **Output:** actor/method-bearing new events plus legacy-import and forged-actor fixtures.

**Acceptance:** every matrix entry has the same engine/tool/route result; evidence-free confirmation is rejected; only an authenticated user with a reason can override/reopen; new events carry actor/method; legacy imports display unknown; denied requests append no event.

**Failure / rollback:** actor forgery, privilege from absent attribution, or mutation before rejection blocks rollout. Restore the previous public entrypoints while preserving event fields and readable snapshots; keep override/reopen disabled until their guards pass.

---

<a id="r1c"></a>

## R1c · Transition guards: cycles, liveness, dead-claim re-reports

**Gate:** Integration/closure requires R1b lifecycle/error/actor contract.

**Build steps:**

1. `supersede(id, replacementId, opts)`:
   - self-check (existing `:309`);
   - **liveness**: `replacement.status ∈ {open, confirmed}` else `LifecycleError("replacement_not_live")`;
   - **cycle walk** (bounded and fail-closed):
     ```ts
     let cur = replacementId;
     const visited = new Set<string>();
     for (let hops = 0; hops < 64; hops++) {
       if (visited.has(cur)) throw new LifecycleError("cycle", "Replacement chain contains a cycle.");
       visited.add(cur);
       const f = this.findings.get(cur);
       if (!f) throw new LifecycleError("dangling_replacement", …);
       if (f.id === id) throw new LifecycleError("cycle", …);
       cur = f.supersededBy ?? "";
       if (cur === "") break;
     }
     if (cur !== "") throw new LifecycleError("chain_too_deep", …);
     ```
2. Dead-claim re-report: for a matching `refuted` claim, derive a new revision id from canonical
   claim plus evidence digest and predecessor id; replaying the same report returns that same
   revision. Use a typed contradiction relation or explicit relation metadata, not a tag whose
   meaning depends on later C5 work. A report against a `superseded` claim follows its live
   replacement or creates a distinct open claim; it never mutates the terminal old record.
3. `reopen` is a separate route action limited to the authenticated user with a reason. A tool
   report cannot set it. Document whether reopening a claim resets confirmation evidence.

**Tests:** imported cycle and >64-hop chain are rejected; a normal `a→b` followed by `b→a`
fails the liveness gate; replacement must be live; repeating a report after refutation creates
one stable new claim; agent-supplied reopen is rejected; user reopen is reasoned and attributed.

**Ordered work packages:**

1. <a id="r1c.1"></a>**R1c.1 — Validate replacement chains.** Add live-target, self/cycle, missing-node, and 64-hop fail-closed guards before supersession. **Output:** normal-chain, imported-cycle, dangling-target, non-live-target, and over-depth fixtures with distinct typed errors.
2. <a id="r1c.2"></a>**R1c.2 — Give dead-claim reports stable revision identity.** Derive ids from canonical claim/evidence/predecessor, persist a typed contradiction relation, and follow live replacements without changing terminal records. **Output:** repeat-report and snapshot round-trip fixtures showing one new open revision.
3. <a id="r1c.3"></a>**R1c.3 — Separate human reopen from report.** Route authenticated, reasoned reopen through R1b; document whether confirmation evidence resets. **Output:** an explicit reopen contract and tool/user authority comparison.

**Acceptance:** invalid chains fail with the documented code before mutation; repeated refuted-claim reports create exactly one revision and preserve the predecessor; links survive export/import; an agent report cannot reopen; user reopen records actor/reason.

**Failure / rollback:** a terminal claim mutates, a chain escapes its bound, or a replay creates a duplicate blocks the change. Revert new report/reopen handling while retaining revision ids and contradiction links already persisted.

---

<a id="r2a"></a>

## R2a · Scope-aware findings store and acknowledged writes

**Gate:** Authority selection requires R0's approved scope contract; independent unmapped stores can be implemented against it.

**Interface (new `packages/core/src/knowledge/store.ts`):**

```ts
export interface FindingsStore {
  readonly scopeId: string;
  read(): Promise<{ snapshot: FindingsGraphSnapshot; revision: string; recovery: RecoveryState }>;
  update<T>(
    expectedRevision: string | null,
    fn: (graph: FindingsGraph) => T | Promise<T>,
  ): Promise<{ result: T; revision: string }>;
  invalidate(): void;
}
export class StoreCorruptionError extends Error {
  quarantinedTo?: string;
}
```

**Authority:** R0 chooses the canonical path for a mapped logical scope. An unmapped workspace
and server project keep separate scope ids; the UI must say which is being shown. Use one
cross-process lock and atomic-write implementation for both paths (extract the proven server
seam or compose it, avoiding independent lock files for the same authority). Clone the graph
inside a transaction; only replace the cached graph after the write succeeds. Return a typed
failure when write, flush, rename, or lock acquisition fails. Never treat an unwritable
workspace as a successful report.

**Cache:** key by canonical scope and a durable revision/content fingerprint, not just mtime+size;
bound entries and invalidate after every commit. Avoid a second hydration cache in the route if
the shared store already caches. A concurrent force reload must not replace a newer in-memory
revision. Read-only calls may serve a validated cached copy; writers always recheck under lock.

**Tests (`test/knowledge/findings-store.test.ts`):**

- `serializes concurrent updates` — 50 parallel reports through two store instances for each
  independent authority, then restart → 50 findings per authority. A shared tool/route ingress
  test joins the suite only if R2d's trusted mapping is implemented.
- `observes same-size external edit` — preserve mtime if the fixture platform permits; next
  `read()` still reflects the revision change.
- `never acknowledges an uncommitted report` — inject permission, full disk, rename, and lock
  failures; the call fails and the old snapshot remains readable.
- `keeps unmapped scopes distinct` — identical titles in unrelated project/workspace scopes do
  not mix. `invalidate()` cannot invalidate another scope.

**Rollback:** keep old format readable before R2d migration; do not remove the legacy paths in
the same change as the new lock contract.

**Ordered work packages:**

1. <a id="r2a.1"></a>**R2a.1 — Introduce the shared store boundary.** Implement the interface above with R0 scope/path selection, one lock per canonical authority, cloned transaction graphs, and a shared serializer/error contract. **Output:** store implementations for separate tool and server authorities.
2. <a id="r2a.2"></a>**R2a.2 — Acknowledge only durable commits.** Wire both ingresses to update; propagate permission/full-disk/flush/rename/lock failures and release lock/in-flight state on exceptions. **Output:** fault fixtures and an acknowledgment/restart ledger.
3. <a id="r2a.3"></a>**R2a.3 — Validate bounded revision caching.** Key by canonical scope and durable fingerprint, recheck writers under lock, invalidate on commit, and prevent force reload from replacing a newer revision. **Output:** two-instance concurrency and same-size external-edit fixtures.

**Acceptance:** 50 parallel reports through two instances survive restart for each independent authority; a failed durable operation never returns success; same-size edits are observed; cache entries remain bounded and isolated; exception cleanup allows a later update. Shared cross-ingress authority is accepted only after R2d's approved binding.

**Failure / rollback:** lost acknowledgments, overlapping locks for one authority, or stale reads block switching ingresses. Restore legacy ingress wiring and paths while retaining committed store snapshots and the old-format reader.

---

<a id="r2b"></a>

## R2b · Bounds parity + store byte cap + rehydrate cache

**Gate:** Integration/closure requires R2a store/revision/cache interface.

**Shared validator (`knowledge/validation.ts`) — the exact caps (both paths call it):**

| field            | cap                                                      |
| ---------------- | -------------------------------------------------------- |
| title            | 1–300 chars                                              |
| body             | ≤50,000                                                  |
| subjects         | ≤100 entries × ≤500                                      |
| evidence         | ≤100 entries; quote ≤2,000; note ≤2,000; line ≥0 integer |
| tags             | ≤50 × ≤100                                               |
| note (lifecycle) | ≤2,000                                                   |

**Capacity:** 24 MiB UTF-8 serialized bytes is the high-water warning and 32 MiB is the hard
cap per live store; keep the 5,000-finding count cap. Prove the largest permitted single report
fits in an empty store and measure hydration memory/startup before raising the cap. At capacity,
reads, export, archive inspection, and recovery stay possible; only a new
write that cannot fit fails with `StoreTooLargeError`. **Cache:** reuse R2a's bounded revision
cache; do not add an unrelated route cache. **Tests:** shared limit table for tool/route;
high-water warning and hard-limit refusal; export/recovery at capacity; two unchanged reads
parse once; same-size rewrite invalidates.

**Ordered work packages:**

1. <a id="r2b.1"></a>**R2b.1 — Share the exact input limits.** Implement one validation table for every field above and call it from tool/route before transactions. **Output:** boundary fixtures at and one unit beyond each cap with identical error classification.
2. <a id="r2b.2"></a>**R2b.2 — Enforce serialized capacity.** Measure UTF-8 bytes, warn at 24 MiB, refuse a new write exceeding 32 MiB or the 5,000-finding cap, and retain export/archive/recovery. **Output:** largest-allowed-report, multibyte-capacity, and recover-capacity fixtures plus hydration memory/startup measurements.
3. <a id="r2b.3"></a>**R2b.3 — Reuse R2a's hydration cache.** Confirm unchanged reads parse once, external same-size changes invalidate, and many-project cache retention stays bounded. **Output:** parse-count/revision/cache-size observations and no second route cache.

**Acceptance:** both ingresses enforce every table limit; the largest valid report fits an empty store; existing data remains readable/exportable at capacity; a rejected write leaves bytes/revision unchanged; two unchanged reads parse once. Raising a cap requires measured supported-host memory/startup/disk evidence; capacity handling preserves confirmed evidence.

**Failure / rollback:** cap bypass, unreadable full stores, or independent stale caches block activation. Restore previous capacity enforcement/cache wiring and retain stored bytes; provide export/prune access during rollback.

---

<a id="r2c"></a>

## R2c · Corruption quarantine and read-only recovery

**Gate:** Integration/closure requires R2a failure/transaction interface.

**Flow:** `ENOENT` creates a new empty store; parse/validation/unsupported-version errors do not.
On corruption: copy original bytes to a uniquely named, permission-preserving quarantine file,
emit one structured event per revision, and mark the scope read-only. `snapshot`/tool output
reports `recoveryRequired` without presenting an empty graph as truth. A privileged recovery
action can export raw bytes, restore a selected backup, or explicitly reset after a second
confirmation; it preserves the corrupt original. Quarantine failure still blocks writes.
**Tests:** invalid JSON, partial JSON, unsupported version, unreadable file, quarantine failure,
repeated corruption, restore/reset, and a valid legacy snapshot. Verify no normal write changes
the original bytes in every error case.

**Ordered work packages:**

1. <a id="r2c.1"></a>**R2c.1 — Classify store read failures.** Separate ENOENT from parse, schema, unsupported-version, and unreadable-file errors. **Output:** one fixture per category; only ENOENT initializes an empty store.
2. <a id="r2c.2"></a>**R2c.2 — Preserve corruption and refuse writes.** Copy exact bytes to unique permission-preserving quarantine, emit one structured event per revision, and expose recoveryRequired through tool/routes even if quarantine fails. **Output:** byte/permission comparisons, repeat-error event counts, and read-only status fixtures.
3. <a id="r2c.3"></a>**R2c.3 — Make recovery explicit and attributable.** Add privileged raw export, selected-backup restore, and reset after a second confirmation; retain the original. **Output:** restore/reset authorization and audit fixtures, including valid legacy import.

**Acceptance:** normal writes never change invalid/unreadable original bytes; repeated corrupt revisions cannot overwrite earlier quarantines; failed quarantine still blocks mutation; empty initialization is ENOENT-only; restore/reset require privilege and preserve original evidence.

**Failure / rollback:** corruption presented as an empty truth, overwritten originals, or unauthenticated recovery blocks release. Disable recovery mutations and retain read-only/raw-export access, original/quarantine files, and the prior valid backup.

<a id="r2d"></a>

## R2d · Existing-store migration and rollback

**Gate:** Apply is deferred until an explicit authorized R0 binding and R2a/R2c acceptance; dry-run fixtures can be prepared independently.

**Dry-run first:** for a scope R0 proved equivalent, enumerate both old files, permissions,
hashes, counts, event sequences, and same-id conflicts. Back up both exact byte streams before
the first mutation. `same id + different content` is a conflict for review, never last-write-wins.
Preserve the trusted actor and event provenance during deduplication; assign a new revision only
after deterministic reconciliation.

**Apply:** acquire the canonical scope lock; recheck the manifest hashes; write the new snapshot
atomically; verify by read-back/restart; switch the route and tool to it. Keep old files for a
documented rollback window. An interrupted or repeated migration resumes/idempotently reports
the same result. **Fixture matrix:** both empty, tool only, route only, identical, divergent,
corrupt side, concurrent writer, interrupted write, and rollback after one successful report.

**Ordered work packages:**

1. <a id="r2d.1"></a>**R2d.1 — Prove eligibility and produce a dry run.** Require R0's approved owner/binding record; enumerate both paths, permissions, hashes, counts, revisions, event sequences, and same-id conflicts. **Output:** a deterministic manifest and explicit outcome for both-empty, tool-only, route-only, identical, divergent, and corrupt-side fixtures.
2. <a id="r2d.2"></a>**R2d.2 — Back up and apply under the canonical lock.** Preserve both exact byte streams, recheck manifest hashes, reconcile actor/event provenance, and replace the new snapshot atomically. **Output:** backup hashes and concurrent-writer/interrupted/rerun migration results.
3. <a id="r2d.3"></a>**R2d.3 — Prove switch and rollback.** Read back/restart before switching tool/route, document the old-file retention window, and demonstrate rollback after one successful post-migration report without losing acknowledgment. **Output:** authority-switch and restore ledger covering all fixture outcomes.

**Acceptance:** approved trusted binding precedes any real mutation; same-id divergence requires explicit review; all fixture outcomes are deterministic; rerun is idempotent; hashes changed during apply cause refusal; read-back/restart and rollback preserve every acknowledged finding.

**Failure / rollback:** no binding, unresolved conflict, corrupt side, or changed manifest blocks apply. Keep authorities separate; after a failed switch, restore backed-up paths/route behavior and preserve the new snapshot plus acknowledged post-migration records for reconciliation.

---

<a id="r3"></a>

## R3 · Report & governance reconciliation

**Gate:** Ready for current documentation reconciliation; retained dated evidence is historical.

**Historical evidence (2026-09-30; inspect for reuse):** Moved the dated audit to `docs/audits/2026-09-29-unified.md`, kept a short root pointer, and
reconciled its historical baseline with current branch status. Added the checked-in
`docs/policies/porting-and-refusals.md` and linked it from the plan and README.
**Verification:** docs suite 7/7 files and 53/53 tests, docs typecheck, Prettier, and targeted
contradiction/path/policy-link checks all passed.

**Ordered work packages:**

1. <a id="r3.1"></a>**R3.1 — Separate historical evidence from current status.** Check dated audit Parts 3/5 and the root pointer against the current canonical todo ledger. **Output:** a contradiction inventory with source date/path for each retained historical claim.
2. <a id="r3.2"></a>**R3.2 — Reconcile governance references.** Keep the audit under docs/audits, make porting/refusals and source/license review policy canonical, and connect plan/README pointers. **Output:** the policy and resolvable links from both entrypoints.
3. <a id="r3.3"></a>**R3.3 — Review documentation consistency.** Check stale no-commit headers, policy paths, status wording, and audit baseline preservation. **Output:** a file/claim/link review table with any unresolved contradiction.

**Acceptance:** current documents make no contradictory completion claim; historical dates/baselines remain intact; the root points to the dated audit; policy exists and both plan/README links resolve. The historical verification below applies only to its recorded revision; current state remains in the index.

**Failure / rollback:** deleted historical evidence, broken policy pointers, or unsupported current claims block reconciliation. Restore the affected document/pointer and retain the contradiction inventory for the next review.

---

<a id="r4"></a>

## R4 · Route hygiene

**Gate:** Integration/closure requires R1b typed errors, shared enums, and trusted actor plumbing.

**Concrete edits (`packages/server/src/http/routes/findings.ts`):**

1. `enumQuery(c, "kind", KINDS)` / `enumQuery(c, "status", STATUSES)` — same error text family as
   `enumField` (400 listing the enum).
2. Replace the catch-all in `mutate`:
   ```ts
   catch (err) {
     if (err instanceof UnknownFindingError) throw notFound(err.message);
     if (err instanceof LifecycleError) throw err.code === "evidence_gate" ? conflict(err.message) : badRequest(err.message);
     throw err;   // real 500s stay 500s
   }
   ```
   (adds `conflict()` to `http/validate.ts` if absent).
3. `safeParam(c, "findingId")` — `decodeURIComponent` in try/catch → `badRequest` on `URIError`.
4. Delete the route's `TIERS`/enum literals; import from core (`packages/core/src/knowledge/types.ts`
   exports `EVIDENCE_TIERS`, `FINDING_KINDS`, `FINDING_SEVERITIES`, `FINDING_STATUSES` — add these
   const arrays next to the types in R1b's pass).
5. Drop the unused `_c` parameter from `mutate`.
   **Tests (`test/findings-routes.test.ts` additions): `rejects unknown query enums with the enum
list` · `engine type errors surface as 500` (stub the store to throw `TypeError`) · `malformed
finding ids are 400 not 500` · `confirm requires evidence (409)`.

**Ordered work packages:**

1. <a id="r4.1"></a>**R4.1 — Centralize enums and decode validation.** Replace route literals with core arrays, validate kind/status query values, and handle malformed URI ids at the boundary. **Output:** one enum owner plus unknown-enum and malformed-id response fixtures.
2. <a id="r4.2"></a>**R4.2 — Map only known engine errors.** Map UnknownFindingError to 404, evidence_gate to 409, other lifecycle errors to 400; rethrow unexpected errors and remove the unused parameter. **Output:** typed-error/status mapping and injected TypeError = 500 fixture.
3. <a id="r4.3"></a>**R4.3 — Check access and caller compatibility.** Exercise confirm/query/mutation with project access and shared actor wiring from R1b. **Output:** route contract table showing status, enum list, actor source, and untouched data on rejection.

**Acceptance:** ?kind=vibes and unknown status return 400 with allowed values; %zz ids return 400; unknown finding returns 404; evidence-free confirm returns 409; real engine errors remain 500; each enum has one definition; access denial precedes mutation.

**Failure / rollback:** unexpected errors disguised as client errors or unauthenticated writes block activation. Revert route mapping/validation changes while preserving core lifecycle guards and previously readable request/response shapes.

---

<a id="r5"></a>

## R5 · Revision-aware, byte-bounded tool output

**Gate:** Integration/closure requires R2a revision-aware reads; archive pagination additionally requires R1a's archive contract.

**Protocol:**

```ts
type Page<T> = {
  version: 2;
  action: string;
  items: T[];
  scopeRevision: string;
  latestSequence: number;
  nextCursor: string | null;
  truncated: boolean;
  omittedCount: number;
  highWater: boolean;
  error?: { code: string; restart: boolean };
};
// cursor = opaque, versioned encoding of hashed scope + revision + normalized filter hash + stable sort key
```

- `query`, `snapshot`, `events`, and `archive` use the version-2 envelope. Sort snapshot by `id`,
  events by `seq`, and archive by `(archivedAt,id)`; reuse identical filters, limit, scope, and
  revision on every page. Scope/filter mismatch and stale revisions return typed restart errors.
  Event gaps include the earliest retained sequence and the graph's latest sequence.
- Enforce a UTF-8 byte budget **after** serialization; reserve envelope space. If one body or
  event cannot fit, emit a summary and recall id. `recall` returns base64 chunks of the exact JSON
  bytes; concatenate decoded bytes and parse once. Never cut JSON text.
- `outputVersion: 1` is an explicit, small-output compatibility path for the legacy query,
  snapshot, and events shapes. It has no cursor and returns a typed error when the full result
  exceeds budget. Version 2 is the default.
  **Tests:** 500-record traversal without gaps/duplicates; mutation mid-page; wrong scope/filter;
  multibyte budget; single 50,000-char body; event-log truncation; JSON.parse for every variant;
  legacy consumer fixture. Roll back by selecting the compatibility mode, not by slicing JSON.

**Ordered work packages:**

1. <a id="r5.1"></a>**R5.1 — Define the page/cursor contract.** Implement version-2 envelopes and opaque cursors bound to scope/revision/filter/sort; sort ids, event seqs, and archive time/id as specified. **Output:** a 500-record traversal and typed stale/scope/filter mismatch fixtures.
2. <a id="r5.2"></a>**R5.2 — Serialize within the byte budget.** Reserve envelope bytes, replace oversize records/events with summaries/recall ids, and emit exact JSON bytes as base64 recall chunks. **Output:** multibyte and 50,000-char body fixtures with measured serialized lengths and reconstructed bytes.
3. <a id="r5.3"></a>**R5.3 — Preserve legacy reads and expose event gaps.** Implement explicit outputVersion: 1 for small legacy query/snapshot/events; report earliest retained/latest seq and typed oversized-legacy refusal. **Output:** legacy consumer and retained-event-gap fixtures.

**Acceptance:** fixed-revision pages traverse all 500 records without duplicate/missing ids; every response parses and stays inside its UTF-8 byte budget; mutation causes a restart error; recall reconstructs exact bytes; legacy small shapes remain compatible and oversized legacy output fails explicitly.

**Failure / rollback:** truncated JSON, silently mixed revisions, missing gap markers, or altered legacy shapes block rollout. Select the bounded compatibility mode while retaining version-2 readers and issued recall data; never restore character slicing.

---

<a id="r6"></a>

## R6 · code_graph resource discipline

**Gate:** Ready; coordinate the cache interface with D11 without waiting for another wave.

**Shape (`packages/core/src/environment/tools/code-graph.ts`):**

```ts
const inflight = new Map<string, Promise<CacheEntry>>(); // single-flight
const MAX_CACHED = 8; // LRU by lastUsed
async function graphFor(workspaceDir: string, force: boolean) {
  const hit = cache.get(workspaceDir);
  if (hit && !force && Date.now() - hit.scannedAt < TTL) return hit.watcher;
  const running = inflight.get(workspaceDir);
  if (running && !force) return (await running).watcher;
  const p = (async () => {
    const w = new CodeGraphWatcher(workspaceDir);
    await w.scanWorkspace();
    return { watcher: w, scannedAt: Date.now() };
  })();
  inflight.set(workspaceDir, p);
  try {
    const entry = await p;
    putLRU(workspaceDir, entry);
    return entry.watcher;
  } finally {
    inflight.delete(workspaceDir);
  }
}
```

`putLRU` closes evicted watchers (`watcher.close()`); TTL refresh closes the old watcher **after**
the new scan succeeds (the current code closes first — the leak window). `stats()` gains
`{ cachedWorkspaces, evictions, scans }`. Docs answer (tools.en/zh): "`scanWorkspace()` installs
no file watchers; only `init()` does, and this tool never calls it."
**Tests:** `20 concurrent index calls perform exactly one scan` (counter on a spy) · `LRU closes
evicted watchers` · `TTL refresh does not leak the old watcher` · `docs claim matches code`
(string assertion is overkill — cite the line in the PR instead).

**Ordered work packages:**

1. <a id="r6.1"></a>**R6.1 — Share in-flight scans by workspace.** Extract the cache seam, return the existing scan promise to concurrent callers, and clear in-flight state on success/failure. **Output:** 20-concurrent-index scan counts and a rejected-scan retry fixture.
2. <a id="r6.2"></a>**R6.2 — Bound and close cache resources.** Enforce LRU 8, close evictions, retain the old watcher until a replacement succeeds, and close failed replacements while keeping the stale entry for retry. **Output:** 10-workspace size/close counts, TTL-success/failure fixtures, and cachedWorkspaces/evictions/scans stats.
3. <a id="r6.3"></a>**R6.3 — Align tool diagnostics and docs.** Distinguish hit/scan and state that only init installs watchers, which this tool never calls. **Output:** en/zh guidance and a cited current watcher-entrypoint source.

**Acceptance:** 20 concurrent index calls perform exactly one scan and zero init calls; 10 workspaces leave at most 8 cache entries and observe 2 closes; replacement failure closes only its new watcher, preserves the old graph, releases in-flight state, and permits the next retry.

**Failure / rollback:** double scans, unclosed entries, or old-graph loss after failed refresh block the change. Restore the prior cache seam, close newly created watchers, and preserve a usable scanned graph; retain the corrected documentation.

---

<a id="r7"></a>

## R7 · Memory-plane honesty (Option B selected)

**Gate:** Ready; supplies the measured baseline and honest claim evidence to C2/J11.

List actual consumers of `retention.ts` and freeze a small recall fixture with retained and
retrieved items, write volume, and latency. Label the module unconsumed/experimental and reword
`FindingsGraph.strength` to its actual creation-recency math; do not claim access reinforcement
from `createdAt`. Leave default retention unchanged. C2 owns any later opt-in policy proposal:
it needs a named consumer, pinned-memory survival, restart/rollback tests, and a measured gain
on the frozen fixture before C3 can use it.

**Ordered work packages:**

1. <a id="r7.1"></a>**R7.1 — Inventory actual consumers.** Trace retention exports, test consumers, production call paths, and RecallStore's independent bounds. **Output:** a symbol/consumer table distinguishing exports from active policy execution.
2. <a id="r7.2"></a>**R7.2 — Freeze existing recall behavior.** Capture ranking, retained/retrieved items, retained window, write volume, and latency in test/memory/recall-baseline.fixture.json. **Output:** a repeatable baseline for C2 with fixture method and measured values.
3. <a id="r7.3"></a>**R7.3 — Correct memory claims.** Mark policy experimental/unconsumed and describe strength from creation age; align ledger/report/tool documentation with that formula. **Output:** evidence-linked wording and the consumer inventory.

**Acceptance:** docs/formula/fixtures agree; the ledger distinguishes exported policy from RecallStore behavior; default retention/eviction remains unchanged. A future C2 activation requires a named consumer, pinned-memory survival, restart/rollback evidence, and measured fixture gain before C3 uses it.

**Failure / rollback:** a consumer cannot be substantiated or documentation claims access reinforcement from createdAt blocks closure. Revert unsupported wording/policy wiring, preserve the baseline fixture, and keep Option B/default retention.

---

<a id="r8"></a>

## R8 · Agent-authored marking on read-back

**Gate:** Integration/closure requires R1b trusted actor/event contract.

`query`/`snapshot` rows expose `authoredBy` from host-attested creation context and `sourceLabel`
from untrusted report text as separate fields. Persist the original actor on each new finding so
bounded event-log rotation and archive eviction do not erase known authorship; old snapshots fall
back to their trusted ingest event, then to `legacy-unknown`. A user override is not retroactively
an author change. Every row shows status and strongest evidence tier; the tool description says
these are claims requiring verification. Tests cover agent, user, system, legacy, event rotation,
archive recall, and a forged body actor. Update `packages/docs/content/tools.en.md` and `tools.zh.md`.

**Ordered work packages:**

1. <a id="r8.1"></a>**R8.1 — Persist immutable creation attribution.** Store the host-attested original actor on new findings; use legacy trusted ingest events then legacy-unknown when importing old snapshots. **Output:** agent/user/system/legacy and forged-body-actor fixtures.
2. <a id="r8.2"></a>**R8.2 — Render provenance separately from report labels.** Return authoredBy/sourceLabel, status, and strongest evidence tier in query/snapshot and archive recall. **Output:** tool/route read-back contracts before/after event rotation, eviction, and human override.
3. <a id="r8.3"></a>**R8.3 — Explain claim trust in both languages.** Update tool descriptions and en/zh guides; keep free-form labels/body text outside trusted identity and automatic briefings. **Output:** bilingual claim/provenance examples.

**Acceptance:** actor categories remain distinct; labels cannot impersonate a user; original author survives event rotation/archive recall and overrides; legacy absent provenance remains unknown; each row exposes status and evidence tier without blanket agentAuthored inference.

**Failure / rollback:** trust inferred from labels or author rewritten by override blocks rollout. Revert new display wiring while preserving persisted original actors and readable legacy snapshots; show unknown where trust is unavailable.

---

<a id="r9"></a>

## R9 · Bounded batch fan-out

**Gate:** Ready; coordinate shared sidebar ownership with any concurrent UI task.

`packages/web/src/components/layout/sidebar.tsx` — extract `runBounded<T>(ids, worker, limit = 8)`
(promise-pool); use it in `batchArchive` and `confirmBatchDelete`. Preserve semantics exactly
(per-id settle, succeeded/failed split, retention of failed marks). **Test:** mocked endpoint
records concurrency peaks; 200 ids → peak ≤ 8; partial-failure contract unchanged (existing e2e
still green).

**Ordered work packages:**

1. <a id="r9.1"></a>**R9.1 — Extract the bounded ordered worker pool.** Implement the shared helper at limit 8, validate concurrency, and return per-id settled results in input order. **Output:** worker-pool contract and invalid-limit fixtures.
2. <a id="r9.2"></a>**R9.2 — Wire both batch actions.** Route batchArchive and confirmBatchDelete through the same pool, preserving succeeded/failed splits, cleanup, and failed selections. **Output:** both action integrations and partial-failure state snapshots.
3. <a id="r9.3"></a>**R9.3 — Demonstrate bounded fan-out.** Record mocked endpoint peaks for 200 ids and inspect one rejected item amid successful neighbors. **Output:** peak/order/result ledger aligned with the existing batch E2E flow.

**Acceptance:** a 200-item batch peaks at no more than 8; result order equals input order; one rejection neither rejects the whole batch nor stops later ids; invalid concurrency is rejected; failed marks remain selected and successful ones settle/clear as before.

**Failure / rollback:** lost selections, unordered id/result association, or excess fan-out blocks integration. Restore batch wiring and retain the verified helper; rollback must preserve each outstanding item's success/failure state.

---

<a id="r10"></a>

## R10 · Tool-schema token cost measurement

**Gate:** Ready for portable measurements; schema trimming depends on the >1,500-token probe rule.

Method: freeze one agent config from before PR #12 and the PR head; serialize the actual default
tool payload, including catalog/lazy exposure, with the same code path the agent sees. Record
`{chars, chars/4 estimate, provider-tokenizer tokens when available}` per tool and total. Run a
tiny task-success probe if the delta exceeds 1,500 estimated tokens; trim schema descriptions
only if the probe confirms no routing loss. Commit a path-free measurement script. The four
preexisting `tools/measure-q*` scripts contain local paths and stay outside the PR.

**Ordered work packages:**

1. <a id="r10.1"></a>**R10.1 — Freeze comparable tool configurations.** Select pre-PR #12 and candidate revisions with the same agent config; resolve actual default direct/lazy exposure through the agent payload path. **Output:** portable configuration/revision fixture and tool-name inventory.
2. <a id="r10.2"></a>**R10.2 — Measure exact serialized payloads.** Add a path-free measurement script reporting per-tool/total chars, chars/4 estimate, and provider-tokenizer counts where available. **Output:** before/after table including lazy catalog behavior and tokenizer availability.
3. <a id="r10.3"></a>**R10.3 — Apply the routing-loss gate.** If estimated delta exceeds 1,500 tokens, run the frozen tiny task-success probe, then trim or justify schemas using its outcomes. **Output:** below-threshold decision or probe evidence and description-change rationale.

**Acceptance:** the new script reproduces the table in a clean checkout; both revisions use the same config/exposure method; estimates are labelled; absent provider counts are explicit; any >1,500-token delta has task-success evidence, and trimming preserves routing.

**Failure / rollback:** incomparable fixtures, unpublished method, or routing loss after trimming blocks closure. Restore schema descriptions and retain the measurement/failed probe; leave all four local measure-q* scripts outside the PR.

---

<a id="r11"></a>

## R11 · Findings-plane test battery

**Gate:** Closure requires R0, R1a/R1b/R1c, R2a/R2b/R2c, and R5; fixture design can run alongside their implementations.

Named cases (a regression assertion should fail against the relevant pre-fix code when isolated):

1. `merge idempotency under randomized reports` (seeded LCG, 100 reports over 20 titles).
2. `snapshot round-trip preserves the events log` (seq + actor + type).
3. `supersede cycles` (R1c) · 4. `eviction + reference hygiene` (R1a) · 5. `dead-claim re-report`
   (R1c) · 6. `bounded parseable output and gap` (R5) · 7. `store concurrency and same-size external
replacement` (R2a) · 8. `corruption quarantine` (R2c) · 9. `separate-scope isolation and
unauthorized binding refusal` (R0/R2a) · 10. `acknowledged write survives restart and write
failure never reports success` (R2a) · 11. `revision cursor rejects a changed snapshot` (R5).
   The two-path migration and rollback suite runs only if R2d's binding prerequisite is met. Property loops use a
   tiny seeded PRNG (no new deps). Keep one table mapping each lifecycle rule to engine, tool, and
   route assertions; a missing layer requires a written reason.

**Ordered work packages:**

1. <a id="r11.1"></a>**R11.1 — Map every rule to assertions.** Create one engine/tool/route coverage table for all 11 named cases above and record a reason for any absent layer. **Output:** rule/case/layer/fixture matrix using R0/R1/R2/R5 contracts.
2. <a id="r11.2"></a>**R11.2 — Build deterministic regression fixtures.** Use a tiny seeded LCG for 100 reports over 20 titles; add events round-trip, concurrency, corruption, isolation, durable acknowledgment, and revision-cursor cases. **Output:** reproducible fixtures with no new PRNG dependency; migration fixtures remain conditional on R2d.
3. <a id="r11.3"></a>**R11.3 — Prove the assertions detect the defects.** Isolate the relevant pre-fix behavior for each named regression and record the expected failing assertion, then candidate result. **Output:** a per-case regression ledger with fixture seed, defect, and observed result.

**Acceptance:** every named case has an assertion and an isolated defect-detection result; round-trip preserves seq/actor/type; 50-update stores survive restart; denied/failed writes cannot appear successful; a changed revision invalidates cursors. Migration/rollback runs only with approved trusted binding.

**Failure / rollback:** flaky unseeded loops, cases passing pre-fix defects, or uncovered layers without reasons block closure. Revert unsupported assertions/production changes separately, keep useful deterministic fixtures, and leave affected task gates open.

---

<a id="r12"></a>

## R12 · A11y verification pass

**Gate:** Ready for baseline accessibility evidence; F1's affected focus fixes require this gate for closure.

`packages/web/e2e/a11y.spec.mjs`: chat page, sidebar, settings — run `axe-core` (add as a devDep
if absent; it is already referenced by prior audits' tooling) and assert zero `critical`/`serious`;
add keyboard-only flows: Tab to the batch bar, operate Delete, Escape semantics; dark-mode
contrast sampling on `--color-text-secondary`; target-size sweep (≥24px per WCAG 2.5.8 floor the
app already states). Output: `a11y-report.md` in the PR with the raw counts.

**Ordered work packages:**

1. <a id="r12.1"></a>**R12.1 — Record surface/theme coverage.** Define chat/sidebar/settings fixtures and collect axe critical/serious counts with exact candidate revision and theme. **Output:** per-surface raw results in a11y-report.md.
2. <a id="r12.2"></a>**R12.2 — Exercise keyboard and visual requirements.** Walk every desktop and mobile Tab stop plus batch Delete/Escape flows, inspect visible focus for every control, sample dark secondary-text contrast, and sweep mobile target sizes and overflow against the ≥24px stated floor. **Output:** desktop/mobile keyboard/focus, contrast, target-size, and mobile overflow results with affected controls and viewport sizes.
3. <a id="r12.3"></a>**R12.3 — Fix observed failures and rerun affected flows.** Coordinate shared focus-token changes with F1 and report remaining manual-review cases explicitly. **Output:** targeted fixes and revised raw-count/interaction evidence.

**Acceptance:** chat, sidebar, and settings each have zero critical/serious axe findings; every desktop/mobile Tab stop is reached with visible focus; Delete/Escape semantics hold; contrast, mobile ≥24px targets, and mobile overflow checks have concrete passing outcomes; unresolved manual-review cases are named.

**Failure / rollback:** an inaccessible control, lost focus, unexamined serious finding, or undocumented manual case blocks closure. Revert the affected visual/interaction change, retain failure evidence, and keep the accessibility gate open.

---

<a id="r13"></a>

## R13 · CI truth pass

**Gate:** Ready for current candidate diagnosis; publishing/running remote CI follows the user's external-action authorization.

**Historical blocker:** PR #12 run `36563549648` has 155 browser cases passed, two skipped, one
failed. At `packages/web/e2e/skills.spec.mjs:246`, `getByText("使用 data-analysis 技能", {exact:true})`
resolves to sidebar title, chat heading, and message paragraph, causing a Playwright strict-mode
failure. Aggregate `ci` failed; the other reported jobs passed.

**Repair sequence:** scope the locator to the intended message/card (prefer a role or test id
with product meaning), then verify the dropdown selection cleared and the sent message really
contains the invocation. Inspect the same flow for an actual update-order race; if present, fix
the product state transition as well. Run the named case, full browser suite, then the complete
PR matrix on the exact pushed SHA. Record per-job result and run URL in the report. A green
targeted rerun alone does not close R13. CI Node = 24; local runs recorded in the plan used 26.

**Ordered work packages:**

1. <a id="r13.1"></a>**R13.1 — Reproduce and scope the invocation assertion.** Locate the current skills flow, target its intended message/card by meaningful role/test id, and assert selection clearing plus sent invocation. **Output:** a focused assertion change and locator/race diagnosis.
2. <a id="r13.2"></a>**R13.2 — Resolve any product ordering race.** Trace selection/send updates before deciding locator-only; fix an observed state transition without weakening the invocation assertion. **Output:** flow-state evidence and focused/full-browser results.
3. <a id="r13.3"></a>**R13.3 — Collect the complete candidate CI ledger.** After authorized publication, record exact pushed SHA, Node 24, every required job, aggregate ci, and run URLs. **Output:** per-job candidate results with explained skips/failures.

**Acceptance:** the named flow proves dropdown clearing and actual invocation text; full browser E2E and aggregate ci are green on the same candidate SHA; all required jobs have recorded results. The historical 155 passed/2 skipped/1 failed run and Node 26 local results cannot substitute for this ledger.

**Failure / rollback:** a broad assertion, unresolved race, unexplained red, or differing SHAs blocks closure. Restore the affected flow/assertion if it regresses behavior; preserve failed-run evidence and leave the release gate open.

---

<a id="r14a"></a>

## R14a · Electron high-severity repair

**Gate:** Ready for dependency inventory/patch preparation; release requires exact candidate runtime/audit evidence.

**Historical evidence (2026-09-29):** the audited lockfile resolves desktop `electron@43.2.0`; the 2026-09-29 audit reports
four high advisories, with the strictest patched floor at 43.5.0. Update the desktop manifest
and lockfile to a supported 43.x version at or above that floor. Inspect the lockfile diff for
unexpected runtime changes. Test desktop launch, server utility process, same-origin window,
installer and packaged binaries on Windows/macOS/Linux. **Negative case:** a manifest change
that leaves the bundled binary at 43.2.0 fails the release gate. **Rollback:** ship the previous
release artifact; never republish a known vulnerable binary as a successful upgrade.

**Ordered work packages:**

1. <a id="r14a.1"></a>**R14a.1 — Trace the shipped Electron resolution.** Inspect desktop manifest/lockfile and identify packaged/runtime candidate versions against the historical 43.2.0 finding and four high advisories. **Output:** manifest/lock/runtime version inventory.
2. <a id="r14a.2"></a>**R14a.2 — Make the narrow compatible 43.x update.** Resolve a supported 43.x version ≥43.5.0 and review unexpected lockfile/runtime changes. **Output:** dependency diff and Electron advisory audit results.
3. <a id="r14a.3"></a>**R14a.3 — Validate actual release artifacts.** Exercise launch, utility process, same-origin window, installer, and packaged runtime on Windows/macOS/Linux for the exact candidate. **Output:** binary-version and platform smoke ledger.

**Acceptance:** the actual bundled binary is supported 43.x ≥43.5.0; no Electron high advisory remains in the audit; all named runtime/installer cases pass for the candidate across three platforms. A patched manifest with a bundled 43.2.0 binary fails.

**Failure / rollback:** affected binary, remaining high advisory, or platform failure blocks release. Use the previous release artifact for rollback and retain the candidate evidence; an affected rebuild cannot be labelled a successful upgrade.

---

<a id="r14b"></a>

## R14b · Undici runtime and build-chain repair

**Gate:** Ready for both-path inventory/patch preparation; release requires compatible patched branches and audit/smoke evidence.

**Historical evidence (2026-09-29):** audit JSON reports runtime `undici@7.29.0` and transitive desktop build-chain
`undici@6.28.0` against the same decompression advisory. Update the server range/resolution to
≥7.29.1 and the builder chain to ≥6.28.1 with the narrowest compatible change. Review both
paths in `pnpm audit --json`; a single clean runtime path is insufficient. Run server
WebSocket/HTTP tests and desktop package smoke. **Negative case:** a broad override that forces
7.x into the 6.x chain fails compatibility review. **Rollback:** revert the dependency update
and block release until a compatible patched path is available.

**Ordered work packages:**

1. <a id="r14b.1"></a>**R14b.1 — Inventory both Undici branches.** Trace server runtime and desktop build-chain resolutions against historical 7.29.0/6.28.0 advisory paths. **Output:** runtime/build dependency-path table from audit JSON.
2. <a id="r14b.2"></a>**R14b.2 — Patch each compatible major separately.** Update runtime to ≥7.29.1 and build-chain 6.x to ≥6.28.1 through the narrowest supported dependency/resolution change. **Output:** reviewed manifest/lockfile diff with no blanket 7.x override into 6.x.
3. <a id="r14b.3"></a>**R14b.3 — Prove audit and runtime compatibility.** Inspect both audit paths and exercise server WebSocket/HTTP plus desktop package smoke. **Output:** branch-specific audit and candidate smoke ledger.

**Acceptance:** audit JSON reports neither named vulnerable path; the runtime and build-chain patched floors both hold in resolved dependencies; server WebSocket/HTTP and desktop packaging pass; lockfile review confirms compatible branch treatment.

**Failure / rollback:** only one branch fixed, decompression advisory remaining, or major-version incompatibility blocks release. Revert the dependency change, preserve audit evidence, and keep release blocked until a compatible patched path exists.

---

## Wave 1 cards

<a id="a2"></a>

### A2 · FailureStatusTracker + error taxonomy triple

**Gate:** Ready; A1 consumes the tracker/error contract after this card's acceptance.

`packages/core/src/llm/failure-status.ts`:

```ts
export class FailureStatusTracker {
  note(status: number): void;
  finalStatus(): number; // last non-429 seen; else 429 if any failure; else 502
}
```

Wire into the rotation loop (A1 owns the call site — A2 lands the class + unit tests first).
Error contract: `HttpError.kind` classifies expected/unexpected failures; `english` returns the
message fallback; `i18nKey` defaults to `errors.byCode.<code>`. The response adds an optional
`i18nKey`, and the web client prefers a known own-property key before falling back to code/message.
The locale checker scans literal `new HttpError(..., "code", ...)` calls; dynamically constructed
codes use the constructor fallback. Tests cover tracker branches, error metadata/serialization,
client propagation, safe translation lookup, old-server fallback, and bilingual code parity.

**Ordered work packages:**

1. <a id="a2.1"></a>**A2.1 — Implement the exhaustion-status tracker.** Encode last non-429, all-429, and no-failure behavior independently of A1's rotation wiring. **Output:** FailureStatusTracker and its exhaustive branch table.
2. <a id="a2.2"></a>**A2.2 — Carry error metadata through server/client.** Add kind, English fallback, optional serialized i18nKey, and safe web key selection with old-server/code/message fallback. **Output:** constructor/serialization/client contract fixtures, including inherited/unknown translation keys.
3. <a id="a2.3"></a>**A2.3 — Check bilingual literal-code coverage.** Extend the locale checker for literal HttpError codes and document dynamic-code fallback; hand the tracker contract to A1. **Output:** en/zh parity results and A1 integration seam.

**Acceptance:** tracker returns the last non-429, else 429 after failures, else 502; HTTP message remains English fallback; only known own-property errors.byCode keys are used; older servers remain readable; every literal code has en/zh coverage. A1 owns exhausted-rotation end-to-end verification.

**Failure / rollback:** status precedence changes, unsafe translation lookup, or old-server breakage blocks metadata adoption. Remove additive client/server key wiring and restore fallback selection; retain the standalone tracker for A1's gated integration.

<a id="a3"></a>

### A3 · Retry-delay provenance + Retry-After

**Gate:** Ready; A1/A4 consume the parser/timing contract after this card's acceptance.

`packages/core/src/llm/retry-delay.ts`:

```ts
export type DelaySource = "header" | "structured" | "text";
export interface ParsedDelay {
  rawMs: number;
  source: DelaySource;
  bufferedMs: number;
} // +200 header/structured, +1000 text
export function parseRetryAfter(v?: string): ParsedDelay | null; // seconds | HTTP-date
export function parseStructuredDelay(body: unknown): ParsedDelay | null; // depth-8 walk,
// separator-insensitive keys: retryDelay / retry_after / retry-after / RetryAfter
export function parseTextDelay(text: string): ParsedDelay | null; // "1h16m0.667s" compound
export function graceWindow(d: ParsedDelay): boolean; // 0 < d.bufferedMs ≤ 5000
```

Wire: `reconnectDelayMs` consults a `ParsedDelay` when the provider supplies one; `key-rotator`
cooldown uses `bufferedMs` (replacing the flat 60s). Tests: one per precedence row · compound
duration parsing · nonsense `Retry-After` degrades to default · grace window bounds.

**Ordered work packages:**

1. <a id="a3.1"></a>**A3.1 — Implement provenance-aware parsers.** Parse seconds/HTTP-date headers, depth-8 structured separator-insensitive keys, and compound text durations; attach +200ms header/structured or +1000ms text buffers. **Output:** source/raw/buffered fixtures, including 1h16m0.667s and malformed values.
2. <a id="a3.2"></a>**A3.2 — Enforce precedence and timing limits.** Select header > structured JSON > text; bound honored Retry-After to ≤60s and define grace as 0 < bufferedMs ≤5,000. **Output:** one fixture per precedence row and timing-boundary table.
3. <a id="a3.3"></a>**A3.3 — Wire reconnect and cooldown consumers.** Feed ParsedDelay to reconnectDelayMs and key-rotator in place of flat 60s; retain default behavior when parsing fails. **Output:** consumer delay observations and A1/A4 handoff contract.

**Acceptance:** every precedence branch matches its row; retryDelay keys are parsed structurally; the walk is depth-bounded; malformed headers fall back; buffers follow provenance; Retry-After never exceeds 60s; grace includes positive delays up to 5s only.

**Failure / rollback:** unbounded waits, incorrect units/precedence, or nonsense values suppressing default retry blocks integration. Restore existing reconnect/cooldown defaults and retain parsers behind the consumer seam.

<a id="b2"></a>

### B2 · BoundedStreamCapture

**Gate:** Ready; B1/F18 depend on the bounded capture/spill chain.

```ts
class BoundedStreamCapture {
  constructor(headBytes = 262_144, tailBytes = 262_144);
  write(chunk: Buffer): void; // O(1) amortized: keep head until full, then ring the tail
  render(): string; // head + "\n…[omitted N bytes]…\n" + tail
}
```

Tests: `keeps both ends of a 1MB stream byte-exact` · `marker states the omitted size` ·
`small streams pass through unmarked`.

**Ordered work packages:**

1. <a id="b2.1"></a>**B2.1 — Implement bounded byte capture.** Keep a 262,144-byte head and 262,144-byte tail ring with amortized O(1) writes, independent of chunk boundaries. **Output:** BoundedStreamCapture and memory-bound observations.
2. <a id="b2.2"></a>**B2.2 — Render the omitted seam.** Insert the exact omitted-byte count only when middle bytes were discarded; preserve unmarked small streams. **Output:** below/exact/over-cap and varied-chunk byte fixtures.
3. <a id="b2.3"></a>**B2.3 — Establish the spill-consumer handoff.** Demonstrate 1MB head/tail preservation and expose the reusable capture contract for B1 failures. **Output:** byte-exact ends/marker ledger and B1 integration interface.

**Acceptance:** a 1MB stream retains both ends byte-exact regardless of chunk partition; the marker counts all omitted bytes; small streams render unchanged; capture storage remains bounded by the configured head/tail budgets.

**Failure / rollback:** tail loss, incorrect omitted count, or retention growing with total stream length blocks B1 adoption. Restore the prior capture consumer while retaining the isolated helper and original stream evidence.

<a id="f1"></a>

### F1 · Input focus rings (exact edits)

**Gate:** Ready for scoped style edits; R12 evidence gates accessibility closure.

1. `components/ui/input.tsx` `searchSharedClass`: `focus:outline-none` → keep, add
   `focus-visible:ring-2 focus-visible:ring-[var(--accent-bg)]/50` to `menuSearchClass` and a
   matching border change to `panelSearchClass`.
2. `features/guardian/rule-policy-editor.tsx:125`: `focus:ring-0` → `focus-visible:ring-2
focus-visible:ring-[var(--accent-bg)]/50`.
3. `components/ui/field.tsx` `controlBase`: `focus:ring-2 focus:ring-gray-400/30` →
   `focus:ring-2 focus:ring-[var(--accent-bg)]/50` (+ the dark variant to `dark:focus:ring-[var(--accent-bg)]/40`).
   Acceptance check = R12's axe run (zero focus-indicator violations).

**Ordered work packages:**

1. <a id="f1.1"></a>**F1.1 — Locate and compare the current focus styles.** Record menuSearchClass, panelSearchClass, guardian editor, and field controlBase in light/dark themes. **Output:** control/token inventory and current keyboard-focus observations.
2. <a id="f1.2"></a>**F1.2 — Apply the specified accent focus tokens.** Make the three edit groups above with visible focus, panel border change, and dark ring variant. **Output:** focused style diff covering every named control.
3. <a id="f1.3"></a>**F1.3 — Supply R12 focus evidence.** Walk the edited controls by keyboard and measure rendered focus contrast ≥3:1 in both themes. **Output:** per-control visibility/contrast results for R12's accessibility report.

**Acceptance:** all named controls have visible keyboard focus with ≥3:1 contrast; R12 reports zero focus-indicator violations on the affected flows; layout and control behavior remain compatible.

**Failure / rollback:** invisible focus, inadequate contrast, or lost keyboard navigation blocks closure. Revert the failing token group and retain per-control evidence for a corrected focus treatment.

<a id="f3"></a>

### F3 · Comment-lies + dead code (defaults recorded)

**Gate:** Ready for current applicability/import inventory; deletion and push retain the stated human review gate.

- `router.tsx:427-428`: fix the comment to the real gate (`usage.ts:69` is `requireProjectAccess`).
- `nav-group-collapse.ts:50-53`: delete the phantom-route claim; do not add an unrelated route.
- `features/canvas/` — delete (0 importers, verified by the III.2 audit); run the verbatim/dead-import
  checks used by the IV.4 split work.
- `features/cockpit/` directory rename → `features/cockpit-widgets/` (ends the name collision);
  update importers (grep-driven).

**Ordered work packages:**

1. <a id="f3.1"></a>**F3.1 — Verify each historical claim against current code.** Trace /usage access, nav grouping, canvas importers, and cockpit imports before changing them; the 1,308-line/zero-importer canvas count belongs to the original audit. **Output:** four-site verified/refuted evidence table.
2. <a id="f3.2"></a>**F3.2 — Apply only supported cleanup.** Correct the access comment, remove the phantom-route claim, delete canvas only if still unused, and rename cockpit to cockpit-widgets with all importers updated. **Output:** focused comment/deletion/rename diff and importer inventory.
3. <a id="f3.3"></a>**F3.3 — Review behavior and deletion evidence.** Check dead imports/verbatim references, compilation and affected web flows; obtain human deletion review before an authorized push. **Output:** cleanup review table with renamed/deleted paths and checks.

**Acceptance:** no touched comment contradicts behavior; deleted canvas has zero live importers; all cockpit imports use the new path and compilation succeeds; F3 deletions have human review before push.

**Failure / rollback:** discovered canvas consumers, broken imports, or changed route behavior blocks that cleanup slice. Restore deleted/renamed modules and import paths together; retain accurate comment repairs and the consumer inventory.

<a id="f6"></a>

### F6 · STREAM_BANNER_FRAME

**Gate:** Ready; reserve the constant owner and six compact-banner modules before concurrent UI edits.

The shared compact notice frame lives beside `disclosure-row.tsx`'s exported frame strings and is
used by the six components with that same shell: `attached-files-banner`, `goal-banner`,
`handoff-banner`, `org-trigger-banner`, `scheduled-banner`, and `skills-banner`. The inherited
nine-file list mixed three different disclosure surfaces into this task: `harness-banner` uses an
expandable output card, `mcp-connect-banner` delegates to the process-step disclosure, and
`step-banner` is that shared interactive process-step surface. They have different layout and
interaction contracts and must not be forced into the compact notice frame. Preserve each
component's own animation and layout prefix; the common frame token remains the single source of
border, background, spacing, and text styling. Acceptance compares each compact banner's rendered
class list before and after, and confirms all six use the shared token; the three disclosure
surfaces remain unchanged.

**Ordered work packages:**

1. <a id="f6.1"></a>**F6.1 — Record six compact-banner class contracts.** Capture the common shell and each banner's layout/animation prefix; inventory the three disclosure surfaces separately. **Output:** before-class matrix for all six compact notices.
2. <a id="f6.2"></a>**F6.2 — Extract the single shared frame.** Add STREAM_BANNER_FRAME beside disclosure-row constants and replace shell duplication in attached-files, goal, handoff, org-trigger, scheduled, and skills banners. **Output:** one token definition and six consumers.
3. <a id="f6.3"></a>**F6.3 — Compare rendered compatibility.** Compare each compact banner's rendered classes, preserving its prefixes, and inspect disclosure surfaces. **Output:** before/after class equality and unchanged disclosure-shell evidence.

**Acceptance:** exactly one frame definition serves all six compact notices; each rendered shell/class contract and animation/layout prefix is preserved; harness, MCP-connect, and step keep their interactive disclosure contracts.

**Failure / rollback:** a banner gains/loses shell behavior or a disclosure surface is forced into the frame blocks extraction. Restore that consumer's prior classes and remove an unused shared token if the whole change is rolled back.

<a id="g5"></a>

### G5 · TLS verification fix

**Gate:** Ready where the executable downloader is present; source/config write boundaries still apply.

`.agents/skills/bm…/bgm-library/scripts/downloader.js` — use Node's built-in `fetch` so default
certificate validation remains active; accept custom trust roots only through
`NODE_EXTRA_CA_CERTS`. Sweep `.agents/` for executable `rejectUnauthorized: false` bypasses and
smoke the downloader against a normal HTTPS endpoint. The CLI's Axios API client is separate.

**Ordered work packages:**

1. <a id="g5.1"></a>**G5.1 — Inventory executable TLS bypasses.** Inspect the downloader's real path and executable rejectUnauthorized: false usages under .agents. **Output:** per-path bypass/applicability table.
2. <a id="g5.2"></a>**G5.2 — Use certificate-validating transport.** Replace the downloader bypass with Node fetch and keep custom roots exclusively through NODE_EXTRA_CA_CERTS. **Output:** transport diff preserving download/error behavior.
3. <a id="g5.3"></a>**G5.3 — Demonstrate secure download behavior.** Exercise normal HTTPS, invalid-certificate refusal, and configured custom-root behavior, then repeat the executable bypass inventory. **Output:** TLS outcome table and zero-bypass result.

**Acceptance:** no executable rejectUnauthorized: false remains under .agents; a normal TLS download succeeds; invalid certificates fail; custom trust uses NODE_EXTRA_CA_CERTS; CLI Axios behavior is independently preserved.

**Failure / rollback:** disabled validation or broken supported HTTPS blocks closure. Revert to a certificate-validating prior transport or disable the affected download action until repaired; retain the bypass inventory.

<a id="g7"></a>

### G7 · Anti-slop installer path fix

**Gate:** Applicability inventory is ready; installer repair stays deferred until the vendored source is restored.

The original report describes a vendored skill installer, but this checkout has no `install.mjs`,
`rules-src/`, or `assets/anti-slop/`. The active `tools/oxlint/anti-slop/` tree contains plugin
source under `rules/`; adding the absent installer or a second asset tree would invent a product
surface. Re-audit applicability if the vendored skill is restored; then preserve its destination
manifest while resolving the source that actually ships. Current disposition: not applicable to
the checked-out source set; retain the evidence and do not fabricate an installer dry-run.

**Ordered work packages:**

1. <a id="g7.1"></a>**G7.1 — Record source applicability.** Check for vendored install.mjs, rules-src, and assets/anti-slop; identify active tools/oxlint/anti-slop/rules. **Output:** path existence/source-ownership table.
2. <a id="g7.2"></a>**G7.2 — Reconcile the stale installer claim.** Attach the absent-source evidence to the task card and route active plugin work to its actual owner. **Output:** an explicit deferred applicability note; source absence is not implementation completion.
3. <a id="g7.3"></a>**G7.3 — Repair only after source restoration.** If the vendored skill returns, resolve its shipped source while preserving the destination manifest, then produce an installer dry-run comparison. **Output:** restored-source inventory and destination/source mapping, conditional on that gate.

**Acceptance:** applicability evidence resolves every historical path; absent sources keep the implementation deferred. After restoration, the installer resolves real shipped inputs, preserves destinations, and its dry run documents the result.

**Failure / rollback:** fabricated installer/tree, changed destination manifest, or unresolved source blocks repair. Restore original mapping/destinations and preserve the applicability evidence; current absence retains its evidenced N/A disposition and reopen condition.

<a id="j1"></a>

### J1 · Safe workspace clean command

**Gate:** Ready; preserve the cleaner's report-only default and tracked/user-file checks.

Wire `package.json` `"clean": "node scripts/clean-workspace.mjs"` as a **report-only** default;
`pnpm clean -- --apply` remains the explicit mutation. Test a disposable fixture containing a
tracked file, a known rebuildable cache and a deliberately ignored user file: the report lists
only the cache and apply preserves the other two. Rollback: remove the script alias; do not
weaken `clean-workspace.mjs` safety checks.

**Ordered work packages:**

1. <a id="j1.1"></a>**J1.1 — Wire the safe clean alias.** Add package.json clean = node scripts/clean-workspace.mjs with report mode as default. **Output:** script alias and explicit apply usage.
2. <a id="j1.2"></a>**J1.2 — Build the safety fixture.** Use a disposable tracked-file/cache/deliberately-ignored-user-file workspace and compare report/apply outcomes. **Output:** candidate listing plus preserved-file and deleted-cache observations.
3. <a id="j1.3"></a>**J1.3 — Document operator behavior.** Describe pnpm clean reporting and pnpm clean -- --apply mutation, preserving the cleaner's tracked/user-content checks. **Output:** contributor usage example with exact mode distinction.

**Acceptance:** pnpm clean matches the direct cleaner report and changes nothing; apply removes only the listed rebuildable cache in the fixture; the tracked file and ignored deliberate user file survive.

**Failure / rollback:** report mode deletes anything or apply selects user/tracked content blocks the alias. Remove the alias and retain all existing cleaner safety checks and user files.

<a id="j6"></a>

### J6 · CI and documentation drift sweep

**Gate:** Ready; its claim/count reconciliation supplies J11.

Remove the brittle numeric spec count in `ci.yml:150` and sibling prose, or generate the count
from the test discovery command at runtime. A fixture adding one spec must not leave an asserted
stale count. Verify the docs suite and workflow syntax; rollback only the prose change if an
automation consumes it.

**Ordered work packages:**

1. <a id="j6.1"></a>**J6.1 — Inventory count and status claims.** Locate brittle numeric browser/spec counts in CI/prose and current status claims without file evidence. **Output:** workflow/document claim table with owners.
2. <a id="j6.2"></a>**J6.2 — Remove or generate mutable counts.** Drop asserted numeric counts or derive them from discovery; attach file evidence to live done/shipped claims. **Output:** workflow/prose diff and discoverable-count source.
3. <a id="j6.3"></a>**J6.3 — Check discovery and documentation compatibility.** Add one spec in a disposable fixture and confirm no stale asserted count; inspect workflow syntax/docs and any automation consuming prose. **Output:** count-change result and J11 ledger handoff.

**Acceptance:** adding a spec cannot invalidate a hardcoded count; workflow syntax remains valid; every live done/shipped claim names its evidence file; documentation claims agree with the canonical ledger.

**Failure / rollback:** syntax errors, stale counts, or an unhandled prose consumer blocks the affected slice. Restore only the incompatible prose/workflow change and retain the inventory for a corrected generated/advisory treatment.

<a id="t0.3"></a>

### T0.3 · Read-only workspace dependency freshness guard

**Gate:** Ready; read-only guard precedes dependency-sensitive local evidence across all waves.

`scripts/check-workspace-deps.mjs` compares the built core revision/export sentinel with the
package actually resolved by server/web/CLI. It prints concrete paths and a supported
reinstall/build command when stale. It does **not** mutate `node_modules/.pnpm` or write the root
`AGENTS.md` (git-ignored in this checkout). A fixture plants an old resolved snapshot, expects
failure, then refreshes through the package manager and expects success. Document the workflow
in a tracked contributor guide. Rollback: disable the freshness check, preserve package state.

**Ordered work packages:**

1. <a id="t0.3.1"></a>**T0.3.1 — Identify resolved dependency freshness.** Compare source/core build revision/export sentinel to actual server/web/CLI resolved package paths and hashes. **Output:** read-only freshness report naming each source/build/resolved path.
2. <a id="t0.3.2"></a>**T0.3.2 — Explain supported remediation.** Print the configured package-manager reinstall/build command when stale, with no internal .pnpm copying or root AGENTS.md changes. **Output:** failure message and tracked contributor workflow.
3. <a id="t0.3.3"></a>**T0.3.3 — Prove stale-to-fresh outcomes.** Plant an old resolved export in a disposable fixture, then refresh using the supported install/build path; repeat in a clean checkout. **Output:** stale nonzero/fresh success ledger with package-state change attributed to the package manager.

**Acceptance:** stale source/build/resolved sentinel mismatch fails with concrete paths/hashes and usable remediation; fresh supported install succeeds for server/web/CLI; guard is read-only and works in a clean checkout.

**Failure / rollback:** false freshness, missing consumer path, or direct package/config mutation blocks adoption. Disable the freshness check and preserve package state, root AGENTS.md, and contributor instructions.

<a id="j11"></a>

### J11 · Docs claim consistency gate

**Gate:** Enforcement/closure requires J6 reconciliation and R7's honest runtime/experimental status evidence.

`scripts/check-doc-claims.mjs` validates versioned status-ledger syntax, paths and evidence
links. A `Shipped` claim needs a proven runtime entrypoint chain, dynamic-registry fixture or
integration test; a simple external-import count is insufficient for same-package consumers.
`Experimental/unconsumed` (R7's Option B) is a valid distinct status. Plant a false `Shipped`
claim and a valid same-package consumer fixture; only the false claim fails with file/line and
reason. Rollback: keep the evidence table and run checker as advisory while false positives are
fixed, with an owner and expiry.
The machine-checked JSON ledger is the only live claim source; the [archived v3 Status Ledger](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/tasks/archive/plan-v3-2026-10-02.md)
remains a historical inventory and must not be used as current runtime evidence.

**Ordered work packages:**

1. <a id="j11.1"></a>**J11.1 — Define the live claim ledger contract.** Use the machine-checked JSON ledger as the sole live claim source; validate version/status/path/evidence-anchor syntax and label the [archived v3 Status Ledger](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/tasks/archive/plan-v3-2026-10-02.md) historical. **Output:** schema/checker rules and ledger inventory.
2. <a id="j11.2"></a>**J11.2 — Verify runtime evidence beyond imports.** Resolve entrypoint chains, dynamic-registry fixtures, or integration evidence, accepting same-package consumers and Experimental/unconsumed distinctly. **Output:** per-claim evidence resolution after J6/R7 reconciliation.
3. <a id="j11.3"></a>**J11.3 — Exercise true/false claim fixtures and CI.** Plant a false Shipped claim and a valid same-package consumer; wire the checker after their opposite outcomes are established. **Output:** false-claim file/line/reason diagnostics and valid-consumer success.

**Acceptance:** ledger syntax, every path, and evidence anchors resolve; false Shipped fails; valid same-package evidence passes; experimental/unconsumed passes honestly; historical inventory cannot establish live runtime status.

**Failure / rollback:** false positives or unsupported Shipped claims block enforcement/closure. Keep the evidence table and run advisory with a named owner/expiry while rules are repaired; preserve failed-claim diagnostics.

---

## Promotion routing — one owning card per task

The full requirements and ordered packages live in these wave files. Use their per-task gates
when scheduling ready work across waves; this table introduces no additional task body or status.

| Task | Owning execution card                                                      |
| ---- | -------------------------------------------------------------------------- |
| F17  | [Wave 2 · Offline posture banner](execution-wave-2.md#f17)                 |
| F18  | [Wave 2 · Spill/recall UI affordance](execution-wave-2.md#f18)             |
| I7   | [Wave 2 · Pressure-aware write guard](execution-wave-2.md#i7)              |
| J13  | [Wave 4 · Health → alerting](execution-wave-4.md#j13)                      |
| C10  | [Wave 3 · Session briefing injection](execution-wave-3.md#c10)             |
| C11  | [Wave 3 · Watcher-driven staleness](execution-wave-3.md#c11)               |
| C12  | [Wave 3 · Findings chat-native surface](execution-wave-3.md#c12)           |
| K18  | [Wave 3 · Verification workflow gating briefings](execution-wave-3.md#k18) |
| D11  | [Wave 3 · Impact-aware write advisory](execution-wave-3.md#d11)            |
| J12  | [Wave 3 · PR annotations for gates + findings](execution-wave-3.md#j12)    |
| G8   | [Wave 3 · Skills doctor + health badges](execution-wave-3.md#g8)           |
