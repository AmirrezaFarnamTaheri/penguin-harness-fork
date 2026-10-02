# Implementation contracts and decisions

These constraints apply to the task cards. Current task state is in [todo.md](todo.md); dispatch order is in [work-orders.md](work-orders.md). The v3 source and historical adjudications are preserved in [the archive](archive/plan-v3-2026-10-02.md). Changing a selected decision requires concrete evidence, the affected paths/version, and a reversible implementation; a failed promotion gate keeps the proven default active.

## Architecture decisions

1. **Clean-room, spec-first ports.** CC BY-NC-SA (Antigravity twins), GPLv3 (Budibase core),
   proprietary (tldraw editor) and ELv2 (mastra `ee/`, `connect`) sources are re-implemented from
   the _reports'_ prose; source files of those trees are never opened while implementing.
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

## Promotion contracts

The plan's tasks mostly _build_ things. This section asks the second question the OG material
supports but never states: **which built things should be elevated** — wired to a second system,
promoted from read to write, or surfaced from engine layer to product/user layer. Ladder:
**L0** library/engine · **L1** wired + active in-process · **L2** agent surface (tool) ·
**L3** server/API surface · **L4** user-facing product surface.

| #   | Item (today's layer)                                           | Promote to                     | Wiring that elevates it                                                                                                                                                                                | Task                | Product surface gained                                                    |
| --- | -------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------- |
| P1  | Findings store is a passive record (L0–L3)                     | **Active context** (L4)        | session-open hook retrieves only confirmed, non-stale, authorized findings for the mapped scope; a ≤1,200-token lower-trust briefing quotes titles/subjects as data and records the revision used      | **C10**             | chat "Known findings" panel; first-run orientation                        |
| P2  | Findings ⇄ code-graph links are static text (L0)               | **Live staleness** (L1)        | persisted code identity/content revisions mark directly evidenced findings stale after a relevant source change; filesystem events alone are hints and never change claim status                       | **C11**             | `stale` badge in query rows and the cockpit page                          |
| P3  | Findings live on the cockpit page only (L3)                    | **Chat-native surface** (L4)   | composer "log finding" action (opens the report dialog prefilled with the current file/symbol), count badge on the chat header, drill-through `path:line`                                              | **C12**             | findings inside the daily surface, not a separate page                    |
| P4  | Findings trust is a marker (R8, L1)                            | **Verification workflow** (L4) | human confirmation records a trusted actor and evidence/override reason; an agent confirmation still needs evidence and stays visibly agent-attributed; C10 includes only confirmed, non-stale claims  | **K18**             | "verify this claim" loop in the UI; briefing trust is earned, not assumed |
| P5  | `code_graph.impact` is a read (L2)                             | **Write-path advisory** (L1)   | `edit_file`/`write_file` compute impact for touched symbols (cheap: reuse the cached graph) and append one line — "impact: N dependents (code_graph)" — above a threshold (≥5)                         | **D11**             | impact warning at the moment of change, not on request                    |
| P6  | Engine tier (ast vs regex fallback) is internal (L0)           | **Honest status** (L2–L4)      | `code_graph` `status` action reports tier + staleness + cache stats (R6); topology header shows an "AST / scan" badge                                                                                  | **D9** (amended)    | users know which quality tier they are looking at                         |
| P7  | Large-output spill is invisible plumbing (L1)                  | **Recall affordance** (L4)     | tool-call card renders a "full output saved" chip; clicking streams the recall id on demand; CLI `penguin recall <id>`                                                                                 | **F18**             | the compression story becomes legible in the chat                         |
| P8  | Offline behavior is a test only (L0)                           | **Posture banner** (L4)        | combine browser network state with an actual local-server reachability probe; copy says which actions are available from cached data and when reconnect is needed, without claiming that nothing syncs | **F17**             | users know which actions still work offline                               |
| P9  | ACP resume/behind-state is engine-only (L1)                    | **Resync control** (L4)        | the E4 gap signal feeds a "Updates missed — resync" button; show a count only when the server can prove it                                                                                             | **E3/E4** (amended) | users self-heal staleness instead of trusting it                          |
| P10 | `resource_pressure` observes and never refuses (L2, by design) | **Enforcement elsewhere** (L1) | command-policy guard measures the target volume; warn below 200 MiB, block only nonessential new writes below 50 MiB, preserve cleanup/export/recovery, and log an explicit user override              | **I7**              | pressure gauge + actionable block toast                                   |
| P11 | `/health` is an endpoint (L3)                                  | **Alerting** (L4)              | degradation emits through the K6 digest/notification plane (disk, DB, kernel-version skew, eviction-archive growth)                                                                                    | **J13**             | ops learn from the product, not from a curl                               |
| P12 | Skill validators are CI scripts (L1)                           | **Doctor + badges** (L4)       | `penguin skills doctor` (G1/G2 output as CLI) + skills-page health badges (capability risk from G6 manifests)                                                                                          | **G8**              | skill health is user-visible where skills are managed                     |
| P13 | Classifier flip is engine policy (A1, L1)                      | **Failure stories** (L4)       | A1's classifications + B2's head/tail become K4's `failureTrace`, rendered in the web error panel and in `penguin why`                                                                                 | **K4** (amended)    | "what actually went wrong" is a product answer                            |
| P14 | Retention/eviction is library policy (R7, L0)                  | **Memory transparency** (L4)   | the eviction archive (R1a) is surfaced: "why is this memory gone" reads the archive; dashboard counts by tier                                                                                          | **R7/C1** (amended) | memory stops being a black box                                            |
| P15 | Gates are scripts (J3/J11, L1)                                 | **PR annotations** (L4)        | CI posts annotations (coverage delta, stale-doc claims, findings on touched files) instead of only a red check                                                                                         | **J12**             | reviewers see why, in the PR                                              |
| P16 | Benchmark runs are reports (D10/K17, L0)                       | **Auto-findings** (L1)         | benchmark outcomes create idempotent, run-keyed **open** findings with artifact links; human or evidence-gated review is needed before confirmation                                                    | **K17** (amended)   | a queryable ledger without automatic authority                            |

