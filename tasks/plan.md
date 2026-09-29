# Implementation Plan: Absorption & Hardening Master Plan

**Target:** `D:/GitHub/penguin-harness-fork` · **Base:** PR #12 (`feat/knowledge-plane-native-tools`) ·
**Sources:** `Unified Report Multi-Agent Collage.txt` (Parts I–V), `absorb/reports/cluster-{A–F}.md`
(+ per-repo sections), `UNIFIED-AUDIT-AND-IMPLEMENTATION.md`, the four prior audit reports (adjudicated).

## Overview

Everything the OG investigations put on the table — the 25-item port ledger (collage §V.6), the six
cluster reports' port candidates and higher-order flags, the audit findings and residuals, the
named-but-unfixed leaks and defects (§IV.5.5, §IV.8.2), and the remaining queue (§V.3) — broken
into ~75 sized, verifiable tasks in four dependency-ordered waves. Tasks are vertical slices:
each lands working, tested, and independently revertable. Sources are cited per task so a future
reader can re-derive the design instead of trusting this document.

## Status Ledger — already DONE (do not rebuild)

| Item (OG naming) | State | Where |
|---|---|---|
| Findings knowledge graph + agent reporting (mission 1; cluster-C schema) | **Shipped** | `packages/core/src/knowledge/`, `knowledge_graph` tool, `/api/projects/:id/findings/*` |
| Memory retention/decay/consolidation **policy** (agentmemory constants) | **Shipped** | `packages/core/src/memory/retention.ts` |
| AST substrate: IR + FQN + single `entityIdOf` + parser pool w/ incremental reparse (cluster-D §7 core) | **Shipped** | `packages/core/src/codegraph/ast/` |
| Native code intelligence tool (pi-codegraph "tool-surface donor" core) | **Shipped** | `code_graph` tool (index/search/callers/callees/impact/explore/files/hubs) |
| Cockpit runtime key coherence (backend F1 core) | **Shipped** | `packages/server/src/cockpit/ws.ts` + regression tests |
| Incremental-cache invalidation ordering | **Shipped** | `packages/core/src/codegraph/incremental-graph-cache.ts` |
| Multi-select batch delete (user-reported bug) + e2e | **Shipped** | `packages/web/src/components/layout/{sidebar,selection-bar}.tsx`, `e2e/session-select.spec.mjs` |
| Secondary-ink contrast sweep (web F1) | **Shipped** | 29 files, per `session-row-menu.tsx` convention |
| Kernel advance + tool-alias sync for the new tools (two guards caught both halves) | **Shipped** | `kernel-history.ts` 2026-09-29, `strings-*.ts` |
| Snapshot→findings dedupe/supersession/provenance (agentmemory remember/cascade core semantics) | **Shipped** | `findings-graph.ts` |
| Audit adjudication of all 4 prior reports (incl. JEV existence proof) | **Shipped** | `UNIFIED-AUDIT-AND-IMPLEMENTATION.md` |

## Architecture Decisions

1. **Clean-room, spec-first ports.** The Antigravity twins are CC BY-NC-SA: their behavior is
   re-implemented from the reports' descriptions, never translated from their source (collage §I.1.6).
2. **One graph for agent and UI.** `code_graph` reads the same engines as the cockpit topology;
   the AST tier slots in *behind* that seam (extractor → IR → resolver), so nothing re-plumbs.
3. **Findings are append-only facts.** Merge/supersede/refute, never delete; decay at read time.
   New evidence planes (influence receipts, eval results) attach as evidence, not new stores.
4. **Failure classification is typed, never prose-matched.** The qwen/gemini `strings.Contains`
   lesson (collage §I.4.3.3): errors carry status/kind; prose is display only.
5. **Compression and pruning never destroy signal.** The RTK rule: failures survive in full,
   pass-through by default, and compressed output is labeled with a recall path.
6. **Every default change is a migration.** The kernel-hash and tool-alias guards are the model:
   change the default, advance the kernel, record the superseded hash, update every mirror.

## Dependency Graph

```
A3/A4 retry policy ──► A1 classifier flip ──► K4 self-diagnosing failures
A8 estimator ──► A7 CanonicalUsage ──► K2 cost ledger
D1 grammars ──► D2 queries ──► D3 languages ──► D4a symbol table ──► D4b call ladder ──► D5 diff tool
C2 retention wiring ──► C3 consolidation runner ──► C4 RRF retrieval
B1 spill ──► B3 compression (recall path reuses spill archive)
E2 acp sweep ──► E3 resume ──► E4 durable tail
H1 foreign-config ──► H2 YAML round-trip ──► H3 atomic audit ──► K3 configure command
G1 skill validator ──► G2 routing probes ──► G6 capability manifests
```

