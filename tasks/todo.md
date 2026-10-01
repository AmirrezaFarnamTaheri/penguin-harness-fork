# Task List — Absorption & Hardening Master Plan (v3)

Index of `tasks/plan.md` (authority for acceptance, evidence, dependencies, rollback). Check a
box only after its acceptance criteria and named checks pass on the exact commit. The Verify
column names the required suite or evidence; use the owning package's actual script. PR #12 head
`68148d15baf95a941cc98a7d3b41086b1b2a6ae7` passed required CI, including browser E2E and the
installer/runtime matrix; the dependency audit is clean. R13 and R14a/b are complete, with the
[exact-head evidence ledger](../docs/audits/pr-12-ci-2026-09-30.md). PR #12 merged on 2026-09-30 as
`fc44861a4730a43c58d9accdbc9e15ee27003d8b`; that receipt applies only to its recorded head.
The focused findings suites now pass locally, but follow-up Wave R acceptance remains open for
exact-head quality/CI evidence and the broader web integration gate.
Sizing: XS / S / M; the broad strategic rows require design/measurement gates before implementation.

Local review and continuation on 2026-10-01 added the R1b/R1c lifecycle, R4 route hygiene, and
R8 authorship read-back implementations, and corrected G3/I2/D6 boundaries. See the
[implementation review](../docs/audits/implementation-review-2026-10-01.md) for source paths,
coverage, and remaining acceptance work. These local changes do not close wave checkpoints
or replace the exact-commit evidence required by this list.

The Wave 3 D7 continuation adds a checksummed, versioned `GraphStore`, strict topology snapshot
validation, bounded reads/writes, and atomic replacement through the shared writer. Schema
mismatch is an explicit rebuildable cache miss; malformed snapshots are never returned. Focused
store and atomic-write checks pass locally. The D7 checkbox remains open until exact-commit review.
H7 now suggests a unique nearby command or option from registered CLI vocabulary. Registered
option arity prevents an unknown flag's value from redirecting command lookup. Parser errors do
not echo unknown tokens or inline values; paths, ambiguous matches and distant tokens receive no
suggestion. Its focused CLI suite and typecheck pass locally; exact-commit review remains.

The R2a–R2c store continuation is connected to tool and HTTP paths, with local concurrency,
capacity, corruption and recovery receipts in the
[findings-store ledger](../docs/audits/findings-store-2026-10-01.md). Checkboxes remain open for
the plan's dependency/review and exact-commit gates. The latest continuation adds the bounded
atomic eviction archive, durable creator provenance, and revision-bound paged output. The full
core `test/knowledge` suite passes 66/66, the focused findings HTTP routes pass 19/19, and core
typecheck/build are green; server typecheck, core lint/format, and docs-claims checks pass. Full web
acceptance, remaining wave suites, workspace-wide static-quality gates, exact-commit CI, and
required review remain open.

R11's eleven named graph/store/output cases and engine/tool/route lifecycle mapping are now present
in the current worktree. Its focused core and HTTP checks pass; the exact-commit evidence rule still
keeps the tracker checkbox open until the changes land on the reviewed head.

The 2026-10-02 workspace audit initially found 22 advisories after the registry added new Axios,
fast-uri, and brace-expansion findings. The lockfile now resolves patched Axios/fast-uri versions
and version-aware brace-expansion overrides; the follow-up `pnpm audit --json` reports zero
findings. This is worktree evidence, not exact-commit or CI acceptance; details are in the
[follow-up audit note](../docs/audits/dependency-audit-followup-2026-10-02.md).

## Wave R — PR #12 review absorptions (first)

