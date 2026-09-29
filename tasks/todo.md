# Task List — Absorption & Hardening Master Plan

Derived from `tasks/plan.md` (full task definitions, acceptance criteria, file sets). Check a box
only when that task's acceptance criteria AND verification are green. Sizing: XS/S/M/L per plan.

## Wave 1 — Foundations & quick wins

- [ ] A3 Retry-delay provenance + Retry-After honoring (M)
- [ ] A2 FailureStatusTracker + error taxonomy triple (S)
- [ ] B2 BoundedStreamCapture head+tail (S)
- [ ] F1 Input focus rings (menu search / checkbox / faint gray rings) (S)
- [ ] F3 Comment-lies + features/canvas removal + cockpit dir rename (S)
- [ ] F6 STREAM_BANNER_FRAME dedup (XS)
- [ ] G5 TLS verification fix + sibling sweep (XS)
- [ ] G7 Anti-slop installer path fix (XS)
- [ ] J1 `clean` npm script wiring (XS)
- [ ] J6 CI/docs drift sweep ("75 specs") (XS)
- [ ] T0.3 Snapshot-refresh helper + AGENTS.md line (S)

### Checkpoint: Wave 1
- [ ] Named focused suites green; prettier / oxlint / tsc clean
- [ ] Human review of the F3 deletions before push

## Wave 2 — Core hardening

- [ ] A1 Classifier flip: provider-gateway shadow → active (M) [deps A2,A3]
- [ ] A4 Pool-shape-aware retry budget + once-per-account grace (M) [deps A3]
- [ ] A5 Snapshot→delta stream reassembler (M)
- [ ] A6 Length-prefixed frame parser (S)
- [ ] B1 Large-output spill + recall id (M) [deps B2]
- [ ] B3 In-process tool-output compression + honest savings table (M) [deps B1]
- [ ] B4 Transactional compaction + prune frontier (M)
- [ ] C2 Retention wiring into HierarchicalMemoryStore (S)
- [ ] E1 Cockpit sync-seam residuals (S)
- [ ] E5 trigger_swarm non-simulate: handler or 400 (S)
- [ ] E6 Cockpit error-shape unification (XS)
- [ ] E7 Gateway input validation (XS)
- [ ] E8 /health + readiness route (S)
- [ ] E9 Structured logger + rejection counter (M)
- [ ] E10 Leak fixes: orphan reaping / hung-run dispose / swarm abort wiring / archive cap (M)
- [ ] E2 acp.ts 8-defect sweep (M)
- [ ] E3 ACP connection resume (cursor + bounded replay + behind banner) (M) [deps E2]
- [ ] E4 Durable SSE tail + safeSend gap signal (M) [deps E3]
- [ ] C8 Offline e2e regression (S)
- [ ] G1 validate-agent-skills CI gate (M)
- [ ] G3 skills-lock pin format + resolver (S)
- [ ] G4 local.patch / SKILL.superseded hygiene (S)
- [ ] H3 Atomic credential write 5-step audit (S)
- [ ] I1 Redaction completions (session-id allowlist / mask_email) (S)
- [ ] I2 Command-policy completions (is_safe_path / CREATE_NO_WINDOW) (S)
- [ ] I3 Zip symlink-entry refusal (S)
- [ ] I4 effective_auth_mode loopback/LAN matrix (S)

### Checkpoint: Wave 2
- [ ] Full suites green (core ≈4.9k, web ≈2.5k, server split, cli/docs/landing)
- [ ] A1 flip evidence (shadow-log scan) attached
- [ ] B3 savings table reviewed — sub-10% strategies dropped

## Wave 3 — Expansion