### Explicit NON-promotions (design invariants — do not "elevate" these)

1. **Jev advisory stays event-only.** Its `PROVENANCE.md` invariant — observes, never authorizes,
   vetoes, gates, or adds latency — is the module's reason to exist. Any "make Jev decide" request
   is refused at the design level.
2. **`resource_pressure` the _tool_ stays observe-only** (see P10: enforcement lives at the
   command-policy layer). The tool's docs comment exists precisely to stop this drift.
3. **Briefings keep bodies out and sanitize titles/subjects as untrusted data** (poisoning bound,
   review N7). They use confirmed, non-stale claims only. On-demand `query` keeps its existing
   documented result shape until a versioned consumer migration is verified.
4. **`code_graph` stays read-only** — no refactor/write actions on the graph surface. P5 is an
   advisory _inside existing write tools_, not a new writer.
5. **Refusal-list items are never promoted to product** (see the source and license boundary below): a bridge, a rotation pool, or a
   fingerprint spoofer is not a feature waiting for a UI.
6. **Frozen agent configs are not auto-migrated.** Kernel updates stay explicit (the tools docs
   already promise this); P-tier surfaces may _show_ "kernel outdated" but never rewrite silently.

### Promotion task mapping

The live dependency index is [todo.md](todo.md). These contracts distinguish discovery work
that can start now from producer contracts required before integration; the linked card owns
the ordered packages and acceptance evidence.

**C10 · Session briefing injection** · M · deps R0,R2a,R1b,R8,K18 — P1
**C11 · Source-revision-driven staleness** · S · deps R0,R2a,R1b and a persisted source-content revision seam from C5/C6 or a bounded D7 adapter — P2
**C12 · Findings chat-native surface** · M · deps C1,R8 — P3
**K18 · Verification workflow gating briefings** · S · deps R1b,R8 — P4
**D11 · Impact-aware write advisory** · S · deps D4b or fresh regex-tier impact, R6, and D9 tier/freshness status — P5
**F17 · Offline posture banner** · S · deps C8 — P8 (Wave 2)
**F18 · Spill/recall UI affordance** · S · deps B1 — P7
**I7 · Pressure-aware write guard** · M · deps target-volume probe and the existing authoritative command-policy boundary; E9 supplies emergency disk diagnostics — P10
**J12 · PR annotations for gates + findings** · M · deps J3,J11,R1b for authorized finding annotations — P15 (Wave 3)
**J13 · Health → alerting** · S · deps E8,E9,K6 — P11 (Wave 4; Wave 2 ships health data)
**G8 · Skills doctor + health badges** · S · deps G1,G3 for doctor; G2 routing and G6 capability badges require their producer slices — P12

Amended acceptance (existing tasks): **D9** += P6 status/tier surfacing · **E3/E4** += P9 resync
button · **R7/C1** += P14 memory transparency · **K4** += P13 rendered failure stories ·
**K17** += P16 auto-findings · **A1** += classifications consumed by K4's panel.

## Risk controls

| Risk                                                                                          | Impact   | Mitigation                                                                                                                      |
| --------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Registry `file:` snapshots hide stale core (bit us 3×; also masked the alias failure locally) | Med      | T0.3 helper; CI is arbiter; never merge on local green alone                                                                    |
| A workspace is mistaken for a server project and findings leak or diverge                     | Critical | R0 identity matrix; authorize before mapping; never silently merge unrelated scopes; R2d dry-run and rollback                   |
| Acknowledged write is lost or corruption is overwritten                                       | Critical | R2a durable acknowledgement; R2c read-only recovery; archive/write fault injection and restart tests                            |
| Archive rotation invalidates a perpetual-retention promise                                    | High     | State finite window and limits; expose counts and export; reject durable mutation when required archive append fails            |
| Cursor reuse across a mutation skips or duplicates findings                                   | High     | R5 revision/filter-bound cursors and explicit stale/gap response                                                                |
| Memory poisoning of the findings plane (N7)                                                   | Med      | R8 trust marking + bodies out of automatic briefings; on-demand query stays compatible; provenance/actor visible; K16 checklist |
| Compression/pruning destroys signal                                                           | High     | B3's three non-negotiables as tests; recall path mandatory                                                                      |
| Resolver emits wrong edges                                                                    | High     | D4b fixtures per step; drop-the-edge doctrine                                                                                   |
| Clean-room contamination                                                                      | High     | task Source cites report §, never encumbered source files                                                                       |
| Sibling sessions editing this tree                                                            | High     | named file ownership, `git status`/commit SHA before edits, separate worktrees when isolation is needed                         |
| L-scope creep                                                                                 | Med      | break at 5 files / 3 acceptance bullets; K14/K11 get design notes first                                                         |
| Release size from wasm grammars                                                               | Med      | TS/JS lazy pack first; D10 per-language resource gate before D3 expansion                                                       |
| Full server suite local stall (`isolate:false` quirk)                                         | Low      | named-file runs; CI split jobs authoritative                                                                                    |