| # | Task | Size | Verify | Acceptance (compressed) |
|---|---|---|---|---|
| [x] | **R13** Repair PR #12 browser E2E and record exact-head CI | S | named Playwright case, full E2E, `gh pr checks 12` | `skills.spec.mjs:246` targets the intended message; aggregate CI and browser job green on same SHA; [evidence](../docs/audits/pr-12-ci-2026-09-30.md) |
| [x] | **R14a** Upgrade Electron past four high advisories | S | `pnpm audit --audit-level high` + desktop/installer matrix | lockfile and packaged runtime ≥43.5.0; no Electron high advisory; exact-head desktop smokes green; [evidence](../docs/audits/pr-12-ci-2026-09-30.md) |
| [x] | **R14b** Repair runtime/build undici advisory paths | S | `pnpm audit --json` + server/packaging smokes | runtime ≥7.29.1, build-chain ≥6.28.1; neither path in audit; [evidence](../docs/audits/pr-12-ci-2026-09-30.md) |
| [ ] | **R0** Findings scope and authority contract (implemented locally; PR review pending) | S | tool/route identity fixtures | `tasks/findings-scope-matrix.md`; cross-layer tests cover independent paths, name collisions, workspace rename, symlink alias cache, and server ownership checks; keep any authority binding or migration blocked until review approves the contract |
| [ ] | **R1a** Eviction policy truth & reference hygiene | M | graph eviction + store fault/restart tests | 1,000 entries / 4 MiB / 90 days in the same atomic snapshot; fail-closed write, zero dangling live refs, confirmed-last rank, rotation and restart |
| [ ] | **R1b** Lifecycle state machine + evidence gate + actor | M | engine+tool+route tests | `canTransition` table; `confirm` needs runtime/impl evidence (or user override); every event names actor |
| [ ] | **R1c** Transition guards: cycles, liveness, dead-claim re-reports | S | engine+route/tool negative tests | imported cycles/depth fail closed; replayed re-report is idempotent; only authenticated user reopens |
| [ ] | **R2a** Scope-aware store + acknowledged writes | M | `test/knowledge/findings-store.test.ts` + integration | 50 cross-path updates survive restart; stale cache and write/rename failure cannot return success |
| [ ] | **R2b** Bounds parity + capacity/recovery path | S | store+route+tool tests | shared field caps; high-water and hard-limit behavior; export possible at capacity; revision cache bounded |
| [ ] | **R2c** Corruption quarantine + read-only recovery | S | store+route+tool fault tests | corrupt/partial/unsupported file never overwritten by report; raw export, explicit audited reset/restore |
| [ ] | **R2d** Conditional migration after trusted workspace↔project binding | M | binding proof + migration fixture matrix | deferred under today's model; dry-run conflicts, idempotent apply and byte-exact rollback only after binding exists |
| [x] | **R3** Report & governance reconciliation | S | docs suite + contradiction/path grep | dated report reconciled under `docs/audits/`; root pointer; canonical policy exists and is linked by plan + README |
| [ ] | **R4** Route hygiene | S | `vitest run test/findings-routes` | GET enums validated (400); engine TypeError → 500; `%zz` → 400; one definition of TIERS; `_c` gone |
| [ ] | **R5** Revision-aware, byte-bounded output | M | tool/consumer contract tests | v2 query/snapshot/events/archive envelopes; stable scope/filter/revision cursors; latest event sequence and explicit gaps; UTF-8 budget, oversize recall, and v1 compatibility |
| [x] | **R6** code_graph resource discipline | S | cache/tool tests + full core suite/typecheck | single-flight scan (20 concurrent → 1 scan); LRU cap 8 with observed closes; TTL refresh closes old only after success; cache stats + watcher boundary documented |
| [x] | **R7** Memory-plane honesty (Option B selected) | S | core memory/findings tests + frozen recall fixture | retention module is exported but has no in-repo production callers; strength formula documents/tests createdAt term; frozen RecallStore ranking/tokens; no new eviction behavior |
| [ ] | **R8** Accurate provenance on read-back | S | tool/route tests + docs | author inferred from trusted event, legacy unknown, free-form source cannot impersonate user |
| [x] | **R9** Bounded batch fan-out (8 concurrent) | S | `test/all-settled-bounded.test.ts` + full web suite/typecheck | 200-item batch peaks at 8; ordered all-settled results preserve partial failures |
| [x] | **R10** Tool-schema token measurement | S | `tools/measure-default-tool-schema.mts` + audit report | direct + lazy payloads measured; two additions cost 1,176 chars/4 estimates (<1,500 threshold); provider tokenizer unavailable and documented |
| [ ] | **R11** Findings-plane test battery | M | `vitest run test/knowledge` | lifecycle, byte-bound output, durable ack, corruption, stale cache, and separate-scope fixtures; conditional migration suite only if R2d activates |
| [x] | **R12** A11y verification pass (axe + keyboard/focus/dark/target) | S | `e2e/a11y.spec.mjs` + [audit report](../docs/audits/web-accessibility-2026-09-30.md) | zero axe violations on covered surfaces; every desktop and mobile stop reached with visible focus; mobile target-size and overflow checks pass; Axe manual-review items documented |

