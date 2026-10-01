# Execution Cards — Vol. 1: Wave R + Wave 1

Companion to `tasks/plan.md` (architecture, ordering, sources) and `tasks/todo.md` (checklist).
Each card unpacks one task into its smallest useful slice, compatibility boundary, failure mode,
verification, and rollback. Cards assume the Definition of Done in plan §0. Any line number in
an inherited audit is evidence for that commit, not an edit target; locate the current symbol
before implementation. `execution-cards-2.md` covers the later, risk-bearing work.

---

## R0 · Findings scope and authority contract

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

## R1a · Eviction policy truth & reference hygiene

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

---

## R1b · Lifecycle state machine, evidence gate, actor attribution

**Goal:** Transitions become enumerated, gated, attributed — the audit protocol as code.

**Data shapes:**
```ts
export type ActorKind = "user" | "agent" | "system" | "unknown";
export interface Actor { kind: ActorKind; id: string }
export interface FindingEvent { seq; type; findingId; at; note?; actor?: Actor;
                                method?: "tool" | "route" | "engine" }   // optional only for legacy reads
export type LifecycleErrorCode = "illegal_transition" | "evidence_gate" | "replacement_not_live"
  | "cycle" | "dangling_replacement" | "chain_too_deep";
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

| from \ to | open | confirmed | refuted | superseded |
|---|---|---|---|---|
| open | — | ✔ (evidence gate) | ✔ | ✔ (replacement live) |
| confirmed | ✖ (use reopen) | — | ✔ (falsification) | ✔ (replacement live) |
| refuted | ✔ **only** via an authenticated, reasoned user `reopen` operation | ✖ | — | ✖ |
| superseded | ✖ | ✖ | ✖ | — (immutable) |

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

**Build steps:** 1) types + `canTransition` + `LifecycleError`; 2) gate check in `confirm`;
3) `assertTransition` at the top of `confirm/refute/supersede/reopen`; 4) actor on events;
5) thread `actor` through tool + routes (R4 shares the call sites); 6) `reopen(id, actor, reason)`
as a distinct user action; 7) keep an old-snapshot import fixture.

**Tests:** `rejects confirming an evidence-free finding` · `user override records the actor` ·
`illegal transitions throw typed codes` (table-driven over the matrix) · `events name the actor` ·
`tool ignores body-supplied actor` · `agent cannot request override` · `legacy actor stays unknown`
(route + tool layers). Verify that the route requires the right project access for each action.

---

## R1c · Transition guards: cycles, liveness, dead-claim re-reports

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

---

## R2a · Scope-aware findings store and acknowledged writes

**Interface (new `packages/core/src/knowledge/store.ts`):**
```ts
export interface FindingsStore {
  readonly scopeId: string;
  read(): Promise<{ snapshot: FindingsGraphSnapshot; revision: string; recovery: RecoveryState }>;
  update<T>(expectedRevision: string | null,
    fn: (graph: FindingsGraph) => T | Promise<T>): Promise<{ result: T; revision: string }>;
  invalidate(): void;
}
export class StoreCorruptionError extends Error { quarantinedTo?: string }
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

---

## R2b · Bounds parity + store byte cap + rehydrate cache

**Shared validator (`knowledge/validation.ts`) — the exact caps (both paths call it):**

| field | cap |
|---|---|
| title | 1–300 chars |
| body | ≤50,000 |
| subjects | ≤100 entries × ≤500 |
| evidence | ≤100 entries; quote ≤2,000; note ≤2,000; line ≥0 integer |
| tags | ≤50 × ≤100 |
| note (lifecycle) | ≤2,000 |

**Capacity:** 24 MiB UTF-8 serialized bytes is the high-water warning and 32 MiB is the hard
cap per live store; keep the 5,000-finding count cap. Prove the largest permitted single report
fits in an empty store and measure hydration memory/startup before raising the cap. At capacity,
reads, export, archive inspection, and recovery stay possible; only a new
write that cannot fit fails with `StoreTooLargeError`. **Cache:** reuse R2a's bounded revision
cache; do not add an unrelated route cache. **Tests:** shared limit table for tool/route;
high-water warning and hard-limit refusal; export/recovery at capacity; two unchanged reads
parse once; same-size rewrite invalidates.

---

