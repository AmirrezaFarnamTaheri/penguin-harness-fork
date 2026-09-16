# Technical Design Specification: 4-Pillar Backend Web Cockpit Suite

**Date:** 2026-09-14  
**Status:** Approved Intent  
**Target Repository:** `@prismshadow/penguin-web`  
**Related Backend Services:**
- `packages/server/src/services/memory-service.ts`
- `packages/server/src/services/model-key-health.ts`
- `packages/server/src/services/trace-service.ts` & `trace-index.ts`
- `packages/server/src/services/snapshot-service.ts` & `session-service.ts`

---

## 1. Executive Summary & Problem Statement

While `@prismshadow/penguin-web` recently acquired first-class interfaces for Codebase Topology, Shell Guardian, Quorum Consensus, and Context Breakdown, four critical backend runtime services in `penguin-harness` still operate as opaque or under-visualized subsystems:

1. **Agent Long-Term Memory (`memory-service.ts`)**: Manages User and Workspace memory scopes, Markdown topic files, and `MEMORY.md` indexes. Operators currently lack visual topic graph exploration, semantic recall search simulation, frontmatter editing, and memory compaction/pruning controls.
2. **Model Key Fleet & Resilient Failover (`model-key-health.ts`)**: Tracks live key health, cooldown timers, success/failure counts, active leases, and eviction states. Operators lack real-time key fleet cards, latency heatmaps, probe execution, and manual failover overrides.
3. **Deep Execution Spans & Flamegraphs (`trace-service.ts`)**: Captures hierarchical execution spans (sessions, sub-agents, tool calls, model segments, token trends). Operators need an interactive waterfall timeline, millisecond latency attribution (TTFT vs execution), and causal failure tree diagnostics.
4. **Session Time-Travel & State Snapshots (`snapshot-service.ts`)**: Produces `.tar.gz` archives of `agent_state/` across version increments. Operators lack visual checkpoint timelines, side-by-side state diffing, one-click time-travel rollbacks with safety guards, and session branching.

This specification defines the comprehensive architecture and implementation plan to deliver a unified, enterprise-grade Web Cockpit suite for all 4 capability pillars.

---

## 2. Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
|                                CENTRAL AGENT COCKPIT                              |
|   (/agent/cockpit - Live Telemetry, Mini Health Badges, Quick-Action Launchers)   |
+---------+--------------------+---------------------+--------------------+---------+
          |                    |                     |                    |
          v                    v                     v                    v
+--------------------+ +---------------------+ +--------------------+ +--------------------+
|     PILLAR 1       | |      PILLAR 2       | |      PILLAR 3      | |      PILLAR 4      |
|  Agent Memory      | |  Model Key Fleet    | | Execution Traces   | | State Rewind       |
|  Vault & Graph     | |  & Failover Health  | |  & Flamegraphs     | | & Checkpoints      |
|  (/memory)         | |  (/models/keys)     | |(/traces/flamegraph)| | (/snapshots)       |
+--------------------+ +---------------------+ +--------------------+ +--------------------+
| - Topic Graph      | | - Live Key Cards    | | - Waterfall Canvas | | - Version Timeline |
| - Markdown Studio  | | - Cooldown Timers   | | - Latency Breakout | | - State Diffing    |
| - Recall Simulator | | - Manual Overrides  | | - Causal Error Tree| | - Dual Rollback    |
| - Scope Switcher   | | - Latency Probes    | | - Token Attribution| | - Archive I/O      |
+--------------------+ +---------------------+ +--------------------+ +--------------------+
          ^                    ^                     ^                    ^
          |                    |                     |                    |
