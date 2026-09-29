# Task List — Absorption & Hardening Master Plan (v2)

Index of `tasks/plan.md` (authority for acceptance criteria, verification, files, sources).
Check a box only when the task's acceptance criteria AND verification are green. Verify column =
the exact command to run. Sizing: XS / S / M (L is pre-split).

## Wave R — PR #12 review absorptions (first)

| # | Task | Size | Verify | Acceptance (compressed) |
|---|---|---|---|---|
| [ ] | **R1a** Eviction policy truth & reference hygiene | S | `vitest run test/knowledge` | header/comment match real order (refuted→superseded→open→confirmed-last); sidecar archive; zero dangling refs; rank-order test |
| [ ] | **R1b** Lifecycle state machine + evidence gate + actor | M | engine+tool+route tests | `canTransition` table; `confirm` needs runtime/impl evidence (or user override); every event names actor |
| [ ] | **R1c** Transition guards: cycles, liveness, dead-claim re-reports | S | `vitest run test/knowledge` | supersede cycles throw; replacement must be live; refuted re-report → new finding (`contradicts`) unless `reopen:true` |
| [ ] | **R2a** One findings store behind one locked interface | M | `test/knowledge/findings-store.test.ts` | both paths share `FindingsStore`; 50 interleaved updates all land; external edits observed (mtime guard) |
| [ ] | **R2b** Bounds parity + 8MB store cap + rehydrate cache | S | store+route+tool tests | tool caps == route caps (shared validator); byte cap; GET parses store once per change |
| [ ] | **R2c** Corruption quarantine (never silent loss) | S | store tests | corrupt → `.corrupt-<ts>` copy + log + `recoveredFromCorruption` flag; no overwrite |
| [ ] | **R3** Report & governance reconciliation | S | docs suite + grep | zero "unimplemented"/"No commits made" contradictions; report under `docs/audits/`; `docs/policies/porting-and-refusals.md` exists |
| [ ] | **R4** Route hygiene | S | `vitest run test/findings-routes` | GET enums validated (400); engine TypeError → 500; `%zz` → 400; one definition of TIERS; `_c` gone |
| [ ] | **R5** Tool output markers + pagination | S | tool tests (JSON.parse every variant) | snapshot/events paginate (`after`/`limit`, `nextCursor`); truncation marker; never invalid JSON |
| [ ] | **R6** code_graph resource discipline | S | `test/knowledge/code-graph-tool.test.ts` | single-flight scan (20 concurrent → 1 scan); LRU cap 8 with observed closes; watcher answer documented |
| [ ] | **R7** Memory-plane honesty or wiring | M | core memory tests + fixture run | Option A wired+measured OR Option B experimental label; `strength()` docs match math |
| [ ] | **R8** Agent-authored marking on read-back | S | tool tests + docs | query rows show source/status/`agentAuthored`; trust notice in tool description |
| [ ] | **R9** Bounded batch fan-out (8 concurrent) | S | web unit test | 200-marked batch ≤8 in flight; partial-failure semantics unchanged |
| [ ] | **R10** Tool-schema token measurement | S | `tools/measure-*` run | measured table in docs; >1,500 tokens → trimmed or justified |
| [ ] | **R11** Findings-plane test battery | M | `vitest run test/knowledge` | merge idempotency · snapshot+events round-trip · cycles · eviction+refs · dead-claim re-report · truncation · store concurrency · corruption — each fails pre-fix |
| [ ] | **R12** A11y verification pass (axe + keyboard/focus/dark/target) | S | `e2e/a11y.spec.mjs` + axe | zero critical/serious on chat/sidebar/settings; keyboard-reachable with visible focus |
| [ ] | **R13** CI truth pass (Node 24) | XS | `gh pr checks 12` | per-job table recorded in the report; zero unexplained reds |

### Checkpoint R
- [ ] Wave-R suites green (`test/knowledge`, `findings-routes`, web)
- [ ] §2/§3 of the plan updated per R7/R12/R13 outcomes
- [ ] Every review ID (F1–F7, N1–N12) marked resolved or declined-with-reason

## Wave 1 — Foundations & quick wins

