# Execution Cards — Vol. 1: Wave R + Wave 1

Companion to `tasks/plan.md` (architecture, ordering, sources) and `tasks/todo.md` (checklist).
Each card unpacks one task into build steps with the exact shapes, constants, and test names the
implementer needs. Cards assume the Definition of Done in plan §0. **Line numbers cited are from
PR #12's head (`beebef8`) — re-anchor with `grep -n` before editing.**

---

## R1a · Eviction policy truth & reference hygiene

**Goal:** The invariant becomes "nothing is *lost*": eviction archives, cleans references, and the
docs name the real order.

**Constants (pin in code and tests):**
- `DEFAULT_MAX_FINDINGS = 5000` (unchanged) · archive `findings-graph.evicted.ndjson` beside the
  store · archive rotation at 32 MB (the audit-retention precedent) → rename to `.1`, keep one.
- Rank order (already computed by `STATUS_RANK`, ascending): `refuted(0) → superseded(1) →
  open(2) → confirmed(3)`; within a rank, oldest `updatedAt` goes first.

**Build steps:**
1. Rewrite the header invariant (`findings-graph.ts:14`): "Nothing is lost. Lifecycle marks and
   chains; eviction past `maxFindings` archives the victim to `findings-graph.evicted.ndjson` and
   cleans references; see `evictIfNeeded`."
2. Fix the `:508` doc comment to the real order above.
3. `evictIfNeeded()`: before `this.findings.delete(victim.id)` —
   a. append `JSON.stringify(this.clone(victim)) + "\n"` to the archive (via the store's injected
      `archive?: (line: string) => void` so the engine stays pure — `FileFindingsStore` supplies
      the fs writer; tests supply a collector);
   b. reference hygiene over survivors: `related = related.filter((r) => r !== victim.id)`;
      if `supersededBy === victim.id`, clear `supersededBy` (history lives in the archive line and
      an `update` event `evicted:<id>` is pushed to the log);
   c. rotation: the store writer checks byte size before append; ≥32 MB → `rename(.1)` then append.
4. Export a test seam `evictionSink` option in `FindingsGraphOptions` (defaults to none → no
   archive, only deletion — the in-memory engine must stay fs-free).

**Tests (`test/knowledge/findings-graph.test.ts`, new `describe("eviction")`):**
- `evicts in rank order and archives each victim` — cap 3; seed refuted+superseded+open+confirmed;
  after one more ingest: victim is the refuted one; archive collector holds exactly its record.
- `cleans related and supersededBy on eviction` — the N1 case: a superseded pair where the
  replacement is evicted first; assert `related` has no dangling ids and `supersededBy` cleared;
  `exportSnapshot()` re-imports with `skipped === 0`.
- `confirmed is evicted only when it is the only rank left` — the reviewer's probe, pinned.
- `archive rotation renames at the byte cap` — fake writer with a size counter.

**Edge cases:** eviction during `report()` merge (the merged target must never be the victim);
empty-graph cap 0 (throws on construction — add the guard); archive write failure (log-free
degradation: eviction proceeds, `evictionArchiveFailures` counter in `stats()`).

---

## R1b · Lifecycle state machine, evidence gate, actor attribution

**Goal:** Transitions become enumerated, gated, attributed — the audit protocol as code.

**Data shapes:**
```ts
export type ActorKind = "user" | "agent" | "system";
export interface Actor { kind: ActorKind; id: string }
export interface FindingEvent { seq; type; findingId; at; note?; actor?: Actor;
                                method?: "tool" | "route" | "engine" }   // extend, keep optional
export class LifecycleError extends Error {
  code: "illegal_transition" | "evidence_gate" | "replacement_not_live" | "cycle";
}
export function canTransition(from: FindingStatus, to: FindingStatus): boolean;
```

**Transition matrix (encode as a frozen record; this table is the spec):**