---

## Task List

Sizing: XS 1 file · S 1–2 · M 3–5 · L 5–8 (split further if it grows). Every task: `Accept` =
acceptance criteria, `Verify` = the repo's own gates (run the focused suite named, plus
`prettier --check`, `oxlint --deny-warnings`, `tsc --noEmit` for touched packages).

### Wave 1 — Foundations & quick wins (start here; most parallelizable)

**A3 Retry-delay provenance + `Retry-After` honoring — M — deps: none**
Does: `ParsedDelay { rawMs, source: header|structured|text }` per collage §I.1.3.2 (confidence-weighted
buffer: +200ms structured, +1000ms text; separator-insensitive key match; grace ≤5000ms), wired into
`context-engine.ts` `reconnectDelayMs` and `key-rotator.ts` cooldowns (which is flat today).
Accept: delays parsed from header > JSON body > NL text; `Retry-After` honored and bounded; unit
tests pin both buffers. Verify: `vitest run test/llm*` core. Files: `packages/core/src/llm/{retry-delay,context-engine,key-rotator}.ts` + tests.
**A2 FailureStatusTracker + error taxonomy triple — S — deps: none**
Does: track the *interesting* status (last non-429; else 429 if any failure; else 502 — collage
§I.1.3.4) in the failover path; server errors gain `(kind, english, i18n_key)` (§I.1.3.15).
Accept: exhausted rotation reports the real cause (403/400), not "rate limited"; every HttpError
code maps to an i18n key. Verify: `vitest run test/errors.test.ts test/gateway*` server. Files:
`packages/core/src/llm/failure-status.ts`, `packages/server/src/http/errors.ts`, `strings-*.ts`.
**B2 `BoundedStreamCapture` head+tail — S — deps: none**
Does: keep 256KB head **and** 256KB tail, never the middle (§I.1.3.15) in `packages/core/src/trace/`.
Accept: a 1MB stream retains both ends; byte-exact round trip. Verify: new `test/trace/bounded-capture.test.ts`.
**F1 Input focus rings — S — deps: none**
Does: web audit F2–F4 — menu search box, `rule-policy-editor.tsx:125` `focus:ring-0`, and
`field.tsx`/`panelSearchClass` faint gray rings → solid `var(--accent-bg)` focus-visible rings.
Accept: every interactive control has a ≥3:1 focus indicator. Verify: `vitest run` web; axe spot-check.
Files: `packages/web/src/components/ui/{input,field}.tsx`, `features/guardian/rule-policy-editor.tsx`.
**F3 Comment-lies + dead code — S — deps: none**
Does: III.4.3 — `router.tsx:427-428` /usage claim vs reality; `nav-group-collapse.ts:50-53` phantom
machines route (ship the route or delete the claim); `features/canvas/` (1,308 lines, zero importers)
removed; `features/cockpit/` dir renamed to end the name collision (III.2 #5).
Accept: zero comments contradicting behavior; `features/canvas` gone; rename compiles. Verify: web tests + `grep` re-check.
**F6 `STREAM_BANNER_FRAME` dedup — XS — deps: none**
Does: III.5 top action — one constant beside the ones in `disclosure-row.tsx`, five files adopt it.
Accept: single definition, identical rendered bytes. Verify: web tests. Files: 6 banner files.
**G5 TLS-verification fix — XS — deps: none**
Does: `.agents/skills/bgm-library/scripts/downloader.js` `rejectUnauthorized: false` removed (audit
SEC-EXEC-04 survivor); sweep sibling skill scripts for the same pattern.
Accept: no `rejectUnauthorized:false` under `.agents/`. Verify: `grep -r rejectUnauthorized .agents`.
**G7 Anti-slop installer path fix — XS — deps: none**
Does: IV.6.7 #2 — the vendored skill's `install.mjs` expects `assets/anti-slop`; only `rules-src/`
exists. Fix the installer or the manifest. Accept: `node install.mjs` dry-run resolves. Verify: run it.
**J1 `clean` script wiring — XS — deps: none**
Does: IV.5.6 — `scripts/clean-workspace.mjs` exists; add the `clean` npm script (package.json owner
has since changed). Accept: `pnpm clean` report-mode matches the documented output. Verify: run it.
**J6 CI/docs drift sweep — XS — deps: none**
Does: infra F5 (`ci.yml:150` "75 specs" comment) + docs count drift beyond tools docs.
Accept: counts match reality or say "N spec files". Verify: docs tests. Files: `.github/workflows/ci.yml`.
**T0.3 Snapshot-refresh helper — S — deps: none**
Does: the `file:` snapshot trap cost three debugging rounds (memory: `penguin-core-file-snapshot-trap`);
a `scripts/refresh-core-snapshot.mjs` (build core → copy dist into every `.pnpm/@prismshadow+penguin-core@*`)
plus an AGENTS.md line. Accept: one command makes server/web/cli see fresh core. Verify: run + `grep -c` probe.

### Checkpoint: Wave 1
- [ ] Focused suites named above all green; `pnpm lint`, `prettier --check`, `tsc` clean
- [ ] PR #12 merged or rebased onto; branch discipline per workstream kept
- [ ] Human review of the dead-code deletion (F3) before push

### Wave 2 — Core hardening (sequential within a stream; streams parallel)

**A1 Classifier flip: shadow → active — M — deps: A2, A3**
Does: `fleet/provider-gateway.ts` vocabulary already runs in shadow (sibling session); promote it to
the decision path per its flip rule ("zero un-enumerated `agrees=false` over a full release" — check
the log evidence first), retire the duplicated precedence (`generative-model.ts` rate-limit-first vs
`credential-rotation.ts` auth-first), keeping `KNOWN_DIVERGENCES` documented.
Accept: one classifier decides lock/cooldown; prose never decides; shadow log retired. Verify: core llm + fleet tests.
**A4 Pool-shape-aware retry budget — M — deps: A3**
Does: `retry-policy.ts` with §I.1.3.3 semantics: attempts `pool≤1?3:(pool*2).clamp(4,12)`; round-1
50ms fast-rotate; delay ≤5s grace-in-place; >5s && pool>2 keep rotating; linear 2s fallback capped 5s;
single-account 429 capped 10s; **once-per-account grace** set. Port the branch table from the
`retry_strategy_tests.rs` spec in prose (collage §I.1.3.3) — clean-room.
Accept: the full branch table passes; no 50ms exhaustion loop. Verify: new `test/llm/retry-policy.test.ts`.
**A5 Snapshot→delta stream reassembler — M — deps: none**
Does: §I.3.2.1 semantics — track delivered view; extend → emit suffix; prefix-truncate → emit nothing;
rewrite → emit after longest common prefix **and re-sync the view**; rune-boundary LCP; UTF-16→byte
offset with surrogate clamp; 24-rune hold-back; `<details`/quote-marker partial holds; release
reasoning before content overtakes. Clean-room from the description (glm sources are REFUSE-to-copy).
Accept: a property test (random edit sequences) never emits invalid UTF-8 and view==target at flush.
Verify: new `test/llm/stream-reassembler.test.ts`.
**A6 Length-prefixed frame parser — S — deps: none**
Does: §I.4.3.1 — structural boundary scan (first `\n` + 1–12 digits + `\n`), marker as minimum-length
hint only, cross-chunk state, one-byte resync, EOF flush. Accept: the reference's 5 test shapes pass.
Verify: new `test/llm/frame-parser.test.ts`.
**B1 Large-output spill + recall id — M — deps: B2**
Does: Composio spill policy (§I.2.3 / cluster-A #1): 40KB inline threshold, `bytes/4` token estimate,
spill to the truncated-output archive and return `{path,sizeBytes,tokenCount}`; "run" origin stays
inline; recall id reuses `truncated-tool-output-archive.ts`. Accept: spill never loses failures
(non-zero exits always inline); recall round-trips full output. Verify: core environment tests.
**B3 In-process tool-output compression — M — deps: B1**
Does: RTK §IV.9 — four strategies (filter/group/truncate/dedup-with-counts), test-runner
failures-only collapse, and the three non-negotiables as tests (failures survive; pass-through
default; labeled output with recall path). Ship the disappointing numbers in the PR if a strategy
saves <10% — and drop it if so. Accept: those 3 tests + measured savings table. Verify: new tests + `tools/measure-*` script.
**B4 Transactional compaction + prune frontier — M — deps: none**
Does: dirac + pi-context-prune (cluster-C #4): keep-the-IDs pruning, oversized-skip frontier cursor,
cache-safe reminders, all-or-nothing compaction steps. Accept: a failed compaction leaves context
byte-identical; frontier never re-reads a skipped block. Verify: core compaction tests.
**C2 Retention wiring — S — deps: none**
Does: `retention.ts` policies drive `HierarchicalMemoryStore` eviction (`evictToTokenBudget` becomes
tier-aware: 0.7/0.4/0.15). Accept: eviction prefers expired/cold; write-only-what-changed holds.
Verify: core memory tests.
**E1 Cockpit sync-seam residuals — S — deps: none**
Does: backend F1 residual — sync seams default `process.cwd()` and build `SwarmCoordinator` without
the project `ShellGuardian`. Route them through `resolveProjectWorkspaceDir` + guardian, or delete
the seams and force the async factory (prefer deletion if `buildCockpitSnapshot` defaults are the
only consumer). Accept: no path creates a guardian-less coordinator. Verify: `vitest run test/cockpit*` server.
**E5 `trigger_swarm` non-simulate — S — deps: none**
Does: backend F4 — `runTask` without `handlers.onExecute` can never execute; either wire an
execution handler or reject non-simulate at the WS boundary with 400. Accept: no silent dead path.
Verify: cockpit ws tests. Files: `packages/server/src/cockpit/ws.ts`, `packages/core/src/agent/swarm-coordinator.ts`.
**E6 Cockpit error-shape unification + E7 gateway validation — XS ×2 — deps: none**
Does: backend F5 `{success:false,error}` → global `{error:{code,message}}` (keep `success` additive);
F6 `gateway.ts:126-139` ids through `requireValidId`/bounded strings. Accept: one error shape in
OpenAPI-ish docs; oversized ids 400. Verify: server route tests.
**E8 `/health` + readiness — S — deps: none**
Does: infra gap — mount beside `versionRoutes` (app.ts ~1412): liveness + DB/instance-lock readiness.
Accept: 200 when serving, 503 when DB closed. Verify: new route test.
**E9 Structured logger + rejection counter — M — deps: none**
Does: II.4 gap — `packages/server/src/internal/logger.ts` (levels, redaction via `credential-redactor`),
replacing `console.*`; `unhandledRejection` path (F7) gains a rate counter. Accept: no console.* in
server src; counter visible in `/health` or telemetry. Verify: server tests.
**E10 Leak fixes (§IV.5.5) — M — deps: none**
Does: (a) orphan reaping beyond `process.on("exit")` (SIGKILL/crash: parent-pid watchdog or Job Object),
(b) `disposeRemoved` timeout on `entry.running` never settling, (c) wire `SwarmCoordinator.abort()`
to session deletion, (d) truncated-output archive per-session cap. Accept: each has a test (the
report's revert-and-see method). Verify: core environment + swarm tests.
**E2 `acp.ts` defect sweep (§IV.8.2, 8 items) — M — deps: none**
Does: clear `transportError` on recovery (reset/handshake), cap `lineBuffer` (+ max frame), count
late responses, record swallowed parse errors, write queue for ordering, parallel notification
handlers (the request path already documents why), dispose notifies peer. Preserve the two documented
fixes (request starvation, `result ?? null`). Accept: all 8 verified individually first (report which
hold), each fixed or refuted. Verify: new `test/kernel/acp.test.ts`.
**E3 ACP connection resume — M — deps: E2**
Does: IV.8.2 brief — monotonic cursor, bounded replay (unbounded = leak), reconnect-storm jitter,
UI "behind" banner rather than silent staleness. Accept: dropped connection replays missed events
within the bound; banner shows when truncated. Verify: ws + web state tests.
**E4 Durable SSE tail (OpenMAIC pattern) — M — deps: E3**
Does: cluster-F #3 — log=truth, `Last-Event-ID` replay, `caught_up` marker, lossy NOTIFY-at-commit
wakeup; also fixes backend F3 (`safeSend` drops become a gap signal + resync). Accept: kill the socket
mid-stream; reconnect shows no silent gap. Verify: cockpit ws tests.
**C8 Offline e2e — S — deps: none**
Does: REL-ARCH-02 coverage gap — Playwright `setOffline(true)` → open a seeded chat → transcript
renders <100ms, zero unhandled rejections. Accept: the test passes in CI's e2e-browser job. Verify: `e2e/run.sh`.
**G1 Skill validator gate — M — deps: none**
Does: Composio #1 — taxonomy/frontmatter/≤80-line/references-link rules + **command-liveness
cross-check** ("every pnpm/make command in guidance exists"), ported as `scripts/validate-agent-skills.mjs`
over `.agents/skills` + CI job. Accept: the known 2,567-skill corpus passes or is triaged in the PR;
new violations fail CI. Verify: run against the corpus.
**G3 skills-lock pin format — S — deps: none**
Does: cluster-A #7 — `{version, skills:{name:{source,sourceType,skillPath,computedHash}}}` plus the
missing resolver (hash on ingest; verify command). Accept: one skill pinned + verified end-to-end.
Verify: script test. Files: `skills-lock.json`, `scripts/skills-lock.mjs`.
**G4 Patch/supersession hygiene — S — deps: none**
Does: 57 stale `local.patch` records + 14 `SKILL.superseded.md` (audit B) — archive applied-patch
records to a single ledger or delete; keep deliberate supersessions (documented redirect stubs).
Accept: zero ambiguous `local.patch`; policy written in `AGENTS.md`-level guidance. Verify: `find` sweep.
**H3 Atomic credential write audit — S — deps: none**
Does: §I.1.3.6 five steps against `packages/core/src/internal/atomic-write.ts`: `create_new`,
0600-at-creation, inherit perms, `sync_all` before rename, temp cleanup. Accept: all five proven by
test (or fixed). Verify: core internal tests.
**I1 Redaction completions — S — deps: none**
Does: session-id header allowlist preserved while keys redact (§I.1.3.15), `mask_email`,
`sanitize_error_for_log` → `internal/credential-redactor.ts`. Accept: the 14-header allowlist test.
Verify: core internal tests.
**I2 Command-policy completions — S — deps: none**
Does: `is_safe_path` dangerous-char allowlist before spawning discovered binaries + `CREATE_NO_WINDOW`
trait (§I.1.3.15) → `internal/command-policy.ts`. Accept: a discovered binary with `` ` `` in its path
is refused. Verify: core tests.
**I3 Zip-slip/symlink refusal — S — deps: none**
Does: cluster-A #8 — `isSymlinkZipEntry` (unix mode `0o170000`/`0o120000`) refused at every
download-and-extract site (CVE-2026-56876 class). Accept: extraction tests incl. a symlink entry fixture.
**I4 `effective_auth_mode` — S — deps: none**
Does: `Auto` → `Off` on loopback, `AllExceptHealth` on LAN (§I.1.3.15) in server auth middleware.
Accept: the resolution matrix test. Verify: server auth tests.

### Checkpoint: Wave 2
- [ ] Full suites green: core (≈4.9k), web (≈2.5k), server split, cli/docs/landing
- [ ] A1 flip evidence attached (shadow log scan) before merging
- [ ] B3's honest savings table reviewed by a human — drop any strategy under 10%

### Wave 3 — Expansion (features; heavy parallelization)

**D1 Grammar pack vendoring — M — deps: none**
Does: cluster-D §7 — pin `web-tree-sitter` ≥0.25, `scripts/codegraph/build-grammars.sh`
(`tree-sitter build --wasm`, TS in its `typescript/` subdir), 12 launch languages, license manifest.
Never runtime-install. Accept: `ParserPool.engineFor("typescript")` reports `ast` with vendored
grammars; absent grammar degrades one language. Verify: ast tests + build script run.
**D2 `.scm` query packs (TS/JS) + extractor→IR — M — deps: D1**
Does: `queries/{typescript,javascript}.scm` seeded from vscode-tree-sitter predicates + grammar repos;
extractor emits the IR (`ParsedFile/Function/Call/LocalVar`, `CallStep = call|branch`, nested lambdas
not attributed). Accept: golden-file extraction on fixtures incl. the calldiff CONTRACT's 6 behaviors.
**D3 Language packs (python, go, rust, java) — M — deps: D2**
Accept: same goldens per language. Verify: per-language fixture suites.
**D4a Symbol table + import resolution — M — deps: D2**
Does: Bikach Phase A (byFqn/byName/byPackage/typeHierarchy; `resolveTypeName` ladder) + alias-aware
import maps. Accept: cross-file import edges resolve; homonyms clamped by language+path.
**D4b Call-resolution ladder + overload scoring — M — deps: D4a**
Does: Bikach's 11-step ladder as written spec (cluster-D §3): qualified → constructor → receiver
chains → superclass → imports → same package → wildcards → extensions → single-candidate else
**drop the edge** ("a missing edge beats a wrong one"); overload scoring +100/−1/+50/+50/+25/−10.
Accept: the ladder's documented cases each have a fixture; zero fake edges in goldens.
**D5 `callstack-diff.ts` + `graph_diff` tool — M — deps: D4b**
Does: calldiff LCS tree diff (§5) + fingerprint-seeded reverse-BFS entry inference; two snapshots
compared through one extraction cache. Accept: added/removed subtrees fully marked; recursion `⇄`.
**D6 `git-snapshot.ts` — M — deps: none**
Does: `ls-tree`/`ls-files` + oid-deduped chunked `git cat-file --batch` reader (§5). Accept: a
two-commit fixture diffs without a worktree checkout. Verify: core codegraph tests.
**D7 GraphStore interface + snapshot versioning — S — deps: D4a**
Does: business-ops-only store (cluster-D #9), SCHEMA_VERSION drop-and-recreate semantics (safe:
reindex rebuilds). Accept: handlers contain no SQL/serialization. 
**D8 Seeded Louvain + god nodes — S — deps: D4b**
Does: deterministic community detection (codepoint-sorted insertion, seeded PRNG) + `get_god_nodes`.
Accept: two runs byte-identical. Verify: graph-algorithms tests.
**D9 Tool-surface upgrade — M — deps: D5, D8**
Does: cluster-D #4/#10 — explore-first catalog gating (pi-codegraph's measured finding), budgeted
markdown grouped by file, compact pipe formatters with `… M more (raise limit…)`, empty-result
diagnostics ("exists but no internal callers; defined at …"), 5-line routing guidance (already in
`code_graph`'s description — keep one source of truth). Accept: token budget respected; hints appear
on empty results. Verify: code-graph tool tests.
**D10 Benchmark harness — S — deps: D9**
Does: Bikach 5-scenario harness (LLM calls/tokens/cost/time, graph vs grep/read) as `tools/` +
server eval. Accept: reproducible table in the PR. 
**C1 Findings cockpit UI — M — deps: none**
Does: wiki-page sibling — list/ranked query, detail with evidence + provenance, lifecycle actions,
event replay strip. Design per `1-design`/impeccable Operate mode: scanable, the repo's tokens,
`text-gray-500 dark:text-gray-400` ink discipline. Accept: all 8 routes exercised; a11y pass (focus
rings, names, keyboard). Verify: web tests + e2e smoke.
**C3 Consolidation runner — M — deps: C2**
Does: agentmemory's schedule (2h pipeline, 5min Stop-hook debounce, 24h decay sweep) as a server
scheduler consumer; LLM-backed summary tiers behind the model layer (skip cleanly with no key).
Accept: `consolidate` gates fire exactly at ≥5 summaries / ≥2×freq≥2 (already pinned); runner idempotent.
**C4 RRF hybrid retrieval — M — deps: C3**
Does: 3-stream fusion 0.4/0.6/0.3, K=60, +5% agreement bonus, provenance rank string (cluster-C #5).
Accept: the reference's ranking fixtures. Verify: memory retrieval tests.
**C5 Bitemporal edges + `asOf` — M — deps: C4**
Does: `tcommit/tvalid/tvalidEnd/version/supersededBy/isLatest` on findings edges (cluster-C #1).
Accept: an `asOf` query reconstructs last week's graph. 
**C6 Supersession cascade → stale — S — deps: C5**
Does: jaccard>0.7 supersedes / >0.4 hints, cascade marks dependents stale (never deletes).
**C7 Influence receipts — S — deps: none**
Does: first-tree schemas (cluster-B #2) as the `FindingEvidence` channel a subagent emits about what
changed its context. Accept: a receipt round-trips through `report` → `query`.
**C9 MEMORY.md ⇄ findings interop — S — deps: C1**
Does: brain-tree markdown-brain pattern: MEMORY.md stays the human surface; a sync rule promotes
stale memory lines into findings and links back. Accept: round-trip preserves both.
**F2 Shared clock — S — deps: none** — III: one clock context replaces N 1s `setInterval`s.
**F4 Nav-collapse migration — S — deps: none** — III.4.2 #1: apply the existing `navCollapsed`
machinery outside the company-mode branch (~20 lines; the migration was half-finished).
**F5 Dock tab dedup — S — deps: none** — III.4.2 #2: the four embedded nav rows (Topology/Guardian/
Consensus/KeyFleet) drop the remount-on-session-switch (`key={selected.sessionId}`), ~30 lines net.
**F8 Contrast module + token-colors fixes — S — deps: none** — cluster-E #2 (99-line luminance/
compositing/ratio module) + fix III.2's measured hits (1.67:1, 2.77:1, 2.98:1, amber 2.15:1).
**F9 Calendar grid + ticket nested button — S — deps: none** — III.3's two confirmed blockers
(SC 1.3.1 grid semantics; `tickets-page.tsx:218`).
**F7a Sidebar split step 4 — M — deps: F4, F5** — behavior-free leaf moves per III.4's table.
**F7b ChatInput + workspace-browser splits — M ×2 — deps: none** — III.5 god-objects (2,911 / 2,152
lines), first-step extractions already identified in the audit pads.
**G2 Skill routing probes — M — deps: G1** — Composio #2: deterministic description-scoring probes,
one per skill category, coverage-enforced. Accept: a description edit that breaks routing fails CI.
**G6 Skill capability manifests — M — deps: G1** — SEC-SKILL-03 remediation: `network/fs/env`
declarations in SKILL.md frontmatter, enforced at the skill-script boundary (deny by default for
undeclared). Accept: the audit's named scripts declare and pass.
**H1 foreign-config contract — M — deps: H3** — backup → atomic write → version-gated → restore,
`is_managed_provider` ownership, `redact_json_value` read-back (§I.1.3.8).
**H2 YAML round-trip — M — deps: none** — §I.1.3.7 semantics (record sequence styles pre-parse,
restore after CST edit; comments survive). Accept: fixture with comments/indentless sequences round-trips.
**H5 Tiered help — M — deps: none** — simple/default/full command tables (cluster-A CLI §1).
**H6 Command-hint graph — S — deps: H5** — typed `Record<CommandHintId,{example,links}>` CTAs.
**H7 Levenshtein arg suggestions — S — deps: none** — cluster-A #3 (normalized distance + contains
bonus + adaptive threshold) in `tool-arguments.ts` errors.
**I6 Payload audit compaction — S — deps: I1** — structural JSON compaction + field reorder for logs (§I.1.2.5).
**J2 Actions SHA pinning — S — deps: none** — infra F1.
**J3 Coverage instrumentation — M — deps: none** — infra F2: v8 coverage + a threshold on critical modules.
**J4 retry:0 flake lane — S — deps: none** — infra F3: scheduled run surfacing latent flakes.
**J5 Desktop Electron smoke — M — deps: none** — infra F4: one Playwright `_electron` boot test.
**J7 3-variant Dockerfiles — M — deps: none** — full/backend-only/localdist (§I.1.2.13).
**J8 AGENTS.md constitution — S — deps: none** — §I.1.3.14's four rules (wildcard patterns, focused
tests, one-problem-class PRs, risky-path replacement rules).
**J9 Postmortem template + checklists — S — deps: none** — §I.1.3.15 docs practice.

### Checkpoint: Wave 3
- [ ] D10 benchmark table produced; D9's token claims measured, not asserted
- [ ] C-plane: one demo transcript (session → findings → query → UI) recorded
- [ ] Full suite + e2e green on the three OSes (CI matrix)

### Wave 4 — Strategic / second-order (compose the primitives)

**K4 Self-diagnosing failure mode — M — deps: A1, A2, B2** — §I.1.4.4: `failureTrace` on errors
("rotated N accounts; real cause was a 400 on attempt 3") + head/tail capture attached.
**K2 Cost ledger + `penguin why` — M — deps: A7, A8** — §I.1.4.2: per-turn decomposition (thinking
vs cache-miss vs prompt), `cache-effectiveness` repo, CLI subcommand. The debugging tool, not a metric.
**K3 Trustworthy CLI configurator — M — deps: H1, H2, H4** — §I.1.4.3 composition with the review
screen in `packages/web/`.
**K1 Turn ledger + cross-protocol resume — L→ tasks when scoped — deps: A5, A9** — §I.1.4.1:
`session/turn-ledger.ts` + `resumeFrom(ledger)`; content-addressed steps survive envelope changes.
**K5 Tool-schema normalisation surface — M — deps: none** — §I.1.4.5 + cluster-A schema pack:
`llm/tool-schema.ts` ($ref flattening, scored `anyOf`, strict-mode rewrite with `unsupported`
reporting, `sanitizeSchemaPropertyKeys` round trip). Start from the cluster-A port candidates #5/#6/#1.
**K14 ToolRouter session plane + permission vocabulary — L→ scope it — deps: K5** — cluster-A
higher-order (a): search/execute sessions, `gateToolExecution` ladder (allow_once/session/deny,
fail-closed in CI). Reconcile with our approvals plane first (design note required).
**K6 Interruption politeness (novu) — M — deps: E9** — digest merge (at-most-one per window, jittered
backoff), ConditionsFilter, preference precedence → `runtime/` + `channel.ts` (cluster-F H6).
**K7 HITL suspend/resume plane — M — deps: E3** — mastra verdicts + dify forms + budibase
release-the-worker escalation; reconcile with `runtime/approvals.ts` (cluster-B #2, dify #2).
**K8 Eval plane — M — deps: C4** — mastra runEvals gates/thresholds/`notScorable` + sha256 sampling;
scorers-as-loop-guards on WorkRouter goals; first-tree 4-tier skill-evals across the skill corpus.
**K9 Fleet state machine + worktree-per-agent — M — deps: none** — vibe-tree H1: slot states
(queued/blocked/paused), PTY resume, "which subagent needs you".
**K10 Rules engine + context providers + system-message tools — M — deps: none** — continue's three
planes (path-triggered rules as project memory; `@`-mention providers; tools for non-function-calling models).
**K11 Agent-orchestration plane — L→ scope it — deps: K8** — mastra network routing + tri-state goal +
completion scorers composing with `WorkRouter` (collage V.4's dispatch rules as acceptance criteria).
**K12 Agent-ops dashboards — M — deps: C1** — lobehub plane: hiring/scheduling/reporting for agents.
**K13 PiX graph-of-turns + patch codec — M — deps: K1** — multi-branch swarm chat; MPL-2.0 → modified
files stay openly licensed.
**F10 Semantic token layer — L→ scope it — deps: F8** — astryx tokens as a second layer over the
Tailwind gray scale, then delete `dark:` twins; generation-time contrast receipts.
**F11 Topology canvas engine — L→ scope it — deps: none** — tldraw MIT parts (`@tldraw/state`, store)
+ clean-room culling/camera/elbow routing for `features/topology/`.
**F12 Workflow visualizer — L→ scope it — deps: K11** — mastra/sim step-graph → Dagre layout for swarm runs.
**F13 Export plane — L→ scope it — deps: none** — open-design DTO contract, screenshot PPTX/PDF,
print CSS, export-queue state machine.
**F14 Cowork UX (AionUI) — M — deps: K9** — status badge, run-view reconciliation (seq guards,
orphan self-heal), warmup overlay, sidebar liveness badges, command queue.
**F15 Chart architecture + palettes — M — deps: F8** — astryx shared-scale charts + data-viz palettes
for the cockpit's usage/benchmark charts.

---

## Constraints — permanent REFUSE list (collage §I.1.5, reaffirmed by every cluster)

No free-api bridge (glm/qwen/gemini/deepseek families), no account/quota rotation, no device-fingerprint
spoofing, no uTLS/JA3 dialers, no vendor-binary patching, no PoW-WASM execution, no `.assets/`
reverse-engineering material, no WAF/prompt sanitiser stripping. **Licenses:** the Antigravity twins
(CC BY-NC-SA) = clean-room from the reports' prose only; Budibase core (GPLv3) = design-rewrite;
dify `web/` (modified Apache) and tldraw editor (proprietary) and mastra `ee/**` + `connect` (ELv2)
= ideas only; PiX = MPL-2.0 (modified files stay open); everything else cited MIT/Apache-2.0 keeps
its notice.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Registry `file:` snapshots hide stale core (bit us 3×) | Med | T0.3 helper; memory note; CI is arbiter — never trust a local pass alone |
| Sibling sessions editing this tree | High | Disjoint file sets confirmed before editing (collage V.1 rule); md5-snapshot before edits |
| Compression/pruning silently destroys signal | High | B3's three non-negotiables as tests; recall path mandatory |
| Resolver emits wrong edges | High | D4b "drop the edge" doctrine + golden fixtures per ladder step |
| Clean-room contamination from CC/GPL sources | High | Task notes cite the *report* §, never the source file, for encumbered repos |
| Full server suite local stall (isolate:false quirk) | Low | Known recovery: run the named file alone; CI split jobs are authoritative |
| Scope creep in L-sized tasks | Med | Break at 5 files / 3 acceptance bullets (this plan's sizing rule) |

## Parallelization

Safe: Waves 1–3 streams A/B/C/D/E/F/G/H/I/J are disjoint by package; run 4–8 concurrent workers
(flash model for investigations, main line for integration). Sequential: D1→D2→D3→D4a→D4b→D5;
A3→A4→A1; C2→C3→C4→C5; H3→H1→K3. Coordinate: anything touching `packages/core/src/index.ts`,
`default-config.ts`, `kernel-history.ts` (the guards fire there — one owner at a time).

## Open Questions

1. K14: should the Composio permission vocabulary *replace* our approvals plane or sit above it?
   (Design note requested before scoping.)
2. F10: full semantic-token migration vs. incremental overlay — cost/benefit needs one measurement
   pass over the 635 `text-gray-*` sites.
3. B3: which outputs actually compress well in our corpus — the measurement decides; anything under
   10% savings ships *nowhere* (collage IV.9's explicit instruction).
4. D1: vendoring 12 wasm grammars adds ~10–20MB to releases — confirm packaging tolerance before D3.