| # | Task | Size | Verify |
|---|---|---|---|
| [ ] | **A2** FailureStatusTracker + error taxonomy triple | S | `vitest run test/errors.test.ts` + `check:i18n` |
| [ ] | **A3** Retry-delay provenance + Retry-After | M | `vitest run test/llm*` |
| [ ] | **B2** BoundedStreamCapture head+tail | S | `test/trace/bounded-capture.test.ts` |
| [ ] | **F1** Input focus rings (3 sites) | S | web suite + R12 |
| [ ] | **F3** Comment-lies + `features/canvas` removal + cockpit dir rename | S | web suite + grep (human-reviewed deletion) |
| [ ] | **F6** STREAM_BANNER_FRAME dedup | XS | web suite |
| [ ] | **G5** TLS verification fix + sweep | XS | `grep -r rejectUnauthorized .agents` |
| [ ] | **G7** Anti-slop installer path fix | XS | installer dry-run |
| [ ] | **J1** `clean` npm script wiring | XS | `pnpm clean` |
| [ ] | **J6** CI/docs drift sweep ("75 specs") | XS | docs suite |
| [ ] | **T0.3** Snapshot-refresh helper + AGENTS.md line | S | helper run + staleness probe |
| [ ] | **J11** Docs-claims consistency gate | S | `node scripts/check-doc-claims.mjs` |

### Checkpoint 1
- [ ] Named suites green; prettier / oxlint / tsc clean

## Wave 2 — Core hardening

| # | Task | Size | Deps | Verify |
|---|---|---|---|---|
| [ ] | **A1** Classifier flip shadow→active (attach the `agrees=false` scan) | M | A2,A3 | core llm + fleet tests |
| [ ] | **A4** Pool-shape-aware retry budget + once-per-account grace | M | A3 | `test/llm/retry-policy.test.ts` branch table |
| [ ] | **A5** Snapshot→delta stream reassembler | M | — | 500-sequence property test |
| [ ] | **A6** Length-prefixed frame parser | S | — | 5 reference test shapes |
| [ ] | **B1** Large-output spill + recall id | M | B2 | failures always inline; recall byte-exact |
| [ ] | **B3** Tool-output compression + honest savings table | M | B1 | 3 non-negotiable tests + table (losers dropped) |
| [ ] | **B4** Transactional compaction + prune frontier | M | — | byte-identical on failure; frontier no-reread |
| [ ] | **C8** Offline e2e | S | — | CI e2e job green |
| [ ] | **E1** Cockpit sync-seam residuals | S | — | `vitest run test/cockpit*` |
| [ ] | **E5** trigger_swarm non-simulate | S | — | cockpit ws tests |
| [ ] | **E6** Cockpit error-shape unification | XS | — | server route tests |
| [ ] | **E7** Gateway input validation | XS | — | gateway tests |
| [ ] | **E8** /health + readiness | S | — | route test (200/503) |
| [ ] | **E9** Structured logger + rejection counter | M | — | zero `console.*` in server src |
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
- [ ] Full suites green (core ≈4.9k · web ≈2.5k · server split · cli/docs/landing)
- [ ] A1 evidence attached · B3 table reviewed · E2 per-item table in PR

## Wave 3 — Expansion

