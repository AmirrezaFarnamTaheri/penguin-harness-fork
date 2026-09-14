# 4-Pillar Backend Web Cockpit Suite Implementation Plan

> **For agentic workers:** Sequential inline execution with strict TDD, control-sizing accessibility verification (`test/control-size.test.ts`), and monorepo typecheck validation at each task boundary.

**Goal:** Implement a premier, enterprise-grade Web Cockpit suite for `@prismshadow/penguin-web` exposing 4 core backend services: Agent Memory Vault (`memory-service.ts`), Model Key Fleet & Failover (`model-key-health.ts`), Trace Spans & Flamegraphs (`trace-service.ts`), and Session Time-Travel Snapshots (`snapshot-service.ts`), unified in the central Agent Cockpit.

**Architecture:** A modular 4-pillar frontend architecture where each capability has its own dedicated full-page feature workbench and dockable panel, while telemetry summaries and live status badges are embedded directly into `AgentCockpit`. All communications route through typed API endpoints with clean DTO mappings.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind CSS, Lucide Icons, Vitest, `@testing-library/react`.

## Global Constraints

- **Strict Control Sizing**: All form controls (`<Input>`, `<Select>`, `<Button>`) must use `size="sm"` and MUST NOT have `className="text-xs"` (per `packages/web/test/control-size.test.ts`).
- **Semantic Colors**: Use design system semantic tokens (`bg-card`, `text-foreground`, `border-border`, `text-muted-foreground`, `bg-destructive/10`) — no raw arbitrary hex colors.
- **No Mock/Placeholder Short-circuits**: Implement real functional algorithms, canvas math, state diffing, and filter mechanisms.
- **Monorepo Typecheck Clean**: All 25 projects must compile cleanly (`pnpm run typecheck`).
- **Fork-Only Scope**: Target only `origin` (`AmirrezaFarnamTaheri/penguin-harness-fork`). Never touch `upstream`.

---

### Task 1: Pillar 1 — Agent Memory Vault & Semantic Knowledge Studio (`/memory`)

**Files:**
- Create: `packages/web/src/features/memory/memory-types.ts`
- Create: `packages/web/src/features/memory/memory-graph-canvas.tsx`
- Create: `packages/web/src/features/memory/memory-document-studio.tsx`
- Create: `packages/web/src/features/memory/memory-recall-simulator.tsx`
- Create: `packages/web/src/features/memory/memory-page.tsx`
- Test: `packages/web/test/memory-vault.test.ts`

**Interfaces:**
- Produces: `MemoryPage` component, `MemoryTopicNode`, `MemoryScope` ("user" | "workspace"), `MemoryRecallResult`, `MemoryFilePayload`.