| from \ to | open | confirmed | refuted | superseded |
|---|---|---|---|---|
| open | — | ✔ (evidence gate) | ✔ | ✔ (replacement live) |
| confirmed | ✖ (use reopen) | — | ✔ (falsification) | ✔ (replacement live) |
| refuted | ✔ **only** via `reopen` with `actor.kind === "user"` or a report carrying `reopen:true` | ✖ | — | ✖ |
| superseded | ✖ | ✖ | ✖ | — (immutable) |

**Evidence gate:** `confirm(id, opts)` where `opts = { note?, actor, override?: boolean }`;
requires `finding.evidence.some((e) => e.tier === "runtime" || e.tier === "implementation")` —
else `LifecycleError("evidence_gate")` unless `override === true && opts.actor.kind === "user"`.

**Actor plumbing:** routes build `actor = { kind: "user", id: c.var.user.userId }`; the tool uses
`ctx.attribution ? { kind: "agent", id: ctx.attribution.agentId } : { kind: "system", id: "tool" }`
— **body-supplied actors are ignored** (add a test). Every confirm/refute/supersede/reopen/link
pushes `FindingEvent` with `actor` + `method`.

**Build steps:** 1) types + `canTransition` + `LifecycleError`; 2) gate check in `confirm`;
3) `assertTransition` at the top of `confirm/refute/supersede/reopen`; 4) actor on events;
5) thread `actor` through tool + routes (R4 shares the call sites); 6) `reopens(id, actor)` API.

**Tests:** `rejects confirming an evidence-free finding` · `user override records the actor` ·
`illegal transitions throw typed codes` (table-driven over the matrix) · `events name the actor` ·
`tool ignores body-supplied actor` (route + tool layers).

---

## R1c · Transition guards: cycles, liveness, dead-claim re-reports

**Build steps:**
1. `supersede(id, replacementId, opts)`:
   - self-check (existing `:309`);
   - **liveness**: `replacement.status ∈ {open, confirmed}` else `LifecycleError("replacement_not_live")`;
   - **cycle walk** (bounded):
     ```ts
     let cur = replacementId;
     for (let hops = 0; hops < 64; hops++) {
       const f = this.findings.get(cur);
       if (!f) break;
       if (f.id === id) throw new LifecycleError("cycle", …);
       cur = f.supersededBy ?? "";
       if (cur === "") break;
     }
     ```
2. Dead-claim re-report: in `report()`'s id-line merge, if the existing finding is `refuted` or
   `superseded` and the new report is not `reopen`: create a NEW finding (fresh id — salt the
   fingerprint with `report.at`) and `link` it `contradicts`-style to the dead claim (use the
   existing `related` link plus a `contradicts` tag until C5 adds typed edges). With
   `ReportFindingInput.reopen === true`: reopen (`status = "open"`, event `update` with actor).

**Tests:** `supersede cycle is rejected (a→b→a)` · `replacement must be live` · `re-reporting a
refuted claim creates a contradicting claim` · `reopen is explicit and attributed` · `chain walk
terminates at 64 hops`.

---

## R2a · One findings store behind one locked interface

**Interface (new `packages/core/src/knowledge/store.ts`):**
```ts
export interface FindingsStore {
  readonly path: string;
  read(): Promise<FindingsGraphSnapshot>;                 // cache-validated by mtime+size
  update<T>(fn: (graph: FindingsGraph) => T | Promise<T>): Promise<T>;  // serialized per path
  invalidate(): void;
}
export class StoreCorruptionError extends Error { quarantinedTo?: string }
```
**Lock protocol:** move the server's `withFileLock` (`packages/server/src/services/project-json-store.ts:279`)
into `packages/core/src/internal/file-lock.ts`; `FileFindingsStore.update` runs
`withFileLock(path, root, …)` with a per-path promise chain (`Map<string, Promise<void>>` tails —
the exact shape `ProjectJsonStore` already uses). The server keeps `ProjectJsonStore` but wraps it
in `ProjectJsonStoreAdapter implements FindingsStore`; the tool's `graphs` Map becomes the cache
inside `FileFindingsStore` keyed by `{mtimeMs, size}`.