## Source and license boundary

The canonical hard refusals, license-scope findings, required evidence, and clean-room workflow
live in [`docs/policies/porting-and-refusals.md`](../docs/policies/porting-and-refusals.md).
Retention constants come from agentmemory report descriptions (clean-room numbers; no upstream
source code copied). The upstream [LICENSE](https://github.com/rohitg00/agentmemory/blob/main/LICENSE)
was verified as Apache-2.0 on 2026-09-30; the implementation records that source link.

## Selected decisions Q1–Q8

These are implementation decisions, not unanswered design questions. A gate may reject a
specific implementation; it does not silently replace the selected default. Record any
exception with measured evidence, owner, affected version, and rollback in the PR.

| ID                            | Decision now                                                                                                                                                                                                                                                                                           | Reopen only if                                                                                                                                     | Proof before rollout                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 · PR #12                   | Keep the coherent PR intact through R13's browser repair and exact-head matrix; PR #12 merged on 2026-09-30. Ship subsequent Wave-R slices as narrow, reversible follow-up PRs.                                                                                                                        | A reviewer identifies an independently revertible portion that blocks a follow-up review, or a bounded gate cannot pass without unrelated changes. | [PR #12 merge](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/pull/12), its exact-head evidence ledger, and changed-file ownership for follow-ups. |
| Q2 · permission plane         | K14's vocabulary is an adapter above the current approvals enforcement point. A single authoritative decision applies to direct, aliased, retried, resumed, and delegated tool calls.                                                                                                                  | A concrete action path cannot be represented by the existing approval decision without reducing safety or correctness.                             | Deny/allow matrix and one-enforcement trace for every action class; fail closed on missing context.                                                              |
| Q3 · compression              | B3 is off by default. Freeze the eligible output corpus; ship only deterministic, lossless-to-recall strategies that save at least 10% bytes on that corpus while preserving complete failures and original artifact access. Drop losing strategies.                                                   | A representative production corpus or output contract changes materially.                                                                          | Raw input/output hashes, savings distribution, failure fixture, privacy and latency results; opt-in flag and immediate rollback.                                 |
| Q4 · grammar assets           | D1 packages TS/JS only as a lazy opt-in tier. D10 requires the stated quality gate plus ≤5 MiB compressed delta, ≤2× regex and ≤2 s p95 indexing on the fixed 200-file fixture, and ≤256 MiB incremental peak RSS. D3 adds languages individually.                                                     | A measured language shows enough value to justify a reviewed budget change; no global 12-grammar payload is assumed.                               | Reproducible manifest and hashes, repeated two-tier table and missing-asset fallback.                                                                            |
| Q5 · retention                | R7 uses Option B now: label `retention.ts` unconsumed/experimental and correct `strength()` semantics. C2 owns baseline recall evidence; C3 cannot silently enable destructive retention.                                                                                                              | An opt-in policy improves the frozen recall/storage fixture without loss of pinned data and survives restart/rollback tests.                       | Consumer inventory, fixture diff, write/latency table and flag owner.                                                                                            |
| Q6 · visual tokens            | Fix measured contrast and component defects incrementally in F8. F10a measures live token drift; F10b is conditional: its first component family must cut hard-coded color sites by ≥50%, introduce no contrast failure, and have zero unreviewed screenshot differences in normal/dark/mobile states. | Representative migration cannot meet those limits or later components have different needs.                                                        | Site count, contrast receipts, screenshot review and rollback per component.                                                                                     |
| Q7 · findings identity        | Workspace findings and server-project findings stay separate authorities by default. R0/R2a share a validated durable store contract, not a file path. R2d migration is conditional on an authenticated workspace↔project binding.                                                                     | Product identity gains a trusted persistent binding and migration benefits exceed conflict/leak risk.                                              | Dry-run identity map, ownership checks, conflict list, restart and byte-exact rollback.                                                                          |
| Q8 · retention and corruption | Acknowledged writes are durable; corrupt or unsupported stores enter read-only recovery. Eviction is an explicit bounded archive policy, not a promise of infinite retention.                                                                                                                          | Storage budgets or legal retention requirements change.                                                                                            | Fault-injection matrix, raw export, archive/recovery documentation and no-success-on-write-failure tests.                                                        |