## R2c · Corruption quarantine and read-only recovery

**Flow:** `ENOENT` creates a new empty store; parse/validation/unsupported-version errors do not.
On corruption: copy original bytes to a uniquely named, permission-preserving quarantine file,
emit one structured event per revision, and mark the scope read-only. `snapshot`/tool output
reports `recoveryRequired` without presenting an empty graph as truth. A privileged recovery
action can export raw bytes, restore a selected backup, or explicitly reset after a second
confirmation; it preserves the corrupt original. Quarantine failure still blocks writes.
**Tests:** invalid JSON, partial JSON, unsupported version, unreadable file, quarantine failure,
repeated corruption, restore/reset, and a valid legacy snapshot. Verify no normal write changes
the original bytes in every error case.

## R2d · Existing-store migration and rollback

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

---

## R3 · Report & governance reconciliation — completed

Moved the dated audit to `docs/audits/2026-09-29-unified.md`, kept a short root pointer, and
reconciled its historical baseline with current branch status. Added the checked-in
`docs/policies/porting-and-refusals.md` and linked it from the plan and README.
**Verification:** docs suite 7/7 files and 53/53 tests, docs typecheck, Prettier, and targeted
contradiction/path/policy-link checks all passed.

---

## R4 · Route hygiene

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

---

## R5 · Revision-aware, byte-bounded tool output