| # | Task | Size | Deps | Verify |
|---|---|---|---|---|
| [ ] | **D1** Grammar pack vendoring (12 wasm + manifest) | M | — (Q4 gate) | `engineFor("typescript")` = ast |
| [ ] | **D2** .scm packs TS/JS + extractor→IR | M | D1 | CONTRACT 6-behavior goldens |
| [ ] | **D3** Language packs python/go/rust/java | M | D2 | per-language goldens |
| [ ] | **D4a** Symbol table + import resolution | M | D2 | cross-file edges; homonym clamp |
| [ ] | **D4b** Call-resolution ladder + overload scoring | M | D4a | fixture per step; zero fake edges |
| [ ] | **D5** callstack-diff + graph_diff tool | M | D4b | LCS/entry-inference tests |
| [ ] | **D6** git-snapshot reader | M | — | two-commit fixture |
| [ ] | **D7** GraphStore interface + versioning | S | D4a | migration test |
| [ ] | **D8** Seeded Louvain + god nodes | S | D4b | byte-identical runs |
| [ ] | **D9** Tool-surface upgrade (explore-first/budgets/formatters/hints) | M | D5,D8 | budget + hint tests |
| [ ] | **D10** Benchmark: AST vs regex (promotion gate!) | S | D9 | 5-scenario two-tier table |
| [ ] | **C1** Findings cockpit UI | M | R2b | 8 routes + a11y + demo transcript |
| [ ] | **C3** Consolidation runner | M | R7 | gates fire exactly at thresholds |
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
| [ ] | **H5** Tiered help | M | — | CLI snapshot tests |
| [ ] | **H6** Command-hint graph | S | H5 | hint rendering tests |
| [ ] | **H7** Levenshtein arg suggestions | S | — | suggestion unit tests |
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
| [ ] | **K3** Trustworthy CLI configurator | M | H1,H2,H4 | configure E2E |
| [ ] | **K1a** Turn ledger core | M | A5,A9 | resume test |
| [ ] | **K1b** Cross-protocol resume demo | M | K1a | provider-switch demo |
| [ ] | **K5** Tool-schema normalisation surface | M | — | corpus fixtures (cluster-A #7 pattern) |
| [ ] | **K14a** Permission-plane design note | S | K5 | note approved (Q2) |
| [ ] | **K14b** ToolRouter + permission vocabulary | M | K14a | gate-ladder tests |
| [ ] | **K6** Interruption politeness (digest/preferences/conditions) | M | E9 | digest coalescing test |
| [ ] | **K7** HITL suspend/resume plane | M | E3 | suspend→resume E2E |
| [ ] | **K8** Eval plane + scorers-as-loop-guards + skill-evals | M | C4 | gate/threshold tests |
| [ ] | **K9** Fleet state machine + worktree-per-agent | M | — | slot-state tests |
| [ ] | **K10** Rules engine + context providers + system-message tools | M | — | per-plane tests |
| [ ] | **K11a** Orchestration contract note | S | K8 | note approved |
| [ ] | **K11b** Orchestration implementation | M | K11a | WorkRouter composition tests |
| [ ] | **K12** Agent-ops dashboards | M | C1 | UI + a11y |
| [ ] | **K13** PiX graph-of-turns + patch codec | M | K1 | codec round-trip |
| [ ] | **K16a** Audit-protocol mapping (statuses + labels + checklist data) | S | R1b | mapping tests |
| [ ] | **K16b** Protocol enforcement in tooling | M | K16a | checklist-gated confirm |
| [ ] | **K17** Benchmark ledger + README section | M | D10,C4 | README renders from ledger |
| [ ] | **F10a** Semantic-token measurement (635 sites) | S | F8 | cost report (resolves Q2) |
| [ ] | **F10b** Semantic token overlay | L→split | F10a | contrast receipts |
| [ ] | **F11a/b/c** Topology: signals+store / culling+camera / elbow routing | M×3 | — | per-piece tests |
| [ ] | **F12a/b** Workflow visualizer (graph model / renderer) | M×2 | K11b | render tests |
| [ ] | **F13a/b/c** Export plane (DTO / PPTX+PDF+print / queue) | M×3 | — | export round-trips |
| [ ] | **F14** Cowork UX (badge/reconciliation/warmup/queue) | M | K9 | UI tests |
| [ ] | **F15** Chart architecture + palettes | M | F8 | chart a11y |

### Checkpoint 4
- [ ] K4/K2/K3 end-to-end demos recorded
- [ ] Q1–Q5 resolved or deferred with reasons recorded in tasks/plan.md

## Sequencing & ownership rules

- Waves run in order; within a wave, all streams may run in parallel across 4–8 flash-model workers.
- Single-owner files (pause if held): `core/src/index.ts`, `state/default-config.ts`,
  `state/kernel-history.ts`, `knowledge/findings-graph.ts` (R1b/R1c), `knowledge/store.ts` (R2).
- Any worker finding a defect in another worker's file: record it, don't edit (collage V.4 rule).
- Local green is not enough — CI is the arbiter (the tool-alias failure was invisible locally).
