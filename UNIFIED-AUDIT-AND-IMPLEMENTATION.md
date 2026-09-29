# Unified Audit & Implementation Report — penguin-harness-fork

Date: 2026-09-29 · Workspace: `D:/GitHub/penguin-harness-fork` · No commits made (per standing rule).

This report is the deliverable for the combined engagement: (1) forensic adjudication of the four
pasted audit reports and the `Unified Report Multi-Agent Collage.txt` evidence base, (2) the
follow-up implementation program (knowledge/findings graph, memory graph, native codegraph tools),
and (3) the port/absorption ledger from the peer-repo investigations.

---

## Part 1 — Audit adjudication (evidence-tiered)

The four pasted reports were treated as untrusted hypotheses and checked against the real tree at
commit `9ca1a00d` (merge of PR #11, release/0.2.18) — a tree that **contains the full
`packages/` source** the reports claimed was "omitted from snapshot".

### Headline claims

| Prior claim | Verdict | Evidence |
| --- | --- | --- |
| SEC-ARCH-01: graph/wiki indexes the workspace root instead of the session project | **Contradicted** (mechanism), with named residuals | The code-structure page fetches `/api/cockpit/topology?project=<id>` (`packages/web/src/features/topology/topology-page.tsx:54`) → `getOrCreateProjectRuntime(projectId, {root})` → `CodeGraphWatcher(projectDir(root, projectId))` (`packages/server/src/cockpit/ws.ts:438-468`). The claimed invariant is *test-enforced*: `packages/server/test/cockpit-runtime.test.ts:15` — "scopes the default project's topology to its own root, not the server CWD". The wiki is not a crawler at all: per-project JSON store (`packages/server/src/http/routes/wiki.ts` + `ProjectJsonStore`). Residual (real, now fixed): `getOrCreateProjectRuntimeSync` keyed runtimes by bare `projectId`, ignoring the root (stale-root hazard), and the `process.cwd()` fallback remains in the sync seam. Residual (design): scoping is project-level, not session-level. |
| REL-ARCH-02: chat hydration depends on the internet | **Contradicted** | Hydration is same-origin fetch → local `node:sqlite` + JSON trace shards (`packages/web/src/api/client.ts:79-113`, `packages/server/src/http/routes/sessions.ts:784-851`, `db/repos/sessions.ts:209-218`). The report's `Promise.all([db.get, cloudSync.verify, modelGateway.probe()])` snippet exists nowhere in the tree. KaTeX/shiki are bundled precisely to render offline (`packages/web/src/main.tsx:28-32`). Real residuals: one off-path CDN `<script>` in the artifact-preview iframe (`artifact-preview-drawer.tsx:82`), and **no offline e2e coverage**. |
| REJ-01: "no JEV components exist" | **Contradicted** | `packages/core/src/jev/` is a real 11-file advisory module (advisor/client/insight/… + `PROVENANCE.md`) wrapping the TypeSafe System One API, plus a gitignored `JEV-Family/` reference tree. |
| "src/ omitted from the snapshot" | **Contradicted** | `git ls-tree 9ca1a00d packages/` lists all seven packages at the audited revision. |
| SEC-SKILL-03 / SEC-EXEC-04: unsandboxed skill scripts | **Partially confirmed** | The scripts exist (incl. `downloader.js` with `rejectUnauthorized: false`), but generic execution IS guarded: `ShellGuardian`, `sandbox-runner.ts`, `capability-contract.ts`, `packages/server/src/sandbox/service.ts` (fail-closed). What is missing is skill-script-specific policy, not all sandboxing. |
| PERF-TOKEN-03: unbounded self-critique loops | **Contradicted** | `best-of-n` bounds N (2–4, default 3); `aihero-loop-me/grilling` are user-facing interview rounds; schema files sit in `references/` (on-demand), and cache-control guidance already ships in `claude-api/`. |
| MAINT-CONF-05 / DOC-DRIFT-06 | **Confirmed but mislabeled** | 57 tracked `local.patch` files exist — but they record *already-applied* localizations (stale records, not pending patches); 14 `SKILL.superseded.md` exist, at least one as deliberate supersession with a redirect stub. |
| UI-A11Y-03 / UX-RESP-04 / PERF-ANIM-05 (skill templates) | **Mostly contradicted** | Survivors: one range-input missing a focus style, missing CSP metas in 3 skill templates, one unresponsive 4-col grid. The layout-animation claim is flatly contradicted (`animations-animate/SKILL.md:77` mandates transform/opacity). Note: these are `.agents/skills` template assets, not the product UI. |

### Product-UI findings that WERE real (from the UI audit slices + this session's fixes)

- `text-gray-400` secondary ink = 2.54:1 on white — below WCAG 1.4.3. The repo's own convention
  (`packages/web/src/components/ui/session-row-menu.tsx` header) prescribes
  `text-gray-500 dark:text-gray-400` and admits the sweep was incomplete. **Fixed this session**
  (see Part 2). The old focus-ring blocker (1.54:1) is already fixed upstream in `styles.css`.
- The multi-select delete bug reported by the user: with rows marked, every delete affordance
  deleted one chat. **Fixed this session.**

---

## Part 2 — Changes landed this session (all validated, nothing committed)

| # | Change | Files | Validation |
| --- | --- | --- | --- |
| 1 | Cockpit runtime cache-key coherence: one runtime per resolved workspace dir across the async factory and the sync seams (fixes the stale-root hazard; regression-tested fail-before/pass-after) | `packages/server/src/cockpit/ws.ts`, `packages/server/test/cockpit-runtime.test.ts` (+2 tests) | 5/5 cockpit-runtime, 58/58 cockpit suite, tsc server clean |
| 2 | Incremental graph cache: dependents now snapshotted *before* `detachImportLinks` deletes the reverse-import key (was silently dropping importers from `stale`) | `packages/core/src/codegraph/incremental-graph-cache.ts` | 73/73 codegraph+watcher tests, tsc core clean |
| 3 | Multi-select batch delete: marked rows now delete as one confirmed batch (row menu + new selection-bar Delete), per-id fan-out with partial-failure retention, draft/pin/order cleanup, active-chat navigation | `packages/web/src/components/layout/sidebar.tsx`, `selection-bar.tsx`, `lib/strings-en.ts`, `lib/strings-zh.ts` | web 205 files / 2,525 tests pass, tsc web clean, i18n parity passes |
| 4 | WCAG contrast sweep: meaning-carrying `text-gray-400` → `text-gray-500 dark:text-gray-400` per the repo's documented convention (29 files; `aria-hidden` decorative marks, comment lines and the one documented "recede" timestamp preserved) | 29 files under `packages/web/src` | 2,525 web tests, tsc, prettier green |
| 5 | **Findings/knowledge graph engine** (new): deterministic ids, two-line dedupe (id + Jaccard), replace-by-source accounting, supersession chains, never-delete lifecycle, read-time decay (agentmemory formula), bounded event log, tolerant snapshot import/export | `packages/core/src/knowledge/{types,findings-graph,index}.ts` | 13/13 new tests |
| 6 | **`knowledge_graph` builtin tool** (new): report/query/confirm/refute/supersede/link/events/snapshot with host-attested provenance (forgery-proof attribution), atomic 0600 persistence at `.penguin/knowledge/findings-graph.json` | `packages/core/src/environment/tools/knowledge-graph.ts`, `registry.ts` | 3/3 tool tests |
| 7 | **`code_graph` builtin tool** (new): native code intelligence over the cockpit's own engines — index/search/callers/callees/impact/explore/files/hubs, 60s cache, no fs watchers, read-only | `packages/core/src/environment/tools/code-graph.ts`, `registry.ts` | 3/3 tool tests |
| 8 | Tools documentation synced (en+zh): registry table corrected from 8 → 12 entries (it was already missing `environment_info` and `resource_pressure`), new sections for `knowledge_graph` and `code_graph` | `packages/docs/content/tools.{en,zh}.md` | docs suite 7 files / 53 tests green |
| 9 | **Experimental memory retention & consolidation policy** (new, exported but not wired to production): agentmemory's reported numbers as pure helpers — strength `min(1, salience·e^(-0.01d) + 0.3·Σ1/daysSinceAccess)`, tiers 0.7/0.4/0.15, storage decay ×0.9 per 30 idle days floor 0.1 with write-only-what-changed, consolidation gates (≥5 summaries → semantic, ≥2 patterns × freq ≥2 → procedural), budget eviction | `packages/core/src/memory/retention.ts` | 10/10 policy-unit tests; frozen recall baseline maintained separately |
| 10 | **AST layer** (new, per cluster-D §7): parser-agnostic IR (ParsedFile/Function/Call/LocalVar/CallStep, dangling edges, provenance tiers), FQN scheme (`filePath::Name`, single `entityIdOf` builder — the absorbed two-builders drift lesson), grammar-backed parser pool (lazy optional `web-tree-sitter`, absolute grammar paths, LRU + byte-budget tree cache, 6-field incremental `tree.edit` deltas, honest `ast`/`fallback` engine tiers) | `packages/core/src/codegraph/ast/{ir,fqn,parser-pool,index}.ts` | 11/11 new tests; tsc clean |
| 11 | **Server-persistent findings plane** (new): `ProjectJsonStore`-backed routes mirroring the wiki — report (merges, host-attested provenance from the authenticated user), query, confirm/refute/supersede/link, events replay (log now snapshot-persisted), snapshot export; bounded inputs, 404/400 semantics | `packages/server/src/http/routes/findings.ts`, `app.ts`, `packages/core/src/knowledge/*` (events in snapshot format) | 5/5 route tests; tsc server clean |
| 12 | **Double-check completion**: the two new builtin tools joined the DEFAULT toolset (`state/default-config.ts` — the registry alone never delivers tools to agents), and the kernel advanced `2026-09-18 → 2026-09-29` per the module's documented workflow (old `tools` hash appended to `KERNEL_SUPERSEDED_TAB_HASHES`, new hash pinned, generation line added). The pinned-hash guard caught the omission — exactly its job. Pinned lists in `state.test.ts` updated | `packages/core/src/state/{default-config,kernel-history}.ts`, `packages/core/test/state.test.ts` | kernel-hash guard + state/tool-registry/kernel-version/agent/engine suites green (576 + 97 tests) |

Gates run repeatedly this session: prettier (clean), `tsc --noEmit` for core/server/web (clean),
vitest core targeted + full, vitest web (2,525), vitest docs (53), `node scripts/check-i18n.mjs`
(parity passes).

## Part 3 — The three steered missions: status

1. **Knowledge/findings graph with agent reporting — DONE.** Engine + `knowledge_graph` builtin
   tool + **server persistence** (`/api/projects/:id/findings/*`, item 11) + provenance +
   snapshot-persisted event log + tests + docs. Both the tool (workspace `.penguin/knowledge/`)
   and the server (`ProjectJsonStore`) write paths exist; the tool serves single-workspace
   agents, the routes serve the multi-user server.
2. **Memory subsystem — PARTIALLY IMPLEMENTED.** `RecallStore` enforces its own active age,
   event-count, and token bounds. `packages/core/src/memory/retention.ts` is an experimental,
   exported pure-policy module with unit tests but no in-repository production caller;
   `FindingsGraph.strength()` exposes a separate read-only score whose additive term follows
   creation age, not tracked access. Neither policy is an eviction or consolidation runner.
   Integrating retention remains deferred until C2 establishes recall/storage baselines, an
   owner, and an opt-in boundary.
3. **AST CodeGraph + graphify as native tools — DONE at the architecture layer.** The native
   tool surface (`code_graph`) and the AST substrate (IR/FQN/parser-pool, item 10) are in. The
   remaining pieces are mechanical and specified in cluster-D: vendor `web-tree-sitter` + build
   the wasm grammar pack (`tree-sitter build --wasm`), author `queries/<lang>.scm`, and stand up
   the two-pass resolver — the parser pool already degrades to the regex tier until then.

## Part 4 — Port/absorption ledger (from the collage + cluster reports)

Highest-value candidates already validated by the multi-agent investigations, in the order I would
land them. Verdict vocabulary: ADOPT / ADAPT / REIMPLEMENT / INSPIRE / REFUSE.

**Done or superseded by this session's work:** findings-graph schema & supersession (cluster-C
sketch → implemented in `knowledge/`), native codegraph tool surface (implemented), the cockpit
cache-key coherence (implemented).