### Checkpoint R
- [ ] R0 and R1–R12 acceptance criteria green; R2d remains deferred until a trusted binding exists; Wave-R suites green (`test/knowledge`, `findings-routes`, web)
- [x] R13 browser/aggregate CI green on exact PR head; R14a/b audit paths repaired; see [evidence ledger](../docs/audits/pr-12-ci-2026-09-30.md)
- [x] §2/§3 of the plan updated per R7/R12/R13/R14 outcomes
- [ ] Every review ID (F1–F7, N1–N12) marked resolved or declined-with-reason

## Wave 1 — Foundations & quick wins

| # | Task | Size | Verify |
|---|---|---|---|
| [x] | **A2** FailureStatusTracker + localized HttpError metadata/error rendering | S | Core tracker + findings suites; server error/findings suites; web API error tests; typechecks/build; `check:i18n`; Prettier |
| [x] | **A3** Retry-delay provenance + Retry-After | M | `vitest run test/llm*` |
| [x] | **B2** BoundedStreamCapture head+tail | S | `test/trace/bounded-capture.test.ts` — four focused cases passed; core typecheck passed |
| [ ] | **F1** Input focus rings (3 sites) | S | local web 2,533/2,533 + R12 pass; exact-commit gate pending |
| [ ] | **F3** Comment-lies + `features/canvas` removal + cockpit dir rename | S | web suite + grep (human-reviewed deletion) |
| [ ] | **F6** STREAM_BANNER_FRAME dedup across six compact notice modules | S | local rendered classes + web 2,533/2,533; exact-commit gate pending |
| [ ] | **G5** TLS verification fix + sweep (implemented locally; exact-commit gate pending) | XS | no active bypass; direct downloader smoke against `https://example.com/` passed with TLS verification enabled |
| [ ] | **G7** Anti-slop installer path fix — N/A disposition | XS | source audit recorded locally; exact-commit gate pending |
| [x] | **J1** `clean` npm script wiring | XS | `pnpm clean` report passed; cleaner fixture suite passed |
| [x] | **J6** CI/docs drift sweep ("75 specs") | XS | docs suite passed; workflow parsed; numeric claim removed |
| [x] | **T0.3** Workspace dependency freshness guard | S | injected-snapshot fixture: stale fails, supported reinstall + build sync passes |
| [ ] | **J11** Docs-claims consistency gate | S | local fixtures/checker/CI step pass; exact-commit gate pending |

Implementation progress (2026-10-01, local changes): F1's three focus fixes now use solid accent
rings; the full web suite passes 2,533/2,533 and the R12 browser rerun has zero axe violations and
zero missing keyboard-focus indicators. These are local receipts; exact-commit gates still apply.
F3's comments and canvas removal were already present; the widget
directory is now `cockpit-widgets`, with importers updated; 24 focused component checks, web
typecheck and the full web suite pass; human review of the deletion remains. G5 has no executable `.agents`
TLS-verification bypass remaining. The downloader now uses Node's built-in `fetch` with default TLS
verification and passed a direct 713-byte HTTPS download smoke; the temporary file was removed.
`bgm.js` still uses its declared Axios dependency for the ccMixter API path, which was not part of
the downloader smoke.
J11's versioned ledger, runtime-chain checker and CI step are implemented; same-package and
false-claim fixtures pass. Plan §2 is explicitly retained as a historical inventory, while
`docs/status-ledger.json` is the only current machine-checked claim ledger.
F6's scope is reconciled against the current source: six compact notice modules share the frame;
the harness, MCP-connect, and step banners are distinct interactive disclosures and stay on their
own shell. `packages/web/test/stream-banner-frame.test.ts` now pins rendered classes for all six
modules (including handoff/model-switch variants) and verifies the three interactive disclosure
shells stay independent. Its focused run passed 3/3; the full web suite passed 2,533/2,533, and
web typecheck, scoped oxlint and Prettier pass. F6 acceptance is complete locally; the task stays
unchecked until the current commit meets this ledger's exact-head rule, and the Wave 1 checkpoint
remains open for its other gates.
The Wave 1 web integration run found nine literal server error codes missing from both locale
dictionaries. English and Chinese messages are now present, and the focused i18n parity suite
passes 2/2; after the fix, the full web suite passes 2,533/2,533 across 207 files.
G7's referenced `install.mjs`, `rules-src` and `assets/anti-slop` are absent from this checkout;
`tools/oxlint/anti-slop/` contains the active plugin's `rules/` instead. The execution card and
plan record the applicability finding and prohibit fabricating a second source tree. G7 is closed
as not applicable to this checkout; reopen only if the vendored installer artifact is restored.