- [ ] **Step 1: Write the failing unit tests for Memory Vault components**
Create `packages/web/test/memory-vault.test.ts` verifying:
- Graph node clustering and edge link generation from `MEMORY.md` index links.
- Frontmatter metadata parsing and YAML index invariants.
- Semantic recall simulation with similarity threshold filtering and token meter calculation.
- Scope switching between User Scope and Workspace Scope.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @prismshadow/penguin-web test run test/memory-vault.test.ts`
Expected: FAIL (files missing).

- [ ] **Step 3: Implement memory-types and graph canvas**
Create `packages/web/src/features/memory/memory-types.ts` and `memory-graph-canvas.tsx` with interactive SVG topic graph, zoom/pan, edge rendering for cross-topic links, and node selection callbacks.

- [ ] **Step 4: Implement document studio and recall simulator**
Create `packages/web/src/features/memory/memory-document-studio.tsx` (markdown/frontmatter editor with index sync) and `memory-recall-simulator.tsx` (similarity matcher, token counter per topic).

- [ ] **Step 5: Assemble memory-page.tsx and run unit tests**
Create `packages/web/src/features/memory/memory-page.tsx` combining graph canvas, studio drawer, and recall simulator.
Run: `pnpm --filter @prismshadow/penguin-web test run test/memory-vault.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify control size rule and typecheck**
Run: `pnpm --filter @prismshadow/penguin-web test run test/control-size.test.ts`
Run: `pnpm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 7: Commit**
```bash
git add packages/web/src/features/memory/ packages/web/test/memory-vault.test.ts
git commit -m "feat(web): add agent memory vault and semantic knowledge studio"
```

---

### Task 2: Pillar 2 — Model Key Fleet & Resilient Failover Console (`/models/keys`)

**Files:**
- Create: `packages/web/src/features/models/key-fleet-types.ts`
- Create: `packages/web/src/features/models/key-health-card.tsx`
- Create: `packages/web/src/features/models/key-probe-modal.tsx`
- Create: `packages/web/src/features/models/models-key-fleet-page.tsx`
- Test: `packages/web/test/key-fleet.test.ts`

**Interfaces:**
- Produces: `ModelsKeyFleetPage` component, `KeyHealthItem`, `ModelKeyFleetReport`, `KeyActionType` ("revive" | "cooldown" | "evict" | "probe").

- [ ] **Step 1: Write the failing unit tests for Key Fleet Console**
Create `packages/web/test/key-fleet.test.ts` testing:
- Rendering masked keys with status badges (`healthy`, `cooldown`, `evicted`).
- Cooldown countdown timer logic and formatted remaining milliseconds.
- Success/failure invocation ratios and active lease counters.
- Manual override callbacks: revive key, force cooldown, evict key, latency probe test.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @prismshadow/penguin-web test run test/key-fleet.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement key-fleet-types and key-health-card**
Create `packages/web/src/features/models/key-fleet-types.ts` and `key-health-card.tsx` with live timer countdowns, status tags, and action buttons.

- [ ] **Step 4: Implement key-probe-modal and models-key-fleet-page**
Create `packages/web/src/features/models/key-probe-modal.tsx` (simulated latency check with latency sparklines) and `models-key-fleet-page.tsx` (fleet summary, provider grouping, rotation strategy selection).

- [ ] **Step 5: Run unit tests and verify**
Run: `pnpm --filter @prismshadow/penguin-web test run test/key-fleet.test.ts`
Run: `pnpm --filter @prismshadow/penguin-web test run test/control-size.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/web/src/features/models/ packages/web/test/key-fleet.test.ts
git commit -m "feat(web): add model key fleet and resilient failover console"
```

---

### Task 3: Pillar 3 — Deep Execution Waterfall & Flamegraph Profiler (`/traces/flamegraph`)

**Files:**
- Create: `packages/web/src/features/traces/flamegraph-types.ts`
- Create: `packages/web/src/features/traces/waterfall-canvas.tsx`
- Create: `packages/web/src/features/traces/causal-error-tree.tsx`
- Create: `packages/web/src/features/traces/span-detail-drawer.tsx`
- Create: `packages/web/src/features/traces/trace-flamegraph-page.tsx`
- Test: `packages/web/test/trace-flamegraph.test.ts`

**Interfaces:**
- Produces: `TraceFlamegraphPage` component, `ExecutionSpan`, `WaterfallSegment`, `CausalChainNode`, `SpanLatencyBreakdown`.

- [ ] **Step 1: Write the failing unit tests for Trace Flamegraph**
Create `packages/web/test/trace-flamegraph.test.ts` testing:
- Hierarchical waterfall layout math (nesting sessions, subagents, tool calls, model segments).
- Duration calculations (time-to-first-token vs generation vs tool runtime).
- Causal error tree extraction from failing tool spans.
- Span detail drawer inspection for token consumption and payload inspection.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @prismshadow/penguin-web test run test/trace-flamegraph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement flamegraph-types and waterfall-canvas**
Create `packages/web/src/features/traces/flamegraph-types.ts` and `waterfall-canvas.tsx` rendering interactive span rows, timing scales, and color-coded latency phases.

- [ ] **Step 4: Implement causal-error-tree, span-detail-drawer, and trace-flamegraph-page**
Create `causal-error-tree.tsx` (recursive failure causality tracing), `span-detail-drawer.tsx` (token cost, prompt/output payloads), and `trace-flamegraph-page.tsx` (session selector, zoom/pan controls, latency breakdown cards).

- [ ] **Step 5: Run unit tests and verify**
Run: `pnpm --filter @prismshadow/penguin-web test run test/trace-flamegraph.test.ts`
Run: `pnpm --filter @prismshadow/penguin-web test run test/control-size.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/web/src/features/traces/ packages/web/test/trace-flamegraph.test.ts
git commit -m "feat(web): add deep execution waterfall and flamegraph profiler"
```

---

### Task 4: Pillar 4 — Session Time-Travel & Snapshot Rewind Studio (`/snapshots`)

**Files:**
- Create: `packages/web/src/features/snapshots/snapshot-types.ts`
- Create: `packages/web/src/features/snapshots/snapshot-timeline.tsx`
- Create: `packages/web/src/features/snapshots/snapshot-diff-viewer.tsx`
- Create: `packages/web/src/features/snapshots/snapshots-page.tsx`
- Test: `packages/web/test/snapshot-rewind.test.ts`

**Interfaces:**
- Produces: `SnapshotsPage` component, `SnapshotVersionInfo`, `StateDiffSummary`, `RollbackMode` ("in-place" | "fork-branch").

- [ ] **Step 1: Write the failing unit tests for Snapshot Rewind Studio**
Create `packages/web/test/snapshot-rewind.test.ts` testing:
- Snapshot version list rendering with version tags (`v1`, `v2`...), uncompressed sizes, and trigger labels.
- Visual side-by-side state diff generation for prompt, memory files, and skills.
- Dual-mode time-travel actions: in-place revert (requiring safety snapshot) vs branching session fork.
- Archive `.tar.gz` export and import structure validation.

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm --filter @prismshadow/penguin-web test run test/snapshot-rewind.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement snapshot-types and snapshot-timeline**
Create `packages/web/src/features/snapshots/snapshot-types.ts` and `snapshot-timeline.tsx` with chronological checkpoint nodes, version badges, and rollback triggers.

- [ ] **Step 4: Implement snapshot-diff-viewer and snapshots-page**
Create `snapshot-diff-viewer.tsx` (side-by-side file and prompt diffs) and `snapshots-page.tsx` (archive import drag-and-drop, export download, confirmation modal for in-place revert).

- [ ] **Step 5: Run unit tests and verify**
Run: `pnpm --filter @prismshadow/penguin-web test run test/snapshot-rewind.test.ts`
Run: `pnpm --filter @prismshadow/penguin-web test run test/control-size.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/web/src/features/snapshots/ packages/web/test/snapshot-rewind.test.ts
git commit -m "feat(web): add session time-travel and snapshot rewind studio"
```

---

### Task 5: Pillar 5 — Unified Cockpit, Dock Panels, Navigation & Monorepo Validation

**Files:**
- Modify: `packages/web/src/features/agent/agent-cockpit.tsx`
- Modify: `packages/web/src/features/dock/dock-state.ts`
- Modify: `packages/web/src/features/dock/panel-meta.tsx`
- Modify: `packages/web/src/router.tsx`
- Modify: `packages/web/src/components/layout/sidebar.tsx`
- Modify: `packages/web/src/components/layout/app-layout.tsx`
- Modify: `packages/web/src/components/ui/icons.tsx`
- Modify: `packages/web/src/lib/strings.ts` & `packages/web/src/lib/strings-en.ts`
- Test: `packages/web/test/control-size.test.ts` & full test suite

- [ ] **Step 1: Update navigation and icons**
Add icons (`Brain`, `Flame`, `History`, `KeyRound`) to `icons.tsx`.
Update localized labels in `strings.ts` and `strings-en.ts`.
Add route definitions in `router.tsx` for `/memory`, `/models/keys`, `/traces/flamegraph`, `/snapshots`.
Add navigation links in `sidebar.tsx` and `app-layout.tsx`.

- [ ] **Step 2: Register dock panels**
Update `dock-state.ts` and `panel-meta.tsx` to add dock panel descriptors for Memory Studio, Key Fleet, Flamegraph, and Snapshots.

- [ ] **Step 3: Integrate telemetry widgets into Agent Cockpit**
Update `agent-cockpit.tsx` to embed 4 live telemetry summary cards:
- Memory Vault (topics count, total indexed bytes, recent sync).
- Key Fleet (healthy ratio badge, active leases, cooldown count).
- Trace Flamegraph (mean TTFT, tool execution latency, last span status).
- Snapshot Time-Travel (active version, time since last snapshot, instant checkpoint button).

- [ ] **Step 4: Run full Vitest suite across penguin-web**
Run: `pnpm --filter @prismshadow/penguin-web test run`
Expected: 100% passed test files and tests.

- [ ] **Step 5: Run monorepo typecheck**
Run: `pnpm run typecheck`
Expected: Exit code 0 across all 25 monorepo projects.

- [ ] **Step 6: Commit and push to origin**
```bash
git add packages/web/
git commit -m "feat(web): integrate memory, key fleet, flamegraph & snapshots into agent cockpit"
git push origin feat/cockpit-topology-guardian-consensus
```
