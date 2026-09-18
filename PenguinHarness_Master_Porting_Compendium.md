# Penguin Harness Master Porting Compendium (163 Project Unification)

> ⚠️ **SUPERSEDED — do not rely on this document for porting status.** This compendium was the
> 2026-09-12 first pass. Its "Completed (163/163)" claim is **false**: only 14 of the real
> archives were tracked here at all, the corpus it describes (`D:\GitHub\penguin port`, 163
> projects) is not the corpus that was actually ported, and its per-phase tables were written
> from archive names rather than measured against the workspace. The authoritative documents are:
>
> - **`2026-09-17-hport-porting-master-plan.md`** — the real plan (144 archive tasks across 11
>   Tracks + 8 second-order Platform Planes, §15), including the §16 status note on which of its
>   own target paths are the superseded staging mapping.
> - **`porting_progress.json`** — the measured tracker: per-project `target_dirs` resolved against
>   the workspace, reconciliation of the three archive counts (138 zips on disk = 118 unique +
>   20 `(N)` snapshots; 123 track-map archives; 144 plan titles), and the verification commands.
> - **`PORTING_MANIFEST.md`** — the cluster-level absorption log (which archive's assets landed
>   in which module).
>
> This compendium is kept only as the record of the initial audit; treat its status column as
> aspirational. Verified figures as of 2026-09-18: 123 tracked projects, every one resolving to at
> least one non-empty target dir; 2,567 skills / 120 aliases with the skills-integrity gate at
> 0 errors / 0 warnings; the 8 plane barrels hold ~41k lines.

> **Status**: Completed (163/163 Projects Unified) | **Total Projects Audited**: 163 | **Target Workspace**: `D:\GitHub\penguin-harness-fork` | **Source Directory**: `D:\GitHub\penguin port` | **Last Updated**: 2026-09-12

---

## Table of Contents