**Tests (`test/knowledge/findings-store.test.ts`):**
- `serializes concurrent updates` — 50 parallel `update(report)` on one path → 50 findings on disk.
- `observes external edits` — rewrite the file outside the store; next `read()` reflects it.
- `single-flight` — two concurrent `update`s never interleave (instrument fn with an array log).
- `tool and route share one store instance per path` — construct both adapters against one temp
  file; interleaved writes all land (this is F2's regression test).

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

**Byte cap:** `update` refuses to write a snapshot >8 MB → `StoreTooLargeError` with guidance
("prune or split per project"). **Rehydrate cache:** routes hold `Map<projectId, {mtimeMs,size,graph}>`;
`store.read()` stats first and only re-parses on change. **Tests:** `tool caps match route caps
exactly` (same fixture table run against both), `store refuses oversized writes`, `GET parses the
store once per change` (parse counter in a spy decoder).

---

## R2c · Corruption quarantine (never silent loss)

**Flow:** `read()` parse failure → (1) `copyFile(path, path + ".corrupt-" + Date.now())`;
(2) structured log once per file; (3) start empty and set `recoveredFromCorruption: true` on the
store (surfaced in the `snapshot` route response and the tool's `snapshot` output);
(4) second corruption creates a second uniquely-named copy (never overwrite).
**Tests:** `quarantines a corrupt store before starting empty` · `second corruption does not
overwrite the first quarantine` · `snapshot output flags recovery`.

---

## R3 · Report & governance reconciliation

**Steps:** (1) `UNIFIED-AUDIT-AND-IMPLEMENTATION.md` → `docs/audits/2026-09-29-unified.md`, leaving
a 3-line pointer at the old path (or a README link — pick one, note it in the commit); (2) fix
Part 5's "unimplemented" line → "shipped (item 11)"; (3) header: replace "No commits made" with
"landed on PR #12 (7 commits)"; (4) create `docs/policies/porting-and-refusals.md` — the REFUSE
list + license table from plan §9 verbatim, with a "checked-in policy" preamble; (5) link the
policy from `tasks/plan.md` §9 and the README's governance section if one exists.
**Tests:** grep gates — zero matches for `unimplemented` in the report's Part 3/5, zero
`No commits made`; docs suite green.

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

## R5 · Tool output markers + pagination

**Protocol:**
```ts
type Page<T> = { page: T[]; nextCursor: string | null; total: number };
// cursor = base64 of the last record's stable key (finding id / event seq)
```
- `snapshot`: `limit` (default 100, max 500) + `after` (cursor) → `Page<Finding>`.
- `events`: keep `since`, add `limit` + `after`.
- Small outputs (`JSON.stringify` ≤ budget) are emitted as plain JSON (back-compat).
- Oversized single objects (a giant finding body) truncate at the field boundary and append
  `… [truncated: showing X of Y chars]` **outside** the JSON (`{"…": "truncated", "data": …}`
  envelope) so `JSON.parse` always succeeds.
**Tests:** `pages a 500-finding snapshot with no gaps or duplicates` · `every output parses`
(JSON.parse each variant in a loop over sizes 100…10,000) · `truncation marker present` ·
`budget never produces invalid JSON` (the N6 regression).

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

## R7 · Memory-plane honesty or wiring (decision card)

**Option A (preferred if the fixture run is cheap):** `HierarchicalMemoryStore.evictToTokenBudget`
gains `retentionPolicy?: { tiers: 0.7/0.4/0.15; decay: { λ: 0.01, σ: 0.3 } }` (defaults = today's
behavior); run the existing memory fixtures before/after and record recall deltas in the PR.
**Option B:** `@experimental` JSDoc on `retention.ts` + one docs line; fix `FindingsGraph.strength`
— either add `lastAccessedAt?: number` (set on `query` hits, used like `strengthAt`) or reword the
doc to "reinforced by creation recency". **Q5 decides; default B if the fixture run exceeds an
hour.** Tests: option-A recall fixture or option-B doc/impl agreement (`strength` math pinned to
the reworded description).

---

## R8 · Agent-authored marking on read-back

`query`/`snapshot` rows gain `agentAuthored: true` and always include `sources` + `status`; tool
description appends: "Findings are agent-authored claims with evidence — verify before acting."
Docs (`tools.en/zh.md`) get a short "Trust model" paragraph. Tests: `query rows carry provenance
and the trust flag`.

---

## R9 · Bounded batch fan-out

`packages/web/src/components/layout/sidebar.tsx` — extract `runBounded<T>(ids, worker, limit = 8)`
(promise-pool); use it in `batchArchive` and `confirmBatchDelete`. Preserve semantics exactly
(per-id settle, succeeded/failed split, retention of failed marks). **Test:** mocked endpoint
records concurrency peaks; 200 ids → peak ≤ 8; partial-failure contract unchanged (existing e2e
still green).

---

## R10 · Tool-schema token cost measurement

Method: `JSON.stringify({name, description, parameters})` per default tool → `chars/4` (the repo's
labelled estimate); baseline = the 9-tool set before PR #12; report `{ baseline, withNew, delta,
perTool }` in `docs/content/tools.*.md` (a small table) and as `tools/measure-tool-schema-tokens.mts`.
Trim rule: if delta > 1,500 tokens, cut description prose to the schema (the catalog defers
exposure, so long descriptions are not load-bearing).

---

## R11 · Findings-plane test battery

Named cases (each must FAIL against pre-R code — use the revert-check method):
1. `merge idempotency under randomized reports` (seeded LCG, 100 reports over 20 titles).
2. `snapshot round-trip preserves the events log` (seq + actor + type).
3. `supersede cycles` (R1c) · 4. `eviction + reference hygiene` (R1a) · 5. `dead-claim re-report`
(R1c) · 6. `truncation markers` (R5) · 7. `store concurrency` (R2a) · 8. `corruption quarantine`
(R2c). Property loops use a tiny seeded PRNG (no new deps).

---

## R12 · A11y verification pass

`packages/web/e2e/a11y.spec.mjs`: chat page, sidebar, settings — run `axe-core` (add as a devDep
if absent; it is already referenced by prior audits' tooling) and assert zero `critical`/`serious`;
add keyboard-only flows: Tab to the batch bar, operate Delete, Escape semantics; dark-mode
contrast sampling on `--color-text-secondary`; target-size sweep (≥24px per WCAG 2.5.8 floor the
app already states). Output: `a11y-report.md` in the PR with the raw counts.

---

## R13 · CI truth pass

`gh pr checks 12 --repo …` → per-job table into `docs/audits/2026-09-29-unified.md` §Validation;
any red: `gh run view <id> --log-failed`, fix, push, re-record. Node version note: CI = 24
(Dockerfile pins 24.18.0); local runs = 26.

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
Error triple: `HttpError` gains `kind` + `i18nKey`; strings gain `errors.<code>` entries (en+zh).
Tests: `reports the interesting status not the last` (403→429→429 ⇒ 403) · `defaults to 502 with
no failures` · `every HttpError code has an i18n key` (parity test) · `check:i18n` green.

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
- `nav-group-collapse.ts:50-53`: delete the phantom-route claim (default), or ship the route —
  maintainer's call recorded in the PR.
- `features/canvas/` — delete (0 importers, verified by the III.2 audit); run the verbatim/dead-import
  checks used by the IV.4 split work.
- `features/cockpit/` directory rename → `features/cockpit-widgets/` (ends the name collision);
  update importers (grep-driven).

### F6 · STREAM_BANNER_FRAME
Constant lives beside `disclosure-row.tsx`'s exported frame strings; five call sites
(`attached-files-banner`, `goal-banner`, `handoff-banner`, `harness-banner`, `mcp-connect-banner`,
`org-trigger-banner`, `scheduled-banner`, `skills-banner`, `step-banner` — take the verbatim
copies the III.5 audit listed) import it. Rendered-class strings must be byte-identical before
and after (diff the joined class strings in a unit assertion).

### G5 · TLS verification fix
`.agents/skills/bm…/bgm-library/scripts/downloader.js:12` — drop `rejectUnauthorized: false`
(and any sibling: `grep -rn "rejectUnauthorized" .agents`). If a host genuinely needs a custom
CA, the escape hatch is an explicit env var (`NODE_EXTRA_CA_CERTS`), not a disabled check.

### G7 · Anti-slop installer path fix
`tools/oxlint/anti-slop/` ships `rules-src/`; the vendored skill's `install.mjs` expects
`assets/anti-slop`. Fix `install.mjs`'s path or add the missing manifest entry (the skill permits
`rules-src` copies — follow its own README). Acceptance: `node install.mjs --dry-run` resolves.

### J1 / J6 / T0.3 / J11
- **J1:** `package.json` `"clean": "node scripts/clean-workspace.mjs"`.
- **J6:** `ci.yml:150` comment → "59 spec files" (or `# N spec files` computed); sweep sibling count claims.
- **T0.3:** `scripts/refresh-core-snapshot.mjs` — build core (tsup via the `.pnpm` path trick),
  glob `node_modules/.pnpm/@prismshadow+penguin-core@*/node_modules/@prismshadow/penguin-core`,
  copy `dist/**`, print `grep -c <sentinel> …/dist/index.js` per copy. AGENTS.md line: "after
  changing `packages/core/src`, run `node scripts/refresh-core-snapshot.mjs` — server/web/cli see
  core through file: snapshots."
- **J11:** `scripts/check-doc-claims.mjs` — parse Status-Ledger tables in `tasks/plan.md` +
  `docs/audits/*`, resolve each named module path, `grep -c` importers outside its package;
  a "DONE"/"Shipped" row with zero external importers fails (R7's Option B keeps `retention.ts`
  legal by labelling it experimental — the checker honors the label).

---

## Promotion cards (plan §5A — passive → active → product)

### C10 · Session briefing injection (P1)
**Where it hooks:** `Agent.assembleContext` (`packages/core/src/agent.ts` — the same seam the
skills index uses) gains a `findingsSection()` built from `FindingsGraph.query`:
`status ∈ {confirmed, open}`, `subject` = the session workspace, sorted by
severity·confidence·recency, **cap 8 rows and ≤1,200 tokens** (chars/4), titles + subjects +
status only (P4's trust rule: `open` rows are labelled "unverified"). Dedupe against the skills
index lines (no title overlap). Re-assembles only where skills do (compaction rotation).
**Tests:** `briefings carry only confirmed or labelled-unverified rows` · `budget is respected`
(100-finding fixture → ≤8 rows) · `a poisoned body never reaches the prompt` (body content
asserted absent) · `workspace with zero findings adds no section`.
**Files:** `agent.ts`, `knowledge/briefing.ts` (new), tests.

### C11 · Watcher-driven staleness (P2)
**Hook:** `CodeGraphWatcher` `change` events (already emitted for the cockpit) add a second
listener in the server runtime: for each changed file, `findings.query({ subject: file })` and set
`stale: true` (new optional field; `FindingEvent { type: "demote" }`). Query gains
`stale?: boolean` filter; `confirm` clears staleness (re-verification). Never delete (invariant).
**Tests:** `touching a subject demotes its findings` · `confirm re-verifies` · `demote is logged
with actor system`. **Files:** `packages/server/src/cockpit/ws.ts` (listener), `findings-graph.ts`
(`demote`), tests.

### C12 · Findings chat-native surface (P3)
Composer action "Log finding" (in the `PlusMenu`), prefilled `subjects: [currentFile]`; chat
header badge = count of open findings for this workspace; rows render `path:line` drill-through
(uses the existing file-preview drawer seam). Reuses C1's components — one implementation, two
mounts. Acceptance: keyboard-operable; a11y per R12; i18n en+zh (new keys in `strings-*.ts`).
**Tests:** web unit (form validation mirrors routes) + one e2e flow in `session-select` style.

### K18 · Verification workflow gating briefings (P4)
UI: findings rows gain Confirm/Refute buttons → `POST /confirm` with `actor:user` (R1b) and the
evidence-gate dialog ("confirm needs runtime/implementation evidence — add one or override").
Briefing rule (C10) ships `confirmed` + `user`-verified only; `open` rows render labelled
"unverified" until then. Tests: `confirm without evidence opens the override dialog` ·
`briefing excludes unverified claims when the strict flag is on` (default on; the flag is a
session option, not a silent knob).

### D11 · Impact-aware write advisory (P5)
`edit_file`/`write_file` post-success: resolve the edited file in the cached code graph
(`graphFor(ctx.workspaceDir)` — R6's single-flight), collect its symbols' dependent counts
(`getImpactRadius` on the regex tier today; D4b later), and when max dependents ≥5 append one line
to the tool output: `impact: <symbol> has N dependents (code_graph)`. Budget: ≤1 line, ≤20ms
(cache hit only — never scan on the write path; miss = silent). Tests: `high-impact edit gains the
notice` · `cache miss stays silent` · `notice never exceeds one line`.

### F17 · Offline posture banner (P8)
Global banner bound to `navigator.onLine` events: "Offline — PenguinHarness is local-first;
nothing syncs." C8's e2e asserts it appears under `setOffline(true)` and disappears on restore.
One component + one i18n pair + one e2e assertion.

### F18 · Spill/recall UI affordance (P7)
When a tool-call result carries B1's `{path,sizeBytes,tokenCount}`, the tool-call card renders a
chip "Full output saved (N KB, ~M tokens) — open" that streams the recall id via a small endpoint
(`GET /api/scratchpad-file?...` with the existing workspace-file seam, read-only, path-guarded);
CLI `penguin recall <id>` prints to stdout. Tests: chip renders for spilled results only; recall
endpoint refuses paths outside the archive root (the path-guard test from the workspace-file seam).

### I7 · Pressure-aware write guard (P10)
`internal/command-policy.ts` (or `sandbox/service.ts` where writes converge): before write-capable
commands, consult the same probe `resource_pressure` uses; free space <200MB → surface warning in
tool output; <50MB → refuse with `PressureBlocked` unless the call carries the explicit
`overridePressure: true` user-approved flag (approval flow integration — recorded in the
approval receipt). The `resource_pressure` **tool** is untouched (its observe-only contract).
Tests: `warns under 200MB` · `blocks under 50MB without override` · `override passes and is
recorded` · `resource_pressure still never refuses`.

### J12 · PR annotations for gates + findings (P15)
CI step after J3/J11 compute their results: GitHub annotations API (`::error file=…`) for
stale-doc claims and coverage deltas; a findings sweep: for every file in the diff, `query({subject:
file, status: confirmed})` → `::warning` per hit, `::error` for severity critical. Output also lands
in the job summary. Tests: the check script has a fixture diff + fixture findings producing the
expected annotation lines (pure function test).

### J13 · Health → alerting (P11)
`/health` computes `degradations: string[]` (disk <200MB, DB closed, kernel-version skew on the
default agent, eviction-archive >16MB); when non-empty and changed since the last emit (dedupe
window 6h), publish through the K6/notification seam (once K6 exists; until then, a structured
log + `/health` payload is the contract). Tests: `degradations listed` · `repeats deduped`.

### G8 · Skills doctor + health badges (P12)
`penguin skills doctor` wraps G1/G2/G6 outputs (same code path as CI — one implementation);
skills-page rows gain a health badge: green (validators clean) / amber (capability manifest
missing) / red (validation failure), with the failing rule named in the tooltip. Tests: doctor
exit codes; badge mapping unit test.