- [ ] D1 Grammar pack vendoring (web-tree-sitter + build-grammars.sh + license manifest) (M)
- [ ] D2 .scm query packs TS/JS + extractor→IR (M) [deps D1]
- [ ] D3 Language packs: python/go/rust/java (M) [deps D2]
- [ ] D4a Symbol table + import resolution (M) [deps D2]
- [ ] D4b Call-resolution ladder + overload scoring (M) [deps D4a]
- [ ] D5 callstack-diff + graph_diff tool (M) [deps D4b]
- [ ] D6 git-snapshot reader (M)
- [ ] D7 GraphStore interface + snapshot versioning (S) [deps D4a]
- [ ] D8 Seeded Louvain + god nodes (S) [deps D4b]
- [ ] D9 Tool-surface upgrade (explore-first / budgets / pipe formatters / hints) (M) [deps D5,D8]
- [ ] D10 Benchmark harness + measured table (S) [deps D9]
- [ ] C1 Findings cockpit UI (M)
- [ ] C3 Consolidation runner (2h pipeline / 5min debounce / 24h sweep) (M) [deps C2]
- [ ] C4 RRF hybrid retrieval (M) [deps C3]
- [ ] C5 Bitemporal edges + asOf (M) [deps C4]
- [ ] C6 Supersession cascade → stale (S) [deps C5]
- [ ] C7 Influence receipts (S)
- [ ] C9 MEMORY.md ⇄ findings interop (S) [deps C1]
- [ ] F2 Shared clock for live-duration ticks (S)
- [ ] F4 Nav-collapse migration to dev mode (S)
- [ ] F5 Dock tab dedup (S)
- [ ] F8 Contrast module + token-colors fixes (S)
- [ ] F9 Calendar grid semantics + ticket nested button (S)
- [ ] F7a Sidebar split step 4 (M) [deps F4,F5]
- [ ] F7b ChatInput split (M)
- [ ] F7c Workspace-browser split (M)
- [ ] G2 Skill routing probes (M) [deps G1]
- [ ] G6 Skill capability manifests (M) [deps G1]
- [ ] H1 foreign-config contract (M) [deps H3]
- [ ] H2 YAML round-trip preserving comments (M)
- [ ] H5 Tiered help (M)
- [ ] H6 Command-hint graph (S) [deps H5]
- [ ] H7 Levenshtein arg suggestions (S)
- [ ] I6 Payload audit compaction (S) [deps I1]
- [ ] J2 Actions SHA pinning (S)
- [ ] J3 Coverage instrumentation (M)
- [ ] J4 retry:0 flake-surfacing lane (S)
- [ ] J5 Desktop Electron smoke (M)
- [ ] J7 3-variant Dockerfiles (M)
- [ ] J8 AGENTS.md maintenance constitution (S)
- [ ] J9 Postmortem template + verification checklists (S)

### Checkpoint: Wave 3
- [ ] D10 benchmark table produced; D9 token claims measured
- [ ] Findings demo transcript recorded (session → findings → query → UI)
- [ ] Full CI matrix green on 3 OSes

## Wave 4 — Strategic / second-order

- [ ] K4 Self-diagnosing failure mode (failureTrace) (M) [deps A1,A2,B2]
- [ ] K2 Cost ledger + `penguin why` (M) [deps A7,A8]
- [ ] K3 Trustworthy CLI configurator (M) [deps H1,H2,H4]
- [ ] K1 Turn ledger + cross-protocol resume (L→split) [deps A5,A9]
- [ ] K5 Tool-schema normalisation surface (M)
- [ ] K14 ToolRouter plane + permission vocabulary (L→split; design note first) [deps K5]
- [ ] K6 Interruption politeness (novu digest/preferences/conditions) (M) [deps E9]
- [ ] K7 HITL suspend/resume plane (M) [deps E3]
- [ ] K8 Eval plane + scorers-as-loop-guards + skill-evals (M) [deps C4]
- [ ] K9 Fleet state machine + worktree-per-agent (M)
- [ ] K10 Rules engine + context providers + system-message tools (M)
- [ ] K11 Agent-orchestration plane (L→split) [deps K8]
- [ ] K12 Agent-ops dashboards (M) [deps C1]
- [ ] K13 PiX graph-of-turns + patch codec (M) [deps K1]
- [ ] F10 Semantic token layer (L→split) [deps F8]
- [ ] F11 Topology canvas engine (L→split)
- [ ] F12 Workflow visualizer (L→split) [deps K11]
- [ ] F13 Export plane (L→split)
- [ ] F14 Cowork UX (AionUI set) (M) [deps K9]
- [ ] F15 Chart architecture + palettes (M) [deps F8]

### Checkpoint: Wave 4
- [ ] Second-order compositions demonstrated end-to-end (K4, K2, K3)
- [ ] Open Questions in tasks/plan.md resolved or explicitly deferred with reasons

## Sequencing note

Tasks sharing `packages/core/src/index.ts` / `default-config.ts` / `kernel-history.ts` (the
kernel-hash and tool-alias guards fire there) are single-owner at a time. Everything else in a
wave may run in parallel across 4–8 workers.