**Protocol:**
```ts
type Page<T> = { version: 2; action: string; items: T[]; scopeRevision: string;
  latestSequence: number; nextCursor: string | null; truncated: boolean;
  omittedCount: number; highWater: boolean; error?: { code: string; restart: boolean } };
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

---

## R6 · code_graph resource discipline

**Shape (`packages/core/src/environment/tools/code-graph.ts`):**
```ts
const inflight = new Map<string, Promise<CacheEntry>>();   // single-flight
const MAX_CACHED = 8;                                       // LRU by lastUsed
async function graphFor(workspaceDir: string, force: boolean) {
  const hit = cache.get(workspaceDir);
  if (hit && !force && Date.now() - hit.scannedAt < TTL) return hit.watcher;
  const running = inflight.get(workspaceDir);
  if (running && !force) return (await running).watcher;
  const p = (async () => { const w = new CodeGraphWatcher(workspaceDir); await w.scanWorkspace();
                           return { watcher: w, scannedAt: Date.now() }; })();
  inflight.set(workspaceDir, p);
  try { const entry = await p; putLRU(workspaceDir, entry); return entry.watcher; }
  finally { inflight.delete(workspaceDir); }
}
```
`putLRU` closes evicted watchers (`watcher.close()`); TTL refresh closes the old watcher **after**
the new scan succeeds (the current code closes first — the leak window). `stats()` gains
`{ cachedWorkspaces, evictions, scans }`. Docs answer (tools.en/zh): "`scanWorkspace()` installs
no file watchers; only `init()` does, and this tool never calls it."
**Tests:** `20 concurrent index calls perform exactly one scan` (counter on a spy) · `LRU closes
evicted watchers` · `TTL refresh does not leak the old watcher` · `docs claim matches code`
(string assertion is overkill — cite the line in the PR instead).

---

## R7 · Memory-plane honesty (Option B selected)

List actual consumers of `retention.ts` and freeze a small recall fixture with retained and
retrieved items, write volume, and latency. Label the module unconsumed/experimental and reword
`FindingsGraph.strength` to its actual creation-recency math; do not claim access reinforcement
from `createdAt`. Leave default retention unchanged. C2 owns any later opt-in policy proposal:
it needs a named consumer, pinned-memory survival, restart/rollback tests, and a measured gain
on the frozen fixture before C3 can use it.

---

## R8 · Agent-authored marking on read-back

`query`/`snapshot` rows expose `authoredBy` from host-attested creation context and `sourceLabel`
from untrusted report text as separate fields. Persist the original actor on each new finding so
bounded event-log rotation and archive eviction do not erase known authorship; old snapshots fall
back to their trusted ingest event, then to `legacy-unknown`. A user override is not retroactively
an author change. Every row shows status and strongest evidence tier; the tool description says
these are claims requiring verification. Tests cover agent, user, system, legacy, event rotation,
archive recall, and a forged body actor. Update `packages/docs/content/tools.en.md` and `tools.zh.md`.

---

## R9 · Bounded batch fan-out

`packages/web/src/components/layout/sidebar.tsx` — extract `runBounded<T>(ids, worker, limit = 8)`
(promise-pool); use it in `batchArchive` and `confirmBatchDelete`. Preserve semantics exactly
(per-id settle, succeeded/failed split, retention of failed marks). **Test:** mocked endpoint
records concurrency peaks; 200 ids → peak ≤ 8; partial-failure contract unchanged (existing e2e
still green).

---

## R10 · Tool-schema token cost measurement

Method: freeze one agent config from before PR #12 and the PR head; serialize the actual default
tool payload, including catalog/lazy exposure, with the same code path the agent sees. Record
`{chars, chars/4 estimate, provider-tokenizer tokens when available}` per tool and total. Run a
tiny task-success probe if the delta exceeds 1,500 estimated tokens; trim schema descriptions
only if the probe confirms no routing loss. Commit a path-free measurement script. The four
preexisting `tools/measure-q*` scripts contain local paths and stay outside the PR.

---

## R11 · Findings-plane test battery

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

---

## R12 · A11y verification pass

`packages/web/e2e/a11y.spec.mjs`: chat page, sidebar, settings — run `axe-core` (add as a devDep
if absent; it is already referenced by prior audits' tooling) and assert zero `critical`/`serious`;
add keyboard-only flows: Tab to the batch bar, operate Delete, Escape semantics; dark-mode
contrast sampling on `--color-text-secondary`; target-size sweep (≥24px per WCAG 2.5.8 floor the
app already states). Output: `a11y-report.md` in the PR with the raw counts.

---

## R13 · CI truth pass

**Current blocker:** PR #12 run `36563549648` has 155 browser cases passed, two skipped, one
failed. At `packages/web/e2e/skills.spec.mjs:246`, `getByText("使用 data-analysis 技能", {exact:true})`
resolves to sidebar title, chat heading, and message paragraph, causing a Playwright strict-mode
failure. Aggregate `ci` failed; the other reported jobs passed.

**Repair sequence:** scope the locator to the intended message/card (prefer a role or test id
with product meaning), then verify the dropdown selection cleared and the sent message really
contains the invocation. Inspect the same flow for an actual update-order race; if present, fix
the product state transition as well. Run the named case, full browser suite, then the complete
PR matrix on the exact pushed SHA. Record per-job result and run URL in the report. A green
targeted rerun alone does not close R13. CI Node = 24; local runs recorded in the plan used 26.

---

## R14a · Electron high-severity repair

**Evidence:** current lockfile resolves desktop `electron@43.2.0`; the 2026-09-29 audit reports
four high advisories, with the strictest patched floor at 43.5.0. Update the desktop manifest
and lockfile to a supported 43.x version at or above that floor. Inspect the lockfile diff for
unexpected runtime changes. Test desktop launch, server utility process, same-origin window,
installer and packaged binaries on Windows/macOS/Linux. **Negative case:** a manifest change
that leaves the bundled binary at 43.2.0 fails the release gate. **Rollback:** ship the previous
release artifact; never republish a known vulnerable binary as a successful upgrade.

---

## R14b · Undici runtime and build-chain repair

**Evidence:** audit JSON reports runtime `undici@7.29.0` and transitive desktop build-chain
`undici@6.28.0` against the same decompression advisory. Update the server range/resolution to
≥7.29.1 and the builder chain to ≥6.28.1 with the narrowest compatible change. Review both
paths in `pnpm audit --json`; a single clean runtime path is insufficient. Run server
WebSocket/HTTP tests and desktop package smoke. **Negative case:** a broad override that forces
7.x into the 6.x chain fails compatibility review. **Rollback:** revert the dependency update
and block release until a compatible patched path is available.

---

## Wave 1 cards

### A2 · FailureStatusTracker + error taxonomy triple
`packages/core/src/llm/failure-status.ts`:
```ts
export class FailureStatusTracker {
  note(status: number): void;
  finalStatus(): number;   // last non-429 seen; else 429 if any failure; else 502
}
```
Wire into the rotation loop (A1 owns the call site — A2 lands the class + unit tests first).
Error contract: `HttpError.kind` classifies expected/unexpected failures; `english` returns the
message fallback; `i18nKey` defaults to `errors.byCode.<code>`. The response adds an optional
`i18nKey`, and the web client prefers a known own-property key before falling back to code/message.
The locale checker scans literal `new HttpError(..., "code", ...)` calls; dynamically constructed
codes use the constructor fallback. Tests cover tracker branches, error metadata/serialization,
client propagation, safe translation lookup, old-server fallback, and bilingual code parity.

### A3 · Retry-delay provenance + Retry-After
`packages/core/src/llm/retry-delay.ts`:
```ts
export type DelaySource = "header" | "structured" | "text";
export interface ParsedDelay { rawMs: number; source: DelaySource;
  bufferedMs: number }   // +200 header/structured, +1000 text