### Checkpoint 1
- [ ] Named suites green; prettier / oxlint / tsc clean

## Wave 2 — Core hardening

| # | Task | Size | Deps | Verify |
|---|---|---|---|---|
| [ ] | **A1** Classifier flip shadow→active (attach the `agrees=false` scan) | M | A2,A3 | core llm + fleet tests |
| [ ] | **A4** Pool-shape-aware retry budget + once-per-account grace (implemented locally; exact-commit gate pending) | M | A3 | policy branch table + fake-timer runtime checks; see Wave 1–2 evidence |
| [ ] | **A5** Snapshot→delta stream reassembler (implemented locally; exact-commit gate pending) | M | — | 500-sequence property test; see Wave 1–2 evidence |
| [x] | **A6** Length-prefixed frame parser | S | — | Five reference shapes pass; core typecheck passes; exported primitive awaits provider integration |
| [ ] | **B1** Large-output spill + recall id (implemented locally; exact-commit gate pending) | M | B2 | failures remain useful inline; Session-scoped paged recall reproduces persisted UTF-8 text after redaction |
| [ ] | **B3** Tool-output compression + honest savings table | M | B1 | 3 non-negotiable tests + table (losers dropped) |
| [ ] | **B4** Transactional compaction + prune frontier | M | — | byte-identical on failure; frontier no-reread |
| [ ] | **C8** Offline e2e | S | — | CI e2e job green |
| [ ] | **E1** Cockpit sync-seam residuals | S | — | `vitest run test/cockpit*` |
| [ ] | **E5** trigger_swarm non-simulate | S | — | cockpit ws tests |
| [ ] | **E6** Cockpit error-shape unification | XS | — | server route tests |
| [ ] | **E7** Gateway input validation (implemented locally; exact-head gate pending) | XS | — | gateway tests; URL/body identifiers and approval session IDs bounded before lookup |
| [ ] | **E8** /health + readiness (implemented locally; exact-head gate pending) | S | — | `health.test.ts` covers serving, DB-closed, degradation, and recovery |
| [ ] | **E9** Structured logger + rejection counter | M | — | logger/request context, sink-failure/idempotence, and `/health/metrics` focused checks |
| [ ] | **E10** Leak fixes ×4 (orphan reaping / hung dispose / swarm abort / archive cap) | M | — | revert-and-see tests ×4 |
| [ ] | **E2** acp.ts 8-defect sweep (verified/refuted table) | M | — | `test/kernel/acp.test.ts` |
| [ ] | **E3** ACP connection resume | M | E2 | kill-mid-stream replay test |
| [ ] | **E4** Durable SSE tail + safeSend gap signal | M | E3 | no silent gaps on reconnect |
| [ ] | **G1** validate-agent-skills CI gate | M | — | corpus passes or triaged |
| [ ] | **G3** skills-lock pin + resolver | S | — | pin→verify→drift covered |
| [ ] | **G4** local.patch / superseded hygiene | S | — | zero ambiguous `local.patch` |
| [ ] | **H3** Atomic credential write 5-step audit | S | — | internal tests ×5 steps |
| [ ] | **I1** Redaction completions | S | — | 14-header allowlist test |
| [ ] | **I2** Command-policy completions | S | — | spawn-refusal test |
| [ ] | **I3** Zip symlink-entry refusal | S | — | symlink fixture test |
| [ ] | **I4** effective_auth_mode matrix | S | — | auth matrix test |