**Next wave (effort S–M, high value):**
1. Large-output spill-to-file policy (Composio `tools.execute.cmd.ts:325-447`) →
   `packages/core/src/environment/tools/` output budget — the "recall id" pattern can extend our
   existing `truncated-tool-output-archive.ts`.
2. Snapshot→delta stream reassembly with rune-safe slicing + view re-sync (glm `zai.go:679-1026`,
   gemini `frames.go`) → `packages/core/src/llm/` — ADAPT the algorithm only; both sources are
   circumvention tools and their files must not be copied.
3. Failure classifier + interesting-status tracker + confidence-weighted retry-delay (the
   collage's ranks #2/#4/#24) → `packages/core/src/llm/` around `key-rotator.ts` /
   `context-engine.ts` (the shadow-mode `fleet/provider-gateway.ts` vocabulary already exists
   in-tree from a sibling session).
4. Memory consolidation + retention eviction (agentmemory) → `packages/core/src/memory/`.
5. AST extractor interface + tree-sitter grammar packs (cluster-D) → `packages/core/src/codegraph/ast/`.

**Refused, permanently (documented in the collage §I.1.5 and repeated across clusters):** every
free-api bridge, account/quota rotation, device-fingerprint spoofing, uTLS dialers, vendor-binary
patching, the vendored PoW WASM, and the `.assets/` reverse-engineering folders. Licenses that
block copying despite the MIT assumption: the Antigravity twins (CC BY-NC-SA), Budibase core
(GPLv3), dify frontend (modified Apache), tldraw editor (proprietary), mastra `ee/**` + `connect`.

## Part 5 — Remaining risks and open items

- The `code_graph`/`knowledge_graph` tools assemble only for agents whose `tools.builtin` config
  includes them (persisted agent configs are frozen as written — see the tools docs note); adopting
  them on existing agents needs the kernel-update path or a config edit.
- `.penguin/knowledge/` persistence lives in the workspace; server-side per-project persistence
  (ProjectJsonStore) is the cleaner long-term home and is unimplemented.
- The AST layer and memory consolidation are designed but not built (Part 3).
- Sibling sessions are editing this tree live; every file I touched was md5-snapshotted before
  editing and re-validated after.