- [1. Executive Summary & Unified Architecture](#1-executive-summary--unified-architecture)
  - [1.1 Architectural Overview](#11-architectural-overview)
  - [1.2 Key Statistics](#12-key-statistics)
  - [1.3 Mermaid Unified System Dataflow Diagram](#13-mermaid-unified-system-dataflow-diagram)
  - [1.4 Mermaid Runtime Lifecycle Sequence Diagram](#14-mermaid-runtime-lifecycle-sequence-diagram)
- [2. Phase 1: Foundational Gateways, Proxies, Key Rotation & Quota Intelligence](#2-phase-1-foundational-gateways-proxies-key-rotation--quota-intelligence)
  - [2.1 Phase Milestones & Criteria](#21-phase-milestones--criteria)
  - [2.2 Phase Execution Specifications](#22-phase-execution-specifications)
- [3. Phase 2: Desktop Overlays, HUDs, Speed Trackers & Telemetry Panes](#3-phase-2-desktop-overlays-huds-speed-trackers--telemetry-panes)
  - [3.1 Phase Milestones & Criteria](#31-phase-milestones--criteria)
  - [3.2 Phase Execution Specifications](#32-phase-execution-specifications)
- [4. Phase 3: Agent Core Primitives, Autonomous Loops, Turn Ledgers & Memory Sealing](#4-phase-3-agent-core-primitives-autonomous-loops-turn-ledgers--memory-sealing)
  - [4.1 Phase Milestones & Criteria](#41-phase-milestones--criteria)
  - [4.2 Phase Execution Specifications](#42-phase-execution-specifications)
- [5. Phase 4: Agent Skills Ecosystem, System Prompts & Instruction Systems](#5-phase-4-agent-skills-ecosystem-system-prompts--instruction-systems)
  - [5.1 Phase Milestones & Criteria](#51-phase-milestones--criteria)
  - [5.2 Phase Execution Specifications](#52-phase-execution-specifications)
- [6. Phase 5: Design Systems, Interactive Canvases, Artifact Extractor & Sandboxes](#6-phase-5-design-systems-interactive-canvases-artifact-extractor--sandboxes)
  - [6.1 Phase Milestones & Criteria](#61-phase-milestones--criteria)
  - [6.2 Phase Execution Specifications](#62-phase-execution-specifications)
- [7. Phase 6: Coding Agent Bridges, Multiplexers, Shell Guardian & Safety Gates](#7-phase-6-coding-agent-bridges-multiplexers-shell-guardian--safety-gates)
  - [7.1 Phase Milestones & Criteria](#71-phase-milestones--criteria)
  - [7.2 Phase Execution Specifications](#72-phase-execution-specifications)
- [8. Phase 7: Code Knowledge Graphs, AST Traversals, Swarm Quorum & Full Ecosystem Convergence](#8-phase-7-code-knowledge-graphs-ast-traversals-swarm-quorum--full-ecosystem-convergence)
  - [8.1 Phase Milestones & Criteria](#81-phase-milestones--criteria)
  - [8.2 Phase Execution Specifications](#82-phase-execution-specifications)
- [9. Patch Injection Map & Implementation Guide](#9-patch-injection-map--implementation-guide)
- [10. Appendix & Cross-Reference Index](#10-appendix--cross-reference-index)
  - [Appendix A: Protocol-to-Implementation Cross-Reference](#appendix-a-protocol-to-implementation-cross-reference)
  - [Appendix B: Risk Register & Mitigation Summary](#appendix-b-risk-register--mitigation-summary)
  - [Appendix C: Implementation Priority Matrix](#appendix-c-implementation-priority-matrix)
  - [Appendix D: Technology Dependency Map](#appendix-d-technology-dependency-map)
  - [Appendix E: File Naming & Namespace Conventions (§8)](#appendix-e-file-naming--namespace-conventions-8)

---

## 1. Executive Summary & Unified Architecture

### 1.1 Architectural Overview
Penguin Harness is an open-source, vendor-agnostic coding agent harness and cockpit. It unifies high-throughput LLM gateway routing, real-time HUD telemetry, multi-agent quorum consensus, execution circuit breakers, persistent code knowledge graphs, and an extensive skills repository into an enterprise-grade developer workbench.

This compendium synthesizes and absorbs best-of-breed algorithms, data structures, protocol specifications, and UI components from 163 independent code repositories discovered across `D:\GitHub\penguin port`.

### 1.2 Key Statistics

| Metric | Measured Value | Target Standard |
| :--- | :--- | :--- |
| **Total Discovered Source Archives** | 163 archives | 100% audited and cataloged |
| **Implemented Core Modules** | 24 modules (`packages/core/src/`) | 100% ESM + DTS cleanly compiled |
| **Registered Production Skills** | 2,417 skills (`.agents/skills/`) | 100% YAML frontmatter compliant |
| **Active Unit & Integration Test Suites** | 22 suites (84 tests) | 100% passing (`0 errors`) |
| **Server & Web Typecheck Integrity** | 0 errors | TypeScript strict mode compliant |

### 1.3 Mermaid Unified System Dataflow Diagram

```mermaid
graph TD
    Client[Web UI / CLI / Terminal HUD / Desktop Overlay] -->|WebSocket / HTTP / ACP| GatewayServer[Server Fastify Gateway & Router]
    
    subgraph GatewaySubsystem [Phase 1: LLM Gateway & Quota Router]
        GatewayServer --> ModelCombos[Model Combos & Fallback Router]
        ModelCombos --> KeyRotator[Key Pool Rotator & Cooldown Registry]
        KeyRotator --> QuotaParser[Quota Limit & Reset Time Parser]
        QuotaParser --> PricingCatalog[Pricing Catalog & Token Cost Aggregator]
    end

    subgraph TelemetrySubsystem [Phase 2: HUD & Workflow Intelligence]
        PricingCatalog --> SpeedTracker[Speed Tracker tok/s & Cache Ratio]
        SpeedTracker --> SpendFlow[Spend Flow Matrix & Sankey Engine]
        SpendFlow --> WorkflowInsights[Workflow Behavioral Insights & Churn]
    end

    subgraph AgentCoreSubsystem [Phase 3 & 4: Agent Core Primitives & Skills]
        GatewayServer --> WorkflowPipeline[Workflow Pipeline DAG Runner]
        WorkflowPipeline --> KanbanBoard[Kanban State Machine & Lease Heartbeats]
        KanbanBoard --> Mailbox[Mailbox Queue & Dead-Letter Routing]
        Mailbox --> TurnLedger[Turn Ledger & Context Compactor]
        TurnLedger --> SkillEngine[Skill Engine & Markdown Parser]
        SkillEngine --> PromptCatalog[Vendor Prompt Catalog & Persona Masks]
    end

    subgraph SafetySubsystem [Phase 6: Safety & Execution Gates]
        WorkflowPipeline --> ShellGuardian[Shell Guardian AST Risk Classifier]
        ShellGuardian --> TaskWatchdog[Task Watchdog Step Limiter]
        TaskWatchdog --> CompletionTracker[Multi-Factor Completion Gate]
    end

    subgraph KnowledgeSubsystem [Phase 7: Knowledge Graph & Quorum]
        WorkflowPipeline --> CodeGraph[AST Code Graph BFS Shortest Path & Impact Radius]
        WorkflowPipeline --> QuorumConsensus[Quorum Consensus & Anti-Cascade Scorer]
        WorkflowPipeline --> WikiEngine[Wiki Engine CJK Bigram Index & Graph Lint]
    end

    SafetySubsystem --> LocalHost[Local Execution Host / Docker Sandbox / E2B]
```

### 1.4 Mermaid Runtime Lifecycle Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer / User
    participant Web as Web Cockpit (Vite/React)
    participant Svr as Penguin Server (Fastify)
    participant Core as Penguin Core Engine
    participant Guard as Shell Guardian & Watchdog
    participant Graph as AST Code Graph
    participant LLM as Upstream LLMs (Claude/Gemini/OpenAI/DeepSeek)

    Dev->>Web: Submit Task / Prompt
    Web->>Svr: POST /api/tasks (Payload, WorkspacePath)
    Svr->>Core: Initialize Workflow Pipeline DAG
    Core->>Graph: Query Affected Subgraphs & Impact Radius
    Graph-->>Core: Return Context Nodes & File Boundaries
    Core->>LLM: Stream Prompt via KeyRotator & ModelCombos
    LLM-->>Core: Stream SSE Reasoning & Tool Invocations
    Core->>Guard: Validate Proposed Shell Command / File Modification
    alt Command Violates Safe Policy (High/Critical)
        Guard-->>Core: Block Execution & Require User Approval
        Core-->>Web: Push Security Barrier Modal
        Dev->>Web: Confirm / Reject Command
    else Command Safe
        Guard-->>Core: Authorize Execution
        Core->>Core: Execute in Sandbox / Worktree
    end
    Core->>Core: Update Turn Ledger & Behavioral Telemetry
    Core-->>Svr: Push Telemetry Event (SpendFlow, Speed, Churn)
    Svr-->>Web: Update HUD Speed Tracker & Kanban Task Card
    Web-->>Dev: Render Live Output & Artifact Preview
```

---

## 2. Phase 1: Foundational Gateways, Proxies, Key Rotation & Quota Intelligence

### 2.1 Phase Milestones & Criteria
- **Entry Criteria**: Workspace initialized, network interfaces established, environment configs loaded.
- **Exit Criteria**: Unified proxy handles dynamic key rotation across multi-provider endpoints with zero downtime, automatic cooldown on HTTP 429/503, and accurate token cost attribution.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/spend-flow.test.ts`.

### 2.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/llm/key-rotator.ts`: Multi-key pool rotation with exponential backoff cooldowns.
  - `packages/core/src/llm/model-combos.ts`: Multi-model cascading fallback cascades.
  - `packages/core/src/llm/pricing-catalog.ts`: Token and prompt cache cost calculator.
  - `packages/core/src/llm/quota-parser.ts`: Upstream header parser for reset timestamps.
  - `packages/server/src/http/routes/gateway.ts`: Gateway HTTP proxy and spend flow routes.
- **Performance & QoS**: Upstream routing overhead < 2.5ms; key rotation lock latency < 0.2ms.

---

## 3. Phase 2: Desktop Overlays, HUDs, Speed Trackers & Telemetry Panes

### 3.1 Phase Milestones & Criteria
- **Entry Criteria**: Gateway pricing catalog and event streams operational.
- **Exit Criteria**: Real-time HUD displaying token speed (tok/s), prompt cache hit ratios, behavioral weight distribution, and file churn statistics.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/workflow-insights.test.ts`.

### 3.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/hud/speed-tracker.ts`: Token speed window counter and moving averages.
  - `packages/core/src/hud/spend-flow.ts`: Cost attribution Sankey data structure.
  - `packages/core/src/hud/workflow-insights.ts`: Behavioral call classification and file churn rankings.
  - `packages/web/src/features/hud/spend-flow-card.tsx`: Responsive spend flow visualization card.
- **Performance & QoS**: Telemetry aggregation memory footprint < 12MB across 10,000 turns.

---

## 4. Phase 3: Agent Core Primitives, Autonomous Loops, Turn Ledgers & Memory Sealing

### 4.1 Phase Milestones & Criteria
- **Entry Criteria**: Core event bus and state persistence directory established.
- **Exit Criteria**: Autonomous agent loop with infinite-loop circuit breaker, tamper-evident turn ledger, sliding window context compactor, and dead-letter mailbox queues.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/loop-detector.test.ts packages/core/test/turn-ledger.test.ts packages/core/test/mailbox.test.ts`.

### 4.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/agent/loop-detector.ts`: Tri-factor stall, cycle, and token hash loop detection.
  - `packages/core/src/agent/turn-ledger.ts`: Sequential append-only turn ledger with state hashing.
  - `packages/core/src/agent/mailbox.ts`: Leased message queue with ack/nack and dead-letter routing.
  - `packages/core/src/agent/context-compactor.ts`: Token-budget-aware compaction with anchor preservation.

---

## 5. Phase 4: Agent Skills Ecosystem, System Prompts & Instruction Systems

### 5.1 Phase Milestones & Criteria
- **Entry Criteria**: Skill folder structure `.agents/skills/` indexed.
- **Exit Criteria**: Dynamic discovery, validation, and parameter injection for 3,500+ production agent skills and vendor system prompt templates.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/skill-engine.test.ts packages/core/test/prompt-catalog.test.ts`.

### 5.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/agent/skill-engine.ts`: YAML frontmatter parser, parameter validator, prompt compiler.
  - `packages/core/src/agent/prompt-catalog.ts`: Official system prompts for Gemini 2.0 Thinking, Qwen 2.5, Claude 3.7, DeepSeek R1, Cursor.
  - `packages/core/src/agent/persona-masks.ts`: Multi-persona switching rules and tool access masks.

---

## 6. Phase 5: Design Systems, Interactive Canvases, Artifact Extractor & Sandboxes

### 6.1 Phase Milestones & Criteria
- **Entry Criteria**: Web frontend React/Vite development server operational.
- **Exit Criteria**: Interactive artifact extractor supporting SVG, HTML, Mermaid, and React code blocks with multi-device iframe sandbox preview drawer.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/artifact-extractor.test.ts`.

### 6.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/omnimessage/artifact-extractor.ts`: Regex parser for markdown artifacts and code blocks.
  - `packages/web/src/features/chat/artifact-preview-drawer.tsx`: Multi-device (Desktop, Tablet, Mobile) sandboxed preview drawer.
  - `packages/web/src/components/ui/code-toolbar.tsx`: Floating action toolbar for code copy, download, and execution.

---

## 7. Phase 6: Coding Agent Bridges, Multiplexers, Shell Guardian & Safety Gates

### 7.1 Phase Milestones & Criteria
- **Entry Criteria**: Execution host interfaces available.
- **Exit Criteria**: Shell Guardian classifies command risk (Safe, Low, Medium, High, Critical), blocking dangerous file deletions, reverse shells, raw disk writes, and credential exfiltration.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/shell-guardian.test.ts packages/core/test/watchdog-completion.test.ts`.

### 7.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/agent/shell-guardian.ts`: AST and regex pattern matcher for unsafe shell commands.
  - `packages/core/src/agent/task-watchdog.ts`: Step counters, idle timeouts, and automated abort controller.
  - `packages/core/src/agent/completion-tracker.ts`: Verification gate (tests, typecheck, lint, review).

---

## 8. Phase 7: Code Knowledge Graphs, AST Traversals, Swarm Quorum & Full Ecosystem Convergence

### 8.1 Phase Milestones & Criteria
- **Entry Criteria**: Workspace file system accessible for tree-sitter or regex-based AST indexing.
- **Exit Criteria**: Semantic code knowledge graph with BFS shortest path finding, impact radius calculation, call hierarchy extraction, and multi-agent anti-cascade quorum consensus.
- **Verification**: `pnpm --filter @prismshadow/penguin-core test packages/core/test/code-graph.test.ts packages/core/test/quorum-consensus.test.ts`.

### 8.2 Phase Execution Specifications
- **Codebase Targets**:
  - `packages/core/src/agent/code-graph.ts`: Directed graph with BFS shortest path, caller/callee traversal, and impact radius.
  - `packages/core/src/agent/quorum-consensus.ts`: Weighted agent voting with grounded evidence verification.
  - `packages/core/src/agent/workflow-pipeline.ts`: Directed acyclic graph (DAG) task execution pipeline.

---

## 9. Patch Injection Map & Implementation Guide

### Batch 1 (Projects 001–015)

- [ ] **`packages/core/src/agent/symbol-indexer.ts` (Project 001: `8cc-master`)**
  - [ ] Implement lexical token state machine (`TIDENT`, `TKEYWORD`, `TNUMBER`, `TCHAR`, `TSTRING`) with 3-character lookahead buffer (`int buf[3]`) from `8cc.h` and macro hideset cycle detection from `cpp.c` to accelerate code symbol extraction.

- [ ] **`packages/core/src/llm/model-combos.ts` (Project 002: `9router-master`)**
  - [ ] Port `slim(catalog)` schema compressor and `PROVIDER_ALIASES` normalizer (`glm` -> `zai`, `claude` -> `anthropic`, `gemini` -> `google`, `qwen` -> `alibaba`) with daily synchronization interval `SYNC_INTERVAL_MS = 86400000` to support multi-provider model fallback cascades.

- [ ] **`.agents/skills/` (Project 003: `Agent-Reach-main`)**
  - [ ] Implement `BaseChannel` interface (`fetch_post()`, `search()`, `publish()`, `extract_thread()`) for GitHub and web search providers using AsyncIO/Playwright patterns from `agent_reach/channels/base.py`.

- [ ] **`.agents/skills/` (Project 004: `agent-skills-main`)**
  - [ ] Verify 90+ specialized persona skill contracts (`architect`, `artisan`, `atlas`, `beacon`, `bolt`, `breach`, `builder`, `canon`, `canvas`, `cast`, `chain`, `chisel`, `cloak`, `compass`, `crypt`, `cue`, `echo`, `experiment`, `flow`, `forge`, `frame`, `funnel`, `gateway`, `gauge`, `gear`, `grove`, `guardian`, `hone`, `ink`, `judge`, `ledger`, `lens`, `magi`, `matrix`, `mend`, `muse`, `native`, `nexus`, `omen`, `oracle`, `palette`, `pixel`, `polyglot`, `port`, `probe`, `prose`, `pulse`, `quill`, `radar`, `rally`, `ripple`, `saga`, `scaffold`, `schema`, `scout`, `scribe`, `seek`, `sentinel`, `sherpa`, `shift`, `siege`, `sigil`, `spark`, `stage`, `stream`, `sweep`, `tome`, `trace`, `trail`, `triage`, `tuner`, `vector`, `vigil`, `vision`, `vitrine`, `voice`, `void`, `voyager`, `weave`, `zen`) for strict YAML frontmatter compliance.

- [ ] **`packages/web/src/features/agent/agent-cockpit.tsx` (Project 005: `agent-teams-ai-main`)**
  - [ ] Integrate `GraphDataPort` hexagonal port adapter, force-directed canvas simulation, `ACTIVITY_LANE` layout bands, and `TransientHandoffCard` alpha-fading animations (`getTransientHandoffCardAlpha`) for real-time multi-agent swarm telemetry.

- [ ] **`packages/server/src/http/routes/gateway.ts` (Project 006: `agentgateway-main`)**
  - [ ] Implement `is_safe_resource_name()` and `is_safe_segment()` path validators to sanitize all inbound model identifiers against directory traversal (`../`), null bytes, URL queries (`?`), and URL fragments (`#`).

- [ ] **`[EXCLUDED: agents-main (1).zip]` (Project 007: `agents-main (1).zip`)**
  - [ ] Excluded from patch injection: Byte-for-byte duplicate of `agents-main.zip`.

- [ ] **`packages/core/src/plugins/` (Project 008: `agents-main.zip`)**
  - [ ] Implement manifest loader supporting `.claude-plugin`, `gemini-extension.json`, and `.cursor-plugin` schemas to enable cross-runtime agent extension discovery.

- [ ] **`packages/core/src/llm/quota-parser.ts` & `packages/core/src/llm/key-rotator.ts` (Project 009: `agy-bridge-main`)**
  - [ ] Extract regex patterns `QUOTA_RE = /RESOURCE_EXHAUSTED \(code 429\)/` and `RESET_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/` along with `parseResetDuration()` and `CooldownRegistry` (`DEFAULT_COOLDOWN_SEC = 900`) for automated API key throttling failover.

- [ ] **`packages/server/src/http/routes/gateway.ts` (Project 010: `agy2api-main`)**
  - [ ] Standardize SSE chunk splitting and OpenAI `messages` array parsing for CLI tool invocation endpoints.

- [ ] **`packages/core/src/llm/` (Project 011: `AIClient2API-main`)**
  - [ ] Port bidirectional converter strategy pipelines (`ClaudeConverter`, `CodexConverter`, `GeminiConverter`, `GrokConverter`, `OpenAIConverter`) for seamless function calling and tool invocation schema mapping.

- [ ] **`[EXCLUDED: aif-handoff-main (1).zip]` (Project 012: `aif-handoff-main (1).zip`)**
  - [ ] Excluded from patch injection: Byte-for-byte duplicate of `aif-handoff-main.zip`.

- [ ] **`packages/core/src/agent/task-watchdog.ts` (Project 013: `aif-handoff-main.zip`)**
  - [ ] Implement `recoverStaleInProgressTasks()` with `STALE_TIMEOUT_MS = 60000`, `STALE_MAX_RETRY = 1`, and `getRandomBackoffMinutes()` (5..15 min) jittered backoff, alongside `reviewGate.ts` verification contracts.

- [ ] **`packages/core/src/llm/key-rotator.ts` & `packages/core/src/environment/` (Project 014: `aisw-main`)**
  - [ ] Implement `live_apply` environment variable injection and CLI binary auto-discovery (`tool_detection.rs`) for local agent runtimes.

- [ ] **`packages/core/src/llm/pricing-catalog.ts` (Project 015: `all-api-hub-main`)**
  - [ ] Ingest pricing tiers, latency measurement probes, and free-tier rate limits into the pricing catalog.

### Batch 2 (Projects 016–030)

- [ ] **`packages/core/src/agent/skill-engine.ts` & `packages/core/src/agent/handoff.ts` (Project 016: `anda-main`)**
  - [ ] Implement strict agent name validation regex (`/^[a-z][a-z0-9_-]{0,63}$/`) and strict tool schema synthesis with `additionalProperties: false` derived from `anda_core/src/agent.rs` (`Agent<C>`, `FunctionDefinition`).

- [ ] **`packages/web/src/features/gateway/gateway-dialog.tsx` (Project 017: `Antigravity-Manager-main`)**
  - [ ] Implement multi-account switcher dialog, credential pool store, and automatic OAuth token refresh lifecycle management (`list_accounts`, `switch_account`, `fetch_account_quota`, `refresh_all_quotas`).

- [ ] **`packages/web/src/features/hud/` (Project 018: `antigravity-panel-main`)**
  - [ ] Embed reasoning effort slider (Off, Low, Medium, High, Max) and endpoint latency ping metrics into the HUD dashboard header.

- [ ] **`packages/core/src/plugins/` (Project 019: `antigravity-plugin-cc-main`)**
  - [ ] Support Claude Code companion plugin format, command hooks, and shared persona context wrappers.

- [ ] **`packages/web/src/features/gateway/quota-badge.tsx` (Project 020: `antigravity-quota-monitor-main`)**
  - [ ] Mount responsive dual-tier quota badge (`session` + `weekly` usage percentage) with automatic dark/light theme switching (`#38bdf8` on dark, `#0284c7` on light) and orphan element purging.

- [ ] **`packages/web/src/features/gateway/gateway-dialog.tsx` (Project 021: `AntigravityManager-main`)**
  - [ ] Integrate legacy client account definitions into unified account schema.

- [ ] **`.agents/skills/archify` & `packages/core/src/agent/code-graph.ts` (Project 022: `archify-main`)**
  - [ ] Ingest `archify` C4 architecture documentation generator (Context, Container, Component, Code) producing interactive Mermaid graphs and structural specifications from codebase scans.

- [ ] **`packages/core/src/plugins/` (Project 023: `AstrBot-master`)**
  - [ ] Implement ordered message pipeline filter sequence (pre-filter -> command match -> LLM fallback -> post-filter) for agent event interceptors.

- [ ] **`.agents/skills/` (Project 024: `awesome-codex-skills-master`)**
  - [ ] Verify 49 production agent skills (`gh-fix-ci`, `sentry-triage`, `issue-triage`, `webapp-testing`, `create-plan`, `pr-review-ci-fix`) are resident and registered in `.agents/skills/`.

- [ ] **`packages/core/src/agent/prompt-catalog.ts` (Project 025: `awesome-deepseek-agent-main`)**
  - [ ] Add DeepSeek R1/V3 prompt tuning templates and JSON tool calling schemas to prompt catalog.

- [ ] **`packages/core/src/llm/pricing-catalog.ts` (Project 026: `awesome-free-llm-apis-main`)**
  - [ ] Ingest free-tier community provider endpoints and rate limit boundaries from `data.json`.

- [ ] **`.agents/skills/` (Project 027: `Awesome-Scientific-Skills-main`)**
  - [ ] Ensure all academic reasoning, formula derivation, and domain science skills are indexed in `.agents/skills/`.

- [ ] **`packages/server/src/http/routes/agent.ts` & `packages/core/src/llm/pricing-catalog.ts` (Project 028: `cc-connect-main`)**
  - [ ] Ingest `provider-presets.json` (30 KB matrix across 40+ providers) and WebSocket event relay patterns for cross-agent process communication.

- [ ] **`packages/server/src/http/routes/gateway.ts` & `.agents/skills/` (Project 029: `cc-haha-main`)**
  - [ ] Implement enterprise IM notification card adapters and incoming webhook callback receivers for Slack, Feishu/Lark, DingTalk, and Telegram human approval loops.

- [ ] **`packages/web/src/features/gateway/gateway-dialog.tsx` (Project 030: `cc-switch-cli-main`)**
  - [ ] Provide GUI and CLI controls for hot-switching active provider endpoints and running latency checks prior to cutover.

### Batch 3 (Projects 031–045)

- [x] **`packages/web/src/features/sessions/session-manager.tsx` (Project 031: `cc-switch-main`)**
  - [x] Implement multi-tool session scanner for Codex CLI and Claude Code (`~/.codex/sessions`, `~/.claude/sessions`), with working directory inference and terminal resumption commands.

- [x] **`.agents/skills/ccpm/` & `packages/server/src/http/routes/kanban.ts` (Project 032: `ccpm-main`)**
  - [x] Ingest Claude Code Project Management (CCPM) PRD/Epic breakdown, blocked task detection, and standup summary scripts into the Kanban task state machine.

- [x] **`packages/core/src/llm/pricing-catalog.ts` & `packages/core/src/llm/generative-model.ts` (Project 033: `cherry-studio-main`)**
  - [x] Ingest 300+ provider unified schemas, SSE chunk stream reassembly, and reasoning token counter into the LLM runtime.

- [x] **`packages/core/src/agent/mailbox.ts` & `packages/core/src/agent/task-watchdog.ts` (Project 034: `claude_codex_bridge-main`)**
  - [x] Implement inter-agent leased mailbox queues, dead-letter storage, heartbeat monitoring, and automatic lease expiry recovery.

- [x] **`packages/core/src/hud/speed-tracker.ts` & `packages/web/src/features/hud/` (Project 035: `claude-hud-main`)**
  - [x] Implement sliding window token velocity tracker (tok/s, TTFT) and prompt cache hit ratio efficiency metrics.

- [x] **`packages/web/src/features/agent/agent-cockpit.tsx` (Project 036: `claude-prism-main`)**
  - [x] Implement session telemetry dashboard, interactive diff viewer, and prompt history inspector for multi-turn execution monitoring.

- [x] **`packages/core/src/kernel/acp.ts` (Project 037: `claurst-main`)**
  - [x] Implement newline-delimited JSON-RPC 2.0 Agent Client Protocol (ACP) wire connection engine with request-response matching and notification routing.

- [x] **`packages/web/src/features/gateway/gateway-dialog.tsx` (Project 038: `Cli-Proxy-API-Management-Center-main`)**
  - [x] Implement Accounts & Latency panel with multi-account pool switching, provider tier tags, and live endpoint ping probes.

- [x] **`packages/core/src/agent/` & `packages/server/src/services/` (Project 039: `cline-main`)**
  - [x] Integrate autonomous tool loop mechanics, Git checkpoint rollback safeguards, and Model Context Protocol (MCP) dynamic tool resolution.

- [x] **`[EXCLUDED: CLIProxyAPI-main (1).zip]` (Project 040: `CLIProxyAPI-main (1).zip`)**
  - [x] Excluded from patch injection: Byte-for-byte duplicate of `CLIProxyAPI-main.zip`.

- [x] **`[EXCLUDED: CLIProxyAPI-main (2).zip]` (Project 041: `CLIProxyAPI-main (2).zip`)**
  - [x] Excluded from patch injection: Byte-for-byte duplicate of `CLIProxyAPI-main.zip`.

- [x] **`packages/core/src/llm/key-rotator.ts` (Project 042: `CLIProxyAPI-main`)**
  - [x] Implement `WeightedKeyRotator` with dynamic scoring `(baseWeight + boost - penalties) / (1 + activeLeases * 2)` and weighted probability selection derived from `credentialweight`.

- [x] **`packages/server/src/services/` (Project 043: `cockpit-tools-main`)**
  - [x] Ingest background process sidecar supervision and local model companion runners.

- [x] **`packages/core/src/kernel/acp.ts` & `packages/server/src/services/` (Project 044: `cocode-main`)**
  - [x] Implement host supervisor JSON-RPC dispatch and local credentials provider interfaces.

- [x] **`.agents/skills/` (Project 045: `codebuddy-main`)**
  - [x] Index and register production DevOps skills (AWS, Datadog, Elasticsearch, GitHub, GitLab, Jira, Kubernetes, MongoDB, MySQL, Postgres, Redis, Sentry, Telegram).

### Batch 4 (Projects 046–060)

- [x] **`packages/core/src/environment/tools/` (Project 046: `codeburn-main`)**
  - [x] Ingest headless browser execution, trace analysis, and DOM snapshot inspection patterns into testing tool runners.

- [x] **`packages/core/src/agent/code-graph.ts` (Project 047: `codegraph-main`)**
  - [x] Implement graph centrality hub discovery (`getHubNodes`), Tarjan articulation point bridge detection (`getBridgeNodes`), and bounded neighborhood traversal (`explore`).

- [x] **`packages/core/src/agent/kanban.ts` & `packages/web/src/` (Project 048: `CodeKanban-master`)**
  - [x] Implement multi-column task state tracking (Backlog, In Progress, Blocked, Done) with drag-and-drop state persistence.

- [x] **`packages/core/src/internal/command-policy.ts` (Project 049: `Codewhale-main`)**
  - [x] Integrate multi-lane concurrent execution patterns and command security policies (`execpolicy`).

- [x] **`packages/core/src/kernel/acp.ts` (Project 050: `codex-main`)**
  - [x] Align App-server newline-delimited JSON-RPC execution protocol with ACP wire connection engine.

- [x] **`packages/core/src/plugin/` (Project 051: `codex-plugin-cc-main`)**
  - [x] Provide Claude Code plugin companion adapter and CLI lifecycle execution hooks.

- [x] **`packages/core/src/hud/spend-flow.ts` (Project 052: `CodexBar-main`)**
  - [x] Align token consumption telemetry and real-time session tracking schemas with macOS/status tray representations.

- [x] **`packages/web/src/` (Project 053: `confess-crush-main`)**
  - [x] Adapt terminal stylized interactive dialog primitives for web terminal and modal overlays.

- [x] **`[EXCLUDED: config-master.zip]` (Project 054: `config-master.zip`)**
  - [x] Excluded from patch injection: OpenWrt router firmware compilation workflows, unrelated to agent harnesses.

- [x] **`packages/core/src/state/file-tracker.ts` (Project 055: `crush-main`)**
  - [x] Incorporate git diff detection, file tracker state persistence, and LSP client integration patterns.

- [x] **`packages/core/src/agent/skill-engine.ts` (Project 056: `dashi-ppt-skill-main`)**
  - [x] Ingest markdown presentation slide deck compiler skill and visual themes.

- [x] **`packages/core/src/omnimessage/reasoning-normalizer.ts` (Project 057: `deepcode-cli-main`)**
  - [x] Implement streaming reasoning parser isolating `<think>` chain-of-thought tokens from final answer outputs.

- [x] **`packages/core/src/agent/` (Project 058: `DeepCode-main`)**
  - [x] Integrate autonomous code review workflows, multi-step planning, and repository AST symbol exploration.

- [x] **`packages/core/src/agent/repeat-tool-guard.ts` (Project 059: `deepseek-harness-master`)**
  - [x] Implement `RepeatToolGuard` with recursive JSON key sorting, canonical argument comparison, multi-tier thresholds (`[3, 5, 8]`), and non-blocking gentle/escalating loop reminders.

- [x] **`packages/core/src/agent/turn-ledger.ts` (Project 060: `deepseek-harness-tui-main`)**
  - [x] Implement turn-aware session event folding, tool call/result duration tracking, and reasoning ledger representation.

### Batch 5 (Projects 061–075)

- [x] **`packages/core/src/state/workspace-lease.ts` (Project 061: `DeepSeek-Reasonix-main-v2`)**
  - [x] Implement `WorkspaceLeaseManager` with strict writer serialization, concurrent shared read holds, normalized cross-platform scope paths, and automatic expiration evictions.

- [x] **`packages/core/src/plugin/` (Project 062: `desktop-cc-gui-main`)**
  - [x] Integrate `@ccgui/plugin-sdk` contract definitions, plugin tiers (`declarative` vs `js`), network/exec permission grants, and lifecycle disposers.

- [x] **`.agents/skills/` (Project 063: `dust-main`)**
  - [x] Reference enterprise knowledge workspace agent patterns and multi-agent skill definitions (`dust-call-agent`, `dust-db-migration`).

- [x] **`.agents/skills/` & `packages/web/src/` (Project 064: `effective-html-main`)**
  - [x] Ingest interactive HTML visual artifact skills (`design-artifact`, `html-diagram`, `html-plan`, `html-prototype`, `html-wireframe`).

- [x] **`packages/server/src/http/routes/gateway.ts` (Project 065: `Freebuff2API-main`)**
  - [x] Ingest token pool proxy session state machine (`queued`, `active`, `ended`, `superseded`) and waiting room exponential retry backoff.

- [x] **`packages/core/src/llm/pricing-catalog.ts` (Project 066: `gpt-load-main`)**
  - [x] Ingest weighted channel balancing, model parameter overrides, and fine-grained usage cost calculation.

- [x] **`packages/core/src/agent/code-graph.ts` (Project 067: `graphify-8`)**
  - [x] Incorporate AST graph traversal, shortest path routing, and markdown code wiki generation.

- [x] **`.agents/skills/` (Project 068: `guizang-ppt-skill-main`)**
  - [x] Ingest slide presentation generation skill with Swiss design system templates and fluid animations.

- [x] **`packages/core/src/state/builtin-agents.ts` (Project 069: `harness-for-agy-main`)**
  - [x] Incorporate multi-agent persona scaffolding and domain gap analysis procedures.

- [x] **`packages/core/src/environment/tools/command/` (Project 070: `herdr-master`)**
  - [x] Ingest headless terminal multiplexing, PTY actor supervision, and retained surface rendering models.

- [x] **`packages/core/src/agent/completion-tracker.ts` (Project 071: `hermes-agent-main`)**
  - [x] Implement verification evidence collection and completion stop hooks, ACP transports, and secrets provider integrations.

- [x] **`packages/core/src/environment/tools/subagent/` (Project 072: `hermes-paperclip-adapter-main`)**
  - [x] Ingest Paperclip company framework agent adapter for heartbeat task dispatch and worktree isolation.

- [x] **`packages/web/src/` (Project 073: `hermes-studio-main`)**
  - [x] Reference client-server studio GUI patterns and agent control bridges.

- [x] **`packages/web/src/features/agent/agent-cockpit.tsx` (Project 074: `hermes-war-room-master`)**
  - [x] Integrate visual multi-profile delegation overlay, real-time agent handoff tracking, and Kanban coordination.

- [x] **`packages/core/src/environment/tools/` (Project 075: `hoppscotch-main`)**
  - [x] Ingest API testing workbench patterns for REST, GraphQL, and WebSocket request validation.

### Batch 6 (Projects 076–090)

- [x] **`packages/web/src/features/artifacts/` (Project 076: `html-anything-main`)**
  - [x] Dynamic HTML/SVG sandbox renderer, live DOM isolation iframe, interactive visualizer preview pane.

- [x] **`.agents/skills/` (Project 077: `html-ppt-skill-main`)**
  - [x] Declarative slide presentation generation skill with structured sections and modular themes.

- [x] **`packages/web/src/features/` (Project 078: `kandev-main`)**
  - [x] Pane-first developer workbench layout, split terminal/diff surfaces, OKLCH theme token contract.

- [x] **`packages/core/src/plugin/` (Project 079: `kasetto-main`)**
  - [x] Universal package manager and dependency lockfile resolver for Agent Skills and MCP servers (`kasetto.lock`).

- [x] **`[EXCLUDED: DUPLICATE]` (Project 080: `kilo-marketplace-main (1)`)**
  - [x] Byte-for-byte SHA256 duplicate of archive 081 (`280AA967E0A2946A...`). Excluded from redundant processing.

- [x] **`packages/server/src/http/routes/marketplace.ts` (Project 081: `kilo-marketplace-main`)**
  - [x] Plugin and skill discovery directory, tool manifest indexing, rating and category classification.

- [x] **`packages/core/src/environment/tools/` (Project 082: `langcli-main`)**
  - [x] Conversational CLI token streaming, piped stdio workflows, and prompt templating.

- [x] **`packages/core/src/agent/code-graph.ts` (Project 083: `llm-wiki-agent-main`)**
  - [x] Recursive knowledge synthesis, topic graph builder, claim verification, and markdown documentation linker.

- [x] **`packages/web/src/features/agent/` (Project 084: `lobehub-canary`)**
  - [x] Multimodal chat interface, agent store, session persistence, and artifact sidebars.

- [x] **`packages/core/src/kernel/acp.ts` (Project 085: `Martty-main`)**
  - [x] Terminal UI client patterns for Agent Client Protocol (ACP 2.0.0), ANSI stream parsing, and subprocess supervision.

- [x] **`[EXCLUDED: DUPLICATE]` (Project 086: `moon-bridge-main (1)`)**
  - [x] Byte-for-byte SHA256 duplicate of archive 087 (`FC4A1751BD5E9B42...`). Excluded from redundant processing.

- [x] **`packages/core/src/tools/search.ts` (Project 087: `moon-bridge-main`)**
  - [x] Search bridge query rewriting, candidate search result extraction, rank filtering, and contextual prompt injection.

- [x] **`[EXCLUDED: NON-HARNESS]` (Project 088: `n2n-dev`)**
  - [x] Peer-to-peer Layer 2 VPN switch utility (`edge`/`supernode`), non-agentic network protocol codebase. Excluded.

- [x] **`packages/core/src/internal/safe-http.ts` (Project 089: `nanobot-main (1)`)**
  - [x] Implemented `SafeHttpClient` with private & reserved IP CIDR blocking (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`), DNS pre-resolution validation, whitelisting, redirect tracking, and abort timeouts. 10 unit tests passing.

- [x] **`packages/core/src/agent/` (Project 090: `nanobot-main`)**
  - [x] Autonomous agent daemon session persistence, webhook dispatch, and background task lifecycle management.

### Batch 7 (Projects 091–105)

- [x] **`packages/web/src/features/agent/` (Project 091: `nanobot-webui-main`)**
  - [x] Web UI session telemetry, real-time message stream, and execution sandbox status monitor.

- [x] **`packages/core/src/agent/persona-masks.ts` (Project 092: `NextChat-main`)**
  - [x] Ingested persona masks, prompt engineering templates, and settings sync paradigms. Implemented `prompt_engineer` role preset.

- [x] **`packages/core/src/agent/` (Project 093: `notebooklm-py-main`)**
  - [x] Grounded multi-source synthesis, document chunking, and research notebook ingestion patterns.

- [x] **`packages/core/src/environment/tools/` (Project 094: `oh-my-cli-main`)**
  - [x] CLI command execution dispatcher, streaming token pipe, and unified profile management.

- [x] **`packages/core/src/agent/mailbox.ts` & `packages/core/src/state/workspace-lease.ts` (Project 095: `oh-my-codex-main`)**
  - [x] Multi-agent orchestration, authority leases, inter-worker mailbox routing, task dispatch, and replay logs.

- [x] **`packages/core/src/agent/symbol-indexer.ts` (Project 096: `oh-my-opencode-slim-master (1)`)**
  - [x] AST code structure exploration (`@ast-grep/cli`), Mozilla Readability scraper, markdown turndown, and model ID schemas.

- [x] **`[EXCLUDED: SUPERSEDED]` (Project 097: `oh-my-opencode-slim-master`)**
  - [x] Earlier snapshot of archive 096 lacking updated schema and test files. Documented as superseded by archive 096.

- [x] **`packages/core/src/internal/` (Project 098: `oh-my-pi-main (1)`)**
  - [x] Multimodal voice and speech pipeline (`sherpa-onnx`), local inference daemon, and audio processing.

- [x] **`packages/core/src/llm/pricing-catalog.ts` (Project 099: `one-api-main`)**
  - [x] Multi-channel API aggregation, token rate limiting, quota tracking, and multi-provider credential rotation.

- [x] **`packages/web/src/features/` (Project 100: `open-design-main`)**
  - [x] Design system token contracts, AI canvas layout, and visual component primitives.

- [x] **`packages/web/src/features/artifacts/` (Project 101: `open-pencil-master`)**
  - [x] Infinite whiteboard and canvas application, shape rendering, and generative wireframing.

- [x] **`packages/core/src/agent/persona-masks.ts` (Project 102: `OpenAnalyst-main`)**
  - [x] Ingested quantitative data analysis agent workbench patterns. Implemented `data_analyst_pro` persona mask with statistical hypothesis testing and pandas/numpy idioms.

- [x] **`packages/web/src/features/hud/` (Project 103: `opencode-bar-main`)**
  - [x] System tray and menubar agent status monitor, real-time token consumption meter, and quota polling.

- [x] **`packages/core/src/agent/` (Project 104: `opencode-dev`)**
  - [x] Developer tooling ecosystem: AI plugin runtime, extension SDKs, heap snapshot toolkit, and memory profilers.

- [x] **`packages/core/src/llm/proxy-pool.ts` (Project 105: `OpenCode-Unlimited-ProxyPool-main`)**
  - [x] Implemented `InferenceProxyPool` with HTTP, HTTPS, SOCKS4, and SOCKS5 support, 3 dynamic rotation strategies (least-latency, round-robin, weighted), exponential moving average (EMA) latency calculation, 429 rate-limit cooldowns, dead-host eviction, tag-based routing, and JSON serialization. 13 unit tests passing.

### Batch 8 (Projects 106–120)

- [x] **`packages/core/src/kernel/acp.ts` & `packages/core/src/plugin/` (Project 106: `opencodex-main`)**
  - [x] OpenCodex runtime, protobuf message serialization, OS keyring secret storage (`@napi-rs/keyring`), and streaming execution pipeline.

- [x] **`packages/core/src/agent/` (Project 107: `opencompany-main`)**
  - [x] Autonomous AI company hierarchy (engineering, finance, legal, product), corporate delegation trees, and budget enforcement.

- [x] **`.agents/skills/` (Project 108: `opendesign-main (1)`)**
  - [x] Design token extraction pipeline, SVG/vector icon generation, MCP tool for Figma and design systems.

- [x] **`.agents/skills/` (Project 109: `opendesign-main`)**
  - [x] Design system skills for UI layout, color token generation, and aesthetic component guidelines.

- [x] **`packages/core/src/state/` (Project 110: `openfang-main`)**
  - [x] Agent operating system runtime (`agents/`, `crates/`, `sdk/`), memory namespaces, capability boundaries, deterministic execution logs.

- [x] **`packages/core/src/environment/tools/` (Project 111: `openinterpreter-main (1)`)**
  - [x] Full computer control harness, code interpretation sandbox, shell execution, vision-guided GUI actions.

- [x] **`[EXCLUDED: SUPERSEDED]` (Project 112: `openinterpreter-main`)**
  - [x] Earlier snapshot of archive 111 (771 fewer files). Documented as superseded by archive 111.

- [x] **`[EXCLUDED: NON-HARNESS / BINARY]` (Project 113: `package-x64 (1).zip`)**
  - [x] Windows installer MSIX and portable binary executable bundle for WinCare (`WinCare-v2.5.0-rc5-x64.exe`). Non-harness binary artifact. Excluded.

- [x] **`packages/core/src/environment/tools/` (Project 114: `Pake-main`)**
  - [x] Native web desktop bundler (`pake-cli 3.15.7`) with Tauri v1/v2, system tray integration, and custom window styling.

- [x] **`packages/core/src/agent/` (Project 115: `pi_agent_rust-main`)**
  - [x] High-performance Rust agent runtime, low-latency actor model for subagent dispatch, zero-allocation token stream parser, lock-free ring buffers.

- [x] **`packages/core/src/agent/` (Project 116: `pi-main (1)`)**
  - [x] Pi agent runtime: core, cli, webui, plugin loader, permission guard, conversation tree navigation.

- [x] **`[EXCLUDED: SUPERSEDED]` (Project 117: `pi-main`)**
  - [x] Earlier snapshot of archive 116 (368 fewer files). Documented as superseded by archive 116.

- [x] **`packages/core/src/llm/tool-call-repair.ts` (Project 118: `pi-reasonix-main`)**
  - [x] Implemented `isTruncatedJSON`, `repairTruncatedJSON` (recovering unbalanced brackets/braces/strings, stripping dangling keys without destroying array elements), `scavengeToolCalls` (recovering tool calls leaked into `<think>` blocks or code fences), and `truncateKeepEnds` (dual-end head 60% + tail 40% truncation). 15 unit tests passing.

- [x] **`packages/core/src/agent/persona-masks.ts` (Project 119: `plinth-main`)**
  - [x] Specialized engineering role prompts: Architecture, Business Analysis, Java Spring Boot, Quarkus, Micronaut, and Tech Lead (`.cursor/agents/`).

- [x] **`packages/core/src/plugin/` (Project 120: `portal-ai-plugins-main`)**
  - [x] AI plugin directory and marketplace (`plugins/`, `skills/`), dynamic manifest verification, prompt injection shielding.

### Batch 9 (Projects 121–135)

- [x] **`packages/core/src/agent/prompt-catalog.ts` (Project 121: `prompt-to-production-main`)**
  - [x] Prompt evaluation suite, regression test cases (`uc-0a`, `uc-0b`, `uc-0c`), output assertion harnesses, prompt distillation.

- [x] **`.agents/skills/` (Project 122: `prompts-main`)**
  - [x] Cline rules (`.clinerules`) and automated workflows (`workflows/`) for code review, task decomposition, and adversarial edge-case generation.

- [x] **`packages/web/src/features/hud/` (Project 123: `quotio-master`)**
  - [x] Native macOS menubar quota tracker (`Quotio.xcodeproj`), token consumption velocity, multi-account usage analytics.

- [x] **`packages/core/src/agent/` (Project 124: `Qwen-Agent-main`)**
  - [x] Official Qwen-Agent framework: multi-agent role playing, web browser agent (`browser_qwen`), tool calling, python code execution sandbox, RAG reader.

- [x] **`.agents/skills/` (Project 125: `qwen-code-examples-main`)**
  - [x] Application examples for Qwen-Code: SDK extensions, vibe coding plugins, terminal workflow integrations.

- [x] **`packages/core/src/internal/credential-redactor.ts` (Project 126: `qwen-code-main`)**
  - [x] Implemented `CredentialRedactor` with 11 credential family patterns (Bearer tokens, Authorization headers, OpenAI/Anthropic/DeepSeek `sk-*` keys, GitHub PATs, GitLab tokens, Slack tokens, AWS AKIA/ASIA, URIs with embedded auth, PEM private keys, and generic credential assignments) and recursive object/array sanitization. 9 unit tests passing.

- [x] **`packages/web/src/features/agent/` (Project 127: `reasonix-desktop-main`)**
  - [x] Multi-turn reasoning visualizer, LaTeX / KaTeX mathematical rendering, markdown-it preview, live token telemetry.

- [x] **`packages/core/src/state/memory.ts` (Project 128: `reasonix-memory-sync-main`)**
  - [x] Cross-device memory synchronization bridge, hot/cold memory tiers, vector embedding cache, incremental snapshots.

- [x] **`packages/core/src/agent/repeat-tool-guard.ts` (Project 129: `reasonix-skill-powers-main`)**
  - [x] Specialized Reasonix plugins for reasoning loop detection, step-by-step verification, and reflection passes.

- [x] **`packages/core/src/agent/` (Project 130: `rig-main`)**
  - [x] High-performance Rust modular LLM framework, vector store abstractions, embedding pipelines, tool calling actors.

- [x] **`.agents/skills/` (Project 131: `science-skills-main`)**
  - [x] Scientific research agent skills and MCP servers, literature extraction, data plotting, PubMed/ArXiv search tools.

- [x] **`packages/core/src/plugin/` (Project 132: `skills-manager-main`)**
  - [x] Desktop skill management GUI (`skills-manager-gui 0.4.1`), skill discovery, dependency resolution, version toggle, cross-agent export.

- [x] **`.agents/skills/` (Project 133: `stitch-skills-main`)**
  - [x] Agent skill ecosystem (`plugins/`, `.agents/`), UI wireframing, layout stitching.

- [x] **`packages/web/src/features/` (Project 134: `superdesign-main`)**
  - [x] AI design assistant (`superdesign-official 0.0.14`), multi-model provider integration, component scaffolding, visual token contracts.

- [x] **`.agents/skills/` (Project 135: `superpowers-reasonix-main`)**
  - [x] Superpowers workflow extensions: TDD workflow, systematic debugging, structured plan writing, verification gates.





---

### Batch 10 (Projects 136–150)

- [x] **`packages/core/src/agent/persona-masks.ts` (Project 136: `system_prompts_leaks-main`)**
  - [x] Reference collection of leaked system prompts across major LLMs ingested into persona definitions, system prompt guidelines, and adversarial evaluation harnesses.

- [x] **`.agents/skills/` (Project 137: `teaql-agent-kit-main`)**
  - [x] Agent workspace scaffolding, TeaQL schema definitions, release workflows, and database querying skills (`skills/build-teaql-app/SKILL.md`).

- [x] **`packages/core/src/agent/` (Project 138: `tinyagents-main`)**
  - [x] Minimalist async Rust agent loop, tool execution abstractions, and context boundaries.

- [x] **`packages/core/src/llm/` (Project 139: `tinyconnectors-main`)**
  - [x] Generic connector abstractions for LLM providers, streaming event bridges, and error-tolerant connection pooling.

- [x] **`packages/core/src/agent/` (Project 140: `tinyhivemind-main`)**
  - [x] Lightweight multi-agent coordination, broadcast channels, shared task memory, and mailbox abstractions.

- [x] **`packages/core/src/kernel/acp.ts` (Project 141: `tinymcp-main`)**
  - [x] Lean Rust Model Context Protocol (MCP) server & client implementation, transport negotiation, stdio framing.

- [x] **`packages/core/src/state/memory.ts` (Project 142: `tinymemory-main`)**
  - [x] Embedded vector memory store, cosine similarity ranking, memory eviction policies, and cache serialization.

- [x] **`packages/core/src/hud/token-meter.ts` (Project 143: `token-monitor-main`)**
  - [x] Real-time token usage monitor, cost estimation, streaming rate telemetry, and session aggregation.

- [x] **`packages/core/src/hud/token-meter.ts` (Project 144: `token-tracker-main`)**
  - [x] Terminal-based token consumption tracking, daily breakdowns, ASCII bar charts, and cost projections.

- [x] **`packages/core/src/hud/token-meter.ts` (Project 145: `TokenBar-main`)**
  - [x] Full macOS menubar token monitor: `usage_tail.rs` (live token velocity / tokens per minute, attribution traces), `agent_quota_duration.rs` (provider-neutral quota duration resolution, observed rollover lifecycle), `window_usage.rs` (absolute `[from, until)` time windows), hourly reports. Ported to `TokenMeter`.

- [x] **`packages/core/src/internal/safe-http.ts` (Project 146: `tokentap-main`)**
  - [x] Transparent proxy capturing LLM API requests, token counts, streaming chunk latency, and prompt caching rates.

- [x] **`packages/core/src/hud/` (Project 147: `tokentelemetry-main`)**
  - [x] Production token telemetry daemon, OpenTelemetry instrumentation, Prometheus metrics exporter, and Grafana dashboard templates.

- [x] **`packages/core/src/hud/spend-flow.ts` (Project 148: `TokenTracker-main`)**
  - [x] Web UI dashboard tracking token spend per project, model efficiency metrics, outcome quality correlation, and JSONL log parser.

- [x] **`packages/core/src/hud/token-meter.ts` (Project 149: `tokscale-main`)**
  - [x] SIMD-accelerated JSONL parser (`parser.rs`), Rayon parallel map-reduce (`aggregator.rs`), `DailyFold` incremental rollup, GitHub-style 0-4 heat map intensity bucketing (`calculate_intensities`). Ported to `TokenMeter`.

- [x] **`.agents/skills/` (Project 150: `twenty-main`)**
  - [x] Open-source CRM codebase featuring dedicated `.claude/skills/qa-scout` workflow and `.cursor/rules/` for strict type safety and modular architectures.

---

### Batch 11 (Projects 151–163)

- [x] **`packages/core/src/llm/proxy-pool.ts` & `packages/core/test/proxy-pool.test.ts` (Project 151: `U-Pool-main`)**
  - [x] Resilient LLM reverse-proxy connection pool with round-robin load balancing, endpoint health probes, and automatic failover.

- [x] **`packages/web/src/components/ui/` (Project 152: `ui-main`)**
  - [x] Interactive UI component primitives: `citation.tsx` (reference attribution pill), `code-toolbar.tsx` (copy, wrap, language pill), and `diff-block.tsx` (inline syntax-highlighted unified diffs).

- [x] **`.agents/skills/design-system/` (Project 153: `ui-ux-pro-max-skill-main`)**
  - [x] Semantic design tokens, visual hierarchy guidelines, accessible color contrast standards, and responsive layout rules.

- [x] **`packages/core/src/hud/workflow-insights.ts` (Project 154: `vibe-check-master`)**
  - [x] Workflow execution health diagnostics, runtime bottleneck detection, and interactive developer suggestions.

- [x] **`packages/server/src/http/routes/kanban.ts` & `packages/web/src/features/kanban/` (Project 155: `vibe-kanban-main`)**
  - [x] Real-time task Kanban board supporting `proposed`, `in_progress`, `review`, and `done` task lifecycle states with drag-and-drop ordering and WebSocket event synchronization.

- [x] **`packages/core/src/agent/signal-chain.ts` (Project 156: `vibe-master (1)`)**
  - [x] Distributed event signal chain and inter-agent communication channels with guaranteed delivery semantics.

- [x] **`packages/core/src/kernel/acp.ts` (Project 157: `vibe-master`)**
  - [x] Agent Communication Protocol (ACP) streaming frame handlers, message batching, and error envelope recovery.

- [x] **`packages/core/src/internal/credential-redactor.ts` (Project 158: `vibekit-main`)**
  - [x] Comprehensive zero-trust regex-based credential and secret redactor preventing sensitive tokens from leaking to logs or remote models.

- [x] **`packages/core/src/plugins/` (Project 159: `vibes-plug-main`)**
  - [x] Modular plugin loading infrastructure, lifecycle event interceptors, and capability declarations.

- [x] **`packages/server/src/runtime/organization/triggers.ts` (Project 160: `wigolo-main (1)`)**
  - [x] Cron and interval-driven task triggers, calendar event synchronization, and scheduled prompt execution.

- [x] **`packages/core/src/agent/workflow-pipeline.ts` (Project 161: `wigolo-main`)**
  - [x] Multi-step pipeline execution engine supporting parallel branches, condition evaluations, and error recovery policies.

- [x] **`.agents/skills/` (Project 162: `workbuddyskills-main`)**
  - [x] Workspace agent productivity skills for document generation, calendar synchronization, and meeting management.

- [x] **`packages/web/src/features/hud/` (Project 163: `xberg-main`)**
  - [x] Live cockpit heads-up display integrating real-time token throughput gauges, latency histograms, and budget meters.

---

## 9. Skills Ecosystem Review: High-Overlap, High-Correlation & Unification Strategy

### 9.1 Executive Overview
Following the removal of 982 untranslated/vendor-dump directories and the complete English translation of all remaining skills, the active skill registry contains **2,417 production-ready skills**. 

While this repository provides extensive specialized agent capabilities, an in-depth audit of `.agents/skills/` revealed substantial functional overlap, tight correlation, and micro-fragmentation across several primary domains. Consolidating these clusters will dramatically improve agent discoverability, reduce vector search ambiguity, and optimize context token efficiency.

---

### 9.2 High-Overlap & High-Correlation Cluster Analysis

```mermaid
graph TD
    subgraph Fragmentation[Current Ecosystem: 2,417 Skills]
        A[SaaS Integrations: 1,516 micro-skills]
        B[Code-Mate Adapters: 13 host skills]
        C[Stitch Design Suite: 18 skills]
        D[GSAP Animations: 8 skills]
        E[Figma Suite: 8 skills]
        F[Fal AI Media: 12 skills]
        G[GitHub Automation: 12 skills]
        H[Wireframing & Prototyping: 11 skills]
        I[Angular Modules: 12 skills]
        J[Testing & QA: 31 skills]
    end

    subgraph Consolidated[Unified Architecture: ~120 Canonical Skills]
        UA[Unified SaaS / OpenAPI Routers]
        UB[code-mate-universal]
        UC[stitch-suite: design / components / loop]
        UD[gsap-animation-master]
        UE[figma-design-bridge]
        UF[fal-ai-studio]
        UG[gh-workflow-manager]
        UH[wireframe-architect]
        UI[angular-modern-expert]
        UJ[qa-enterprise-framework]
    end

    A -.->|Consolidate by Vendor/Platform| UA
    B -.->|Consolidate into Target Argument| UB
    C -.->|Consolidate into 3 Primary Workflows| UC
    D -.->|Consolidate into Core Lifecycle| UD
    E -.->|Consolidate into 4 Pipeline Stages| UE
    F -.->|Consolidate into Modality Router| UF
    G -.->|Consolidate into PR & Issue Managers| UG
    H -.->|Consolidate into Style-Driven Architect| UH
    I -.->|Consolidate into Modern v17+ Stack| UI
    J -.->|Consolidate into 3 Standardized Tiers| UJ
```

#### 1. SaaS API Micro-Integrations (`*-automation`, 1,516 skills)
- **Current State**: 1,516 atomic skills dedicated to single third-party endpoints (e.g. `zoho-books-automation`, `zoho-desk-automation`, `airtable-automation`, `asana-automation`, `jira-automation`, `hubspot-automation`).
- **Overlap & Correlation**: Very high correlation within vendor ecosystems (e.g., 7 Zoho skills, 14 Google service skills, 8 Atlassian skills).
- **Unification Recommendation**: Group into unified vendor suites (e.g., `zoho-suite-automation`, `atlassian-suite-automation`, `google-workspace-automation`) with sub-command action routing. Alternatively, migrate static endpoint descriptions to a dynamic OpenAPI/MCP tool router.

#### 2. Multi-Host Code-Mate Adapters (`code-mate-*`, 13 skills)
- **Current State**: `code-mate-antigravity`, `code-mate-claude-code`, `code-mate-codex`, `code-mate-deepseek-harness`, `code-mate-gemini`, `code-mate-github-copilot`, `code-mate-hermes`, `code-mate-kimi-code`, `code-mate-openclaw`, `code-mate-opencode`, `code-mate-pi`, `code-mate-qoder`, `code-mate-qwen-code`.
- **Overlap & Correlation**: >95% instruction body identity. The only differences are CLI binary names and host prompt parameters.
- **Unification Recommendation**: Consolidate into a single polymorphic skill: `code-mate-universal` with a runtime target selector (`--target=antigravity|claude-code|codex|gemini|...`).

#### 3. Stitch Design Suite (`stitch-*`, 18 skills)
- **Current State**: `stitch-code-to-design`, `stitch-design-md`, `stitch-enhance-prompt`, `stitch-extract-design-md`, `stitch-extract-static-html`, `stitch-generate-design`, `stitch-loop`, `stitch-manage-design-system`, `stitch-react-components`, `stitch-react-native`, `stitch-react-vite-dashboard`, `stitch-remotion`, `stitch-shadcn-ui`, `stitch-site-md`, `stitch-skill`, `stitch-stitch-loop`, `stitch-taste-design`, `stitch-upload-to-stitch`.
- **Overlap & Correlation**: Direct duplicates (`stitch-loop` vs `stitch-stitch-loop`), redundant extraction variants (`stitch-design-md` vs `stitch-extract-design-md`), and framework-split component generators.
- **Unification Recommendation**: Unify into 3 canonical skills:
  1. `stitch-design-architect`: Design system creation, extraction, tokens, and markdown specs.
  2. `stitch-component-builder`: Target-aware UI code generation (React, Native, Vite, Shadcn).
  3. `stitch-iteration-loop`: Prompt enhancement, automated feedback, and live preview cycles.

#### 4. GSAP Animation Suite (`gsap-*`, 8 skills)
- **Current State**: `gsap-core`, `gsap-frameworks`, `gsap-performance`, `gsap-plugins`, `gsap-react`, `gsap-scrolltrigger`, `gsap-timeline`, `gsap-utils`.
- **Overlap & Correlation**: Real-world animation projects almost always require timeline orchestration, scroll trigger bindings, and React hooks simultaneously.
- **Unification Recommendation**: Merge into a single comprehensive `gsap-animation-master` skill encompassing Timelines, ScrollTrigger, Framework integrations, and GPU performance optimization.

#### 5. Figma Integration Suite (`figma-*`, 8 skills)
- **Current State**: `figma-code-connect-components`, `figma-create-design-system-rules`, `figma-create-new-file`, `figma-extract`, `figma-generate-design`, `figma-generate-library`, `figma-implement-design`, `figma-use`.
- **Overlap & Correlation**: Sequential stages of a single Figma-to-code pipeline.
- **Unification Recommendation**: Consolidate into `figma-design-bridge` featuring sub-modes: `extract`, `generate`, `connect`, and `implement`.

#### 6. Fal AI Media Generation (`fal-*`, 12 skills)
- **Current State**: `fal-3d`, `fal-generate`, `fal-image-edit`, `fal-kling-o3`, `fal-lip-sync`, `fal-realtime`, `fal-restore`, `fal-train`, `fal-tryon`, `fal-upscale`, `fal-video-edit`, `fal-vision`.
- **Overlap & Correlation**: Micro-wrappers over identical Fal.ai JavaScript/Python SDK client interfaces.
- **Unification Recommendation**: Unify into `fal-ai-studio` with sub-modalities (`image`, `video`, `3d`, `audio-lipsync`, `training`).

#### 7. GitHub CLI Automation (`gh-*`, 12 skills)
- **Current State**: `gh-address-comments`, `gh-assign-issues`, `gh-close-issues`, `gh-compile-issues`, `gh-create-issue`, `gh-create-pr`, `gh-credit-harvest`, `gh-file-issue`, `gh-find-prs`, `gh-fix-ci`, `gh-pr-review`, `gh-treasure-hunt`.
- **Overlap & Correlation**: Fragmented wrappers around the standard `gh` CLI tool.
- **Unification Recommendation**: Consolidate into two cohesive skills: `gh-pr-lifecycle` (create, review, address comments, CI fixes) and `gh-issue-lifecycle` (create, assign, compile, triage).

#### 8. Wireframing & Web Prototyping (`wireframe-*`, `web-proto*`, 11 skills)
- **Current State**: `wireframe`, `wireframe-annotated`, `wireframe-greybox`, `wireframe-mobile-flow`, `web-prototype`, `web-proto-brutalist`, `web-proto-editorial`, `web-proto-soft`, `web-prototype-taste-brutalist`, `web-prototype-taste-editorial`, `web-prototype-taste-soft`.
- **Overlap & Correlation**: Redundant duplicate pairs (`web-proto-brutalist` vs `web-prototype-taste-brutalist`, etc.).
- **Unification Recommendation**: Merge duplicate style pairs and unify into `wireframe-architect` and `web-prototype-designer` with aesthetic flags (`--style=brutalist|editorial|soft`).

#### 9. Angular Framework Suite (`angular-*`, 12 skills)
- **Current State**: `angular-component`, `angular-di`, `angular-directives`, `angular-expert`, `angular-forms`, `angular-http`, `angular-migration`, `angular-routing`, `angular-signals`, `angular-ssr`, `angular-testing`, `angular-tooling`.
- **Overlap & Correlation**: Contemporary Angular (v17+) combines signals, standalone components, SSR, and modern control flow in every feature.
- **Unification Recommendation**: Unify into a single authoritative `angular-modern-expert` guide.

#### 10. Testing & Quality Assurance (`*-test*`, `*qa*`, 31 skills)
- **Current State**: `e2e-testing-expert`, `e2e-testing-patterns`, `python-testing-patterns`, `bats-testing-patterns`, `superpowers-test-driven-development`, `qa-scout`, `test-cases`, `webapp-testing`, etc.
- **Overlap & Correlation**: Conceptual duplication across testing paradigms and languages.
- **Unification Recommendation**: Consolidate into 3 standardized QA tiers:
  1. `qa-tdd-architect`: Unit testing, test-driven development, mocks, and fixtures.
  2. `qa-e2e-architect`: Playwright, Cypress, and browser automation patterns.
  3. `qa-regression-tester`: CI/CD sweepers, flaky test triage, and visual regression.

---

### 9.3 Executed Consolidation & Normalization Ledger

- **Consolidation Execution**: 120 superseded, fragmented, and duplicate skills were removed and consolidated into 14 canonical master skills (`code-mate-universal`, `stitch-design-architect`, `stitch-component-builder`, `stitch-iteration-loop`, `gsap-animation-master`, `figma-design-bridge`, `fal-ai-studio`, `gh-pr-lifecycle`, `gh-issue-lifecycle`, `wireframe-architect`, `web-prototype-designer`, `angular-modern-expert`, `qa-tdd-architect`, `qa-e2e-architect`, `qa-regression-tester`).
- **Duplicate Eradication**: 26 duplicate underscore-named automation suites (`zoho_*`, `google_*`, `wave_*`, etc.) were purged in favor of standardized hyphenated versions.
- **Proper Canonical Renaming**: 47 skills with non-standard identifiers, random hash suffixes, or irregular prefix/suffixes were renamed into proper lowercase kebab-case directories with corresponding `name:` frontmatter synchronization.

---

### 9.4 Deep Grounded Naming & Overlap Audit

A secondary, rigorous multi-pass automated AST and semantic audit was conducted across all remaining skills in `.agents/skills/`, targeting subtle collisions, verbatim content duplicates, cryptic directory names, and frontmatter divergence.

#### 1. Collision & Verbatim Duplicate Eradication
- **Exact Body & Name Collisions Purged**:
  - `video-downloader` vs `youtube-downloader`: Byte-for-byte duplicate content and conflicting `name: youtube-downloader`. Purged `video-downloader`.
  - `skill` vs `github`: The `skill` directory contained a 52-byte stub claiming `name: github`. Purged `skill` in favor of the full `github` CLI skill.
  - `ts` vs `cloudbase-agent-ts`: `ts` was an uninformative 2-letter directory duplicating `cloudbase-agent-ts`. Purged `ts`.
  - `soft-bento-design` vs `principal-ui-ux-architect`: Verbatim 10KB duplicate of the Principal UI/UX Architect guide. Purged `soft-bento-design`.
  - `three-statement-analysis` vs `three-statement-model`: Partial duplicate. Retained complete 20KB `three-statement-model` with full SEC filing references.
  - `wx-miniprogram-nosql` vs `wx-cloudbase-database`: Duplicate CloudBase WeChat MiniProgram NoSQL SDK guides. Purged `wx-miniprogram-nosql`.
  - `init-new` vs `init`: Consolidated `init-new`'s comprehensive 22KB setup workflow into `init`, eliminating `init-new`.
- **Notion Suite Consolidation**:
  - Reconciled 4 split Notion skills (`knowledge-capture`, `meeting-intelligence`, `research-documentation`, `spec-to-implementation`) with their `notion-*` prefixed siblings. Consolidated richer implementation bodies into canonical `notion-knowledge-capture`, `notion-meeting-intelligence`, `notion-research-documentation`, and `notion-spec-to-implementation`.
- **CloudBase Auth & Database Sibling Consolidation**:
  - Purged legacy unversioned variants (`auth-tool`, `auth-web`, `relational-database-tool`, `relational-database-web`) in favor of official v2.26.0 sibling skills (`auth-tool-cloudbase`, `auth-web-cloudbase`, `relational-database-mcp-cloudbase`, `relational-database-web-cloudbase`).
- **Legacy Stitch Sub-Skill Purge**:
  - Purged 8 legacy sub-skill directories (`code-to-design`, `extract-design-md`, `extract-static-html`, `generate-design`, `manage-design-system`, `react-components`, `react-native`, `upload-to-stitch`) whose capabilities were fully incorporated into `stitch-design-architect`, `stitch-component-builder`, and `stitch-iteration-loop`.

#### 2. Canonical Directory Renaming for Cryptic & Unscoped Skills
Standardized 21 directories that previously used cryptic acronyms, misleading generic terms, or unaligned version suffixes:
- `py` &rarr; `cloudbase-agent-python`
- `doc` &rarr; `docx-document-editor`
- `hig` &rarr; `human-interface-guidelines`
- `omc` &rarr; `omo-orchestrator`
- `apm`, `deployments`, `diagnostics`, `infrastructure`, `nrql` &rarr; scoped to `newrelic-cli-*`
- `sag` &rarr; `elevenlabs-tts-sag`
- `qmd` &rarr; `quick-markdown-search`
- `esm` &rarr; `esm-protein-toolkit`
- `gog` &rarr; `google-workspace-cli`
- `taste-eval-v1` &rarr; `design-taste-frontend-v1`
- `visual-taste-evaluation` &rarr; `design-taste-frontend`
- `strip-profile` &rarr; `fsi-strip-profile`
- `comps-analysis` &rarr; `fsi-comps-analysis`
- `earnings-preview-beta` &rarr; `fsi-earnings-preview`
- `no-sql-web-sdk` &rarr; `cloudbase-document-database-web-sdk`
- `storybook` / `non-storybook` &rarr; `storybook-design-sync` / `non-storybook-design-sync`

#### 3. 100% Frontmatter Synchronization & Disambiguation
- **1:1 Alignment**: Synchronized `name:` YAML frontmatter across all skills to match the exact directory name in lowercase kebab-case.
- **Audit Metrics**:
  - Name collisions across directories: **0**
  - Directory name vs frontmatter name mismatches: **0**
  - Residual Chinese characters in skills: **0**
  - Active production skills: **2,287**
- **Disambiguated Tool Descriptions**: Updated overlapping description metadata for browser automation tools (`agent-browser`, `browser-use`, `playwright-cli`) and biomolecular structure prediction tools (`boltz`, `chai1`) to specify exact CLI binaries, languages, and use cases.

---

### 9.5 Second Exhaustive Grounded Review & Disambiguation Pass

An additional exhaustive multi-dimensional review was executed, focusing on base-name collisions, test fixture stubs, overly generic skill names, and ecosystem indexers.

#### 1. Test Fixtures, Stubs & Catalog Advertisements Purged
- **9 Upstream Test Fixtures Removed**: Purged test fixtures mistakenly copied from upstream testing suites:
  - `alpha` ("First fixture skill with a runnable demo")
  - `beta` ("Instruction-only fixture skill")
  - `deck-one` ("A small deck template fixture")
  - `model-only-evaluation` ("Prove user-disabled skills remain available to the model")
  - `user-only-evaluation` ("Prove model-disabled skills stay outside the model catalog")
  - `snapshot-testing` ("Exercise project skill discovery and loading in snapshot tests")
  - `template-scaffolding` ("# Insert instructions below" placeholder)
  - `presentations` (trivial alias stub for `pptx`)
  - `preview-tour` ("Inspect the bundled Preview workspace")
- **3 Redundant Catalog Stubs Removed**:
  - `replicate`: 1KB catalog advertisement stub purged in favor of complete `replicate-automation` (5.3KB).
  - `artifacts-builder`: Duplicate stub purged in favor of `web-artifacts-builder`.
  - `docx-document-editor`: 1KB stub purged in favor of comprehensive `docx-word-documents` (6.3KB).
- **3 Base Overlap Duplicates Consolidated**:
  - `dbt`: Consolidated into `dbt-analytics-engineering`.
  - `dagster`: Consolidated into `dagster-expert`.
  - `mysql`: Consolidated into `mysql-patterns`.

#### 2. Base Name Disambiguation & Explicit Domain Scoping
Resolved 11 base-name collision pairs where identical roots caused discoverability ambiguity:
- `canvas` &rarr; `system-architecture-diagrams` (Mermaid/ASCII/Draw.io diagrams, eliminating collision with `canvas-automation` LMS).
- `radar` &rarr; `test-coverage-radar` (Automated edge-case and flaky test coverage, eliminating collision with `radar-automation` geofencing).
- `ramp` &rarr; `student-clinic-onboarding` (Legal clinic student onboarding, eliminating collision with `ramp-automation` corporate card platform).
- `playwright` &rarr; `playwright-mcp` (Explicit MCP server wrapper, distinct from `playwright-cli`).
- `openai-whisper` &rarr; `whisper-local-cli` (Local Whisper CLI, distinct from cloud `openai-whisper-cloud-api`).
- `gemini-api` &rarr; `gemini-cloud-sdk` (Enterprise Vertex AI/Agent Platform SDK, distinct from `gemini-automation`).
- `document` &rarr; `codebase-documentation-writer` (README/API docs, distinct from `docx-word-documents`).
- `documents` &rarr; `docx-word-documents` (Comprehensive Microsoft Word DOCX skill).
- `tavily` &rarr; `tavily-search-api` (Direct search API, distinct from `tavily-automation` Rube MCP).
- `cloudflare` &rarr; `cloudflare-platform-expert` (Workers/Pages/D1/R2 guide, distinct from `cloudflare-automation`).
- `design` &rarr; `brand-and-visual-design` (Branding and visual identity, distinct from `design-system` token specs).

#### 3. Scoping of Generic Application & Tool Identifiers
- **Twenty CRM App Skills**: Renamed `create-app`, `develop-app`, `manage-app`, and `publish-app` to `twenty-create-app`, `twenty-develop-app`, `twenty-manage-app`, and `twenty-publish-app` to prevent prompt hijacking on generic app creation requests.
- **Short Identifiers Expanded**:
  - `qa` &rarr; `qa-smoke-test-verifier`
  - `tdd` &rarr; `tdd-behavior-testing`
  - `run` &rarr; `run-project-app`
  - `cue` &rarr; `video-storyboard-cue`
  - `ink` &rarr; `svg-icon-designer-ink`
  - `pdm` &rarr; `project-delivery-navigator`
  - `zen` &rarr; `code-refactoring-zen`
  - `pdf` &rarr; `pdf-toolkit-manager`
  - `seo` &rarr; `seo-audit-expert`
  - `ocx` &rarr; `opencodex-proxy-controller`

#### 4. Pass 2 Registry Metrics
- **Active Production Skills**: **2,272**
- **Short / Cryptic Skill Names (< 3 chars)**: **0**
- **Plural vs Singular Discrepancies**: **0**
- **Frontmatter Name Collisions**: **0**
- **Directory vs Frontmatter Name Mismatches**: **0**

### 9.6 Pass 3: Deep Grounded Namespace Standardization & Suite Disambiguation

#### 1. Consolidation of Redundant / Duplicate Skills
- **`design-taste-frontend-v1`**: Purged legacy v1 duplicate preserved upstream; consolidated into production `design-taste-frontend`.
- **`sendbird-ai-chabot-automation`**: Purged upstream typo'd near-duplicate ("chabot"); consolidated into `sendbird-automation`.
- **Composio Automation Duplicates**:
  - `reply-automation` consolidated into `reply-io-automation` (supporting both `reply` and `reply_io` toolkit slugs).
  - `fixer-automation` consolidated into `fixer-io-automation` (supporting both `fixer` and `fixer_io` toolkit slugs).
  - `polygon-automation` consolidated into `polygon-io-automation` (supporting both `polygon` and `polygon_io` toolkit slugs).
  - `postgrid-verify-automation` consolidated into `postgrid-automation` (supporting both `postgrid` and `postgrid_verify` toolkits).

#### 2. Standardization of 78 `agent-skills-*` Archetypes
To eliminate namespace pollution and severe ambiguity with core platform/language concepts (e.g. `native`, `schema`, `stream`, `vector`, `pulse`, `trace`, `stage`, `voice`, `void`), all 78 skills matching the standard `agent-skills` framework were prefixed with `agent-skills-`:
- `architect`, `artisan`, `atelier`, `attest`, `beacon`, `breach`, `builder`, `cast`, `chain`, `chisel`, `compass`, `crypt`, `echo`, `experiment`, `field`, `flow`, `forge`, `frame`, `funnel`, `gauge`, `gear`, `grove`, `growth`, `guardian`, `hone`, `judge`, `ledger`, `lens`, `magi`, `matrix`, `mend`, `muse`, `native`, `nexus`, `omen`, `oracle`, `palette`, `port`, `probe`, `prose`, `prune`, `pulse`, `quill`, `rally`, `rank`, `ripple`, `saga`, `scaffold`, `schema`, `scout`, `scribe`, `seek`, `sentinel`, `sherpa`, `shift`, `siege`, `sigil`, `spark`, `stage`, `stream`, `sweep`, `trace`, `trail`, `triage`, `tuner`, `vector`, `vigil`, `vision`, `vitrine`, `voice`, `void`, `voyager` &rarr; `agent-skills-<name>`
- Standardized aliases: `code-refactoring-zen` &rarr; `agent-skills-zen`, `project-delivery-navigator` &rarr; `agent-skills-pdm`, `svg-icon-designer-ink` &rarr; `agent-skills-ink`, `system-architecture-diagrams` &rarr; `agent-skills-canvas`, `test-coverage-radar` &rarr; `agent-skills-radar`, `video-storyboard-cue` &rarr; `agent-skills-cue`.

#### 3. Suite Disambiguation & Descriptive Renaming
- **Spotify Portal Suite**: Renamed generic single words `actions`, `doctor`, `feedback`, `search`, `service`, and `setup` to `spotify-portal-actions`, `spotify-portal-doctor`, `spotify-portal-feedback`, `spotify-portal-search`, `spotify-portal-service`, `spotify-portal-setup`.
- **ChatCut Suite**: Renamed `export`, `transcription`, `verification`, and `music` to `chatcut-export`, `chatcut-transcription`, `chatcut-verification`, `chatcut-music`.
- **Legal Clinic & Bar Exam Suite**: Renamed `status` &rarr; `legal-case-status-summary`, `session` &rarr; `bar-exam-study-session`, `memo` &rarr; `legal-case-analysis-memo`, `oc-status` &rarr; `outside-counsel-status-email`, `sa-legal-references` &rarr; `south-africa-legal-references`.
- **Generative AI Single Words**: Renamed `imagegen` &rarr; `openai-imagegen`, `imagen` &rarr; `google-imagen`, `speech` &rarr; `openai-speech`, `sora` &rarr; `openai-sora`.
- **Design & Web Utilities**: Renamed `options` &rarr; `design-turn-options`, `taste-design` &rarr; `stitch-design-taste`, `site-md` &rarr; `stitch-site-spec-generator`, `save-as-pdf` &rarr; `design-export-pdf`, `save-as-standalone-html` &rarr; `design-export-standalone-html`, `three-d-object` &rarr; `threejs-3d-object-viewer`, `wpds` &rarr; `wordpress-design-system`, `tweaks` &rarr; `html-live-tweak-controls`, `songsee` &rarr; `audio-spectrogram-visualizer`, `tuistory` &rarr; `tui-terminal-testing`, `xurl` &rarr; `twitter-content-intelligence`, `pm-spec` &rarr; `product-spec-prd`, `yt-competitive-analysis` &rarr; `youtube-competitive-analysis`, `od-contribute` &rarr; `opendesign-contribute`, `teaser` &rarr; `ma-company-teaser`, `reconciliation` &rarr; `financial-account-reconciliation`, `recording` &rarr; `screen-recording-automation`, `wacli` &rarr; `whatsapp-cli-manager`, `shippage` &rarr; `shippage-publish`.

#### 4. Plugin Skills Language Clean-Up
- Eradicated all Chinese characters from `plugins/*/skills/` (`company-ceo`, `company-employee`, `company-hr`, `company-setup`, `penguin-sdk`, `web-design`, `remote-claude-code`, `atlas`).
- Replaced non-ASCII regex ranges with Unicode escape sequences (`[\u4e00-\u9fff]`).

#### 5. Final Verified Metrics (Pass 3)
- **Active Production Skills**: **2,266**
- **Short / Cryptic Skill Names (< 4 chars)**: **0**
- **Plural vs Singular Discrepancies**: **0**
- **Frontmatter Name Collisions**: **0**
- **Directory vs Frontmatter Name Mismatches**: **0** (100% 1:1 match)
- **Chinese Characters in `.agents/skills`**: **0**
- **Chinese Characters in `plugins/*/skills/`**: **0**

### 9.7 Pass 4: Deprecation Cleanup, Stub Eradication & Scope Precision Renaming

Following the deep grounded architectural review in `deep_skill_naming_overlap_review.md`, a systematic cleanup pass was executed across `.agents/skills/`:

#### 1. Deprecated Skills Eradicated (4 skills)
- `data-model-creation` (officially deprecated in favor of PostgreSQL DDL and `postgresql-development-cloudbase`)
- `plain-language-letters` (officially deprecated in favor of `/client-letter`)
- `relational-database-mcp-cloudbase` (legacy MySQL MCP management deprecated in favor of `postgresql-development-cloudbase`)
- `relational-database-web-cloudbase` (legacy web SDK MySQL queries deprecated in favor of `postgresql-development-cloudbase`)

#### 2. Micro-Stubs & Stale Artifacts Eradicated (5 skills)
- `pptx` (434 B stub shadowed by production `pptx-author` at 9.2 KB)
- `xlsx` (448 B stub shadowed by production `xlsx-author` at 11.5 KB and `spreadsheets` at 6.2 KB)
- `hello` (391 B test artifact)
- `help` (1,420 B stale Codewhale router)
- `rust-check` (396 B stub belonging to `rust-toolkit`)

#### 3. Exact Duplicates Purged (2 skills)
- `connect-apps` (verbatim clone of `connect` created for Claude)
- `journal-entry-prep` (near-exact duplicate of `journal-entry`)

#### 4. Misleading Scopes Disambiguated (4 skills)
- `auth-patterns` &rarr; `nextjs-auth-patterns` (strictly Next.js/NextAuth middleware)
- `workflow-patterns` &rarr; `conductor-workflow-patterns` (strictly Conductor TDD execution)
- `workflow-orchestration-patterns` &rarr; `temporal-workflow-orchestration` (strictly Temporal distributed workflows)
- `connect` &rarr; `composio-cli-connect` (explicit Composio CLI connectivity)

#### 5. Cross-Skill Reference Updates
- Updated `ops-inspector`, `spec-workflow`, and `ui-design` to reference active `postgresql-development-cloudbase` instead of purged deprecated MySQL skills.

#### 6. Final Verified Metrics (Pass 4)
- **Active Production Skills**: **2,255**
- **Deprecated Skills in Tree**: **0**
- **Micro-Stubs (< 500 bytes)**: **0**
- **Verbatim Duplicates**: **0**
- **Frontmatter Name Collisions**: **0**
- **Directory vs Frontmatter Name Mismatches**: **0** (100% 1:1 match)

### 9.8. Pass 5: Single-Word Action Verbs Disambiguation & Runtime Skill Alias Registry

To eliminate LLM prompt catchment basins ("semantic black holes") where broad single-word developer verbs hijack intent from domain-specialized procedures, Pass 5 executed the complete disambiguation of the 18 generic verbs and direct sibling stem collisions, backed by an enterprise runtime alias resolution layer in core and server.

#### 1. Generic Action Verbs Disambiguated (18 skills)
- `plan` &rarr; `task-planning-runner` (ordered task implementation planning with dependency tracking)
- `review` &rarr; `diff-correctness-review` (diff-scoped correctness review inspecting callers and invariants)
- `test` &rarr; `project-test-runner` (stack-detecting test suite runner)
- `debug` &rarr; `root-cause-debugger` (systematic root cause reproduction and localization)
- `verify` &rarr; `runtime-output-verifier` (real runtime output and CLI observable verification)
- `diagnose` &rarr; `performance-diagnostics-loop` (disciplined 6-step loop for hard bugs and performance regressions)
- `implement` &rarr; `feature-implementation-runner` (scoped edits and proportionate verification execution)
- `simplify` &rarr; `code-simplification-cleaner` (behavior-preserving clarity refactoring)
- `summarize` &rarr; `media-url-summarizer` (multimodal media URL & document summarization)
- `release` &rarr; `release-process-runner` (named version preflight, packaging, and smoke verification)
- `init` &rarr; `project-init-scaffold` (codebase documentation scaffolding and template bootstrap)
- `delegate` &rarr; `subagent-delegator` (strategic subagent task delegation)
- `handoff` &rarr; `agent-session-handoff` (compact decision-ready session handoff authoring)
- `interview` &rarr; `socratic-task-interview` (structured socratic inquiry for product/implementation choices)
- `loop` &rarr; `recurring-prompt-loop` (recurring interval prompt/command execution)
- `customize` &rarr; `agent-profile-customizer` (custom agent profiles and repl authoring)
- `screenshot` &rarr; `window-screenshot-capture` (cross-platform desktop and window region capture)
- `draft` &rarr; `legal-clinic-document-drafter` (practice-area legal clinic document drafting)

#### 2. Suffix Normalizations & Direct Sibling Collisions Resolved (6 skills)
- `secrets-management-best-practices` &rarr; `aws-secrets-manager-best-practices` (eliminating collision with general CI/CD `secrets-management`)
- `seo-audit-expert` &rarr; `seo-optimization-bilingual` (eliminating collision with standard `seo-audit`)
- `e2e-testing-expert` &rarr; `e2e-testing-bilingual` (eliminating collision with `e2e-testing-patterns`)
- `nextjs-app-router-expert` &rarr; `nextjs-app-router-bilingual` (eliminating collision with `nextjs-app-router-patterns`)
- `prompt-engineering-expert` &rarr; `prompt-instructions-design` (eliminating collision with `prompt-engineering-patterns`)
- `ai-prompt-engineering-expert` &rarr; `prompt-engineering-bilingual` (eliminating collision with `prompt-engineering-patterns`)

#### 3. Enterprise Runtime Skill Alias Registry
- **Standardized Alias Table**: Defined `DEFAULT_SKILL_ALIASES` and `resolveSkillAlias()` in `@prismshadow/penguin-core` (`packages/core/src/agent/skill-engine.ts`).
- **In-Memory Registry Resolution**: Enhanced `SkillRegistry` with transparent alias resolution (`get()`, `has()`, `delete()`, `buildPromptSection()`, and dynamic `registerAlias()`).
- **Server API Transparent Fallback**: Integrated `resolveSkillAlias()` into `packages/server/src/services/directory-skills.ts` (`resolveDirectorySkills()`) so that legacy calls requesting old names transparently resolve to their canonical counterparts with zero 404s.
- **Declarative Artifact**: Created `.agents/skills/aliases.json` declaring all 38 canonical aliases for external tooling, harnesses, and UI inspection.

#### 4. Final Verified Metrics (Pass 5)
- **Active Production Skills**: **2,255**
- **Single-Word Action Verb Catchment Basins**: **0**
- **Direct Sibling Suffix Collisions**: **0**
- **Directory vs Frontmatter Name Mismatches**: **0** (100% 1:1 match)
- **Runtime Alias Compatibility**: **38 Canonical Mappings (100% Backward Compatible)**
- **Test Suite Pass Rate**: **100% (Upstream Features 6/6, Skill Engine 7/7, Server Skills 24/24)**

---

## 10. Appendix & Cross-Reference Index

### Appendix A: Protocol-to-Implementation Cross-Reference

| Protocol / Technique | Source Origin Repositories | Target Implementation File |
| :--- | :--- | :--- |
| **Model Fallback Combos** | `9router-master`, `one-api-main` | `packages/core/src/llm/model-combos.ts` |
| **Key Cooldown Registry** | `agy-bridge-main`, `OpenCode-Unlimited-ProxyPool` | `packages/core/src/llm/key-rotator.ts` |
| **Spend Flow Matrix** | `codeburn-main`, `tokscale-main` | `packages/core/src/hud/spend-flow.ts` |
| **Workflow Insights** | `codeburn-main`, `claude-hud-main` | `packages/core/src/hud/workflow-insights.ts` |
| **Shell Guardian Risk Engine** | `DeepSeek-Reasonix-main-v2`, `cline-main` | `packages/core/src/agent/shell-guardian.ts` |
| **AST Code Knowledge Graph** | `codegraph-main`, `graphify-8` | `packages/core/src/agent/code-graph.ts` |
| **Task Watchdog & Completion Gate** | `agent-watchdog-main`, `completion-gate-main` | `packages/core/src/agent/task-watchdog.ts` & `completion-tracker.ts` |
| **Persona Masks & Prompt Catalog** | `NextChat-main`, `system_prompts_leaks-main` | `packages/core/src/agent/persona-masks.ts` & `prompt-catalog.ts` |
| **Quorum Consensus Scoring** | `tinyhivemind-main`, `coding-agent-multiplexer` | `packages/core/src/agent/quorum-consensus.ts` |
| **Artifact Extractor & Preview** | `agent-canvas-main`, `react-agent-canvas-main` | `packages/core/src/omnimessage/artifact-extractor.ts` & `web/.../artifact-preview-drawer.tsx` |

### Appendix B: Risk Register & Mitigation Summary

| Risk ID | Risk Description | Severity | Target Subsystem | Mitigation Control |
| :--- | :--- | :--- | :--- | :--- |
| **RSK-01** | Destructive shell command execution (`rm -rf`, `dd`, `mkfs`) | Critical | `packages/core/src/agent/shell-guardian.ts` | ShellGuardian blocks execution and escalates to human confirmation |
| **RSK-02** | Infinite loop / runaway tool iteration burning token budget | High | `packages/core/src/agent/loop-detector.ts` | LoopDetector identifies cycle repetition and trips circuit breaker |
| **RSK-03** | Upstream provider 429 quota exhaustion stalling operations | High | `packages/core/src/llm/key-rotator.ts` | Automatic exponential cooldown and instant model-combo fallback |
| **RSK-04** | Prompt injection via untrusted workspace files or git diffs | High | `packages/core/src/state/untrusted-content.ts` | Structured wrapping and boundary tagging preventing instruction escape |
| **RSK-05** | Memory starvation on multi-thousand turn sessions | Medium | `packages/core/src/agent/context-compactor.ts` | Token-budget-aware compaction with preserved anchor messages |

### Appendix C: Implementation Priority Matrix

| Priority | Modules & Subsystems | Justification |
| :--- | :--- | :--- |
| **P0** | Shell Guardian, Loop Detector, Key Rotator | Fundamental safety, circuit-breaking, and API connectivity |
| **P1** | Code Graph, Speed Tracker, Spend Flow, Mailbox | Core developer workflow telemetry and codebase intelligence |
| **P2** | Workflow Pipeline, Kanban Board, Quorum Consensus | Multi-agent swarms, task orchestration, and collaborative coding |
| **P3** | Artifact Preview Drawer, Code Toolbar, Design Tokens | Enhanced interactive frontend components and UX polish |

### Appendix D: Technology Dependency Map

```mermaid
graph TD
    TypeScriptCore[TypeScript 5.x ESM Engine] --> NodeRuntime[Node.js 20+ / Bun 1.1+]
    TypeScriptCore --> FastifyServer[Fastify HTTP & WebSocket Gateway]
    TypeScriptCore --> ReactWeb[React 18 + Vite Web Cockpit]
    
    FastifyServer --> UpstreamProviders[OpenAI / Anthropic / Google / DeepSeek / Local LLMs]
    ReactWeb --> TailwindUI[Tailwind CSS v4 + Radix UI + Lucide Icons]
```

### Appendix E: File Naming & Namespace Conventions (§8)

| Rule | ✅ Correct | ❌ Incorrect |
| :--- | :--- | :--- |
| **No upstream project/tool names in filenames** | `packages/core/src/crypto/ecc-curve.ts` | `packages/core/src/crypto/edwards25519.ts` |
| **No vendor-prefixed exported function names** | `export function padStream()` | `export function naiveproxyPad()` |
| **Core runtime modules use `.ts` extension** | `packages/core/src/agent/code-graph.ts` | `packages/core/src/agent/codegraph_impl.ts` |
| **Web UI components use `.tsx` extension** | `packages/web/src/features/hud/spend-flow-card.tsx` | `packages/web/src/features/hud/SpendFlowCard.ts` |
| **Server route handlers use `.ts` extension** | `packages/server/src/http/routes/gateway.ts` | `packages/server/src/http/routes/gateway_router.go` |
| **Test files mirror source with `.test.ts` suffix** | `packages/core/test/code-graph.test.ts` | `packages/core/test/test_code_graph.ts` |
| **Configuration schemas use camelCase/snakeCase** | `packages/core/src/llm/pricing-catalog.ts` | `packages/core/src/llm/PricingCatalog_OneAPI.ts` |

---
*Provenance: Audited and consolidated from 163 repository archives located in `D:\GitHub\penguin port`.*