export function parseRetryAfter(v?: string): ParsedDelay | null;       // seconds | HTTP-date
export function parseStructuredDelay(body: unknown): ParsedDelay | null; // depth-8 walk,
  // separator-insensitive keys: retryDelay / retry_after / retry-after / RetryAfter
export function parseTextDelay(text: string): ParsedDelay | null;      // "1h16m0.667s" compound
export function graceWindow(d: ParsedDelay): boolean;                  // 0 < d.bufferedMs ≤ 5000
```
Wire: `reconnectDelayMs` consults a `ParsedDelay` when the provider supplies one; `key-rotator`
cooldown uses `bufferedMs` (replacing the flat 60s). Tests: one per precedence row · compound
duration parsing · nonsense `Retry-After` degrades to default · grace window bounds.

### B2 · BoundedStreamCapture
```ts
class BoundedStreamCapture {
  constructor(headBytes = 262_144, tailBytes = 262_144);
  write(chunk: Buffer): void;   // O(1) amortized: keep head until full, then ring the tail
  render(): string;             // head + "\n…[omitted N bytes]…\n" + tail
}
```
Tests: `keeps both ends of a 1MB stream byte-exact` · `marker states the omitted size` ·
`small streams pass through unmarked`.

### F1 · Input focus rings (exact edits)
1. `components/ui/input.tsx` `searchSharedClass`: `focus:outline-none` → keep, add
   `focus-visible:ring-2 focus-visible:ring-[var(--accent-bg)]/50` to `menuSearchClass` and a
   matching border change to `panelSearchClass`.
2. `features/guardian/rule-policy-editor.tsx:125`: `focus:ring-0` → `focus-visible:ring-2
   focus-visible:ring-[var(--accent-bg)]/50`.
3. `components/ui/field.tsx` `controlBase`: `focus:ring-2 focus:ring-gray-400/30` →
   `focus:ring-2 focus:ring-[var(--accent-bg)]/50` (+ the dark variant to `dark:focus:ring-[var(--accent-bg)]/40`).
Acceptance check = R12's axe run (zero focus-indicator violations).

### F3 · Comment-lies + dead code (defaults recorded)
- `router.tsx:427-428`: fix the comment to the real gate (`usage.ts:69` is `requireProjectAccess`).
- `nav-group-collapse.ts:50-53`: delete the phantom-route claim; do not add an unrelated route.
- `features/canvas/` — delete (0 importers, verified by the III.2 audit); run the verbatim/dead-import
  checks used by the IV.4 split work.
- `features/cockpit/` directory rename → `features/cockpit-widgets/` (ends the name collision);
  update importers (grep-driven).

### F6 · STREAM_BANNER_FRAME
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

### G5 · TLS verification fix
`.agents/skills/bm…/bgm-library/scripts/downloader.js` — use Node's built-in `fetch` so default
certificate validation remains active; accept custom trust roots only through
`NODE_EXTRA_CA_CERTS`. Sweep `.agents/` for executable `rejectUnauthorized: false` bypasses and
smoke the downloader against a normal HTTPS endpoint. The CLI's Axios API client is separate.

### G7 · Anti-slop installer path fix
The original report describes a vendored skill installer, but this checkout has no `install.mjs`,
`rules-src/`, or `assets/anti-slop/`. The active `tools/oxlint/anti-slop/` tree contains plugin
source under `rules/`; adding the absent installer or a second asset tree would invent a product
surface. Re-audit applicability if the vendored skill is restored; then preserve its destination
manifest while resolving the source that actually ships. Current disposition: not applicable to
the checked-out source set; retain the evidence and do not fabricate an installer dry-run.

### J1 · Safe workspace clean command

Wire `package.json` `"clean": "node scripts/clean-workspace.mjs"` as a **report-only** default;
`pnpm clean -- --apply` remains the explicit mutation. Test a disposable fixture containing a
tracked file, a known rebuildable cache and a deliberately ignored user file: the report lists
only the cache and apply preserves the other two. Rollback: remove the script alias; do not
weaken `clean-workspace.mjs` safety checks.

### J6 · CI and documentation drift sweep

Remove the brittle numeric spec count in `ci.yml:150` and sibling prose, or generate the count
from the test discovery command at runtime. A fixture adding one spec must not leave an asserted
stale count. Verify the docs suite and workflow syntax; rollback only the prose change if an
automation consumes it.

### T0.3 · Read-only workspace dependency freshness guard

`scripts/check-workspace-deps.mjs` compares the built core revision/export sentinel with the
package actually resolved by server/web/CLI. It prints concrete paths and a supported
reinstall/build command when stale. It does **not** mutate `node_modules/.pnpm` or write the root
`AGENTS.md` (git-ignored in this checkout). A fixture plants an old resolved snapshot, expects
failure, then refreshes through the package manager and expects success. Document the workflow
in a tracked contributor guide. Rollback: disable the freshness check, preserve package state.

### J11 · Docs claim consistency gate

`scripts/check-doc-claims.mjs` validates versioned status-ledger syntax, paths and evidence
links. A `Shipped` claim needs a proven runtime entrypoint chain, dynamic-registry fixture or
integration test; a simple external-import count is insufficient for same-package consumers.
`Experimental/unconsumed` (R7's Option B) is a valid distinct status. Plant a false `Shipped`
claim and a valid same-package consumer fixture; only the false claim fails with file/line and
reason. Rollback: keep the evidence table and run checker as advisory while false positives are
fixed, with an owner and expiry.
The machine-checked JSON ledger is the only live claim source; plan §2 remains an explicitly
historical inventory and must not be used as current runtime evidence.

---

## Promotion cards (plan §5A — passive → active → product)

### C10 · Session briefing injection (P1)
**Where it hooks:** `Agent.assembleContext` (`packages/core/src/agent.ts` — the same seam the
skills index uses) gains a `findingsSection()` built from `FindingsGraph.query`:
`status === confirmed`, `stale !== true`, and scope = R0's trusted session mapping. Sort by
evidence strength, severity, then recency with a stable id tie-break; cap at eight rows and
≤1,200 measured prompt tokens (chars/4 only as a fallback estimate). Render title/subject as
quoted **untrusted data** in a lower-priority context section, never as a system instruction;
exclude body, free-form source labels, and URLs. Dedupe by finding id/evidence path, not title
overlap with a skill. Pin a scope revision for the assembled turn and refresh only at the normal
context-rebuild seam. **Tests:** only confirmed/non-stale rows; wrong project excluded; 100-row
budget; prompt-injection title remains inert; zero findings adds no section; mutation between
query and assembly restarts or omits the stale page. Rollback flag disables injection while
keeping on-demand query.
**Files:** `agent.ts`, `knowledge/briefing.ts` (new), tests.

### C11 · Watcher-driven staleness (P2)
**Hook:** watcher events schedule a debounced content-revision check; only a changed, directly
evidenced path marks a finding `stale: true`. A touch-only event, unrelated file, or repeated
event does not write the store. Staleness is metadata, **not** a refutation or status transition;
reverification records the new code revision and actor. Workspaces without a trusted R0 mapping
stay separate. **Tests:** real content change marks stale once; touch-only/unrelated change does
not; restart retains the marker; confirm without new evidence cannot clear it. Do not scan the
whole codegraph or block an edit waiting for the staleness write.

### C12 · Findings chat-native surface (P3)
Composer action "Log finding" (in the `PlusMenu`) pre-fills the current file only after R0
resolves the chat's authorized scope. Header badge counts **open, non-stale** findings for that
scope and has a loading/error state. `path:line` opens the existing file preview only after a
workspace path guard. Reuse C1's form and list implementation. Acceptance: keyboard-operable,
R12 a11y, en/zh parity, no leakage when switching projects. Tests: unit validation, project
switch/cross-scope negative case, and one live e2e report→badge→drill-through flow.

### K18 · Verification workflow gating briefings (P4)
UI: findings rows gain Confirm/Refute buttons → `POST /confirm` with `actor:user` (R1b) and the
evidence-gate dialog ("confirm needs runtime/implementation evidence — add one or override").
The briefing rule is simply `confirmed && !stale`, with actor/evidence shown beside the claim.
An open claim remains visible in on-demand UI with an "unverified" label but never enters the
automatic briefing. Tests: evidence-free confirm opens a reasoned human-override dialog;
agents cannot submit that override; refute/confirm controls operate by keyboard and report
server errors without changing the visible state optimistically.

### D11 · Impact-aware write advisory (P5)
`edit_file`/`write_file` post-success: resolve the edited file in the cached code graph
(`graphFor(ctx.workspaceDir)` — R6's single-flight), collect its symbols' dependent counts
(`getImpactRadius` on the regex tier today; D4b later), and when max dependents ≥5 append one line
to the tool output: `impact: <symbol> has N dependents (code_graph)`. Budget: ≤1 line, ≤20ms
(cache hit only — never scan on the write path; miss = silent). Tests: `high-impact edit gains the
notice` · `cache miss stays silent` · `notice never exceeds one line`.

### F17 · Offline posture banner (P8)
Global status combines `navigator.onLine` with a bounded health probe to the local server.
Copy distinguishes "browser offline" from "local server unavailable" and lists the cached
actions that still work; it never claims sync is absent. C8's e2e verifies the banner, cached
chat hydration, failed-write affordance, and disappearance after a successful reconnect probe.
One component, en/zh strings, and a retry action; avoid a persistent banner for a transient
failed request.

### F18 · Spill/recall UI affordance (P7)
When a tool-call result carries B1's opaque `{recallId,sizeBytes,tokenCount}`, the card renders
"Full output saved" with a bounded preview and an explicit open action. The endpoint resolves
the id server-side after project/session authorization; no arbitrary `path` query parameter is
accepted. CLI `penguin recall <id>` uses the same permission and expiry rules. Tests: only
spilled results show a chip; cross-project/expired/path-traversal ids fail; large output streams
without loading the whole file into the browser; screen-reader label names the action.

### I7 · Pressure-aware write guard (P10)
`internal/command-policy.ts` (or `sandbox/service.ts` where writes converge): before write-capable
commands, measure free space on the **target volume**, not the process cwd. Below 200 MiB warn;
below 50 MiB block only nonessential new writes. Export, deletion, cleanup, recovery, and
read-only operations remain available. An unavailable probe warns but cannot invent a zero.
The explicit override comes from the trusted approval flow and is recorded; a model argument
named `overridePressure` has no authority. The `resource_pressure` tool stays observe-only.
Tests: threshold matrix, wrong-volume fixture, cleanup escape, missing probe, user override,
and no model-origin override.

### J12 · PR annotations for gates + findings (P15)
Run only after J3/J11 produce structured results. Emit bounded GitHub annotations for coverage
regressions and stale documentation, with validated repository-relative paths and escaped
message text. Findings on changed files are **advisory**, attributed, and never turn an
unverified claim into a failing check. On fork PRs, run with read-only permissions and no
secrets. Cap duplicate annotations per file/run; put full details in the job summary. Tests:
untrusted title/path injection, fork permission model, duplicate suppression, and a fixture diff.

### J13 · Health → alerting (P11)
**Wave 2:** E8/E9 expose structured readiness/degradation state and logs. **Wave 4:** after K6
exists, map actionable degradation codes to digest notifications with an owner, severity,
dedupe key, recovery event, and quiet period; do not alert on a normal temporary offline state.
Health payload remains independent of notification delivery. Tests: repeat coalescing,
recovery/resolve, clock skew, disabled notifications, and no alert loop when the notification
plane itself is unhealthy.

### G8 · Skills doctor + health badges (P12)
`penguin skills doctor` wraps G1/G2/G6 outputs (same code path as CI — one implementation);
skills-page rows gain a health badge: green (validators clean) / amber (capability manifest
missing) / red (validation failure), with the failing rule named in the tooltip. Tests: doctor
exit codes; badge mapping unit test.