### Checkpoint 2
Local implementation progress (2026-10-01): A5's exported snapshot utility passes the
500-sequence property check; it is not yet consumed by a provider adapter. A6 additionally
passes bounded-frame and terminal-error checks (seven focused cases). E5–E8 are implemented
with focused route/socket checks and server typecheck. A4 now connects the policy to ordinary
engine turns and model account selection, with bounded attempts, grace, cooldown waiting,
cancellation and a legacy rollback switch. Compaction now applies the selected policy to one
shared budget for unusable summaries and transport failures. E1's implicit cwd roots are removed,
with roots injected explicitly by production and test hosts. Final acceptance audits remain.
The unchecked rows retain their broader acceptance and exact-commit requirements.
H3 now uses exclusive 0600 temporary creation, permission inheritance, descriptor chmod,
sync-before-rename and owned-temp cleanup, with fault fixtures at every post-create step.
Native platform permission receipts remain. I3 now rejects symlink metadata, unsafe paths and
normalized collisions before skill/hook decompression; grouped import checks and unchanged-
destination overwrite fixtures pass. Its final platform and wave gates remain open.
G1's existing Skill Integrity workflow already runs strict corpus/resource validation and
publishes taxonomy/readiness reports. It now also checks changed skills against the 80-line
limit: existing long skills are individually inventoried with line counts and SHA-256 in the
CI artifact, while new over-limit skills and growth in grandfathered skills fail the gate.
The current corpus has 2,120 long skills to triage; this gate prevents increasing that debt.
Four line-budget behavior cases pass locally; the full workflow result remains pending.
G3 now has an offline resolver and a deterministic source-path/SHA-256 lock for the skill
corpus. Skill Integrity verifies the lock before accepting a change; pin→verify→drift,
un-pinned/missing source, and path-shaped-name cases are covered locally. Its exact-head CI
gate remains pending.
I2 now validates the final executable argument after sandbox rewriting and refuses dangerous
shell characters before launch. Ordinary paths with spaces, Unicode, drive letters, Windows
separators and `(x86)` remain valid; the launch helper always supplies Node's `windowsHide`
flag. The three focused spawn checks and core typecheck pass on this Windows host; exact-head
CI evidence remains pending.

- [ ] Full suites green (core ≈4.9k · web ≈2.5k · server split · cli/docs/landing)
- [ ] A1 evidence attached · B3 table reviewed · E2 per-item table in PR

## Wave 3 — Expansion

| # | Task | Size | Deps | Verify |
|---|---|---|---|---|
| [ ] | **D1** Optional lazy TS/JS grammar pack + manifest | M | — | pinned assets, license/hash manifest, missing-asset fallback and resource baseline |
| [ ] | **D2** .scm packs TS/JS + extractor→IR | M | D1 | CONTRACT 6-behavior goldens |
| [ ] | **D3** Optional language packs python/go/rust/java | M | D10 | per-language goldens and rerun quality/resource gate before each promotion |
| [ ] | **D4a** Symbol table + import resolution | M | D2 | cross-file edges; homonym clamp |
| [ ] | **D4b** Call-resolution ladder + overload scoring | M | D4a | fixture per step; zero fake edges |
| [ ] | **D5** callstack-diff + graph_diff tool | M | D4b | LCS/entry-inference tests |
| [ ] | **D6** git-snapshot reader | M | — | two-commit fixture |
| [ ] | **D7** GraphStore interface + versioning (implemented locally; exact-commit gate pending) | S | D4a | migration, corruption, interruption and concurrent-reader fixtures |
| [ ] | **D8** Seeded Louvain + god nodes | S | D4b | byte-identical runs |
| [ ] | **D9** Tool-surface upgrade (explore-first/budgets/formatters/hints) | M | D5,D8 | budget + hint tests |
| [ ] | **D10** Benchmark: AST vs regex (quality/resource gate) | M | D9 | frozen five-scenario corpus, false-edge/precision/recall and resource table |
| [ ] | **C1** Findings cockpit UI | M | R2b | 8 routes + a11y + demo transcript |
| [ ] | **C2** Memory recall baseline and opt-in policy boundary | S | R7 | frozen recall/write/latency baseline; no destructive default policy |
| [ ] | **C3** Consolidation runner | M | C2 | gates fire exactly at thresholds; no unproven retention enablement |
| [ ] | **C4** RRF hybrid retrieval | M | C3 | reference fixtures |
| [ ] | **C5** Bitemporal edges + asOf | M | C4 | last-week reconstruction |
| [ ] | **C6** Supersession cascade → stale | S | C5 | 0.7/0.4 thresholds |
| [ ] | **C7** Influence receipts | S | R1b | round-trip test |
| [ ] | **C9** MEMORY.md ⇄ findings interop | S | C1 | round-trip test |
| [ ] | **F2** Shared clock | S | — | web suite |
| [ ] | **F4** Nav-collapse migration | S | — | web + e2e nav |
| [ ] | **F5** Dock tab dedup | S | — | e2e dock |
| [ ] | **F8** Contrast module + token-colors fixes | S | — | ratio tests |
| [ ] | **F9** Calendar grid + ticket nested button | S | — | a11y checks |
| [ ] | **F7a** Sidebar split step 4 | M | F4,F5 | verbatim-check script |
| [ ] | **F7b** ChatInput split | M | — | verbatim-check + web suite |
| [ ] | **F7c** Workspace-browser split | M | — | verbatim-check + web suite |
| [ ] | **G2** Skill routing probes | M | G1 | description-edit breaks CI |
| [ ] | **G6** Skill capability manifests | M | G1 | named scripts declare + pass |
| [ ] | **H1** foreign-config contract | M | H3 | write/restore/ownership tests |
| [ ] | **H2** YAML round-trip (comments survive) | M | — | fixture round-trip |
| [ ] | **H4** Redacted config preview and reversible apply | M | H1,H2,H3 | dry-run, secret-safe diff, fault rollback on Windows/POSIX |
| [ ] | **H5** Tiered help | M | — | CLI snapshot tests |
| [ ] | **H6** Command-hint graph | S | H5 | hint rendering tests |
| [ ] | **H7** Levenshtein arg suggestions (implemented locally; exact-commit gate pending) | S | — | `test/usage-error.test.ts`: typo, ambiguity, distance and no-echo cases |
| [ ] | **I6** Payload audit compaction | S | I1 | redaction tests |
| [ ] | **J2** Actions SHA pinning | S | — | workflow review |
| [ ] | **J3** Coverage instrumentation | M | — | threshold gate green |
| [ ] | **J4** retry:0 flake lane | S | — | scheduled run configured |
| [ ] | **J5** Desktop Electron smoke | M | — | `_electron` test |
| [ ] | **J7** 3-variant Dockerfiles | M | — | all three build |
| [ ] | **J8** AGENTS.md constitution (4 rules) | S | — | review |
| [ ] | **J9** Postmortem template + checklists | S | — | docs suite |

