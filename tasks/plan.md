# Implementation Plan: Absorption & Hardening Master Plan (v2)

**Target:** `D:/GitHub/penguin-harness-fork` · **Base:** PR #12 `feat/knowledge-plane-native-tools`
(7 commits over merge-base `9f978056`; 64 files in the review diff + the tool-alias fix `9c733d4`
and this plan) · **Sources:** `Unified Report Multi-Agent Collage.txt` (Parts I–V),
`absorb/reports/cluster-{A–F}.md` + per-repo sections, `UNIFIED-AUDIT-AND-IMPLEMENTATION.md`,
the four adjudicated prior audits, and the **PR #12 external review (2026-09-29)** — adjudicated
in §3 and absorbed as Wave R.

## 0. How to read this document

- Task IDs: `R#` review absorptions · `A#` LLM resilience · `B#` context economy · `C#`
  knowledge/memory · `D#` codegraph/AST · `E#` server hardening · `F#` web/UI · `G#` skills
  governance · `H#` CLI/config plane · `I#` security · `J#` ops/CI · `K#` strategic.
- Sizing: XS 1 file · S 1–2 files · M 3–5 · L is always split into numbered sub-tasks.
- Every task states: Description → Acceptance (measurable) → Verification (exact command) →
  Dependencies → Files → Source (report § / review ID / audit finding).
- `tasks/todo.md` is the checkable index; this file is the authority on *what and why*.
- Definition of Done (all tasks): the acceptance criteria hold, the named verification is green,
  `prettier --check` + `oxlint --deny-warnings` + `tsc --noEmit` pass for touched packages, docs
  that name the behavior are updated in the same commit, and the change is independently revertable.

## 1. Overview

Everything the OG investigations and the PR #12 review put on the table — the 25-port ledger
(collage §V.6), the six clusters' candidates and higher-order flags, the audit findings/residuals,
the named leaks and defects (§IV.5.5, §IV.8.2), the queue (§V.3), and the review's F1–F7 / N1–N12 —
as ~95 sized tasks in five waves. Wave R (the review absorptions) goes first: it hardens the
findings plane while that code is still newest, and it converts the review's "going further" list
into the plan's spine (lifecycle as a state machine, one store, tool hardening, test batteries).

## 2. Status Ledger — DONE (do not rebuild)

| Item (OG naming) | State | Where |
|---|---|---|
| Findings knowledge graph + agent reporting (mission 1) | **Shipped** (hardening: Wave R) | `packages/core/src/knowledge/`, `knowledge_graph` tool, `/api/projects/:id/findings/*` |
| Memory retention/decay/consolidation **policy module** | **Shipped as unconsumed library** — see R7 before calling memory "done" | `packages/core/src/memory/retention.ts` |
| AST substrate: IR + FQN + `entityIdOf` + parser pool (cluster-D §7 core) | **Shipped** (needs D1–D4 + benchmark before promotion) | `packages/core/src/codegraph/ast/` |
| Native code intelligence tool | **Shipped** (resource discipline: R6) | `code_graph` tool |
| Cockpit runtime key coherence (backend F1 core) | **Shipped** — review probed the reap path and found it sound | `packages/server/src/cockpit/ws.ts` |
| Incremental-cache invalidation ordering | **Shipped** | `incremental-graph-cache.ts` |
| Multi-select batch delete + e2e (user bug) | **Shipped** (fan-out bound: R9) | `sidebar.tsx` / `selection-bar.tsx` / `e2e/session-select.spec.mjs` |
| Secondary-ink contrast sweep (web F1) | **Shipped** (full a11y proof: R12) | 29 files |
| Kernel advance + tool-alias sync (both guards fired) | **Shipped** | `kernel-history.ts` 2026-09-29, `strings-*.ts` |
| Findings dedupe/supersession/provenance core semantics | **Shipped** (lifecycle truth: R1) | `findings-graph.ts` |
| Audit adjudication + ledger | **Shipped** (contradiction cleanup: R3) | `UNIFIED-AUDIT-AND-IMPLEMENTATION.md` |

Local verification already done (Node 26; CI runs Node 24 — R13 records CI's verdict): core 248
files/4,845 tests, web 205/2,525, docs 53, findings routes 5/5, session-select e2e 6/6, server
batteries 17 + 58 + 33, tsc × 5 packages, oxlint 0/0 across 2,273 files, prettier, i18n parity.

## 3. Review Feedback Adjudication (PR #12 external review, 2026-09-29)

Probes run against the live tree on receipt; the reviewer's coverage gaps (no server/web/e2e runs,
Node 22) are covered by the local runs in §2. Every verdict below lands as a task or a note.