+---------+--------------------+---------------------+--------------------+---------+
|                                BACKEND API GATEWAY                                |
|   (/api/agent/memory, /api/models/health, /api/traces/spans, /api/snapshots)      |
+-----------------------------------------------------------------------------------+
```

### Shared UI Component Standards
- **Font & Control Sizing**: Strict adherence to `size="sm"` on all form controls (`Input`, `Select`, `Button`) without hardcoding `className="text-xs"`, preserving accessibility scaling.
- **Color Tokens**: Zero raw hex values or arbitrary Tailwind palettes (`bg-[#123]`); use standard design system semantic classes (`bg-card`, `text-foreground`, `border-border`, `text-muted-foreground`, `bg-destructive/10`, `text-destructive`).
- **Responsive Layout**: Resilient grid & flex structures supporting full-screen views, split-pane drawers, and dockable side panels.

---

## 3. Detailed Component Specifications by Pillar

### Pillar 1: Agent Memory Vault & Semantic Knowledge Studio (`/memory`)

#### Functional Capabilities
1. **Interactive Topic Knowledge Graph**:
   - Canvas/SVG visualizer displaying memory topic nodes grouped by scope (`User` vs `Workspace`).
   - Visual edges connecting cross-referenced topic files parsed from Markdown links `](<topic>)`.
   - Node sizing proportional to memory file size and access frequency.
2. **Slide-Over Markdown & Frontmatter Studio**:
   - In-app markdown editor with YAML frontmatter syntax highlighting and validation.
   - Live index synchronization ensuring edits in topic files maintain `MEMORY.md` index invariants.
   - Scope directory switcher with real-time file creation, renaming, and atomic deletion.
3. **Semantic Recall Simulator & Vector Inspector**:
   - Query input simulator to test how a prospective agent prompt matches against memory topics.
   - Relevance score meters, token consumption gauges per matched topic, and similarity threshold filters.
   - Bulk pruning and consolidation actions for obsolete or redundant memories.

#### Key Files
- `packages/web/src/features/memory/memory-page.tsx`
- `packages/web/src/features/memory/memory-graph-canvas.tsx`
- `packages/web/src/features/memory/memory-document-studio.tsx`
- `packages/web/src/features/memory/memory-recall-simulator.tsx`
- `packages/web/src/features/memory/memory-types.ts`

---

### Pillar 2: Model Key Fleet & Resilient Failover Console (`/models/keys`)

#### Functional Capabilities
1. **Live Key Health Cards & Matrix**:
   - Cards displaying masked keys (`sk-...4x9q`), status tags (`healthy`, `cooldown`, `evicted`), and active lease counts.
   - Dynamic countdown timers for keys currently in cooldown (`cooldownRemainingMs`).
   - Visual success/failure ratio bars and lifetime invocation counters.
2. **Operational Controls & Circuit Breakers**:
   - Manual override buttons: "Revive Key", "Force Cooldown", and "Evict Key".
   - Pool rotation strategy switcher (Round Robin, Least Leases, Priority Weighted).
   - "Test Probe" action executing live latency checks against provider endpoints with response time badges.
3. **Provider Quota & Spend Badges**:
   - Aggregated health score (percentage of pool healthy) and provider load indicators.

#### Key Files
- `packages/web/src/features/models/models-key-fleet-page.tsx`
- `packages/web/src/features/models/key-health-card.tsx`
- `packages/web/src/features/models/key-probe-modal.tsx`
- `packages/web/src/features/models/key-fleet-types.ts`

---

### Pillar 3: Deep Execution Waterfall & Flamegraph Profiler (`/traces/flamegraph`)

#### Functional Capabilities
1. **Hierarchical Waterfall & Flamegraph Canvas**:
   - Visual waterfall timeline representing nested execution spans:
     `Session -> SubAgent Run -> Tool Execution -> Model Segment`.
   - Millisecond-precision duration bars with color-coded phases:
     - Blue: Model time-to-first-token (TTFT)
     - Cyan: Token stream generation duration
     - Amber: Tool execution / shell latency
     - Red: Error / retry backoff
2. **Causal Failure Tree & Error Diagnostics**:
   - Expandable causality chain highlighting the exact sequence of events leading to any failure.
   - Inline inspector displaying error stack traces, tool inputs/outputs, and exit codes.
3. **Span Token Attribution**:
   - Per-span token metrics: prompt tokens, completion tokens, cache-read hits, and estimated cost.

#### Key Files
- `packages/web/src/features/traces/trace-flamegraph-page.tsx`
- `packages/web/src/features/traces/waterfall-canvas.tsx`
- `packages/web/src/features/traces/causal-error-tree.tsx`
- `packages/web/src/features/traces/span-detail-drawer.tsx`
- `packages/web/src/features/traces/flamegraph-types.ts`

---

### Pillar 4: Session Time-Travel & Snapshot Rewind Studio (`/snapshots`)

#### Functional Capabilities
1. **Checkpoint Version Timeline & State Tree**:
   - Chronological branch and checkpoint timeline displaying all snapshot versions (`v1`, `v2`, `v3`...).
   - Checkpoint metadata cards: timestamp, uncompressed size, trigger source (manual, pre-import, prompt milestone).
2. **Side-by-Side State Diffing**:
   - Visual diff comparison between any selected snapshot and the current active agent state.
   - Category diffs for System Prompts, Memory Files, Skills, and Configurations.
3. **Dual-Mode Time-Travel Engine**:
   - **In-Place Revert**: Replaces active state with snapshot (automatically creating a pre-revert safety backup snapshot).
   - **Branch to New Session**: Forks a clean, independent session from the historical checkpoint without mutating the current session.
   - Archive Import/Export: Drag-and-drop `.tar.gz` package uploader and one-click archive downloader.

#### Key Files
- `packages/web/src/features/snapshots/snapshots-page.tsx`
- `packages/web/src/features/snapshots/snapshot-timeline.tsx`
- `packages/web/src/features/snapshots/snapshot-diff-viewer.tsx`
- `packages/web/src/features/snapshots/snapshot-types.ts`

---

### Pillar 5: Unified Cockpit & Navigation Integration

1. **Central Agent Cockpit (`agent-cockpit.tsx`)**:
   - Incorporate live telemetry widgets for all 4 pillars:
     - Memory: Active topic count, total indexed bytes, recent memory update.
     - Key Fleet: Overall pool health (e.g. `94% Healthy`, `2 in Cooldown`), active leases.
     - Traces: Average span latency (TTFT, generation), last error span status.
     - Snapshots: Current version badge (`v4`), time since last snapshot, quick-snapshot button.
2. **Sidebar & Layout Navigation (`sidebar.tsx`, `app-layout.tsx`, `router.tsx`)**:
   - Register routes under `/memory`, `/models/keys`, `/traces/flamegraph`, and `/snapshots`.
   - Add dedicated navigation items with semantic icons (`Brain`, `KeyRound`, `Flame`, `History`).
3. **Dock Panels (`dock-state.ts`, `panel-meta.tsx`)**:
   - Register dock panels for fast multi-tasking across all 4 pillars.

---

## 4. Staged Implementation Plan

The implementation proceeds in 4 sequential, independently testable phases:

| Phase | Target Pillar | Scope | Verification Gate |
|---|---|---|---|
| **Phase 1** | **Memory Studio** | `/memory` routes, topic graph, markdown studio, recall simulator | Vitest unit tests, accessibility control checks, typecheck clean |
| **Phase 2** | **Key Fleet Console** | `/models/keys`, key cards, cooldown timers, manual overrides | Vitest unit tests, countdown timer logic tests, typecheck clean |
| **Phase 3** | **Trace Flamegraphs** | `/traces/flamegraph`, waterfall canvas, causal error tree, span metrics | Vitest unit tests, span calculation tests, typecheck clean |
| **Phase 4** | **Snapshot Rewind** | `/snapshots`, version timeline, state diffing, dual rollback/branching | Vitest unit tests, diff parsing tests, typecheck clean |
| **Phase 5** | **Unified Integration** | `agent-cockpit.tsx` widgets, dock panels, sidebar routes, e2e test pass | 100% full test suite pass, 0 typecheck errors across all 25 workspace projects |

---

## 5. Verification & Acceptance Criteria

1. **Unit & Integration Tests**:
   - All newly created components must have comprehensive Vitest test coverage in `packages/web/test/`.
   - The entire test suite must pass (`pnpm --filter @prismshadow/penguin-web test --run`).
2. **Control Sizing Compliance**:
   - All form controls in the new components must strictly satisfy `test/control-size.test.ts` (using `size="sm"` rather than `className="text-xs"`).
3. **Monorepo Typecheck Integrity**:
   - Zero errors across all 25 monorepo projects (`pnpm run typecheck`).
4. **Git Safety Invariants**:
   - All changes committed strictly on the feature branch `feat/cockpit-topology-guardian-consensus` or dedicated follow-up branch on the user's fork.
   - Zero operations targeting or modifying `upstream`.

---

## 6. Runtime Containment, Security & Subsystem Truthfulness Demarcation

### 6.1 Platform Containment Boundaries & Secret Isolation
The sandbox execution layer in `packages/core/src/environment/sandbox-provider.ts` adapts across target operating systems with explicit, platform-appropriate security boundaries:
- **Linux**: Kernel-enforced unprivileged user namespaces and filesystem isolation via Bubblewrap (`bwrap`), mounting read-only system paths, isolated ephemeral `/tmp`, and optional network namespace isolation.
- **macOS**: Kernel-level mandatory access control via Seatbelt profiles executed through `/usr/bin/sandbox-exec`.
- **Windows**: Process-level containment via direct executable invocation without shell interpolation (`cmd.exe /c` or PowerShell escaping bypassed via explicit argv token arrays). The child environment is strictly isolated using `SAFE_BASELINE_ENV_KEYS` (allowing only OS baseline paths such as `SystemRoot`, `TEMP`, `PATH`, and `USERPROFILE`). Process-global server secrets, OAuth tokens, session cookies, and API keys present in the parent `process.env` are stripped before spawn.

### 6.2 Static Topology & Dependency Analysis vs AST Compilers
The codebase graph analyzer (`packages/core/src/agent/code-graph.ts` and `code-graph-watcher.ts`) provides lightweight, near-instantaneous static topology and module dependency extraction:
- Uses fast regex-guided scanners and module import/export dependency resolution rather than heavyweight multi-language abstract syntax tree (AST) compiler pipelines (such as Tree-sitter or TypeScript Language Server daemons).
- Avoids compiler startup overhead and large memory footprints, enabling sub-10ms incremental topology updates and change event notifications over 10,000+ file codebases.

### 6.3 Turn Ledger & Session Durability Boundaries
The `TurnLedger` (`packages/core/src/agent/turn-ledger.ts`) records deliberation turns, consensus votes, refutations, and artifact snapshots:
- Operates in-memory scoped to an active agent task and session ID (`sessionId`).
- Designed for rapid turn replay, audit inspection, and loop detection during execution.
- Durability across process restarts is achieved through the Session and Snapshot services (`session-service.ts` and `snapshot-service.ts`), which serialize and archive checkpoint states to disk.

### 6.4 Multi-Project Isolation & Access Control
All Cockpit services enforce strict project-level isolation:
- **WebSocket Streams**: Upgrades validate user session credentials and require verified project membership (`requireProjectAccess`). Broadcast events (`swarm_event`, `key_fleet_update`, `topology_change`) are routed exclusively to client connections authorized for that specific `projectId`.
- **REST Endpoints**: Every `/api/cockpit/*` route verifies project access. Commands, directives, and autonomous swarm tasks execute within the target project's workspace directory with its authoritative security command policy applied.
- **Key Fleet Telemetry**: Telemetry reflects truthful configuration from `.project_config.toml`. Projects without configured credentials render an explicit empty state rather than synthetic keys. Manual overrides and probes are fail-closed.

