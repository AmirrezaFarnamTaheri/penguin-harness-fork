# Technical Specification: App Size Reduction & Resource Efficiency Optimization

- **Date:** 2026-09-16
- **Status:** Approved
- **Branch:** `feat/cockpit-topology-guardian-consensus`
- **Scope:** Desktop packaging footprint, Web bundle modularity, and Server/Agent runtime resource governance.

---

## 1. Executive Summary & Problem Statement

Profiling of PenguinHarness build artifacts and runtime processes revealed three major optimization vectors:

1. **Desktop Shell Package Bloat (`dist/main.js` = 6.83 MB):**
   The Electron main process entry (`packages/desktop/src/main.ts`) imports `resolveRoot` from the root entry of `@prismshadow/penguin-core`. Because `tsup` bundles non-external dependencies with `splitting: false`, this single import forces `tsup` to bundle almost the entire `@prismshadow/penguin-core` tree (including Tree-sitter, AST engines, LLM interfaces, and validators) directly into `dist/main.js`.
2. **Web Frontend Monolithic Entry Chunk (`dist/assets/index-*.js` = 624.44 kB):**
   Vite's default chunking bundles React 19, React Router 8, Zustand, KaTeX math parsing, markdown parsers, and terminal utilities into a single monolithic bundle, triggering Vite chunk size warnings and penalizing initial page load and parse times.
3. **Unbounded Background Resource Retention:**
   - **Inactive File Watchers (`CodeGraphWatcher`):** Project runtimes in `packages/server/src/cockpit/ws.ts` instantiate recursive `fs.watch` watchers per project that persist indefinitely even after all WebSocket clients disconnect.
   - **Unbounded Turn Ledger Growth (`TurnLedger`):** Multi-agent swarm turns and envelopes accumulate in memory without upper-bound compaction or truncation, risking heap memory leaks during prolonged sessions.

---

## 2. Architectural Decisions & Target Metrics

### Decision 1: Desktop Shell Decoupling
- **Action:** Add a lightweight subpath export `"./paths"` to `packages/core` pointing directly to `src/state/paths.ts` (which depends solely on `node:os` and `node:path`). Update `packages/desktop/src/main.ts` to import `resolveRoot` from `@prismshadow/penguin-core/paths`.
- **Target:** Reduce `packages/desktop/dist/main.js` from **6.83 MB to < 100 KB** (>98% reduction).

### Decision 2: Web Frontend Strategic Vendor Chunking
- **Action:** Configure `build.rollupOptions.output.manualChunks` in `packages/web/vite.config.ts`:
  - `vendor-react`: `react`, `react-dom`, `react-router`
  - `vendor-markdown`: `remark-gfm`, `remark-math`, `rehype-katex`, `katex`
  - `vendor-terminal`: `@xterm/xterm`, `@xterm/addon-clipboard`, `@xterm/addon-fit`, `@xterm/addon-web-links`
  - `vendor-state`: `zustand`
- **Target:** Eliminate the >500 kB chunk warning; split monolithic `index-*.js` into independent, browser-cacheable chunks.

### Decision 3: Server Idle Watcher Reaper (15-Minute Policy)
- **Action:** In `packages/server/src/cockpit/ws.ts`, implement an idle timer on `ProjectCockpitRuntime`. When `runtime.clients.size === 0`, schedule a 15-minute (`900_000` ms) idle timeout. If no client reconnects before the timer expires, gracefully close `codeGraphWatcher`, clear listeners, and remove the project from `projectRuntimes`. Re-instantiate seamlessly on the next connection.
- **Target:** Prevent CPU/handle leakage from abandoned workspaces in long-running desktop or server processes.

### Decision 4: TurnLedger Memory Bounding
- **Action:** Enhance `TurnLedger` with configurable `maxRecords` (default `5000`) and `maxSummaries` (default `1000`). Automatically evict oldest acknowledged envelopes and summaries when capacity is reached.
- **Target:** Bound memory consumption of long-running swarm sessions to stable heap footprints.

---

## 3. Detailed Component Plan

### 3.1 `@prismshadow/penguin-core`
- Update `packages/core/tsup.config.ts` to include `"src/state/paths.ts"` as a distinct entry.
- Update `packages/core/package.json` to expose `"./paths"` subpath.
- Update `packages/core/src/agent/turn-ledger.ts` to support capacity bounds and auto-pruning.

### 3.2 `@prismshadow/penguin-desktop`
- Update `packages/desktop/src/main.ts` to import `{ resolveRoot } from "@prismshadow/penguin-core/paths"`.

### 3.3 `@prismshadow/penguin-web`
- Update `packages/web/vite.config.ts` with clean `manualChunks` function grouping core vendor dependencies.

### 3.4 `@prismshadow/penguin-server`
- Update `packages/server/src/cockpit/ws.ts` with 15-minute idle runtime reaper logic.

---

## 4. Verification & Quality Gates

1. `pnpm --filter @prismshadow/penguin-core build && pnpm --filter @prismshadow/penguin-desktop build`
   - Verify `dist/main.js` size drops from 6.83 MB to <100 KB.
2. `pnpm --filter @prismshadow/penguin-web build`
   - Verify chunk sizes and ensure no Rollup >500 kB warning for index bundle.
3. Unit Test Verification:
   - `pnpm --filter @prismshadow/penguin-core test`
   - `pnpm --filter @prismshadow/penguin-server test`
   - `pnpm --filter @prismshadow/penguin-web test`
   - `pnpm --filter @prismshadow/penguin-desktop test`
4. Code Quality:
   - `pnpm format:check`
   - `pnpm typecheck`
