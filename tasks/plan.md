# Implementation Plan: Absorption & Hardening Master Plan (v3)

**Target:** `D:/GitHub/penguin-harness-fork` · **Working branch:** PR #12
`feat/knowledge-plane-native-tools`; review baseline `fd27e3d3c` (re-check HEAD before execution;
older commit counts and line numbers are historical snapshots) · **Versioned evidence:**
`docs/audits/2026-09-29-unified.md`, current code/tests, and the
[PR #12 review and checks](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/pull/12).
Historical source labels (`cluster-A`–`F`, collage Parts I–V, prior audits) identify the earlier
investigation, but their source files are not versioned in this checkout. The contracts and
acceptance criteria here and in the execution cards are self-contained; an implementation must
verify any historical assertion against current code before changing behavior.

**Live release gate, 2026-09-30:** the local branch contains unpushed R13/R14 changes after the
remote PR head, so remote check results do not certify this exact candidate. The focused R13
skills browser test passed locally after its locator was scoped; a full browser and operating
system matrix has not been rerun on the current local head. R14a now locks Electron 43.5.0 and
R14b moves the runtime and build-chain Undici paths to 7.29.1 and 6.28.1; `pnpm audit` reports no
known vulnerabilities, and the full server suite/typecheck pass locally. The desktop suite and
typecheck passed after R14a, but packaged installer/runtime and cross-platform checks remain
unverified on the current candidate. Keep release blocked until exact-head CI and packaged desktop
smokes pass; do not infer readiness from a previous remote SHA or local focused tests.

## 0. How to read this document

- Task IDs: `R#` review absorptions · `A#` LLM resilience · `B#` context economy · `C#`
  knowledge/memory · `D#` codegraph/AST · `E#` server hardening · `F#` web/UI · `G#` skills
  governance · `H#` CLI/config plane · `I#` security · `J#` ops/CI · `K#` strategic.
- Sizing: XS 1 file · S 1–2 files · M 3–5 · L is always split into numbered sub-tasks.
- Every execution card states: existing behavior and failure mode → smallest deliverable →
  boundary/compatibility contract → acceptance with a negative case → verification → rollback →
  dependencies and source. The compact task entries below are an index; `execution-cards-1.md`
  covers Wave R and Wave 1, and `execution-cards-2.md` covers the risk-bearing later work.
- `tasks/todo.md` is the checkable index; this file is the authority on *what and why*.
- Definition of Done (all tasks): the acceptance criteria hold, the named verification is green,
  `prettier --check` + `oxlint --deny-warnings` + `tsc --noEmit` pass for touched packages, docs
  that name the behavior are updated in the same commit, and the change is independently
  revertable. Migration tasks additionally require a rollback rehearsal against a copied fixture.
- A task is **not** done because a file exists, a local test passed, or a downstream task is
  planned. Record its output artifact, exact test command/result, target commit, and remaining
  caveat in the PR. Use `blocked` or `deferred` with a reason rather than checking it off.
- All local measurements cite the fixture, runtime/OS, command, baseline revision, and raw
  artifact. Derived thresholds are decision gates, not claims about current performance.

## 1. Overview

The ledger covers the 25-port inventory (collage §V.6), six clusters' candidates, audit
residuals, the named leaks and defects (§IV.5.5, §IV.8.2), the queue (§V.3), and review
F1–F7/N1–N12. The checklist contains more than 100 items, including optional strategic bets;
it is a **decision inventory**, not a promise to ship every external idea. Immediate work is the
PR #12 CI and dependency-audit gates and Wave R. Later waves start only after their stated product, quality, license,
and cost gates are met. Each independently useful slice must work in the active product path,
have an observable failure mode, and be safe to revert.

### Outcome measures and stop rules

| Outcome | Baseline to capture | Promotion/stop decision |
|---|---|---|
| Findings correctness | Tool and route snapshots in separate authorities; concurrency and corruption fixtures; mapped-scope fixture only if R2d activates | No lost acknowledged write, no cross-scope silent merge, no dangling live reference. Stop rollout on any violation. |
| Findings usefulness | Top-N retrieval relevance and false-positive rate on a fixed, reviewer-labelled fixture | Ship a briefing only when verified findings help the task and prompt injection probes stay inert. Otherwise keep query on demand. |
| Code intelligence | Regex and AST output on the same frozen projects and goldens | Promote by precision/recall **and** latency/memory/package-size budgets; never trade invented edges for more coverage. |
| Context economy | Raw bytes/tokens, failure preservation, recall success on a fixed tool-output corpus | Keep a strategy only when it saves ≥10% on its eligible corpus without losing failure evidence. |
| Product surfaces | Task completion, keyboard path, error recovery, and render time on named flows | Keep the smallest surface that improves the flow; remove unused controls. |

**Scope discipline:** Wave R and the CI repair are P0. Wave 1/2 repairs with reproduced defects
are P1. Wave 3 promotions are conditional P2. Wave 4 and external-inspired subsystems are P3
experiments until a named user journey, baseline, owner, and stop criterion justify them.

## 2. Status Ledger — DONE (do not rebuild)

| Item (OG naming) | State | Where |
|---|---|---|
| Findings knowledge graph + agent reporting (mission 1) | **Shipped** (hardening: Wave R) | `packages/core/src/knowledge/`, `knowledge_graph` tool, `/api/projects/:id/findings/*` |
| Memory retention/decay/consolidation **policy module** | **Experimental, exported, and unconsumed by in-repo production code** — distinct from `RecallStore`'s active age/count/token bounds; see R7 | `packages/core/src/memory/retention.ts`, `memory/index.ts` |
| AST substrate: IR + FQN + `entityIdOf` + parser pool (cluster-D §7 core) | **Shipped** (needs D1–D4 + benchmark before promotion) | `packages/core/src/codegraph/ast/` |
| Native code intelligence tool | **Shipped** (resource discipline: R6) | `code_graph` tool |
| Cockpit runtime key coherence (backend F1 core) | **Shipped** — review probed the reap path and found it sound | `packages/server/src/cockpit/ws.ts` |
| Incremental-cache invalidation ordering | **Shipped** | `incremental-graph-cache.ts` |
| Multi-select batch delete + e2e (user bug) | **Shipped** (fan-out bound: R9) | `sidebar.tsx` / `selection-bar.tsx` / `e2e/session-select.spec.mjs` |
| Secondary-ink contrast sweep (web F1) | **Shipped** (R12: zero axe violations, keyboard stops covered; manual-review cases documented) | 29 files |
| Kernel advance + tool-alias sync (both guards fired) | **Shipped** | `kernel-history.ts` 2026-09-29, `strings-*.ts` |
| Findings dedupe/supersession/provenance core semantics | **Shipped** (lifecycle truth: R1) | `findings-graph.ts` |
| Audit adjudication + ledger | **Shipped** (R3 reconciled and moved) | `docs/audits/2026-09-29-unified.md` |

Local verification already done (Node 26; CI runs Node 24 — R13 records CI's verdict): core 248
files/4,845 tests, web 205/2,525, docs 53, findings routes 5/5, session-select e2e 6/6, server
batteries 17 + 58 + 33, tsc × 5 packages, oxlint 0/0 across 2,273 files, prettier, i18n parity.

## 3. Review Feedback Adjudication (PR #12 external review, 2026-09-29)

Probes run against the live tree on receipt; the reviewer's coverage gaps (no server/web/e2e runs,
Node 22) are covered by the local runs in §2. Every verdict below lands as a task or a note.

| ID | Claim | Verdict | Probe evidence | Absorbed as |
|---|---|---|---|---|
| F1 | "Nothing is deleted" invariant false; eviction order comment wrong; no eviction test | **Confirmed** (with the reviewer's correction: `confirmed` sorts last, evicted only after all else) | `findings-graph.ts:14` header vs `:508` comment ("superseded-then-refuted") vs code (`STATUS_RANK` ascending = refuted→superseded→open→confirmed); eviction test grep = 0 hits | R1a |
| F2 | Two stores; tool cache never invalidated; no lock on tool writes | **Partly confirmed; scopes deliberately separate by default.** Workspace and server project keys may name distinct legitimate authorities. Stale cache, best-effort write acknowledgement, and unlocked tool writes are confirmed defects. Bind or migrate only after authenticated identity mapping. | Tool: `<workspace>/.penguin/knowledge/findings-graph.json`; route: `projectDir(config.root, projectId)/.findings_graph.json`. `ProjectRow` has no workspace-path mapping. | R0,R2a; conditional R2d |
| F3 | Report self-contradiction (Part 5 "unimplemented" vs Part 3 "DONE"); stale "No commits made"; root placement | **Confirmed; resolved by R3** | Dated audit baseline, current branch reconciliation, root pointer, corrected status and canonical policy | R3 |
| F4 | GET query casts unchecked; `mutate()` maps all engine errors to 400; unused `_c`; duplicated `TIERS`; transitions record no actor | **Confirmed** | `findings.ts:38` TIERS dup of core, `:120-121` casts, `:191/206/221` bare `decodeURIComponent`, `mutate` catch-all `badRequest` | R4 (+R1b for actor) |
| F5 | "Memory graph DONE" overstated; `strength()` docs vs `createdAt` math | **Confirmed** | `findings-graph.ts:397` computes reinforcement from `createdAt`; `retention.ts` consumers = 0 (grep hits are unrelated modules) | R7 |
| F6 | PR too big to review/revert cleanly | **Qualified** — keep the coherent PR intact after R13 repair, then use narrow follow-up PRs | PR commit list and `git log --oneline` on the branch | Resolved decision Q1 |
| F7 | Default tool schemas: token cost unmeasured; frozen agents need kernel path | **Resolved** — direct and lazy payloads measured; the two added schemas cost 1,176 chars/4 estimated tokens, below the 1,500 threshold | `docs/audits/default-tool-schema-cost-2026-09-30.md`; frozen-config behavior remains documented in tools guides | R10 |
| N1 | Eviction leaves dangling `related`/`supersededBy` refs | **Confirmed** | `evictIfNeeded` deletes map entries without pruning survivors | R1a |
| N2 | Supersession cycles allowed; replacement liveness unchecked | **Confirmed** | `findings-graph.ts:309` guards only `id === replacementId` | R1c |
| N3 | `confirmed` needs no evidence; transitions unattributed | **Confirmed** | `confirm(id, note?)` `:288`; no actor params anywhere in the lifecycle API | R1b |
| N4 | Re-report of a refuted claim merges silently, stays refuted | **Confirmed behavior, undocumented** (design question) | id-line merge has no status guard | R1c |
| N5 | Tool path has no input bounds (routes do) | **Confirmed** | `knowledge-graph.ts` `asString`/`asEvidence` trim-only vs `findings.ts` caps | R2b |
| N6 | Budget slicing can emit invalid JSON, no truncation marker | **Confirmed** | `safeSlice` cuts the serialized text at the char boundary | R5 |
| N7 | Memory-poisoning hypothesis (agent-authored claims persist into future sessions) | **Investigation Candidate — accepted as a design risk** (query returns titles/subjects, not bodies, which bounds it) | tool `query` shape | R8 (+ risk row) |
| N8 | `code_graph` cache race leaks a watcher; Map unbounded | **Confirmed structurally** | `code-graph.ts:83-89` close-then-async-scan, no single-flight, no cap | R6 |
| N9 | retention.ts unused | **Confirmed** (= F5) | grep | R7 |
| N10 | Corrupt store silently resets to empty; next write destroys evidence | **Confirmed** | `decodeGraphJson` returns `emptyGraphJson()` with no quarantine/log. Automatic empty-on-error remains unsafe even if a copy is attempted. | R2c |
| N11 | Batch-delete fan-out unbounded | **Confirmed** (same shape as the pre-existing batchArchive) | `confirmBatchDelete` `Promise.allSettled(ids.map(...))` | R9 |
| N12 | `decodeURIComponent` URIError → likely 500 | **Confirmed plausible** (onError maps unknown → 500) | `findings.ts:191/206/221` | R4 |
| — | Reviewer's soundness checks (reap-by-identity, host-attested provenance both paths, 0600 atomic tool writes, path-scoped `code_graph`) | **Agreed** — independently verified earlier | — | keep as invariants |

## 4. Architecture Decisions

1. **Clean-room, spec-first ports.** CC BY-NC-SA (Antigravity twins), GPLv3 (Budibase core),
   proprietary (tldraw editor) and ELv2 (mastra `ee/`, `connect`) sources are re-implemented from
   the *reports'* prose; source files of those trees are never opened while implementing.
2. **One authority per logical findings scope.** A workspace and a server project are **separate
   scopes by default**: current `ProjectRow` has no workspace binding. Both paths use one
   validated, locked store implementation, each at its own authority path (R0/R2a). R2d is
   conditional on a future, explicit, authorized binding; no automatic cross-scope migration or
   combined UI is permitted. A bound scope must reconcile both files before a shared view exists.
3. **The findings lifecycle is a state machine with actors.** Transitions are enumerated, gated,
   and attributed (R1b/R1c). Eviction is explicit and recoverable within a documented retention
   window; bounded archive rotation cannot justify a perpetual “nothing is lost” claim (R1a).
4. **Evidence gates status.** `confirmed` requires at least one `runtime`/`implementation`
   evidence entry (or an explicit human override recorded as actor=`user`). This encodes the audit
   protocol instead of narrating it.
5. **One graph for agent and UI; AST behind the same seam.** `code_graph` and the cockpit topology
   read one engine; the AST tier replaces extraction behind it and must **beat the regex tier on
   the benchmark before promotion** (D10 gate).
6. **Failure classification is typed, never prose-matched** (the qwen `strings.Contains` lesson).
7. **Compression/pruning never destroy signal** — RTK's three non-negotiables are tests.
8. **Tool output is machine-safe**: one parseable JSON envelope, byte-bounded pages, stable
   revision-aware cursors, and explicit truncation/gap metadata (R5).
9. **Every default change is a migration** — kernel-hash + tool-alias guards stay the model.
10. **Resource discipline is part of correctness** — single-flight scans, capped caches, bounded
    fan-out, and a storage ceiling with a usable recovery path (R6/R9/R2b).
11. **Claims are data, never authority.** Actor identity comes from the trusted boundary;
    user verification is distinct from agent reporting. Briefing candidates are verified,
    sanitized, bounded, and explicitly attributed (R1b/R8/K18/C10).
12. **Release gates are observed, not inferred.** A red or missing required check blocks a PR
    even when local and other platform suites pass (R13).

## 5. Dependency Graph

```
Wave R:  R13 (repair PR #12 E2E) · R14a/R14b (dependency audit)
         R0 ── R2a ─┬─ R2b
                                                 ├─ R2c
                                                 ├─ R1a ── R1b ── R1c
                                                 └─ R5 (revision-aware output)
         R2d is a later conditional binding/migration slice, not a Wave-R blocker.
         R4 follows R1b's typed errors; R8 follows R1b's provenance; R11 follows R1/R2/R5.
         R3, R6, R7, R9, R10, R12 can be prepared independently; checkpoints wait for R13.
Wave 2:  A3 ── A4 ── A1               B2 ── B1 ── B3        E2 ── E3 ── E4
         R7(B) ── C2 (recall baseline)
Wave 3:  D1(TS/JS) ── D2 ── D4a ── D4b ─┬─ D5 ── D9 ── D10(gate) ── D3
                                         └─ D8 ── D9
         D6 assists D5; D7 versions persisted graphs before promotion.
         C2 ── C3 ── C4 ── C5 ── C6; G1 ── G2,G6; H3 ── H1 ── H4
         C1 ── C9,K12; F8 ── F10a,F15; K8 ── K11
         G1 ── G2, G6
         H3 ── H1 ── H2 ── K3        C1 ── C9, K12      F8 ── F10a/F15      K8 ── K11
Wave 4:  K1a ← A5,A9; K1b ← K1a; K13 ← K1b · K5 ── K14 · K16 ← R1b · K17 ← D10,C4
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
| P1 | Findings store is a passive record (L0–L3) | **Active context** (L4) | session-open hook retrieves only confirmed, non-stale, authorized findings for the mapped scope; a ≤1,200-token lower-trust briefing quotes titles/subjects as data and records the revision used | **C10** | chat "Known findings" panel; first-run orientation |
| P2 | Findings ⇄ code-graph links are static text (L0) | **Live staleness** (L1) | persisted code identity/content revisions mark directly evidenced findings stale after a relevant source change; filesystem events alone are hints and never change claim status | **C11** | `stale` badge in query rows and the cockpit page |
| P3 | Findings live on the cockpit page only (L3) | **Chat-native surface** (L4) | composer "log finding" action (opens the report dialog prefilled with the current file/symbol), count badge on the chat header, drill-through `path:line` | **C12** | findings inside the daily surface, not a separate page |
| P4 | Findings trust is a marker (R8, L1) | **Verification workflow** (L4) | human confirmation records a trusted actor and evidence/override reason; an agent confirmation still needs evidence and stays visibly agent-attributed; C10 includes only confirmed, non-stale claims | **K18** | "verify this claim" loop in the UI; briefing trust is earned, not assumed |
| P5 | `code_graph.impact` is a read (L2) | **Write-path advisory** (L1) | `edit_file`/`write_file` compute impact for touched symbols (cheap: reuse the cached graph) and append one line — "impact: N dependents (code_graph)" — above a threshold (≥5) | **D11** | impact warning at the moment of change, not on request |
| P6 | Engine tier (ast vs regex fallback) is internal (L0) | **Honest status** (L2–L4) | `code_graph` `status` action reports tier + staleness + cache stats (R6); topology header shows an "AST / scan" badge | **D9** (amended) | users know which quality tier they are looking at |
| P7 | Large-output spill is invisible plumbing (L1) | **Recall affordance** (L4) | tool-call card renders a "full output saved" chip; clicking streams the recall id on demand; CLI `penguin recall <id>` | **F18** | the compression story becomes legible in the chat |
| P8 | Offline behavior is a test only (L0) | **Posture banner** (L4) | combine browser network state with an actual local-server reachability probe; copy says which actions are available from cached data and when reconnect is needed, without claiming that nothing syncs | **F17** | users know which actions still work offline |
| P9 | ACP resume/behind-state is engine-only (L1) | **Resync control** (L4) | the E4 gap signal feeds a "Updates missed — resync" button; show a count only when the server can prove it | **E3/E4** (amended) | users self-heal staleness instead of trusting it |
| P10 | `resource_pressure` observes and never refuses (L2, by design) | **Enforcement elsewhere** (L1) | command-policy guard measures the target volume; warn below 200 MiB, block only nonessential new writes below 50 MiB, preserve cleanup/export/recovery, and log an explicit user override | **I7** | pressure gauge + actionable block toast |
| P11 | `/health` is an endpoint (L3) | **Alerting** (L4) | degradation emits through the K6 digest/notification plane (disk, DB, kernel-version skew, eviction-archive growth) | **J13** | ops learn from the product, not from a curl |
| P12 | Skill validators are CI scripts (L1) | **Doctor + badges** (L4) | `penguin skills doctor` (G1/G2 output as CLI) + skills-page health badges (capability risk from G6 manifests) | **G8** | skill health is user-visible where skills are managed |
| P13 | Classifier flip is engine policy (A1, L1) | **Failure stories** (L4) | A1's classifications + B2's head/tail become K4's `failureTrace`, rendered in the web error panel and in `penguin why` | **K4** (amended) | "what actually went wrong" is a product answer |
| P14 | Retention/eviction is library policy (R7, L0) | **Memory transparency** (L4) | the eviction archive (R1a) is surfaced: "why is this memory gone" reads the archive; dashboard counts by tier | **R7/C1** (amended) | memory stops being a black box |
| P15 | Gates are scripts (J3/J11, L1) | **PR annotations** (L4) | CI posts annotations (coverage delta, stale-doc claims, findings on touched files) instead of only a red check | **J12** | reviewers see why, in the PR |
| P16 | Benchmark runs are reports (D10/K17, L0) | **Auto-findings** (L1) | benchmark outcomes create idempotent, run-keyed **open** findings with artifact links; human or evidence-gated review is needed before confirmation | **K17** (amended) | a queryable ledger without automatic authority |

### Explicit NON-promotions (design invariants — do not "elevate" these)

1. **Jev advisory stays event-only.** Its `PROVENANCE.md` invariant — observes, never authorizes,
   vetoes, gates, or adds latency — is the module's reason to exist. Any "make Jev decide" request
   is refused at the design level.
2. **`resource_pressure` the *tool* stays observe-only** (see P10: enforcement lives at the
   command-policy layer). The tool's docs comment exists precisely to stop this drift.
3. **Briefings keep bodies out and sanitize titles/subjects as untrusted data** (poisoning bound,
   review N7). They use confirmed, non-stale claims only. On-demand `query` keeps its existing
   documented result shape until a versioned consumer migration is verified.
4. **`code_graph` stays read-only** — no refactor/write actions on the graph surface. P5 is an
   advisory *inside existing write tools*, not a new writer.
5. **Refusal-list items are never promoted to product** (plan §9): a bridge, a rotation pool, or a
   fingerprint spoofer is not a feature waiting for a UI.
6. **Frozen agent configs are not auto-migrated.** Kernel updates stay explicit (the tools docs
   already promise this); P-tier surfaces may *show* "kernel outdated" but never rewrite silently.

### Promotion tasks (full cards in `tasks/execution-cards-1.md`, §Promotion)

**C10 · Session briefing injection** · M · deps R0,R2a,R1b,R8,K18 — P1
**C11 · Source-revision-driven staleness** · S · deps C5(or C6),R0,R2a — P2
**C12 · Findings chat-native surface** · M · deps C1,R8 — P3
**K18 · Verification workflow gating briefings** · S · deps R1b — P4
**D11 · Impact-aware write advisory** · S · deps D4b(or regex-tier impact),R6 — P5
**F17 · Offline posture banner** · S · deps C8 — P8 (Wave 2)
**F18 · Spill/recall UI affordance** · S · deps B1 — P7
**I7 · Pressure-aware write guard** · M · deps E9 — P10
**J12 · PR annotations for gates + findings** · M · deps J3,J11 — P15 (Wave 3)
**J13 · Health → alerting** · S · deps E8,E9,K6 — P11 (Wave 4; Wave 2 ships health data)
**G8 · Skills doctor + health badges** · S · deps G1,G2,G6 — P12

Amended acceptance (existing tasks): **D9** += P6 status/tier surfacing · **E3/E4** += P9 resync
button · **R7/C1** += P14 memory transparency · **K4** += P13 rendered failure stories ·
**K17** += P16 auto-findings · **A1** += classifications consumed by K4's panel.


### Wave R — PR #12 review absorptions (start here)

**R0 · Findings scope and authority contract** · S · deps — · src F2 + current path probe
Description: Inventory every findings reader/writer and key. The builtin tool uses the
realpath-canonicalized workspace scope at `<workspace>/.penguin/knowledge/findings-graph.json`;
HTTP routes use `projectDir(config.root, projectId)/.findings_graph.json`, and `ProjectRow` has no
workspace-path mapping. **Decision:** keep scopes separate. The checked-in
`tasks/findings-scope-matrix.md` records owner, authority path, permission boundary, backup
limitations, and the trusted binding proof required before migration. A display name, matching
title, or guessed filesystem path is insufficient. Acceptance: the matrix and two-path fixture
prove workspace/project independence, same-name project isolation, rename behavior, symlink alias
cache convergence, and owner/member checks; no UI or docs imply shared findings. A future binding
design covers symlinks, renames, shared workspaces, inaccessible paths, and deletion. Verification:
focused core tool and server route tests. Files: the matrix, core tool/cache, server route tests.

**R1a · Eviction policy truth & reference hygiene** · M · deps R2a · src F1,N1
Description: Preserve the live cap while stating the **bounded** history guarantee honestly.
The durable store records each victim in an archive with a documented size/age retention window
and an operation id; a required archive write failure rejects the durable mutation before it is
acknowledged. In-memory graphs expose evicted records to callers but make no persistence claim.
Prune `related` and `supersededBy` references to non-live ids, retaining a resolvable archive
tombstone where needed. Rotation may discard old archived entries; never call that “nothing is
lost.” Acceptance: ① rank order is refuted → superseded → open → confirmed-last; ② a linked
eviction leaves no dangling live reference; ③ archive failure leaves the prior durable snapshot
unchanged; ④ rotation/restart/retry tests show the documented recoverability window and no
duplicate logical victim; ⑤ docs show counts and limitations. Verification: eviction + store
fault-injection tests in `test/knowledge`. Files: graph, store, tests, docs.

**R1b · Lifecycle state machine, evidence gate, actor attribution** · M · deps R1a · src N3,F4
Description: Enumerate transitions and attribute them. Table: `open → confirmed | refuted`;
`open | confirmed → superseded` (replacement must be `open|confirmed`); `confirmed → refuted`
(falsification); `refuted | superseded` are terminal except R1c's explicit reopen. `confirm`
requires ≥1 evidence with tier `runtime|`implementation`, else 409 with the missing-gate message
(human override: `override: true` records actor kind `user`). Every transition appends
`FindingEvent { actor: {kind: "user"|"agent"|"system"|"unknown", id?}, method: "tool"|"route"|"import", note? }`;
routes fill actor from the authenticated user, the tool from `ctx.attribution`; missing tool
attribution is recorded as `unknown`, never silently upgraded to a trusted system actor.
Acceptance: ① the transition table is code (`canTransition(from,to)`) and every illegal move
throws a typed `LifecycleError`; ② `confirm` on an evidence-free finding fails both paths;
③ `events` output names the actor for every new non-ingest event while legacy events remain
readable; ④ route/tool actor forgery and agent-supplied `override` are impossible; ⑤ explicit
human override requires an authenticated user and a non-empty reason. Verification: engine + tool + route tests
(all three layers assert the same table). Files: `findings-graph.ts`, `knowledge-graph.ts`,
`findings.ts`, `types.ts`, tests ×3.

**R1c · Transition guards: cycles, liveness, dead-claim re-reports** · S · deps R1b · src N2,N4
Description: `supersede` rejects a non-live replacement and any cycle in imported or live
chains; traversal beyond 64 hops fails closed. A report matching a refuted claim creates a new,
stable revision id derived from canonical claim/evidence identity, linked as a contradiction;
replaying the same report is idempotent. `reopen` is a separate authenticated user action with
an audit reason, not an agent-controlled report flag. Superseded chains stay immutable.
Acceptance: ① invalid replacement, imported cycle, and >64-hop chain have distinct typed errors;
② repeated re-report produces exactly one new claim, leaving the refuted claim intact; ③ an
agent cannot reopen a refuted claim; ④ all cross-links survive snapshot round-trip.
Verification: engine + route/tool negative tests in `test/knowledge` and `findings-routes`.
Files: `findings-graph.ts`, lifecycle request types, tests.

**R2a · Scope-aware findings store and acknowledged writes** · M · deps R0 · src F2
Description: Define `FindingsStore` around a scope id, `read()` returning a revision and recovery
state, and `update(expectedRevision?, fn)` committing under a cross-process lock. The tool and
routes use the same validator, serializer, atomic-write and error contract, with R0's scope map
choosing the authority path. Keep one in-flight update per canonical file; cache entries are
revision-validated (mtime+size alone can collide), invalidated after commit, and bounded.
The current tool's swallowed `saveGraph()` errors must become visible failures: no successful
report result without a durable write. Acceptance: ① distinct scopes are labelled and any
future mapped scope has exactly one file authority; ② 50 concurrent updates through two store
instances per authority survive restart; cross-ingress mapped-scope test is conditional on R2d;
③ same-size external replacement is observed; ④ disk/rename/permission failure cannot
return success; ⑤ cache and lock state are released after an exception. Verification: new
`test/knowledge/findings-store.test.ts`, route/tool integration and fault-injection tests.
Files: `knowledge/store.ts`, `knowledge-graph.ts`, `findings.ts`, store/route/tool tests.

**R2b · Bounds parity, store byte cap, rehydrate caching** · S · deps R2a · src N5,F7,perf
Description: Tool and route use one `validateReportInput()` and field limits. Use a 24 MiB
UTF-8 serialized high-water warning and a 32 MiB hard cap per live store, alongside the 5,000
finding cap; prove the largest permitted single report fits an otherwise empty store. At the ceiling,
attempt a tested archive/compaction path or return a typed capacity error with an actionable
export/prune path. Do not evict confirmed evidence merely to fit a new report. Cache hydrated
reads by a revision/fingerprint, with a bounded entry count. Revisit the cap only with measured
memory, startup and disk evidence on supported hosts.
Acceptance: ① oversized tool and route reports fail identically; ② at/above the high-water and
hard ceiling, existing data remains readable/exportable and an operator can recover capacity;
③ two unchanged GETs parse once, while a same-size external rewrite invalidates; ④ cache memory
is bounded across many projects. Verification: store + route
+ tool tests. Files: `knowledge/store.ts`, `knowledge/validation.ts`, `findings.ts`,
`knowledge-graph.ts`, `packages/server/src/http/routes/findings.ts`.

**R2c · Corruption policy: quarantine and fail closed** · S · deps R2a · src N10
Description: Distinguish absent store from malformed/non-readable store. On corruption, preserve
the original bytes in a uniquely named, permission-preserving quarantine copy and put that scope
into **read-only recovery**; do not decode it as an empty graph or accept mutations. Expose a
structured recovery status and explicit operator choices (restore backup, export raw, or reset
after acknowledgement). If quarantine itself fails, retain the original and still refuse writes.
Acceptance: ① garbage/partial/unsupported-version snapshots cannot be overwritten by a normal
report; ② repeated failures never overwrite an earlier quarantine; ③ explicit reset is audited
and keeps the raw file; ④ legacy valid snapshots still import. Verification: store, route, and
tool tests with disk/permission faults.
Files: `knowledge/store.ts`, `findings.ts`, tests.

**R2d · Existing-store migration and rollback** · M · deps R0,R2a,R2c · src F2
Description: **Conditional; do not execute under today's model.** Only after an explicit,
authorized project↔workspace binding exists, inventory both old paths, generate a dry-run
manifest with counts/revisions/content hashes, back up both bytes, and reconcile records/events
deterministically under the scope lock. Never silently pick the newer mtime or merge conflicting
same-id claims. Preserve old files until a read-back and restart test passes; rollback restores
the original bytes and old route behavior. Unmapped projects keep separate labelled scopes.
Acceptance: a binding record and owner exist first; both-empty, one-side, identical, divergent,
corrupt-side, interrupted, and rerun fixtures have explicit outcomes; no acknowledged finding
disappears; migration is idempotent and can be rolled back. Verification: migration fixture
matrix + tool/route end-to-end restart test.
Files: store/migration module, server composition, tool wiring, tests, operator docs.

**R3 · Report & governance reconciliation** · S · deps — · src F3
Description: Reconcile the dated audit snapshot with the current branch without erasing its
historical baseline; keep a root pointer; make the REFUSE list, source/license constraints, and
review workflow canonical in `docs/policies/porting-and-refusals.md`; link the policy from this
plan and README. Acceptance: ① no contradictory status claims in report Parts 3/5 or stale
"No commits made" header; ② audit is under `docs/audits/`; ③ policy exists and both plan/README
link it. Verification: docs suite + targeted contradiction/path grep. Files: report, pointer,
policy, plan, README.

**R4 · Route hygiene** · S · deps R1b · src F4,N12
Description: GET `kind`/`status` validated through the same `enumField` path as POST (400 on
unknown); `mutate()` maps only the engine's typed `LifecycleError`/`UnknownFindingError` to
404/409/400 and rethrows anything else (real 500s stay 500s); `decodeURIComponent` wrapped →
400 on `URIError`; the shared `TIERS`/enum lists imported from core (delete the route's copies);
drop the unused `_c` parameter. Acceptance: ① `?kind=vibes` → 400 listing the enum; ② an injected
engine `TypeError` surfaces as 500, not 400; ③ `%zz` in a finding id → 400; ④ one definition of
each enum. Verification: `vitest run test/findings-routes`. Files: `findings.ts`, tests.

**R5 · Tool output integrity: revision-aware pagination** · M · deps R2a · src N6
Description: Return a single versioned JSON envelope for `query`/`snapshot`/`events` with
`items`, `scopeRevision`, `nextCursor`, `truncated`, and `omittedCount`. Encode cursor version,
scope, revision, filter hash, and last stable sort key; reject mismatched/stale cursors with a
typed restart response. Bound serialized **UTF-8 bytes**, not characters. If one record cannot
fit, return a parseable summary with a recall id rather than slicing JSON. Event pagination
reports a gap when the bounded event log no longer covers the requested cursor. Preserve the
existing small-output shape only through a documented versioned compatibility mode for current
consumers. Acceptance: ① 500 findings page with no duplicate/missing ids on a fixed revision;
② concurrent mutation causes an explicit stale-cursor response; ③ every response parses as JSON
and stays under the byte budget; ④ oversize record and event gap are explicit. Verification:
tool contract tests, including multibyte text and consumer compatibility tests. Files:
`knowledge-graph.ts`, `types.ts`, tool/consumer tests.

**R6 · code_graph resource discipline** · S · deps — · src N8
Description: Single-flight scans per workspace (`inFlight` map; concurrent callers await the same
scan); watcher cache capped (LRU 8, close after a replacement scan succeeds and on eviction).
Keep a stale entry if refresh fails, close the failed replacement, and retry on the next request.
`index` reports cache size/evictions and accurately distinguishes a cache hit from a scan.
Documentation states the watcher boundary explicitly: `scanWorkspace()` installs no file
watchers; only `init()` does, and the tool never calls it. Acceptance: ① 20 concurrent `index`
calls → exactly one scan and no watcher initialization; ② 10 workspaces with cap 8 → size ≤ 8
and 2 closes observed; ③ a TTL refresh keeps the old graph alive until its replacement succeeds.
Verification: `test/knowledge/code-graph-cache.test.ts` and
`test/knowledge/code-graph-tool.test.ts`. Files: `code-graph.ts`, `code-graph-cache.ts`, tests,
English and Chinese tool docs.

**R7 · Memory-plane honesty (Option B now)** · S · deps — · src F5,N9
Description: Mark `retention.ts` experimental/unconsumed and correct `FindingsGraph.strength()`
to describe its creation-age calculation. Do not wire new eviction behavior in Wave R. Record
the consumer inventory: `memory/index.ts` re-exports the helpers, `retention.test.ts` exercises
them, and no in-repository production code calls them; `RecallStore` has separate active bounds.
Freeze the current recall ranking and retained-window accounting in
`test/memory/recall-baseline.fixture.json` for C2. Acceptance: docs, formula, and tests agree;
the status ledger distinguishes exported policy from active store behavior; no default eviction
changes. Verification: core memory/findings tests plus the frozen fixture. Files: retention,
findings graph, tests, fixture, plan ledger, unified report status.

**R8 · Accurate provenance on read-back** · S · deps R1b · src N7
Description: `query`/`snapshot` expose trusted actor provenance separately from a reporter's
free-form label. Derive `authoredBy` (`agent|user|system|legacy-unknown`) from R1b's attested
events rather than setting `agentAuthored: true` on every record. Mark legacy imports unknown.
Descriptions state that findings are claims requiring verification; query bodies stay out of
automatic briefings. Acceptance: agent, user, system, and legacy fixtures show distinct labels;
malicious source text cannot impersonate a user; the UI/tool renders status and evidence tier.
Verification: tool/route tests and docs. Files: `knowledge-graph.ts`, knowledge types,
`packages/docs/content/tools.en.md`, `packages/docs/content/tools.zh.md`.

**R9 · Bounded batch fan-out** · XS · deps — · src N11
Description: Run `batchArchive`/`confirmBatchDelete` through the shared ordered
`allSettledBounded` worker pool with at most 8 requests in flight. Preserve each operation's
per-id success, failure, selection-retention, and cleanup behavior. Acceptance: a 200-item batch
peaks at 8 concurrent operations; results retain input order; rejection of one item does not stop
the rest or reject the whole batch; invalid concurrency is rejected. Verification: web unit test,
web suite, typecheck, and existing e2e unchanged. Files: `sidebar.tsx`, bounded helper, unit test.

**R10 · Tool-schema token cost measurement** · S · deps — · src F7
Description: Measure the actual serialized default tool payload before/after against the same
frozen agent configuration. Record chars/4 as an estimate **and** provider-tokenizer counts when
available, including lazy catalog exposure. If the two tools add >1,500 estimated tokens, trim
or justify with a task-success measurement. Do not publish the four local `measure-q*` scripts:
they contain machine-specific paths. Acceptance: a reproducible, path-free measurement script
and a before/after table with method and fixture. Verification: run the new script in a clean
checkout and compare its output.
Status: **Complete.** `tools/measure-default-tool-schema.mts` reproduces a 9→11 direct-schema
change; the two schemas add 4,704 characters (1,176 chars/4; 1,179 production-estimated tokens),
below the 1,500-token threshold. Lazy remains two fixed schemas at 1,309 characters (328 chars/4)
before and after; search results expose each requested definition on demand. No provider-specific
tokenizer is installed, so actual provider token counts are unavailable. The method, fixture,
limitations, and full table are recorded in `docs/audits/default-tool-schema-cost-2026-09-30.md`
and summarized in both tool guides. The script verifies direct configured/exposed names and lazy
payload stability. User-local `measure-q*` scripts remain untouched.
Files: `default-config.ts` (descriptions), `docs/content/tools.*.md`, `tools/`.

**R11 · Findings-plane test battery** · M · deps R0,R1a,R1b,R1c,R2a,R2b,R2c,R5 · src review §5
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
Status: **Complete.** `docs/audits/web-accessibility-2026-09-30.md` records the exact surfaces,
results, and remaining Axe manual-review cases. `@axe-core/playwright` 4.13.0 reports zero
violations across chat/sidebar, system settings, and Agent settings in the tested themes; all
desktop and mobile Tab stops are reached with visible focus, and the mobile chat/sidebar scan
passes target-size and overflow checks. The remaining `color-contrast` incomplete cases are a short decorative
SVG initial and the session timestamp overlapped by the hover-action layer; both are documented,
and the affected text tokens were manually checked against their rendered theme backgrounds.
Fixes include missing switch names, low-contrast text, segmented target size, the composer focus
ring, and fail-fast handling for an unavailable isolated E2E data directory.
Files: `packages/web/e2e/a11y.spec.mjs`, `packages/web/src/`, `packages/web/e2e/run.sh`,
`docs/audits/web-accessibility-2026-09-30.md`.

**R13 · PR #12 CI repair and evidence ledger (Node 24)** · S · deps — · src review §8 + live run
Description: Repair the observed browser failure at `skills.spec.mjs:246` by scoping the
assertion to the intended chat message or state; check the same flow for a real product race
before calling it locator-only. The failed run had 155 passed/2 skipped/1 failed browser tests;
the aggregate `ci` job failed. Rerun the named test locally, then the complete PR matrix.
Acceptance: the named test proves the skill-invocation flow, full browser E2E and aggregate `ci`
are green on the PR head, and a per-job table with run links/commit SHA is recorded. Never
waive an unexplained red because other platforms passed. Verification: targeted Playwright run,
`gh pr checks 12`, and failed-job logs when needed.

**R14a · Electron high-severity advisory repair** · S · deps — · src 2026-09-29 audit
Description: Locked desktop `electron@43.2.0` is affected by four high-severity advisories
([sandbox inheritance](https://github.com/advisories/GHSA-gr2m-v5gq-v685),
[protocol CORS](https://github.com/advisories/GHSA-j84w-jfhq-vhvj),
[webview worker integration](https://github.com/advisories/GHSA-9qh4-3jw8-366w), and
[sandboxed preload cache](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq)). Upgrade within
the supported 43.x line to at least 43.5.0, update lockfile and verify the actual packaged
binary. Acceptance: `pnpm audit --audit-level high` reports no Electron high advisory;
desktop launch, utility process, same-origin window, installer and Windows/macOS/Linux runtime
smokes pass on the exact candidate. Do not waive a high advisory solely because Electron is a
devDependency in the package manifest: it becomes the shipped runtime. Rollback is the prior
release artifact, not a vulnerable new build.

**R14b · Undici moderate advisory repair** · S · deps — · src 2026-09-29 audit
Description: Runtime server resolves `undici@7.29.0`, and the desktop build chain resolves
`undici@6.28.0`; both are affected by
[the WebSocket decompression advisory](https://github.com/advisories/GHSA-3wwx-pv8p-q78v).
Move runtime to ≥7.29.1 and the build-chain path to ≥6.28.1 through compatible dependency
updates or the narrowest documented resolution. Acceptance: audit JSON no longer reports
either path; server WebSocket/HTTP and desktop packaging smokes pass, with a lockfile diff
review. Do not apply a blanket major-version override across both dependency branches.

### Checkpoint: Wave R
- [ ] R0 and R1–R14 acceptance criteria green; R2d remains deferred until a trusted binding exists; `test/knowledge` + `findings-routes` + web suite pass
- [ ] Audit has zero high findings and neither named `undici` path remains; otherwise Wave R and release remain blocked with a dated owner
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
Description: `router.tsx:427-428` /usage claim → correct the comment to current access behavior;
`nav-group-collapse.ts:50-53` machines claim → delete the phantom-route claim; `features/canvas/` (1,308 lines, 0
importers) removed; `features/cockpit/` directory renamed (name collision with the cockpit page).
Acceptance: zero behavior-contradicting comments in the touched files; the rename compiles; human
review before push. Verification: web suite + grep. Files: 4 sites.

**F6 · STREAM_BANNER_FRAME dedup** · S · deps — · src III.5
Acceptance: one definition beside `disclosure-row.tsx`'s constants; all nine listed banner
call sites adopt it; rendered class bytes identical in a unit assertion. Files: constant owner
plus nine banner modules.

**G5 · TLS verification fix** · XS · deps — · src SEC-EXEC-04
Acceptance: no `rejectUnauthorized:false` under `.agents/`; the downloader still works against a
normal TLS endpoint. Files: `.agents/skills/bgm-library/scripts/downloader.js` + sweep.

**G7 · Anti-slop installer path fix** · XS · deps — · src IV.6.7 #2
Acceptance: `node install.mjs` dry-run resolves the existing `rules-src` asset layout and
preserves the destination manifest; do not create a duplicate source tree.

**J1 · `clean` script wiring** · XS · deps — · src IV.5.6
Acceptance: `pnpm clean` matches `scripts/clean-workspace.mjs` report mode. Files: `package.json`.

**J6 · CI/docs drift sweep** · XS · deps — · src infra F5
Acceptance: `ci.yml:150` drops the brittle numeric spec count or derives it at runtime; all Status-Ledger
"done" claims name their file (pairs with J11). Files: `.github/workflows/ci.yml`, docs.

**T0.3 · Workspace dependency freshness guard** · S · deps — · src memory note
Description: Detect when a `file:` dependency snapshot resolves stale core output in local
server/web/CLI runs. Print the source/build/resolved package paths and hashes, then give a
package-manager-supported reinstall/build command; never copy into `.pnpm` internals or commit
machine-specific `AGENTS.md` (the checkout's root file is git-ignored). Acceptance: a planted
stale export fails the guard, a fresh supported install passes, and the command works in a clean
checkout. Verification: `node scripts/check-workspace-deps.mjs` + fixture test. Files:
`scripts/check-workspace-deps.mjs`, tracked contributor documentation, test.

**J11 · Docs-claims consistency gate** · S · deps J6 · src review §8
Description: A script checks ledger syntax, paths and evidence anchors. A `Shipped` claim must
name a runtime entrypoint chain, dynamic-registry fixture or integration test; external-import
counts alone are not proof because same-package consumers are valid. Experimental/unconsumed is
a distinct honest status. Acceptance: the check passes after R7; a planted stale `Shipped`
claim fails while a valid same-package consumer passes. Verification:
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

**D1 · Optional TS/JS grammar pack and manifest** · M · deps — · src cluster-D §7
Acceptance: pin a compatible `web-tree-sitter` and TS/JS grammar versions from tested upstream
releases; reproducible build of only the TS/JS wasm assets, lockfile and license/provenance
manifest, verified hashes and lazy load behind an opt-in tier. Missing/invalid assets fall back
to regex for that language with a visible reason. No mandatory twelve-grammar payload; package
delta, cold start, parse latency and peak memory are recorded before expanding the pack.
**D2 · .scm packs (TS/JS) + extractor→IR** · M · deps D1 · src cluster-D §13
Acceptance: golden extraction passes calldiff CONTRACT's 6 behaviors (methods, receiver calls,
ctors, branches, nested-lambda non-attribution, computed callees ignored).
**D3 · Optional language packs python/go/rust/java** · M · deps D10
Acceptance: each language is a separate, lazy, license-checked asset with extraction and
resolution goldens; promote individually only after the D10 quality/resource gate is rerun
for that language. Unsupported or missing assets keep the regex tier and honest status.
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
**D10 · Benchmark harness (AST vs regex)** · M · deps D9 · src cluster-D #12 + review
Acceptance: same five frozen scenarios and goldens run both tiers with precision/recall,
false-edge count, p50/p95 latency, peak memory, package bytes, LLM calls/tokens/cost. Run
repeated samples and keep raw artifacts. Default promotion gate on the frozen corpus: precision
no worse than regex; recall loss ≤2 percentage points; false edges ≥10% lower when regex has
false edges, otherwise recall ≥5 points higher with zero new false edges. On the fixed 200-file
fixture, compressed install delta ≤5 MiB, p95 indexing ≤2× regex and ≤2 s, incremental peak
RSS ≤256 MiB. These are proposed release limits, not claims about current performance. If any
gate fails, retain regex as default and document the tradeoff. Run TS/JS first, then repeat
per D3 language. Declare environment, corpus and budgets before the first candidate run; any
raised budget needs a signed-off decision record and a rerun of both tiers. Feeds K17.
**C1 · Findings cockpit UI** · M · deps R2b · src mission 1
Acceptance: all 8 routes exercised; evidence + provenance + actor visible; a11y per R12; Operate-mode design.
**C2 · Memory recall baseline and opt-in policy boundary** · S · deps R7 · src R7 decision
Acceptance: frozen recall fixture, latency/write-volume baseline, explicit owner and flag for
any future retention experiment; no automatic destructive policy while the module has no
production consumer. A candidate policy must improve recall or bounded storage on the fixture
without losing pinned items before C3 may consume it.
**C3 · Consolidation runner** · M · deps C2 · src agentmemory schedules
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
**H4 · Redacted configuration preview and reversible apply** · M · deps H1,H2,H3 · src §I.1.4.3
Description: Present an ownership check, redacted before/after diff, target path, permissions,
and backup path before applying a foreign-config change. Confirmed apply uses the H1/H3 atomic
write path; failure restores the original bytes and leaves a readable diagnostic.
Acceptance: dry-run changes no bytes; secret values never appear in logs/preview; a forced
mid-write failure restores comments, style, permissions, and ownership. Verification: CLI
preview/apply/rollback fixture suite on Windows and POSIX.
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
**K3 · Trustworthy CLI configurator** · M · deps H1,H2,H3,H4 · §I.1.4.3 — with the review screen.
**K1a · Turn ledger core** · M · deps A5,A9 — `session/turn-ledger.ts` + `resumeFrom(ledger)`.
**K1b · Cross-protocol resume demo** · M · deps K1a — one session survives a provider/protocol switch.
**K5 · Tool-schema normalisation surface** · M · deps — · cluster-A #5/#6 + §I.1.4.5 —
`llm/tool-schema.ts` ($ref flattening, scored `anyOf`, strict-mode with `unsupported` reporting,
key sanitize/restore round trip).
**K14a · Permission-plane adapter design note** · S · deps K5 · cluster-A higher-order —
define vocabulary above the existing approvals enforcement point. Trace direct, aliased,
retried, resumed and delegated calls through one authoritative decision; missing context denies.
Acceptance: reviewable trace and deny/allow matrix, with no duplicate policy authority.
**K14b · ToolRouter implementation** · M · deps K14a — implement the reviewed adapter;
acceptance: every routed path observes the same decision and denial cannot be bypassed.
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
**K13 · PiX graph-of-turns + patch codec** · M · deps K1b · MPL-2.0: modified files stay openly licensed.
**K16a · Audit-protocol model mapping** · S · deps R1b · src review strategic
Description: map the audit protocol onto the existing model. Keep candidate investigations as
`kind=hypothesis` with evidence and actor; do not add a parallel status without a demonstrated
workflow that cannot be represented by current state. Derive a display-only `confidenceLabel`
from evidence tiers + status; a `checklist` action runs the §19 quality gate as data (10 questions
per finding). Acceptance: mapping and legacy snapshot fixtures pass without status migration.
**K16b · Audit-protocol enforcement** · M · deps K16a — report tooling consumes the checklist;
the new `verify` action requires attested actor, evidence and completed checklist data. Existing
`confirm` ingress keeps R1b's evidence gate during a versioned client migration; its output
must explicitly say `checklistVerified: false`. Only after tool, route and UI clients support
the new contract may a separate release gate retire legacy confirmation. Acceptance: no new
verified label is possible without the checklist or audited human override; old snapshots and
clients remain readable and their confirmation behavior does not silently change.
**K17 · Benchmark ledger** · M · deps D10,C4 · src review strategic
Description: the README's reproducible-benchmark promise — benchmark/task outcomes stored as
findings (evidence = run artifacts), queryable per scenario, feeding a README "Benchmark" section
that always links to the latest ledger entries. Acceptance: D10's table lands as findings and the
README section renders from the ledger.
**F10a · Semantic-token measurement** · S · deps F8 — count current `text-gray-*` sites, measure
contrast and migration cost for full overlay vs incremental (resolves Q6 with numbers).
**F10b.1 · Conditional semantic token map** · S · deps F10a — define aliases, states and
contrast receipts only if Q6's measured gate passes.
**F10b.2 · Component-family migration** · M · deps F10b.1 — migrate one family per reviewable PR,
with screenshots and keyboard checks; no global class replacement.
**F10b.3 · Obsolete-token cleanup** · S · deps F10b.2 — remove aliases after live/dynamic usage
search and visual pass. Decline all three if F10a shows no net benefit; F8 ships regardless.
**F11a · Topology signals and store** · M · deps — · stable node/edge/selection identity;
use licensed state primitives only after package and notice review.
**F11b · Topology culling and camera** · M · deps F11a · viewport, reduced-motion and large-graph
performance receipts; clean-room implementation.
**F11c · Topology elbow routing** · M · deps F11b · deterministic geometry and safe fallback.
**F12a · Workflow graph model** · M · deps K11b · typed state/event mapping, with text timeline
remaining authoritative.
**F12b · Workflow renderer** · M · deps F12a · bounded layout, keyboard and small-screen access.
**F13a · Authorized export DTO** · M · deps — · versioned, scoped snapshot and redaction contract.
**F13b · PPTX/PDF/print renderers** · M · deps F13a · same DTO, artifact goldens and pagination.
**F13c · Export queue** · M · deps F13b · bounded retention, cancellation, restart and download auth.
**F14 · Cowork UX (AionUI set)** · M · deps K9 — status badge, run-view reconciliation, warmup overlay, command queue.
**F15 · Chart architecture + palettes** · M · deps F8 — shared-scale charts + data-viz palettes for cockpit.

### Checkpoint: Wave 4
- [ ] K4/K2/K3 demonstrated end-to-end; K16 checklist enforced on real findings
- [ ] Every §11 decision applied or declined under its stated reopen rule, with evidence

## 7. Verification, rollout, and evidence contract

| Layer | Required proof | Artifact and owner |
|---|---|---|
| Findings engine | Seeded merge/idempotency, full lifecycle matrix, dangling-reference scan, import/export across old and new schema, archive-failure rollback | R11 fixture and assertion table; knowledge owner |
| Findings persistence | Separate-scope matrix, 50 overlapping writes per mapped scope, restart, stale cache, same-size replacement, permission/disk failure, corrupt file; binding/migration fixtures only if R2d activates | R0/R2a evidence and conditional R2d dry-run manifest with before/after hashes; persistence owner |
| Tool and HTTP contracts | Same validator and errors, attested actor, bounded parseable output, cursor invalidation and event gap, legacy consumer compatibility | R4/R5 contract tests; API owner |
| LLM and context | A3 precedence rows, A4 branch table, A5 500 seeded sequences, A1 disagreement corpus, B3 evidence-preservation tests | Raw fixture corpus and before/after table; LLM owner |
| Codegraph | Per-language goldens, resolver-step fixtures, false-edge audit, two-tier D10 repeated benchmark, wasm/license inventory | Raw benchmark artifacts and decision record; codegraph owner |
| User flows | Named Playwright cases for skill invocation, findings query/verification/briefing, offline recovery, keyboard/focus/dark modes | CI run links and accessibility report; web owner |
| Release | Required checks on exact head SHA, compatibility/migration rehearsal, changelog and docs, versioned release artifact smoke test where relevant | One release gate table; release owner |

Use the repository's existing package scripts as the command authority; each card must name its
actual command before implementation. Do not invent a command by copying a test path from a
different package. A claimed defect gets a reproducer that fails on the pre-fix revision when
the failure can be isolated. A migration or concurrency claim additionally gets a restart or
fault-injection test. CI failures are investigated at their failing test and commit, then the
**whole required matrix** is rerun; rerunning only the targeted case is insufficient to merge.

**Rollout order for stateful changes:** (1) ship schema reader compatible with old snapshots;
(2) observe and back up both authorities; (3) dry-run migration with conflict report; (4)
enable one mapped scope behind a reversible flag; (5) compare counts/hashes and watch error
rates; (6) widen only after restart/rollback rehearsal. A bad migration disables writes for the
affected scope and preserves both old files for recovery. Feature flags must have an owner and
a removal date once the rollout proves stable.

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Registry `file:` snapshots hide stale core (bit us 3×; also masked the alias failure locally) | Med | T0.3 helper; CI is arbiter; never merge on local green alone |
| A workspace is mistaken for a server project and findings leak or diverge | Critical | R0 identity matrix; authorize before mapping; never silently merge unrelated scopes; R2d dry-run and rollback |
| Acknowledged write is lost or corruption is overwritten | Critical | R2a durable acknowledgement; R2c read-only recovery; archive/write fault injection and restart tests |
| Archive rotation invalidates a perpetual-retention promise | High | State finite window and limits; expose counts and export; reject durable mutation when required archive append fails |
| Cursor reuse across a mutation skips or duplicates findings | High | R5 revision/filter-bound cursors and explicit stale/gap response |
| Memory poisoning of the findings plane (N7) | Med | R8 trust marking + bodies out of `query`; provenance/actor visible; K16 checklist |
| Compression/pruning destroys signal | High | B3's three non-negotiables as tests; recall path mandatory |
| Resolver emits wrong edges | High | D4b fixtures per step; drop-the-edge doctrine |
| Clean-room contamination | High | task Source cites report §, never encumbered source files |
| Sibling sessions editing this tree | High | named file ownership, `git status`/commit SHA before edits, separate worktrees when isolation is needed |
| L-scope creep | Med | break at 5 files / 3 acceptance bullets; K14/K11 get design notes first |
| Release size from wasm grammars | Med | TS/JS lazy pack first; D10 per-language resource gate before D3 expansion |
| Full server suite local stall (`isolate:false` quirk) | Low | named-file runs; CI split jobs authoritative |

## 9. Constraints — permanent REFUSE list and source-transfer policy

The canonical hard refusals, license-scope findings, required evidence, and clean-room workflow
live in [`docs/policies/porting-and-refusals.md`](../docs/policies/porting-and-refusals.md).
Retention constants come from agentmemory report descriptions (clean-room numbers; no upstream
source code copied). The upstream [LICENSE](https://github.com/rohitg00/agentmemory/blob/main/LICENSE)
was verified as Apache-2.0 on 2026-09-30; the implementation records that source link.

## 10. Ownership and change packaging

Assign an owner **per task and file set** before work starts; use parallel workers only when
their paths and stateful fixtures are disjoint. Streams: {R storage/lifecycle} | {A,B} | {C} |
{D} | {E} | {F} | {G,H,I} | {J,K}. Respect §5's dependency chains. Single-owner files:
`core/src/index.ts`, `state/default-config.ts`, `state/kernel-history.ts`,
`knowledge/findings-graph.ts`, `knowledge/store.ts`, and server route composition. A worker who
finds a defect in another owner's path records the reproducer and hands it to that owner.

Each PR should contain one reversible vertical slice: implementation, migration/compatibility
code where needed, focused tests, product surface, docs, and rollback note. Avoid a Wave-sized PR.
Before moving a task to done, inspect the actual diff, document the exact head SHA and CI run,
and remove temporary probes. Preserve deliberate local/untracked files; never use cleanup as a
substitute for classifying them.

## 11. Resolved decisions and reopen criteria

These are implementation decisions, not unanswered design questions. A gate may reject a
specific implementation; it does not silently replace the selected default. Record any
exception with measured evidence, owner, affected version, and rollback in the PR.

| ID | Decision now | Reopen only if | Proof before rollout |
|---|---|---|---|
| Q1 · PR #12 | Keep the coherent current PR intact. Repair R13's browser locator, rerun the full required matrix on its exact head, and merge only after normal review gates. Ship later Wave-R slices as narrow, reversible PRs. | A reviewer identifies an independently revertible portion that blocks review, or the PR cannot pass a bounded gate without unrelated changes. | Changed-file ownership and exact-head CI evidence in the PR; no split hides a failure. |
| Q2 · permission plane | K14's vocabulary is an adapter above the current approvals enforcement point. A single authoritative decision applies to direct, aliased, retried, resumed, and delegated tool calls. | A concrete action path cannot be represented by the existing approval decision without reducing safety or correctness. | Deny/allow matrix and one-enforcement trace for every action class; fail closed on missing context. |
| Q3 · compression | B3 is off by default. Freeze the eligible output corpus; ship only deterministic, lossless-to-recall strategies that save at least 10% bytes on that corpus while preserving complete failures and original artifact access. Drop losing strategies. | A representative production corpus or output contract changes materially. | Raw input/output hashes, savings distribution, failure fixture, privacy and latency results; opt-in flag and immediate rollback. |
| Q4 · grammar assets | D1 packages TS/JS only as a lazy opt-in tier. D10 requires the stated quality gate plus ≤5 MiB compressed delta, ≤2× regex and ≤2 s p95 indexing on the fixed 200-file fixture, and ≤256 MiB incremental peak RSS. D3 adds languages individually. | A measured language shows enough value to justify a reviewed budget change; no global 12-grammar payload is assumed. | Reproducible manifest and hashes, repeated two-tier table and missing-asset fallback. |
| Q5 · retention | R7 uses Option B now: label `retention.ts` unconsumed/experimental and correct `strength()` semantics. C2 owns baseline recall evidence; C3 cannot silently enable destructive retention. | An opt-in policy improves the frozen recall/storage fixture without loss of pinned data and survives restart/rollback tests. | Consumer inventory, fixture diff, write/latency table and flag owner. |
| Q6 · visual tokens | Fix measured contrast and component defects incrementally in F8. F10a measures live token drift; F10b is conditional: its first component family must cut hard-coded color sites by ≥50%, introduce no contrast failure, and have zero unreviewed screenshot differences in normal/dark/mobile states. | Representative migration cannot meet those limits or later components have different needs. | Site count, contrast receipts, screenshot review and rollback per component. |
| Q7 · findings identity | Workspace findings and server-project findings stay separate authorities by default. R0/R2a share a validated durable store contract, not a file path. R2d migration is conditional on an authenticated workspace↔project binding. | Product identity gains a trusted persistent binding and migration benefits exceed conflict/leak risk. | Dry-run identity map, ownership checks, conflict list, restart and byte-exact rollback. |
| Q8 · retention and corruption | Acknowledged writes are durable; corrupt or unsupported stores enter read-only recovery. Eviction is an explicit bounded archive policy, not a promise of infinite retention. | Storage budgets or legal retention requirements change. | Fault-injection matrix, raw export, archive/recovery documentation and no-success-on-write-failure tests. |