### Checkpoint 3
- [ ] D10 two-tier table produced (AST promoted only if it wins)
- [ ] Findings demo transcript recorded
- [ ] CI green on 3 OSes; R12 a11y clean

## Wave 4 — Strategic / second-order

| # | Task | Size | Deps | Verify |
|---|---|---|---|---|
| [ ] | **A7** CanonicalUsage + Anthropic healing | M | — | usage tests |
| [ ] | **A8** Token estimator + calibration | S | — | estimator tests |
| [ ] | **A9** Content-addressed session fingerprinting | S | — | fingerprint tests |
| [ ] | **K4** Self-diagnosing failure mode (failureTrace) | M | A1,A2,B2 | failure-story test |
| [ ] | **K2** Cost ledger + `penguin why` | M | A7,A8 | decomposition demo |
| [ ] | **K3** Trustworthy CLI configurator | M | H1,H2,H3,H4 | configure E2E |
| [ ] | **K1a** Turn ledger core | M | A5,A9 | resume test |
| [ ] | **K1b** Cross-protocol resume demo | M | K1a | provider-switch demo |
| [ ] | **K5** Tool-schema normalisation surface | M | — | corpus fixtures (cluster-A #7 pattern) |
| [ ] | **K14a** Permission-plane adapter design note | S | K5 | one authoritative approval trace for direct/retry/delegated calls |
| [ ] | **K14b** ToolRouter + permission vocabulary | M | K14a | gate-ladder tests |
| [ ] | **K6** Interruption politeness (digest/preferences/conditions) | M | E9 | digest coalescing test |
| [ ] | **K7** HITL suspend/resume plane | M | E3 | suspend→resume E2E |
| [ ] | **K8** Eval plane + scorers-as-loop-guards + skill-evals | M | C4 | gate/threshold tests |
| [ ] | **K9** Fleet state machine + worktree-per-agent | M | — | slot-state tests |
| [ ] | **K10** Rules engine + context providers + system-message tools | M | — | per-plane tests |
| [ ] | **K11a** Orchestration contract note | S | K8 | note approved |
| [ ] | **K11b** Orchestration implementation | M | K11a | WorkRouter composition tests |
| [ ] | **K12** Agent-ops dashboards | M | C1 | UI + a11y |
| [ ] | **K13** PiX graph-of-turns + patch codec | M | K1b | codec round-trip |
| [ ] | **K16a** Audit-protocol mapping (existing status + labels + checklist data) | S | R1b | compatibility and mapping tests; no new candidate status by default |
| [ ] | **K16b** Versioned checklist verification in tooling | M | K16a | new verified label checklist-gated; legacy confirm evidence-gated and marked unverified |
| [ ] | **K17** Benchmark ledger + README section | M | D10,C4 | README renders from ledger |
| [ ] | **F10a** Semantic-token measurement (live site count) | S | F8 | contrast/migration cost report against §11 Q6 gate |
| [ ] | **F10b.1** Conditional semantic token map | S | F10a | Q6 gate, alias/state and contrast receipts |
| [ ] | **F10b.2** Component-family migration | M | F10b.1 | per-family screenshots and keyboard review |
| [ ] | **F10b.3** Obsolete-token cleanup | S | F10b.2 | dynamic usage search and visual pass |
| [ ] | **F11a** Topology signals and store | M | — | stable identity and update tests |
| [ ] | **F11b** Topology culling and camera | M | F11a | large graph, viewport and reduced-motion tests |
| [ ] | **F11c** Topology elbow routing | M | F11b | deterministic geometry tests |
| [ ] | **F12a** Workflow graph model | M | K11b | state/event mapping tests |
| [ ] | **F12b** Workflow renderer | M | F12a | narrow viewport and keyboard tests |
| [ ] | **F13a** Authorized export DTO | M | — | contract and scope tests |
| [ ] | **F13b** PPTX/PDF/print renderers | M | F13a | artifact goldens and print review |
| [ ] | **F13c** Export queue | M | F13b | restart, cancel, auth and retention tests |
| [ ] | **F14** Cowork UX (badge/reconciliation/warmup/queue) | M | K9 | UI tests |
| [ ] | **F15** Chart architecture + palettes | M | F8 | chart a11y |

### Checkpoint 4
- [ ] K4/K2/K3 end-to-end demos recorded
- [ ] §11 decisions applied or declined under the recorded reopen criteria

## Promotion add-ons (plan §5A — schedule with the wave named)

| # | Task | Size | Wave | Verify |
|---|---|---|---|---|
| [ ] | **C10** Session briefing injection (confirmed, non-stale, ≤1,200 tokens) | M | 3 | scope/trust/budget/injection tests |
| [ ] | **C11** Source-revision-driven finding staleness | S | 3 | content-change vs touch-only tests |
| [ ] | **C12** Findings chat-native surface (composer action + badge + drill-through) | M | 3 | web unit + e2e flow |
| [ ] | **K18** Verification workflow gating briefings (user-actor confirm/refute) | S | 3 | override-dialog + strict-briefing tests |
| [ ] | **D11** Impact-aware write advisory (≤1 line, cache-hit only) | S | 3 | notice presence/absence tests |
| [ ] | **F17** Offline posture banner | S | 2 | C8 asserts cached/reconnect states |
| [ ] | **F18** Spill/recall UI affordance + `penguin recall` | S | 2 | chip render + path-guard tests |
| [ ] | **I7** Pressure-aware write guard (warn 200MB / block 50MB / override recorded) | M | 2 | pressure matrix tests; resource_pressure stays observe-only |
| [ ] | **J12** PR annotations (coverage, stale docs, verified findings-on-diff) | M | 3 | untrusted-path/fork-permission fixture tests |
| [ ] | **J13** Health → alerting (deduped degradations) | S | 4 | K6 notification/recovery tests; Wave 2 health remains separate |
| [ ] | **G8** Skills doctor + health badges | S | 3 | doctor exit codes + badge mapping |

Amended acceptance riding along: **D9** +P6 tier/status surfacing · **E3/E4** +P9 resync button ·
**R7/C1** +P14 memory transparency · **K4** +P13 failure stories · **K17** +P16 auto-findings ·
**A1** classifications feed K4. Non-promotions (plan §5A) are binding: Jev event-only,
resource_pressure tool observe-only, query bodies excluded from briefings, code_graph read-only.

## Sequencing & ownership rules

- Waves run in order; within a wave, independent streams may run in parallel only with named
  owners, disjoint files and fixtures, and a reviewed integration point.
- Single-owner files (pause if held): `core/src/index.ts`, `state/default-config.ts`,
  `state/kernel-history.ts`, `knowledge/findings-graph.ts` (R1b/R1c), `knowledge/store.ts` (R2).
- Any worker finding a defect in another worker's file: record it, don't edit (collage V.4 rule).
- Local green is not enough — CI is the arbiter (the tool-alias failure was invisible locally).
