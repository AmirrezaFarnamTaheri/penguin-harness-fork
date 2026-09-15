---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
---

# Model Gateway & Chat Runtime Enhancements - Plan

## 1. Goal Capsule

### Objective
Provide comprehensive production-grade enhancements across the Model Gateway and Chat Composer systems:
1. Support distinct Text API vs Image/Vision API routing endpoints (e.g. `https://router.bynara.id/v1` for text vs `https://api-images.bynara.id/v1/` for image/vision tasks).
2. Enable group-level defaults (`default_base_url`, `default_image_base_url`), multi-select batch deletion, saved API key reveal toggle, concurrent health probing with one-click non-responding model pruning, and custom group preset management.
3. Allow slash commands (`/skills`, `/compact`, `/goal`) to be composed while tasks are running, with non-prefix substring, token, and description search.
4. Provide context-adaptive compaction that auto-identifies model context limits via catalog properties and dynamic endpoint inspection (`GET /v1/models`).
5. Support explicit keyboard actions: `Enter` to Queue (or Send), `Ctrl+Enter` to Steer immediately, and `Shift+Enter` for newlines.

### Scope Boundaries
- **In-Scope**:
  - `packages/core`: `ModelConfig`, `CatalogModel`, `effectiveMaxContextLength`, `context-limits.ts`, `agent.ts` vision/text routing, and `model-catalog.ts` context limits.
  - `packages/web`: `models-page.tsx` (batch select, key reveal, group defaults, prune unresponsive), `chat-input.tsx` (unblocked slash menu, substring search, steer/queue keybindings).
  - `packages/server`: Model probe and context window detection endpoint integration.
- **Out-of-Scope**:
  - External SaaS billing proxies or proprietary cloud services.
  - Breaking existing CLI configuration schema or system config file formats.

---

## 2. Product Contract & Architectural Specifications

### Domain 1: Dual Endpoint Routing (Text vs Image/Vision APIs)
- **Problem**: Certain API gateways route chat completions and image/vision operations through different hostnames or paths (e.g., Bynara uses `https://router.bynara.id/v1` for text and `https://api-images.bynara.id/v1/` for image generation and vision).
- **Contract & Schema**:
  - Add `image_base_url?: string` to `ModelConfig` in `packages/core/src/state/project-config.ts`.
  - Add `imageBaseUrl?: string` to `CatalogModel` in `packages/core/src/state/model-catalog.ts`.
  - In `packages/core/src/agent.ts`, when preparing vision or image descriptions, resolve `baseUrl` prioritizing `modelEntry.image_base_url ?? modelEntry.base_url ?? groupDefaultImageBaseUrl ?? groupDefaultBaseUrl`.
  - In `packages/web/src/features/models/models-page.tsx`, expose an optional **Image API Base URL** field in the model edit dialog and group defaults.

### Domain 2: Model Group Batch Operations & Key Display
- **Group Base URL Defaults**:
  - Model groups support `default_base_url` and `default_image_base_url`.
  - Models within the group without an explicit base URL automatically inherit the group's default.
- **Multi-Select & Batch Deletion**:
  - Add a "Multi-select" toggle to each model group header.
  - When enabled, cards display selection checkboxes.
  - A sticky batch action bar provides: `N models selected`, `Select All`, `Deselect`, and `Delete Selected (N)` with a single confirmation modal.
- **Reveal Saved API Key**:
  - Add a toggle visibility icon (eye icon) to the API Key input in the Model Dialog.
  - Allow users to view and copy the currently configured key.
- **Pruning Non-Responding Models**:
  - Enhance `runSpeedTest` with bounded concurrency (4 parallel pings).
  - Add a "Prune Non-Responding" action that identifies models failing with network errors or 404s and removes them in a single batch update.
- **Custom Group Presets**:
  - Provide an export/import modal to save and load custom model definitions as reusable presets.

### Domain 3: Chat Composer Slash Commands While Task Is Active
- **Problem**: `chat-input.tsx` currently suppresses slash token matching when `running || compacting`.
- **Solution**:
  - Remove the `running` and `compacting` suppression from `slashTok = matchSlash(text, caret)`.
  - Users can invoke `/skills` and select skills while an execution is running.
  - When the message is sent, it is dispatched through `onQueueFollowUp` with the appropriate `[use_skills]` block already attached.

### Domain 4: Substring, Fuzzy & Description Skill Search
- **Problem**: `slashMatches` currently filters with `c.cmd.startsWith('/' + query)`.
- **Solution**:
  - Normalize query and match across:
    1. Command name substring: `c.cmd.toLowerCase().includes(q)`.
    2. Description substring: `c.desc.toLowerCase().includes(q)`.
    3. Word tokens: all whitespace-separated query tokens matched against name or description.
  - Rank results: Exact prefix matches first, followed by name substring matches, followed by description matches.

### Domain 5: Context-Adaptive Compaction & Context Window Auto-Detection
- **Problem**: Models without an explicit `context_window` fall back to `128000`, causing small-window models (e.g. 32k) to crash before compaction, and 1M-window models to compact prematurely.
- **Solution**:
  - Add known context windows to `model-catalog.ts` for all catalog entries.
  - Implement `/v1/models` inspection for custom OpenAI/vLLM endpoints to detect `max_model_len` or `context_length`.
  - Adapt compaction threshold dynamically based on `window - COMPACTION_HEADROOM`.

### Domain 6: Steer vs Queue Keyboard Shortcuts
- **Keybindings**:
  - `Enter`: When idle -> Send. When running -> Queue as next turn.
  - `Ctrl + Enter` (or `Cmd + Enter`): Steer immediately into running turn.
  - `Shift + Enter`: Insert newline.
  - Visual footer prompt dynamically informs user: `Press [Enter] to queue, [Ctrl+Enter] to steer immediately`.

---

## 3. Key Decisions & Rationale
- **Single Source of Truth**: All URL inheritance (group default -> model override) is computed predictably with explicit precedence.
- **Zero Hallucinated Models**: Pruning non-responding models requires explicit live HTTP ping failure evidence before deletion.
- **Non-blocking Composer**: Decoupling slash menu from agent run state removes friction for multi-turn planning.

---

## 4. Traceability & Testing Strategy
- **Unit Tests**:
  - Test dual URL resolution in `packages/core/test/agent.test.ts`.
  - Test context limits and auto-window detection in `packages/core/test/context-limits.test.ts`.
  - Test slash matching and ranking in `packages/web/test/skill-slash.test.ts`.
- **UI Tests**:
  - Test multi-select model deletion and key reveal in `packages/web/test/models-page.test.tsx`.