| ID | Claim | Verdict | Probe evidence | Absorbed as |
|---|---|---|---|---|
| F1 | "Nothing is deleted" invariant false; eviction order comment wrong; no eviction test | **Confirmed** (with the reviewer's correction: `confirmed` sorts last, evicted only after all else) | `findings-graph.ts:14` header vs `:508` comment ("superseded-then-refuted") vs code (`STATUS_RANK` ascending = refuted→superseded→open→confirmed); eviction test grep = 0 hits | R1a |
| F2 | Two stores; tool cache never invalidated; no lock on tool writes | **Confirmed structurally** (race not reproduced) | `knowledge-graph.ts:115` Map, `:121-131` loadGraph caches forever, `:140` bare `writeFileSync`; routes use `ProjectJsonStore.update` + `withFileLock` | R2a, R2b |
| F3 | Report self-contradiction (Part 5 "unimplemented" vs Part 3 "DONE"); stale "No commits made"; root placement | **Confirmed** | `UNIFIED-AUDIT-AND-IMPLEMENTATION.md` Part 5 line predates item 11; header stale after the PR | R3 |
| F4 | GET query casts unchecked; `mutate()` maps all engine errors to 400; unused `_c`; duplicated `TIERS`; transitions record no actor | **Confirmed** | `findings.ts:38` TIERS dup of core, `:120-121` casts, `:191/206/221` bare `decodeURIComponent`, `mutate` catch-all `badRequest` | R4 (+R1b for actor) |
| F5 | "Memory graph DONE" overstated; `strength()` docs vs `createdAt` math | **Confirmed** | `findings-graph.ts:397` computes reinforcement from `createdAt`; `retention.ts` consumers = 0 (grep hits are unrelated modules) | R7 |
| F6 | PR too big to review/revert cleanly | **Qualified** — 7 logically separated commits, each revertable; full split optional | `git log --oneline` on the branch | Open Question Q1 |
| F7 | Default tool schemas: token cost unmeasured; frozen agents need kernel path | **Confirmed as measurement gap** (frozen-config behavior already documented in tools docs) | `default-config.ts` additions; docs note | R10 |
| N1 | Eviction leaves dangling `related`/`supersededBy` refs | **Confirmed** | `evictIfNeeded` deletes map entries without pruning survivors | R1a |
| N2 | Supersession cycles allowed; replacement liveness unchecked | **Confirmed** | `findings-graph.ts:309` guards only `id === replacementId` | R1c |
| N3 | `confirmed` needs no evidence; transitions unattributed | **Confirmed** | `confirm(id, note?)` `:288`; no actor params anywhere in the lifecycle API | R1b |
| N4 | Re-report of a refuted claim merges silently, stays refuted | **Confirmed behavior, undocumented** (design question) | id-line merge has no status guard | R1c |
| N5 | Tool path has no input bounds (routes do) | **Confirmed** | `knowledge-graph.ts` `asString`/`asEvidence` trim-only vs `findings.ts` caps | R2b |
| N6 | Budget slicing can emit invalid JSON, no truncation marker | **Confirmed** | `safeSlice` cuts the serialized text at the char boundary | R5 |
| N7 | Memory-poisoning hypothesis (agent-authored claims persist into future sessions) | **Investigation Candidate — accepted as a design risk** (query returns titles/subjects, not bodies, which bounds it) | tool `query` shape | R8 (+ risk row) |
| N8 | `code_graph` cache race leaks a watcher; Map unbounded | **Confirmed structurally** | `code-graph.ts:83-89` close-then-async-scan, no single-flight, no cap | R6 |
| N9 | retention.ts unused | **Confirmed** (= F5) | grep | R7 |
| N10 | Corrupt store silently resets to empty; next write destroys evidence | **Confirmed** | `decodeGraphJson` returns `emptyGraphJson()` with no quarantine/log | R2c |
| N11 | Batch-delete fan-out unbounded | **Confirmed** (same shape as the pre-existing batchArchive) | `confirmBatchDelete` `Promise.allSettled(ids.map(...))` | R9 |
| N12 | `decodeURIComponent` URIError → likely 500 | **Confirmed plausible** (onError maps unknown → 500) | `findings.ts:191/206/221` | R4 |
| — | Reviewer's soundness checks (reap-by-identity, host-attested provenance both paths, 0600 atomic tool writes, path-scoped `code_graph`) | **Agreed** — independently verified earlier | — | keep as invariants |

## 4. Architecture Decisions

1. **Clean-room, spec-first ports.** CC BY-NC-SA (Antigravity twins), GPLv3 (Budibase core),
   proprietary (tldraw editor) and ELv2 (mastra `ee/`, `connect`) sources are re-implemented from
   the *reports'* prose; source files of those trees are never opened while implementing.
2. **One findings store behind one interface.** Tool and routes share `FindingsStore`
   (locked `update`, single set of bounds, one corruption policy) — R2. Two persistence authorities
   is a bug, not a feature.
3. **The findings lifecycle is a state machine with actors.** Transitions are enumerated, gated
   and attributed (R1b/R1c). "Nothing is deleted" becomes precise: nothing is *lost* — eviction
   archives to a sidecar and every reference is cleaned (R1a).
4. **Evidence gates status.** `confirmed` requires at least one `runtime`/`implementation`
   evidence entry (or an explicit human override recorded as actor=`user`). This encodes the audit
   protocol instead of narrating it.
5. **One graph for agent and UI; AST behind the same seam.** `code_graph` and the cockpit topology
   read one engine; the AST tier replaces extraction behind it and must **beat the regex tier on
   the benchmark before promotion** (D10 gate).
6. **Failure classification is typed, never prose-matched** (the qwen `strings.Contains` lesson).
7. **Compression/pruning never destroy signal** — RTK's three non-negotiables are tests.
8. **Tool output is machine-safe**: bounded, paginated, and explicitly marked when truncated (R5).
9. **Every default change is a migration** — kernel-hash + tool-alias guards stay the model.
10. **Resource discipline is part of correctness** — single-flight scans, capped caches, bounded
    fan-out (R6/R9/R2b).

## 5. Dependency Graph

```
Wave R:  R1a ─┬─ R1b ── R1c          R2a ─┬─ R2b ── R2c        R4 ──(actor)── R1b
              └─(tests) R11 ◄──────────────┘                    R5, R6, R8, R9, R10 (independent)
                                                                R3, R7, R12, R13 (independent)
Wave 2:  A3 ── A4 ── A1 ── K4        B2 ── B1 ── B3        E2 ── E3 ── E4
         A8 ── A7 ── K2              C2/R7 ── C3 ── C4 ── C5 ── C6
Wave 3:  D1 ── D2 ── D3 ── D4a ── D4b ── D5 ── D9 ── D10(=K17 feed)   G1 ── G2, G6
         H3 ── H1 ── H2 ── K3        C1 ── C9, K12      F8 ── F10a/F15      K8 ── K11
Wave 4:  K1 ← A5,A9 · K5 ── K14 · K16 ← R1b · K17 ← D10,C4
Single-owner files: core/src/index.ts, state/default-config.ts, state/kernel-history.ts
```

## 5A. Promotion Ladder — passive → active → product

The plan's tasks mostly *build* things. This section asks the second question the OG material
supports but never states: **which built things should be elevated** — wired to a second system,
promoted from read to write, or surfaced from engine layer to product/user layer. Ladder:
**L0** library/engine · **L1** wired + active in-process · **L2** agent surface (tool) ·
**L3** server/API surface · **L4** user-facing product surface.

| # | Item (today's layer) | Promote to | Wiring that elevates it | Task | Product surface gained |
|---|---|---|---|---|---|
| P1 | Findings store is a passive record (L0–L3) | **Active context** (L4) | session-open hook: `query({status: confirmed\|open, subject: cwd})` top-N → briefing block in the system prompt, ≤1,200 tokens, deduped against the skills index | **C10** | chat "Known findings" panel; first-run orientation |
| P2 | Findings ⇄ code-graph links are static text (L0) | **Live staleness** (L1) | `code-graph-watcher` change events demote findings whose `subjects` touch changed files (`stale` flag — the agentmemory "watcher-demoted, never deleted" rule) | **C11** | `stale` badge in query rows and the cockpit page |
| P3 | Findings live on the cockpit page only (L3) | **Chat-native surface** (L4) | composer "log finding" action (opens the report dialog prefilled with the current file/symbol), count badge on the chat header, drill-through `path:line` | **C12** | findings inside the daily surface, not a separate page |
| P4 | Findings trust is a marker (R8, L1) | **Verification workflow** (L4) | only `confirmed` (or `user`-verified) findings enter briefings (C10); UI gains Confirm/Refute buttons that record `actor:user` | **K18** | "verify this claim" loop in the UI; briefing trust is earned, not assumed |
| P5 | `code_graph.impact` is a read (L2) | **Write-path advisory** (L1) | `edit_file`/`write_file` compute impact for touched symbols (cheap: reuse the cached graph) and append one line — "impact: N dependents (code_graph)" — above a threshold (≥5) | **D11** | impact warning at the moment of change, not on request |
| P6 | Engine tier (ast vs regex fallback) is internal (L0) | **Honest status** (L2–L4) | `code_graph` `status` action reports tier + staleness + cache stats (R6); topology header shows an "AST / scan" badge | **D9** (amended) | users know which quality tier they are looking at |
| P7 | Large-output spill is invisible plumbing (L1) | **Recall affordance** (L4) | tool-call card renders a "full output saved" chip; clicking streams the recall id on demand; CLI `penguin recall <id>` | **F18** | the compression story becomes legible in the chat |
| P8 | Offline behavior is a test only (L0) | **Posture banner** (L4) | `navigator.onLine` banner ("offline — this is a local-first app; nothing syncs"), asserted by C8 | **F17** | the local-first promise becomes visible instead of implied |
| P9 | ACP resume/behind-state is engine-only (L1) | **Resync control** (L4) | the E4 gap signal feeds a "N events behind — resync" button in the cockpit | **E3/E4** (amended) | users self-heal staleness instead of trusting it |
| P10 | `resource_pressure` observes and never refuses (L2, by design) | **Enforcement elsewhere** (L1) | a pressure-aware guard at the *command-policy* layer: warn <200MB free, block new writes <50MB, always overridable by an explicit user action; the tool itself stays observe-only | **I7** | pressure gauge + block toast; safety without betraying the tool's contract |
| P11 | `/health` is an endpoint (L3) | **Alerting** (L4) | degradation emits through the K6 digest/notification plane (disk, DB, kernel-version skew, eviction-archive growth) | **J13** | ops learn from the product, not from a curl |
| P12 | Skill validators are CI scripts (L1) | **Doctor + badges** (L4) | `penguin skills doctor` (G1/G2 output as CLI) + skills-page health badges (capability risk from G6 manifests) | **G8** | skill health is user-visible where skills are managed |
| P13 | Classifier flip is engine policy (A1, L1) | **Failure stories** (L4) | A1's classifications + B2's head/tail become K4's `failureTrace`, rendered in the web error panel and in `penguin why` | **K4** (amended) | "what actually went wrong" is a product answer |
| P14 | Retention/eviction is library policy (R7, L0) | **Memory transparency** (L4) | the eviction archive (R1a) is surfaced: "why is this memory gone" reads the archive; dashboard counts by tier | **R7/C1** (amended) | memory stops being a black box |
| P15 | Gates are scripts (J3/J11, L1) | **PR annotations** (L4) | CI posts annotations (coverage delta, stale-doc claims, findings on touched files) instead of only a red check | **J12** | reviewers see why, in the PR |
| P16 | Benchmark runs are reports (D10/K17, L0) | **Auto-findings** (L1) | benchmark outcomes auto-`report()` as findings with run artifacts as evidence | **K17** (amended) | the ledger writes itself |

### Explicit NON-promotions (design invariants — do not "elevate" these)

1. **Jev advisory stays event-only.** Its `PROVENANCE.md` invariant — observes, never authorizes,
   vetoes, gates, or adds latency — is the module's reason to exist. Any "make Jev decide" request
   is refused at the design level.
2. **`resource_pressure` the *tool* stays observe-only** (see P10: enforcement lives at the
   command-policy layer). The tool's docs comment exists precisely to stop this drift.
3. **`query` keeps bodies out of its output** (poisoning bound, review N7). Briefings (P1) ship
   titles + subjects + status only, and only `confirmed`/user-verified claims (P4).
4. **`code_graph` stays read-only** — no refactor/write actions on the graph surface. P5 is an
   advisory *inside existing write tools*, not a new writer.
5. **Refusal-list items are never promoted to product** (plan §9): a bridge, a rotation pool, or a
   fingerprint spoofer is not a feature waiting for a UI.
6. **Frozen agent configs are not auto-migrated.** Kernel updates stay explicit (the tools docs
   already promise this); P-tier surfaces may *show* "kernel outdated" but never rewrite silently.

### Promotion tasks (full cards in `tasks/execution-cards-1.md`, §Promotion)

**C10 · Session briefing injection** · M · deps R2a,R1b,K18 — P1
**C11 · Watcher-driven staleness** · S · deps C5(or C6),R1a — P2
**C12 · Findings chat-native surface** · M · deps C1,R8 — P3
**K18 · Verification workflow gating briefings** · S · deps R1b — P4
**D11 · Impact-aware write advisory** · S · deps D4b(or regex-tier impact),R6 — P5
**F17 · Offline posture banner** · XS · deps C8 — P8
**F18 · Spill/recall UI affordance** · S · deps B1 — P7
**I7 · Pressure-aware write guard** · M · deps E9 — P10
**J12 · PR annotations for gates + findings** · M · deps J3,J11 — P15
**J13 · Health → alerting** · S · deps E8,E9,K6 — P11
**G8 · Skills doctor + health badges** · S · deps G1,G2,G6 — P12

Amended acceptance (existing tasks): **D9** += P6 status/tier surfacing · **E3/E4** += P9 resync
button · **R7/C1** += P14 memory transparency · **K4** += P13 rendered failure stories ·
**K17** += P16 auto-findings · **A1** += classifications consumed by K4's panel.


### Wave R — PR #12 review absorptions (start here)

**R1a · Eviction policy truth & reference hygiene** · S · deps — · src F1,N1
Description: Make the invariant honest and eviction safe. Keep the cap (unbounded stores are
worse); evicted findings move to a sidecar `findings-graph.evicted.ndjson` (append, bounded by
rotation at 32MB like the audit-retention precedent) so "nothing is lost" is literally true; on
eviction, prune the victim's id out of every survivor's `related` and clear dangling
`supersededBy` (repointing to the nearest live ancestor or leaving a tombstone note).
Acceptance: ① header says "nothing is lost: eviction archives and cleans references" and the
`:508` comment names the real order (refuted → superseded → open → confirmed-last); ② eviction
of a linked pair leaves zero dangling ids in `exportSnapshot()`; ③ `confirmed` is evicted only
when it is the only rank left (test pins the rank order with `maxFindings: 3`); ④ sidecar
round-trips. Verification: `vitest run test/knowledge` with new `eviction` cases (R11 suite).
Files: `packages/core/src/knowledge/findings-graph.ts`, `test/knowledge/findings-graph.test.ts`.

**R1b · Lifecycle state machine, evidence gate, actor attribution** · M · deps R1a · src N3,F4
Description: Enumerate transitions and attribute them. Table: `open → confirmed | refuted`;
`open | confirmed → superseded` (replacement must be `open|confirmed`); `confirmed → refuted`
(falsification); `refuted | superseded` are terminal except R1c's explicit reopen. `confirm`
requires ≥1 evidence with tier `runtime|`implementation`, else 409 with the missing-gate message
(human override: `override: true` records actor kind `user`). Every transition appends
`FindingEvent { actor: {kind: "user"|"agent"|"system", id}, method: "tool"|"route", note? }`;
routes fill actor from the authenticated user, the tool from `ctx.attribution`.
Acceptance: ① the transition table is code (`canTransition(from,to)`) and every illegal move
throws a typed `LifecycleError`; ② `confirm` on an evidence-free finding fails both paths;
③ `events` output names the actor for every non-ingest event; ④ route/tool actor forgery is
impossible (tool overwrites any body-supplied actor). Verification: engine + tool + route tests
(all three layers assert the same table). Files: `findings-graph.ts`, `knowledge-graph.ts`,
`findings.ts`, `types.ts`, tests ×3.

**R1c · Transition guards: cycles, liveness, dead-claim re-reports** · S · deps R1b · src N2,N4
Description: `supersede` rejects a replacement that is itself `superseded`/`refuted`, rejects
cycles transitively (walk `supersededBy` chain, cap 64), and a re-report landing on a `refuted`
finding follows a written rule: default creates a NEW finding linked `contradicts` the dead one;
`reopen: true` on the report input reopens explicitly and records the actor. Superseded chains
stay immutable. Acceptance: ① `supersede(a,b); supersede(b,a)` throws; ② re-report with new
evidence produces the new finding + `contradicts` link by default and reopens only with the flag;
③ chain walk is bounded and tested at depth 64. Verification: `vitest run test/knowledge`.
Files: `findings-graph.ts`, `types.ts` (`ReportFindingInput.reopen`), tests.

**R2a · One findings store behind one locked interface** · M · deps — · src F2
Description: `FindingsStore` in `knowledge/`: `read(): Promise<FindingsGraphSnapshot>` and
`update<T>(fn): Promise<T>` where `update` is serialized per path (reuse the server's
`withFileLock` seam — move it to `core/internal` or share the pattern), plus `invalidate()`.
`FileFindingsStore` (tool) and a `ProjectJsonStore` adapter (routes) implement it; the tool's
process-wide `Map` cache becomes a cache *behind* the store, invalidated on every write and
guarded by file `mtime+size` so external edits are picked up. One in-flight `update` per workspace
(single-flight promise chain like `ProjectJsonStore.tails`).
Acceptance: ① both paths import the same interface and neither writes files directly; ② two
concurrent `update`s on one workspace serialize (test interleaves 50 reports, all present);
③ an external file edit is observed on the next call (mtime guard). Verification: new
`test/knowledge/findings-store.test.ts` + existing route/tool tests. Files: `knowledge/store.ts`,
`knowledge-graph.ts`, `findings.ts`, `test/knowledge/*`.

**R2b · Bounds parity, store byte cap, rehydrate caching** · S · deps R2a · src N5,F7,perf
Description: The tool enforces exactly the route caps (title ≤300, body ≤50k, subjects ≤100×500,
evidence ≤100 with quote ≤2000, tags ≤50) via one `validateReportInput()` shared by both; the
store refuses to grow past 8MB (413-ish typed error with guidance to prune); the server caches
the hydrated graph per project keyed by file `mtime+size` so reads stop re-parsing per request.
Acceptance: ① an oversized tool report fails with the same error text as the route; ② byte-cap
test; ③ two consecutive GETs parse the store once (counter in test). Verification: store + route
+ tool tests. Files: `knowledge/store.ts`, `knowledge/validation.ts`, `findings.ts`,
`knowledge-graph.ts`, `packages/server/src/http/routes/findings.ts`.

**R2c · Corruption policy: quarantine, never silent loss** · S · deps R2a · src N10
Description: On an unparseable store: copy it to `.findings-graph.json.corrupt-<ts>` before
starting empty, emit one structured log line, and surface `recoveredFromCorruption: true` in the
`snapshot` response so the UI can say it (draculabo's quarantine rule, collage §I.2.4.4).
Acceptance: ① garbage store → quarantine file exists, graph starts empty, log emitted, flag set;
② a second corruption does not overwrite the first quarantine. Verification: store tests.
Files: `knowledge/store.ts`, `findings.ts`, tests.

**R3 · Report & governance reconciliation** · S · deps — · src F3
Description: Fix the contradictions (Part 5 "unimplemented" line → "shipped: item 11"; header
"No commits made" → the PR state); move the report to `docs/audits/2026-09-29-unified.md` with a
root pointer line in the old path or a README link; create `docs/policies/porting-and-refusals.md`
holding the REFUSE list and the license table (so policy is checked in, not report-scoped — the
review's governance note). Acceptance: ① zero contradictory status claims (grep "unimplemented",
"No commits made"); ② the policy file exists and the plan/README link it. Verification: docs
suite + grep. Files: `UNIFIED-AUDIT-AND-IMPLEMENTATION.md` → `docs/audits/…`,
`docs/policies/porting-and-refusals.md`.

**R4 · Route hygiene** · S · deps — · src F4,N12
Description: GET `kind`/`status` validated through the same `enumField` path as POST (400 on
unknown); `mutate()` maps only the engine's typed `LifecycleError`/`UnknownFindingError` to
404/409/400 and rethrows anything else (real 500s stay 500s); `decodeURIComponent` wrapped →
400 on `URIError`; the shared `TIERS`/enum lists imported from core (delete the route's copies);
drop the unused `_c` parameter. Acceptance: ① `?kind=vibes` → 400 listing the enum; ② an injected
engine `TypeError` surfaces as 500, not 400; ③ `%zz` in a finding id → 400; ④ one definition of
each enum. Verification: `vitest run test/findings-routes`. Files: `findings.ts`, tests.

**R5 · Tool output integrity: markers + pagination** · S · deps — · src N6
Description: Never emit truncated JSON. `snapshot`/`events` gain `limit`/`after` cursors and
return `{ page, nextCursor, total }`; any output over the budget is cut at a record boundary and
ends with `… [truncated: N of M records — pass after=<cursor> for more]`. Small outputs stay
plain JSON for compatibility. Acceptance: ① `snapshot` with 500 findings pages deterministically
with no duplicate/missing ids across pages; ② every truncated response parses as JSON (or NDJSON)
and carries the marker; ③ the 6,000-char budget never produces invalid JSON. Verification: tool
tests incl. a JSON.parse over every output variant. Files: `knowledge-graph.ts`, `types.ts`, tests.

**R6 · code_graph resource discipline** · S · deps — · src N8
Description: Single-flight scans per workspace (in-flight `Map<string, Promise<…>>`; concurrent
callers await the same scan); watcher cache capped (LRU 8, `close()` on evict and on TTL refresh —
the current code closes *then* scans, leaking on concurrency); `stats()` reports cache size/evictions;
docs state the watcher answer explicitly (`scanWorkspace()` installs no fs watchers — only
`init()` does, and the tool never calls it). Acceptance: ① 20 concurrent `index` calls → exactly
one scan (counter) and zero leaked watchers; ② 10 workspaces with cap 8 → size ≤ 8 and 2 closes
observed. Verification: `vitest run test/knowledge/code-graph-tool.test.ts` extended.
Files: `code-graph.ts`, tests.

**R7 · Memory-plane honesty or wiring** · M · deps — · src F5,N9
Description: Decide in one place. Option A (preferred): wire `retention.ts` into
`HierarchicalMemoryStore.evictToTokenBudget` behind `retentionPolicy: "experimental"` opt-in and
measure recall before/after on the existing memory fixtures; Option B: label the module
experimental (`@experimental` JSDoc + docs line) and fix `FindingsGraph.strength`'s doc/impl
mismatch (either track `accesses`/`lastAccessedAt` like `strengthAt` does, or reword to
"reinforced by creation recency"). The Status Ledger in §2 already carries the honest wording.
Acceptance: ① one option implemented end-to-end; ② `strength()` docs match the math exactly;
③ if Option A: a measured recall delta is recorded in the PR. Verification: core memory tests +
fixtures run. Files: `retention.ts`, `hierarchical-memory-store.ts`, `findings-graph.ts`, docs.

**R8 · Agent-authored provenance on read-back** · S · deps — · src N7
Description: `query`/`snapshot` results carry `source` + `status` + `agentAuthored: true`, and the
tool description states that stored claims are agent-authored hypotheses, not verified facts — the
poisoning-risk mitigation the review asks for (bodies stay out of `query` output). Acceptance:
① every query row shows source and status; ② the tool description contains the one-line trust
notice. Verification: tool tests + docs section. Files: `knowledge-graph.ts`, `tools.en/zh.md`.

**R9 · Bounded batch fan-out** · XS · deps — · src N11
Description: Chunk `batchArchive`/`confirmBatchDelete` to 8 concurrent requests (simple promise
pool), preserving the existing per-id failure semantics. Acceptance: a 200-marked batch completes
with ≤8 in flight (test with a mocked endpoint counting concurrency) and the same partial-failure
retention behavior. Verification: web unit test + existing e2e unchanged. Files: `sidebar.tsx`, test.

**R10 · Tool-schema token cost measurement** · S · deps — · src F7
Description: Measure the serialized `KNOWLEDGE_GRAPH_PARAMETERS` + `CODE_GRAPH_PARAMETERS` +
descriptions against the 9-tool baseline (chars/4 estimate, the repo's convention) and record the
numbers in the tools docs; if the two tools add >1,500 tokens to the default prompt surface,
trim descriptions to schema-level (the catalog defers exposure anyway). Acceptance: a measured
table (before/after, tokens per tool) in the PR; trimmed or justified. Verification: `tools/measure-*` script run.
Files: `default-config.ts` (descriptions), `docs/content/tools.*.md`, `tools/`.

**R11 · Findings-plane test battery** · M · deps R1a,R1b,R1c,R2a · src review §5
Description: Property-style tests (deterministic seeded loops, no new deps): merge idempotency
(100 randomized reports → stable set), snapshot round-trip incl. events log (seq preserved),
supersede cycles, eviction + reference hygiene, dead-claim re-report, truncation markers,
store concurrency (50 interleaved updates), corruption quarantine. Acceptance: each named case
exists and fails against the pre-R code (revert-check method from §IV.5.2). Verification:
`vitest run test/knowledge`. Files: `test/knowledge/*.test.ts`.

**R12 · A11y verification pass** · S · deps — · src review domain note
Description: The contrast sweep is one SC; run an axe-core pass over the main web surfaces and a
Playwright keyboard/focus/dark-mode/target-size check; record the results and fix only what this
pass finds (F-wave leftovers). Acceptance: axe report with zero critical/serious on chat, sidebar,
settings; every interactive control reachable by keyboard with a visible focus ring. Verification:
new `e2e/a11y.spec.mjs` + axe run. Files: `packages/web/e2e/a11y.spec.mjs`, fixes as found.

**R13 · CI truth pass (Node 24)** · XS · deps — · src review §8
Description: Read the PR #12 CI matrix to completion (the fix re-run was 3-pending at review
time), record the green/red table in the report's validation section, and fix any red before the
PR merges. Acceptance: a recorded per-job table matching Actions; zero unexplained reds.
Verification: `gh pr checks 12` + `gh run view --log-failed` for any red.

### Checkpoint: Wave R
- [ ] R1–R13 acceptance criteria green; `test/knowledge` + `findings-routes` + web suite pass
- [ ] §2 Status Ledger updated wherever R7/R12 change the wording
- [ ] Reviewer's F1–F7/N1–N12 all marked resolved/declined-with-reason in §3

### Wave 1 — Foundations & quick wins

**A2 · FailureStatusTracker + error taxonomy triple** · S · deps — · src collage §I.1.3.4/15
Description: Track the *interesting* status in failover (last non-429; else 429 if any failure;
else 502) so an exhausted rotation reports 403/400, not "rate limited"; server `HttpError` codes
gain `(kind, english, i18n_key)` and strings gain the keys. Acceptance: rotation test with a 403
mid-chain surfaces 403; every `HttpError` code has an i18n key (parity test). Verification:
`vitest run test/errors.test.ts test/gateway*` server + `check:i18n`.
Files: `packages/core/src/llm/failure-status.ts`, `packages/server/src/http/errors.ts`, `strings-*.ts`.

**A3 · Retry-delay provenance + Retry-After** · M · deps — · src §I.1.3.2
Description: `ParsedDelay { rawMs, source: header|structured|text }` with the confidence buffers
(+200ms structured, +1000ms text), separator-insensitive key match (`retryDelay` never misread as
prose), `Retry-After` honored and bounded (≤60s), grace window ≤5s; wire into
`reconnectDelayMs` and `key-rotator` cooldowns (currently flat 60s). Acceptance: the precedence
table (header > JSON > NL) has one test per row; nonsense values degrade to the default. Verification:
`vitest run test/llm*`. Files: `packages/core/src/llm/{retry-delay,context-engine,key-rotator}.ts`, tests.

**B2 · BoundedStreamCapture head+tail** · S · deps — · src §I.1.3.15
Description: 256KB head + 256KB tail, never the middle, with a `…[omitted N bytes]…` marker at
the seam. Acceptance: 1MB stream retains both ends byte-exact; marker present. Verification:
new `test/trace/bounded-capture.test.ts`. Files: `packages/core/src/trace/bounded-capture.ts`, test.

**F1 · Input focus rings** · S · deps — · src web audit F2–F4
Description: menu search box, `rule-policy-editor.tsx:125` `focus:ring-0`, `field.tsx`/panelSearch
faint gray rings → solid `var(--accent-bg)` `:focus-visible` rings (≥3:1). Acceptance: R12's axe
pass shows zero focus-indicator violations. Verification: web suite + R12. Files:
`components/ui/{input,field}.tsx`, `features/guardian/rule-policy-editor.tsx`.

**F3 · Comment-lies + dead code** · S · deps — · src III.2/III.4.3
Description: `router.tsx:427-428` /usage claim → reality (or gate the route as the comment says —
decide with the maintainer, default: fix the comment); `nav-group-collapse.ts:50-53` machines
claim → ship the route or delete the claim (default: delete); `features/canvas/` (1,308 lines, 0
importers) removed; `features/cockpit/` directory renamed (name collision with the cockpit page).
Acceptance: zero behavior-contradicting comments in the touched files; the rename compiles; human
review before push. Verification: web suite + grep. Files: 4 sites.

**F6 · STREAM_BANNER_FRAME dedup** · XS · deps — · src III.5
Acceptance: one definition beside `disclosure-row.tsx`'s constants; 5 files adopt it; rendered
bytes identical (snapshot test optional). Files: 6 banner files.

**G5 · TLS verification fix** · XS · deps — · src SEC-EXEC-04
Acceptance: no `rejectUnauthorized:false` under `.agents/`; the downloader still works against a
normal TLS endpoint. Files: `.agents/skills/bgm-library/scripts/downloader.js` + sweep.

**G7 · Anti-slop installer path fix** · XS · deps — · src IV.6.7 #2
Acceptance: `node install.mjs` dry-run resolves its assets (either path or manifest fixed).

**J1 · `clean` script wiring** · XS · deps — · src IV.5.6
Acceptance: `pnpm clean` matches `scripts/clean-workspace.mjs` report mode. Files: `package.json`.

**J6 · CI/docs drift sweep** · XS · deps — · src infra F5
Acceptance: `ci.yml:150` spec count matches reality or says "N spec files"; all Status-Ledger
"done" claims name their file (pairs with J11). Files: `.github/workflows/ci.yml`, docs.

**T0.3 · Snapshot-refresh helper** · S · deps — · src memory note
Description: `scripts/refresh-core-snapshot.mjs` — build core, copy `dist` into every
`.pnpm/@prismshadow+penguin-core@*/…` snapshot, print the `grep -c` staleness probe; AGENTS.md line.
Acceptance: one command makes server/web/cli see fresh core (probe > 0 for a sentinel export).
Verification: run + probe. Files: `scripts/refresh-core-snapshot.mjs`, `AGENTS.md`.

**J11 · Docs-claims consistency gate** · S · deps J6 · src review §8
Description: A script fails CI when a Status-Ledger/"DONE" claim names a module with zero
importers outside its own package (the review's docs-gate idea, scoped to the ledgers' modules).
Acceptance: the check passes on this tree after R7; a planted stale "DONE" fails it. Verification:
`node scripts/check-doc-claims.mjs` + CI step. Files: `scripts/check-doc-claims.mjs`, workflow.

### Checkpoint: Wave 1
- [ ] Named focused suites green; prettier / oxlint / tsc clean; F3 deletions human-reviewed

### Wave 2 — Core hardening

**A1 · Classifier flip: shadow → active** · M · deps A2,A3 · src §I.2.3 + provider-gateway
Description: Promote `fleet/provider-gateway.ts` per its own flip rule (zero un-enumerated
`agrees=false` over a release — scan the shadow log first and attach the scan as evidence);
retire the precedence divergence (`generative-model.ts` rate-limit-first vs
`credential-rotation.ts` auth-first); keep `KNOWN_DIVERGENCES` documented. Acceptance: one
classifier decides; prose never decides; shadow logger removed or gated. Verification: core llm + fleet tests.
**A4 · Pool-shape-aware retry budget** · M · deps A3 · src §I.1.3.3
Description: attempts `pool≤1?3:(pool*2).clamp(4,12)`; round-1 50ms fast-rotate; ≤5s delay →
grace-in-place; >5s && pool>2 → keep rotating; linear 2s fallback capped 5s; single-account 429
capped 10s; **once-per-account grace** set. The full branch table from the report's
`retry_strategy_tests.rs` summary becomes the test table. Acceptance: every branch row tested;
no 50ms exhaustion loop (the report's "杜绝 50ms 闪电耗尽重试" case). Files: `llm/retry-policy.ts` + tests.
**A5 · Snapshot→delta stream reassembler** · M · deps — · src §I.3.2.1
Description: `class StreamReassembler { apply(target): Delta[]; finalize(): Delta[] }` with the
reference semantics: extend→suffix; prefix-truncate→nothing; rewrite→LCP-suffix **and view
re-sync**; rune-safe LCP; UTF-16→byte with surrogate clamp; 24-rune hold-back; `<details`/quote
partial holds; release reasoning before content overtakes. Property test: 500 random edit
sequences → never invalid UTF-8, view==target at finalize. Files: `llm/stream-reassembler.ts` + tests.
**A6 · Length-prefixed frame parser** · S · deps — · src §I.4.3.1
Acceptance: the reference's five test shapes (cross-chunk, astral, resync, EOF flush, marker≠length) pass.
**B1 · Large-output spill + recall id** · M · deps B2 · src cluster-A #1
Description: 40KB inline threshold (bytes/4 estimate), spill to the truncated-output archive,
return `{path,sizeBytes,tokenCount}`; agent-origin calls stay inline; recall id fetches full
output. Acceptance: failures (non-zero exits) always inline; recall round-trips byte-exact.
**B3 · In-process tool-output compression** · M · deps B1 · src §IV.9
Description: four strategies (filter/group/truncate/dedup-counts), test-runner failures-only
collapse; the three non-negotiables as tests; measured savings table per strategy — **any strategy
under 10% is dropped and the drop is documented**. Acceptance: table + the 3 tests + drop list.
**B4 · Transactional compaction + prune frontier** · M · deps — · src cluster-C #4
Acceptance: failed compaction leaves context byte-identical; oversized-skip frontier never
re-reads a skipped block; kept IDs survive pruning. Files: `agent/resource/compaction/` + tests.
**C8 · Offline e2e** · S · deps — · src REL-ARCH-02 gap
Acceptance: `setOffline(true)` → seeded chat renders <100ms, zero unhandled rejections, in CI's e2e job.
**E1 · Cockpit sync-seam residuals** · S · deps — · src backend F1 residual
Acceptance: no code path builds a guardian-less `SwarmCoordinator`; `process.cwd()` default
removed or proven test-only and documented. Files: `cockpit/ws.ts`, tests.
**E5 · trigger_swarm non-simulate** · S · deps — · src backend F4
Acceptance: non-simulate either executes (handler wired) or 400s at the boundary — never a dead path.
**E6 · Cockpit error-shape unification** · XS · deps — · src backend F5
Acceptance: every cockpit route error is `{error:{code,message}}` (+ additive `success`), tests updated.
**E7 · Gateway input validation** · XS · deps — · src backend F6
Acceptance: `sessionId/projectId/projectPath` bounded at the boundary (defense-in-depth; sink stays display-only).
**E8 · /health + readiness** · S · deps — · src II.4 gap
Acceptance: 200 serving / 503 DB-closed; mounted beside `versionRoutes`; tested.
**E9 · Structured logger + rejection counter** · M · deps — · src II.4 gap
Acceptance: zero `console.*` in server src; `unhandledRejection` rate visible (health/telemetry).
**E10 · Leak fixes** · M · deps — · src §IV.5.5
Description: (a) orphan reaping beyond `exit` hook (parent-pid watchdog / Job Object), (b)
`disposeRemoved` timeout on never-settling `entry.running`, (c) wire `SwarmCoordinator.abort()`
to session deletion, (d) truncated-archive per-session cap. Each fixed with the revert-and-see test method.
**E2 · acp.ts 8-defect sweep** · M · deps — · src §IV.8.2
Description: verify-then-fix each of the 8 (transportError latch → recovery/reset; lineBuffer cap
+ max frame; late-response counter; swallowed-parse-error record; write queue ordering; parallel
notification handlers; handshake/liveness; dispose notifies). Preserve the two documented fixes.
Acceptance: a per-item verified/refuted table in the PR; every confirmed one fixed with a test.
**E3 · ACP connection resume** · M · deps E2 · src §IV.8.2 brief
Acceptance: monotonic cursor + bounded replay (bound documented), reconnect jitter (house idiom),
UI "behind" banner instead of silent staleness. Files: `kernel/acp.ts` + web state.
**E4 · Durable SSE tail + safeSend gap signal** · M · deps E3 · src cluster-F #3, backend F3
Acceptance: kill the socket mid-stream → reconnect replays within the bound, `caught_up` marker,
no silent gaps. Files: `cockpit/ws.ts`, `cockpit/event-log.ts`.
**G1 · validate-agent-skills gate** · M · deps — · src cluster-A #1
Acceptance: taxonomy/frontmatter/≤80-line/references-link + command-liveness cross-check; corpus
passes or is triaged in the PR; new violations fail CI.
**G3 · skills-lock pin + resolver** · S · deps — · src cluster-A #7
Acceptance: one skill pinned → verified → detected-drift case covered.
**G4 · Patch/supersession hygiene** · S · deps — · src audit B
Acceptance: zero ambiguous `local.patch` (ledger or deletion); deliberate supersessions kept and documented.
**H3 · Atomic credential write audit** · S · deps — · src §I.1.3.6
Acceptance: the five steps each proven by test against `internal/atomic-write.ts` (create_new,
0600-at-creation, inherit perms, sync-before-rename, temp cleanup) or fixed.
**I1 · Redaction completions** · S · deps — · src §I.1.3.15
Acceptance: 14-session-header allowlist test; `mask_email`/`sanitize_error_for_log` unit tests.
**I2 · Command-policy completions** · S · deps — · src §I.1.3.15
Acceptance: dangerous-char path refused before spawn; `CREATE_NO_WINDOW` applied on Windows.
**I3 · Zip symlink-entry refusal** · S · deps — · src cluster-A #8
Acceptance: extraction test with a symlink-entry fixture refuses cleanly.
**I4 · effective_auth_mode matrix** · S · deps — · src §I.1.3.15
Acceptance: `Auto→Off` loopback / `AllExceptHealth` LAN matrix tested.

### Checkpoint: Wave 2
- [ ] Full suites green (core ≈4.9k, web ≈2.5k, server split, cli/docs/landing)
- [ ] A1 flip evidence attached; B3 savings table human-reviewed; E2 per-item table in the PR

### Wave 3 — Expansion

**D1 · Grammar pack vendoring** · M · deps — · src cluster-D §7
Acceptance: `web-tree-sitter` pinned ≥0.25; `scripts/codegraph/build-grammars.sh` builds 12 wasm
grammars (`tree-sitter build --wasm`, TS in `typescript/` subdir); license manifest ships; absent
grammar degrades that language only. Gate for D3+: release-size tolerance confirmed (Open Q4).
**D2 · .scm packs (TS/JS) + extractor→IR** · M · deps D1 · src cluster-D §13
Acceptance: golden extraction passes calldiff CONTRACT's 6 behaviors (methods, receiver calls,
ctors, branches, nested-lambda non-attribution, computed callees ignored).
**D3 · Language packs python/go/rust/java** · M · deps D2
Acceptance: per-language goldens.
**D4a · Symbol table + import resolution** · M · deps D2 · src cluster-D §3 Phase A
Acceptance: byFqn/byName/byPackage/typeHierarchy built; alias-aware imports; homonyms clamped by
language+path prefix (the Bikach schema rule).
**D4b · Call-resolution ladder + overload scoring** · M · deps D4a · src cluster-D §3 (the crown jewel)
Description: the 11-step ladder verbatim as spec — 0 qualified FQN · 0.5 ctor heuristic → `<init>`
· 1 receiver type · 2 receiver expr (local → property → statics) · 3 bare (current class →
superclass chain) · 4 imports · 5 same package + overload selection · 6 wildcards · 7 extensions
filtered by receiver · 8 single-candidate else unresolved-if-ambiguous (all-declaring-types share
one ancestor chain → root, else drop) · 9–10 stdlib tables → else **drop the edge**. Overload
scoring: +100 exact arity, −1 per extra, +50 fewer; per-arg +50 equal / +25 compatible / −10
mismatch; deterministic tie-break. Acceptance: one fixture per step; zero fake edges in goldens;
"missing edge beats a wrong edge" asserted directly.
**D5 · callstack-diff + graph_diff tool** · M · deps D4b · src cluster-D §5
Acceptance: LCS sibling alignment (removal-first tie), added/removed subtrees fully marked,
recursion `⇄`, fingerprint-seeded reverse-BFS entry inference.
**D6 · git-snapshot reader** · M · deps — · src cluster-D §5
Acceptance: two-commit fixture diffs without a worktree checkout; oid-deduped `cat-file --batch`.
**D7 · GraphStore interface + snapshot versioning** · S · deps D4a · src cluster-D #9
Acceptance: handlers hold no serialization; SCHEMA_VERSION drop-and-recreate proven by a migration test.
**D8 · Seeded Louvain + god nodes** · S · deps D4b · src cluster-D #11
Acceptance: two runs byte-identical (codepoint insertion order, seeded PRNG).
**D9 · Tool-surface upgrade** · M · deps D5,D8 · src cluster-D #4/#10
Acceptance: explore-first catalog gating; budgeted markdown grouped by file; pipe formatters with
`… M more (raise limit…)`; empty-result hints ("exists but no internal callers; defined at …");
routing guidance has one source of truth (the tool description).
**D10 · Benchmark harness (AST vs regex!)** · S · deps D9 · src cluster-D #12 + review
Acceptance: the 5-scenario table (LLM calls/tokens/cost/time) produced for **both tiers**; the AST
tier is promoted only if it wins, else it stays `fallback` and the docs say so. Feeds K17.
**C1 · Findings cockpit UI** · M · deps R2b · src mission 1
Acceptance: all 8 routes exercised; evidence + provenance + actor visible; a11y per R12; Operate-mode design.
**C3 · Consolidation runner** · M · deps R7 · src agentmemory schedules
Acceptance: 2h pipeline / 5min Stop-hook debounce / 24h decay sweep; gates fire exactly at ≥5
summaries and ≥2×freq≥2; idempotent re-run.
**C4 · RRF hybrid retrieval** · M · deps C3 · src cluster-C #5
Acceptance: 0.4/0.6/0.3 weights, K=60, +5% agreement bonus, provenance rank string; the reference fixtures pass.
**C5 · Bitemporal edges + asOf** · M · deps C4 · src cluster-C #1
Acceptance: `asOf` reconstructs last week's graph from `tcommit/tvalid/tvalidEnd/version/supersededBy/isLatest`.
**C6 · Supersession cascade → stale** · S · deps C5 · src cluster-C #3
Acceptance: jaccard>0.7 supersedes / >0.4 hints; dependents marked stale, never deleted.
**C7 · Influence receipts** · S · deps R1b · src cluster-B #2
Acceptance: a receipt round-trips report → query as evidence with actor `agent`.
**C9 · MEMORY.md ⇄ findings interop** · S · deps C1 · src brain-tree pattern
Acceptance: round-trip preserves both surfaces; promotion rules documented.
**F2 · Shared clock** · S · deps — · src web F5
**F4 · Nav-collapse migration** · S · deps — · src III.4.2 #1 (the ~20-line half-finished migration)
**F5 · Dock tab dedup** · S · deps — · src III.4.2 #2 (~30 lines net; kill remount-on-switch)
**F8 · Contrast module + token-colors** · S · deps — · src cluster-E #2 + III.2 measured hits (1.67/2.77/2.98/2.15:1)
**F9 · Calendar grid + ticket nested button** · S · deps — · src III.3 blockers
**F7a · Sidebar split step 4** · M · deps F4,F5 · src III.4 table
**F7b · ChatInput split** · M · deps — · src III.5 (2,911 lines; behavior-free first extraction)
**F7c · Workspace-browser split** · M · deps — · src III.5 (2,152 lines)
**G2 · Skill routing probes** · M · deps G1 · src cluster-A #2
Acceptance: deterministic description-scoring probes; a routing-breaking edit fails CI.
**G6 · Skill capability manifests** · M · deps G1 · src SEC-SKILL-03
Acceptance: `network/fs/env` declarations enforced at the skill-script boundary; the audit's named scripts declare and pass.
**H1 · foreign-config contract** · M · deps H3 · src §I.1.3.8
Acceptance: backup → atomic write → version gate → restore; `is_managed_provider` ownership; redacted read-back diff.
**H2 · YAML round-trip** · M · deps — · src §I.1.3.7
Acceptance: comments + indentless-sequence style survive a programmatic edit (fixture).
**H5 · Tiered help** · M · deps — · src cluster-A §1 (simple/default/full)
**H6 · Command-hint graph** · S · deps H5
**H7 · Levenshtein arg suggestions** · S · deps — · src cluster-A #3
**I6 · Payload audit compaction** · S · deps I1 · src §I.1.2.5
**J2 · Actions SHA pinning** · S · deps — · src infra F1
**J3 · Coverage instrumentation** · M · deps — · src infra F2 (v8 coverage + thresholds on critical modules)
**J4 · retry:0 flake lane** · S · deps — · src infra F3
**J5 · Desktop Electron smoke** · M · deps — · src infra F4 (Playwright `_electron`)
**J7 · 3-variant Dockerfiles** · M · deps — · src §I.1.2.13
**J8 · AGENTS.md constitution** · S · deps — · src §I.1.3.14 (four rules)
**J9 · Postmortem template + checklists** · S · deps — · src §I.1.3.15

### Checkpoint: Wave 3
- [ ] D10 two-tier benchmark table produced; D4b's ladder fixtures complete
- [ ] C1 findings demo transcript recorded (session → findings → query → UI)
- [ ] CI matrix green on 3 OSes; R12 a11y pass clean

### Wave 4 — Strategic / second-order

**K4 · Self-diagnosing failure mode** · M · deps A1,A2,B2 · §I.1.4.4 — `failureTrace` on errors
("rotated N accounts; real cause was 400 on attempt 3") + head/tail capture attached.
**K2 · Cost ledger + `penguin why`** · M · deps A7,A8 · §I.1.4.2 — per-turn decomposition (thinking
vs cache-miss vs prompt), `cache-effectiveness` repo, CLI subcommand (a debugging tool).
**A7 · CanonicalUsage** · M · deps — · §I.1.3.11 (feeds K2) — 7 fields, 12 aliases, Anthropic-shape healing.
**A8 · Token estimator + calibration** · S · deps — · §I.1.3.12 (feeds A7).
**A9 · Content-addressed session fingerprinting** · S · deps — · §I.1.3.25 (feeds K1).
**K3 · Trustworthy CLI configurator** · M · deps H1,H2,H4 · §I.1.4.3 — with the review screen.
**K1a · Turn ledger core** · M · deps A5,A9 — `session/turn-ledger.ts` + `resumeFrom(ledger)`.
**K1b · Cross-protocol resume demo** · M · deps K1a — one session survives a provider/protocol switch.
**K5 · Tool-schema normalisation surface** · M · deps — · cluster-A #5/#6 + §I.1.4.5 —
`llm/tool-schema.ts` ($ref flattening, scored `anyOf`, strict-mode with `unsupported` reporting,
key sanitize/restore round trip).
**K14 · ToolRouter plane + permission vocabulary** · L→ K14a design note (S) then K14b implementation (M)
· deps K5 · cluster-A higher-order — design note must reconcile with the approvals plane first (Q2).
**K6 · Interruption politeness (novu)** · M · deps E9 · cluster-F H6 — digest merge, ConditionsFilter, preferences.
**K7 · HITL suspend/resume plane** · M · deps E3 · cluster-B #2 + dify #2 — verdicts, forms, release-the-worker.
**K8 · Eval plane** · M · deps C4 · cluster-B #3 — gates/thresholds/`notScorable`, sha256 sampling,
scorers-as-loop-guards on WorkRouter goals, first-tree 4-tier skill-evals for the corpus.
**K9 · Fleet state machine + worktree-per-agent** · M · deps — · vibe-tree H1.
**K10 · Rules engine + context providers + system-message tools** · M · deps — · continue's three planes.
**K11a · Agent-orchestration contract note** · S · deps K8 — how network routing + tri-state goal +
scorers compose with `WorkRouter` (collage V.4 dispatch rules as acceptance).
**K11b · Orchestration implementation** · M · deps K11a.
**K12 · Agent-ops dashboards** · M · deps C1 · lobehub plane.
**K13 · PiX graph-of-turns + patch codec** · M · deps K1 · MPL-2.0: modified files stay openly licensed.
**K16 · Findings-as-audit-protocol** · L→ K16a (S) + K16b (M) · deps R1b · src review strategic
Description: map the audit protocol onto the model — add `investigation_candidate` status and a
`confidenceLabel` enum (observed/confirmed/strongly-inferred/plausible/unverified/contradicted)
derived from evidence tiers + status; a `checklist` action runs the §19 quality gate as data
(10 questions per finding); report tooling consumes it. Acceptance: a finding cannot reach
`confirmed` without surviving the checklist data; the mapping table is documented and tested.
**K17 · Benchmark ledger** · M · deps D10,C4 · src review strategic
Description: the README's reproducible-benchmark promise — benchmark/task outcomes stored as
findings (evidence = run artifacts), queryable per scenario, feeding a README "Benchmark" section
that always links to the latest ledger entries. Acceptance: D10's table lands as findings and the
README section renders from the ledger.
**F10a · Semantic-token measurement** · S · deps F8 — one pass over the 635 `text-gray-*` sites to
cost full overlay vs incremental (resolves Q2 with numbers).
**F10b · Semantic token overlay** · L→ scope after F10a · cluster-E higher-order — token layer over
the Tailwind gray scale, then delete `dark:` twins; generation-time contrast receipts.
**F11a/b/c · Topology canvas engine** · L→ 3 sub-tasks · deps — · tldraw MIT parts (`@tldraw/state`,
store) + clean-room culling / camera+easings / elbow routing for `features/topology/`.
**F12a/b · Workflow visualizer** · L→ 2 sub-tasks · deps K11b · mastra/sim step-graph → Dagre.
**F13a/b/c · Export plane** · L→ 3 sub-tasks · deps — · open-design: DTO contract · PPTX/PDF assembly
+ print CSS · export-queue state machine.
**F14 · Cowork UX (AionUI set)** · M · deps K9 — status badge, run-view reconciliation, warmup overlay, command queue.
**F15 · Chart architecture + palettes** · M · deps F8 — shared-scale charts + data-viz palettes for cockpit.

### Checkpoint: Wave 4
- [ ] K4/K2/K3 demonstrated end-to-end; K16 checklist enforced on real findings
- [ ] Open Questions Q1–Q4 resolved or deferred with recorded reasons

## 7. Test Plan (cross-cutting)

- **Findings plane:** R11's eight named suites; property loops seeded (no new deps); every lifecycle
  rule tested at engine + tool + route level (three layers, one table).
- **LLM layer:** A5's 500-sequence property test; A3 precedence rows; A4's full branch table;
  A1's `agrees=false` corpus as fixtures.
- **Codegraph:** golden extraction per language (D2/D3), ladder fixtures per step (D4b),
  benchmark artifacts (D10) checked in under `tools/benchmarks/`.
- **E2E:** session-select (6 cases incl. batch delete), offline hydration (C8), a11y (R12), and the
  existing 59 specs stay green.
- **Regression discipline:** the revert-check method (§IV.5.2) for every fix that claims a defect —
  the failing case must fail against pre-fix code.

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Registry `file:` snapshots hide stale core (bit us 3×; also masked the alias failure locally) | Med | T0.3 helper; CI is arbiter; never merge on local green alone |
| Findings store unification regresses the shipped routes/tool | High | R2 lands behind the interface with all three test layers green before old code is deleted |
| Memory poisoning of the findings plane (N7) | Med | R8 trust marking + bodies out of `query`; provenance/actor visible; K16 checklist |
| Compression/pruning destroys signal | High | B3's three non-negotiables as tests; recall path mandatory |
| Resolver emits wrong edges | High | D4b fixtures per step; drop-the-edge doctrine |
| Clean-room contamination | High | task Source cites report §, never encumbered source files |
| Sibling sessions editing this tree | High | disjoint file sets, md5-snapshot before edits (collage V.1) |
| L-scope creep | Med | break at 5 files / 3 acceptance bullets; K14/K11 get design notes first |
| Release size from wasm grammars | Med | Q4 gate before D3 |
| Full server suite local stall (`isolate:false` quirk) | Low | named-file runs; CI split jobs authoritative |

## 9. Constraints — permanent REFUSE list (now `docs/policies/porting-and-refusals.md`, R3)

No free-api bridges (glm/qwen/gemini/deepseek families), no account/quota rotation, no device-fingerprint
spoofing, no uTLS/JA3 dialers, no vendor-binary patching, no PoW-WASM, no `.assets/`
reverse-engineering material, no WAF/prompt-sanitiser stripping. Licenses: Antigravity twins CC
BY-NC-SA (clean-room from reports only), Budibase core GPLv3 (design-rewrite), dify `web/`
(modified Apache), tldraw editor (proprietary), mastra `ee/**` + `connect` (ELv2) — ideas only;
PiX MPL-2.0 — modified files stay open; MIT/Apache-2.0 material keeps its notice. Retention
constants come from the Apache-2.0 agentmemory *report descriptions* (clean-room numbers, cited) —
R7's PR must re-verify the license line.

## 10. Parallelization & ownership

4–8 flash-model workers. Disjoint streams: {R tasks} | {A,B} | {C} | {D} | {E} | {F} | {G,H,I} | {J,K}.
Sequential chains per §5. Single-owner: `core/src/index.ts`, `state/default-config.ts`,
`state/kernel-history.ts`, `knowledge/findings-graph.ts` (R1b/R1c hold it), `knowledge/store.ts` (R2).
Any task touching those files pauses if another worker holds them (collage V.4's refuse-or-defer rule).

## 11. Open Questions

- **Q1 (F6):** split PR #12 into fixes / web / knowledge-plane? Commits are already separable and
  revertable; full split is maintainer preference. *Recommendation: keep one PR (CI is green and
  the commits are clean), split only if review bandwidth is the bottleneck.*
- **Q2 (K14):** does the Composio permission vocabulary replace or sit above our approvals plane?
  *Recommendation: above (adapter), keeping approvals as the single enforcement point — K14a's
  design note decides.*
- **Q3 (B3):** which outputs actually compress ≥10% in our corpus? Measurement decides; losers are dropped.
- **Q4 (D1):** is a 10–20MB wasm grammar payload acceptable in releases? Gate before D3.
- **Q5 (R7):** Option A (wired + measured) vs Option B (experimental label)? *Recommendation: A if
  the fixture measurement is cheap, else B now and A at Wave 3's C3.*
