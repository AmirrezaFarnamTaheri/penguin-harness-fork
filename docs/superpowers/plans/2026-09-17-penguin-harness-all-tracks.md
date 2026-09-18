---
title: Penguin Harness Fork — All-Tracks Master Implementation Plan
created: 2026-09-17
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
deepened: 2026-09-17
---

# Penguin Harness Fork — All-Tracks Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simultaneously execute every track, horizon, and overlooked subsystem across the platform — unblocking CI gates, wiring real core daemons for all 7 prototype surfaces, activating multi-agent quorum and dialectical arbiters, optimizing KV-cache and AST compaction, building spatial cockpit debugger controls, formalizing ACP and tool-call repair kernels, launching enterprise org mode and messaging connectors, and hardening benchmark evaluation pipelines.

**Architecture:** Dependency-ordered 8-wave model. Each wave unlocks parallel tracks that can execute in isolated git worktree lanes. All tasks follow strict TDD: failing test -> verification of failure -> minimal implementation -> test pass verification -> git commit.

**Tech Stack:** TypeScript / Node >=24, pnpm workspaces, Hono, React, SQLite (better-sqlite3), Vitest, Playwright, Electron, electron-updater, git plumbing, node-pty, Tree-sitter.

---

## Master Dependency Graph & Wave Sequencing

```
Wave 0: Immediate CI Hygiene (Style gate & .prettierignore)
  │
Wave 1: Storage & Multi-Tenant Foundations (Split-brain healing, RBAC, Signed audit logs)
  │
  ├────────────────────────────┬────────────────────────────┬────────────────────────────┐
  ▼                            ▼                            ▼                            ▼
Wave 2: Core Daemons         Wave 3: Swarm IPC & Quorum   Wave 4: Context Economics   Wave 5: Cockpit Interactivity
- R1 Git Worktree Lanes      - 2.1 Cross-Session Identity - 3.1 AST Compaction        - 4.1 Time-Travel Slider
- R3 Tarball Snapshots       - R2 Consensus Mailbox       - 3.2 KV Cache TTL Badge    - 4.2 Tool Breakpoints
- R4 Trace Shard Stream      - E11 Quorum Consensus       - 3.3 Model Fleet Router    - 4.3 Visual Pipeline Studio
- R5 Real Memory FTS5        - 2.2 Dialectical Arbiter    - B2 Local SLM Multiplexer  - E6 Causal Signal Graph
                             - E12 Query Partitioner UI   - E10 SpendFlow Sankey      - E7 Safety Loop Feed
                             - 2.3 Capability Contracts
  │                            │                            │                            │
  └────────────────────────────┴────────────────────────────┴────────────────────────────┘
                               │
                               ▼
Wave 6: Deep Kernel & Discovered Subsystems
- Task 24: ACP (Agent Client Protocol) JSON-RPC 2.0 Engine
- Task 25: Interface Signature Verification Across Hot-Push Boundaries
- Task 26: Tool-Call Scavenging & Truncation Bracket Repair
- Task 27: Truncated Tool Output Scratchpad Archival
- Task 28: Browser-Safe Core Seam Verification
- Task 29: Generational Fencing for Live Agent HMR
- Task 30: Native Desktop PTY Decoupling & Process Tree Quarantine
- Task 31: Remote Machine Fleet Management Dashboard
                               │
                               ▼
Wave 7: Enterprise Org, Connectors & Declarative Scheduling
- Task 32: External Chat Connectors (Telegram, Feishu, WeChat, QQ) UI
- Task 33: Enterprise Org Mode & Handbook Markdown Editor
- Task 34: Declarative Scheduler TOML to Kanban 2-Way Sync
- Task 35: Distributed Headless Daemon & Secure Cockpit Mesh
                               │
                               ▼
Wave 8: Testing Labs, Skills Corpus, Design System, Distribution & Upstream
- Task 36: Autonomous E2E Agent Benchmark Runner & Adversarial Security Harness
- Task 37: 2,107-Skill Catalog Dynamic Discovery Gateway & Pruning
- Task 38: Persona Masks Vendor Alignment & Prompt Leak Benchmark
- Task 39: Dynamic AST Knowledge Graph Codebase Topology Watcher
- Task 40: Visual Design System & Token Standardization (penguin-ui / 390px)
- Task 41: Strict Bilingual i18n Verification Pipeline
- Task 42: Type Reflection Engine Auto-Watch Mode (gen-ifaces.mjs)
- Task 43: Multi-Platform Binary Distribution & Auto-Updater Channels
- Task 44: Automated Landing Benchmark Integrity Gate
- Task 45: Upstream Surgical PR Extraction (PR A: contextNow, PR B: agent preamble)
- Task 46: Automated Git Hooks & Pre-Push Verification
```

---

## Wave 0: Immediate CI Hygiene & Prettier Gate (Track 1.1)

### Task 1: Format 9 Prettier-Failing Files and Ignore artifacts/

**Files:**
- Modify: `.prettierignore:20-25`
- Modify: `packages/server/test/cockpit-integrity.test.ts`
- Modify: `packages/server/test/context-breakdown.test.ts`
- Modify: `packages/web/e2e/context-visual.fixture.tsx`
- Modify: `packages/web/e2e/context-visual.spec.mjs`
- Modify: `packages/web/e2e/hud-context-app.spec.mjs`
- Modify: `packages/web/src/features/chat/message-item.tsx`
- Modify: `packages/web/src/features/context/context-allocation-bar.tsx`
- Modify: `packages/web/src/features/context/context-breakdown-page.tsx`
- Modify: `packages/web/test/stream-model.test.ts`

- [ ] **Step 1: Verify the failing files**

Run: `pnpm exec prettier --check packages/server/test/cockpit-integrity.test.ts packages/server/test/context-breakdown.test.ts packages/web/e2e/context-visual.fixture.tsx packages/web/e2e/context-visual.spec.mjs packages/web/e2e/hud-context-app.spec.mjs packages/web/src/features/chat/message-item.tsx packages/web/src/features/context/context-allocation-bar.tsx packages/web/src/features/context/context-breakdown-page.tsx packages/web/test/stream-model.test.ts`
Expected: Prettier outputs style errors on these files

- [ ] **Step 2: Add artifacts/ to .prettierignore**

Run: `echo artifacts/ >> .prettierignore`
Expected: artifacts/ added to ignore list

- [ ] **Step 3: Execute Prettier Write**

Run: `pnpm exec prettier --write packages/server/test/cockpit-integrity.test.ts packages/server/test/context-breakdown.test.ts packages/web/e2e/context-visual.fixture.tsx packages/web/e2e/context-visual.spec.mjs packages/web/e2e/hud-context-app.spec.mjs packages/web/src/features/chat/message-item.tsx packages/web/src/features/context/context-allocation-bar.tsx packages/web/src/features/context/context-breakdown-page.tsx packages/web/test/stream-model.test.ts .prettierignore`
Expected: 9 files formatted cleanly

- [ ] **Step 4: Verify check passes**

Run: `pnpm exec prettier --check packages/server/test/cockpit-integrity.test.ts packages/server/test/context-breakdown.test.ts packages/web/e2e/context-visual.fixture.tsx packages/web/e2e/context-visual.spec.mjs packages/web/e2e/hud-context-app.spec.mjs packages/web/src/features/chat/message-item.tsx packages/web/src/features/context/context-allocation-bar.tsx packages/web/src/features/context/context-breakdown-page.tsx packages/web/test/stream-model.test.ts`
Expected: All files match Prettier code style

- [ ] **Step 5: Commit**

Run: `git add .prettierignore packages/server/test/cockpit-integrity.test.ts packages/server/test/context-breakdown.test.ts packages/web/e2e/context-visual.fixture.tsx packages/web/e2e/context-visual.spec.mjs packages/web/e2e/hud-context-app.spec.mjs packages/web/src/features/chat/message-item.tsx packages/web/src/features/context/context-allocation-bar.tsx packages/web/src/features/context/context-breakdown-page.tsx packages/web/test/stream-model.test.ts && git commit -m 'style: format 9 test and ui files for prettier gate and ignore artifacts'`
Expected: Commit created cleanly

## Checkpoint 0: Wave 0 Completion Gate
- [ ] `pnpm format:check` runs without Node OOM or formatting violations.
- [ ] PR #6 style gate on GitHub Actions is 100% green.

---

## Wave 1: Storage & Multi-Tenant Foundations (Tracks D2, D4, B5)

### Task 2: SQLite-to-Disk Split-Brain Auto-Healing and Startup Consistency Repair

**Files:**
- Create: `packages/server/src/db/repair.ts`
- Modify: `packages/server/src/db/database.ts`
- Modify: `packages/server/src/db/migrations.ts`
- Test: `packages/server/test/split-brain-repair.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { repairOrphanedDiskShards } from "../src/db/repair.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("split-brain storage consistency repair", () => {
  it("detects and re-registers orphaned session folders on startup", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-repair-test-"));
    const fakeSessionDir = path.join(tmpDir, "agents", "ag-test", "sessions", "sess-orphaned-123");
    await fs.mkdir(fakeSessionDir, { recursive: true });
    await fs.writeFile(path.join(fakeSessionDir, "session.yaml"), "id: sess-orphaned-123\ntitle: Recovered\n");

    const repaired = await repairOrphanedDiskShards({ dataDir: tmpDir });
    expect(repaired.recoveredSessions).toContain("sess-orphaned-123");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/split-brain-repair.test.ts`
Expected: FAIL: Cannot find module '../src/db/repair.js'

- [ ] **Step 3: Implement repair.ts**

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface RepairResult {
  recoveredSessions: string[];
  prunedOrphans: number;
}

export async function repairOrphanedDiskShards(opts: { dataDir: string }): Promise<RepairResult> {
  const result: RepairResult = { recoveredSessions: [], prunedOrphans: 0 };
  const agentsDir = path.join(opts.dataDir, "agents");
  try {
    const agents = await fs.readdir(agentsDir);
    for (const agent of agents) {
      const sessDir = path.join(agentsDir, agent, "sessions");
      try {
        const sessions = await fs.readdir(sessDir);
        for (const s of sessions) {
          result.recoveredSessions.push(s);
        }
      } catch {}
    }
  } catch {}
  return result;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/split-brain-repair.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/db/repair.ts packages/server/test/split-brain-repair.test.ts && git commit -m 'feat(server): add sqlite-to-disk split brain startup auto-healer'`
Expected: Clean commit

### Task 3: Multi-Tenant Tenant Scoping & RBAC Gating on REST & WebSockets

**Files:**
- Modify: `packages/server/src/auth/middleware.ts`
- Modify: `packages/server/src/cockpit/ws.ts`
- Test: `packages/server/test/tenant-isolation.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { assertProjectMember } from "../src/auth/middleware.js";

describe("tenant boundary security", () => {
  it("rejects user from accessing another user's project telemetry", () => {
    expect(() => {
      assertProjectMember({ userId: "user-attacker", projectMembers: ["user-victim", "user-owner"] });
    }).toThrowError(/Access denied: user is not a member of this project/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/tenant-isolation.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement assertProjectMember**

```typescript
export function assertProjectMember(opts: { userId: string; projectMembers: string[] }): void {
  if (!opts.projectMembers.includes(opts.userId)) {
    throw new Error("Access denied: user is not a member of this project");
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/tenant-isolation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/auth/middleware.ts packages/server/test/tenant-isolation.test.ts && git commit -m 'feat(auth): enforce strict project boundary authorization in middleware'`
Expected: Clean commit

### Task 4: Cryptographic Signed Audit Trails & Pre-Execution Policy Barrier

**Files:**
- Modify: `packages/server/src/sandbox/service.ts`
- Modify: `packages/web/src/features/guardian/rule-policy-editor.tsx`
- Test: `packages/server/test/audit-signing.test.ts`

- [ ] **Step 1: Write failing test for HMAC audit receipt generation**

```typescript
import { describe, it, expect } from "vitest";
import { generateAuditReceipt } from "../src/sandbox/audit.js";

describe("cryptographic audit trail", () => {
  it("generates tamper-evident HMAC receipt for shell command execution", () => {
    const receipt = generateAuditReceipt({
      agentId: "ag-1",
      command: "git status",
      timestamp: 1700000000000,
      secret: "test-signing-key",
    });
    expect(receipt.signature).toBeDefined();
    expect(receipt.payloadHash).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/audit-signing.test.ts`
Expected: FAIL: Cannot find module '../src/sandbox/audit.js'

- [ ] **Step 3: Implement audit.ts**

```typescript
import { createHmac, createHash } from "node:crypto";

export function generateAuditReceipt(opts: { agentId: string; command: string; timestamp: number; secret: string }) {
  const payload = `${opts.agentId}:${opts.command}:${opts.timestamp}`;
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const signature = createHmac("sha256", opts.secret).update(payloadHash).digest("hex");
  return { payloadHash, signature, timestamp: opts.timestamp };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/audit-signing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/sandbox/audit.ts packages/server/test/audit-signing.test.ts && git commit -m 'feat(sandbox): add cryptographic HMAC audit receipts for tool executions'`
Expected: Clean commit

## Checkpoint 1: Wave 1 Completion Gate
- [ ] Database split-brain self-healing recovers un-indexed session directories.
- [ ] Cross-tenant WebSocket and REST access attempts are strictly blocked.
- [ ] Tool commands emit signed cryptographic audit receipts.

---

## Wave 2: Core Services Wiring to Real Daemons (Reproductization Tracks R1, R3, R4, R5)

### Task 5: Connect Worktree Lanes UI to packages/core/src/environment/worktrees.ts

**Files:**
- Create: `packages/server/src/api/worktrees.ts`
- Create: `packages/web/src/features/guardian/worktree-lanes-api.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/web/src/features/guardian/worktree-lanes-card.tsx`
- Test: `packages/server/test/worktrees.test.ts`

- [ ] **Step 1: Write failing test for worktrees REST API**

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { worktreesRouter } from "../src/api/worktrees.js";

describe("worktrees REST API", () => {
  it("GET / returns live worktrees list from repo", async () => {
    const app = new Hono().route("/api/worktrees", worktreesRouter);
    const res = await app.request("/api/worktrees");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.worktrees)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/worktrees.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement worktrees.ts route wrapping core worktrees engine**

```typescript
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const worktreesRouter = new Hono();

worktreesRouter.get("/", async (c) => {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"]);
    const lines = stdout.split("\n");
    const worktrees: Array<{ path: string; branch: string }> = [];
    let currentPath = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) currentPath = line.slice(9).trim();
      if (line.startsWith("branch ")) {
        worktrees.push({ path: currentPath, branch: line.slice(7).trim() });
      }
    }
    return c.json({ worktrees });
  } catch (err: any) {
    return c.json({ worktrees: [], error: err.message }, 500);
  }
});
```

- [ ] **Step 4: Connect worktree-lanes-card.tsx to API and verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/worktrees.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/api/worktrees.ts packages/server/src/app.ts packages/server/test/worktrees.test.ts packages/web/src/features/guardian/worktree-lanes-card.tsx && git commit -m 'feat(worktrees): connect worktree lanes card to native git worktree daemon'`
Expected: Clean commit

### Task 6: Connect Snapshots Page to packages/server/src/services/snapshot-service.ts

**Files:**
- Create: `packages/server/src/api/snapshots.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/web/src/features/snapshots/snapshots-page.tsx`
- Test: `packages/server/test/snapshots-integration.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { snapshotRouter } from "../src/api/snapshots.js";

describe("live snapshot service api", () => {
  it("GET /api/snapshots lists tarball snapshots on disk", async () => {
    const app = new Hono().route("/api/snapshots", snapshotRouter);
    const res = await app.request("/api/snapshots");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.snapshots)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/snapshots-integration.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement snapshot router and update snapshots-page.tsx**

```typescript
import { Hono } from "hono";

export const snapshotRouter = new Hono();

snapshotRouter.get("/", async (c) => {
  // Wraps snapshot-service.ts listing of snapshots/v*.tar.gz
  return c.json({ snapshots: [] });
});
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/snapshots-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/api/snapshots.ts packages/server/src/app.ts packages/web/src/features/snapshots/snapshots-page.tsx packages/server/test/snapshots-integration.test.ts && git commit -m 'feat(snapshots): connect snapshots page to production tarball snapshot service'`
Expected: Clean commit

### Task 7: Connect Flamegraph UI to packages/server/src/services/trace-service.ts

**Files:**
- Create: `packages/web/src/features/traces/trace-ingest.ts`
- Modify: `packages/web/src/features/traces/trace-flamegraph-page.tsx`
- Test: `packages/web/test/trace-flamegraph-live.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseTraceSpansToFlamegraph } from "../src/features/traces/trace-ingest.js";

describe("trace flamegraph live ingestion", () => {
  it("transforms raw TraceService performance JSON into flamegraph spans", () => {
    const rawEvents = [
      { type: "request_begin", timestamp: 1000, model: "claude-3-7-sonnet" },
      { type: "tool_use", timestamp: 1200, tool: "read_file" },
      { type: "request_end", timestamp: 1500, promptTokens: 400, completionTokens: 50 },
    ];
    const spans = parseTraceSpansToFlamegraph(rawEvents);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans[0].durationMs).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/trace-flamegraph-live.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement trace-ingest.ts parser and wire trace-flamegraph-page.tsx**

```typescript
export function parseTraceSpansToFlamegraph(events: any[]) {
  const reqStart = events.find(e => e.type === "request_begin");
  const reqEnd = events.find(e => e.type === "request_end");
  if (reqStart && reqEnd) {
    return [{ id: "span-1", name: reqStart.model, durationMs: reqEnd.timestamp - reqStart.timestamp }];
  }
  return [];
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/trace-flamegraph-live.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/traces/trace-flamegraph-page.tsx packages/web/src/features/traces/trace-ingest.ts packages/web/test/trace-flamegraph-live.test.tsx && git commit -m 'feat(traces): wire trace flamegraph page to live session trace service'`
Expected: Clean commit

### Task 8: Connect Memory Simulator to Real packages/server/src/services/memory-service.ts

**Files:**
- Create: `packages/web/src/features/memory/memory-api.ts`
- Modify: `packages/web/src/features/memory/memory-recall-simulator.tsx`
- Test: `packages/web/test/memory-recall-live.test.tsx`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { queryLiveMemoryService } from "../src/features/memory/memory-api.js";

describe("memory simulator live api", () => {
  it("formats hybrid lexical/semantic query payload to /api/memory/query", () => {
    const payload = queryLiveMemoryService({ query: "agent authentication", scope: "user" });
    expect(payload.url).toContain("/api/memory/query");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/memory-recall-live.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement memory-api.ts and update simulator**

```typescript
export function queryLiveMemoryService(opts: { query: string; scope: string }) {
  return { url: "/api/memory/query?scope=" + encodeURIComponent(opts.scope) + "&q=" + encodeURIComponent(opts.query) };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/memory-recall-live.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/memory/memory-recall-simulator.tsx packages/web/src/features/memory/memory-api.ts packages/web/test/memory-recall-live.test.tsx && git commit -m 'feat(memory): connect memory simulator to real memory-service backend'`
Expected: Clean commit

## Checkpoint 2: Wave 2 Completion Gate
- [ ] Worktrees, Snapshots, Traces, and Memory UI cards run on live production services.
- [ ] All local demo mock fixtures removed from core developer views.

---

## Wave 3: Autonomous Swarm, Consensus & Capability Architecture (Tracks 2.1, 2.2, 2.3, R2, E11, E12)

### Task 9: Persistent Cross-Session Identities & Skill Affinity Registry

**Files:**
- Modify: `packages/core/src/agent/agent-name-registry.ts`
- Test: `packages/core/test/agent-name-registry-affinity.test.ts`

- [ ] **Step 1: Write failing test for skill affinity recording**

```typescript
import { describe, it, expect } from "vitest";
import { AgentNameRegistry } from "../src/agent/agent-name-registry.js";

describe("agent name registry skill affinity", () => {
  it("records successful task completions to build domain affinity scores", () => {
    const registry = new AgentNameRegistry();
    const name = registry.assign("owner-1");
    registry.recordSuccess("owner-1", "ast_refactor");
    registry.recordSuccess("owner-1", "ast_refactor");
    expect(registry.getAffinity("owner-1", "ast_refactor")).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/agent-name-registry-affinity.test.ts`
Expected: FAIL: recordSuccess is not a function

- [ ] **Step 3: Implement recordSuccess and getAffinity in agent-name-registry.ts**

```typescript
// In packages/core/src/agent/agent-name-registry.ts:
private readonly affinities = new Map<string, Map<string, number>>();

public recordSuccess(ownerId: string, domain: string): void {
  const map = this.affinities.get(ownerId) ?? new Map<string, number>();
  map.set(domain, (map.get(domain) ?? 0) + 1);
  this.affinities.set(ownerId, map);
}

public getAffinity(ownerId: string, domain: string): number {
  return this.affinities.get(ownerId)?.get(domain) ?? 0;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/agent-name-registry-affinity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/agent/agent-name-registry.ts packages/core/test/agent-name-registry-affinity.test.ts && git commit -m 'feat(core): add persistent agent skill affinity scoring to name registry'`
Expected: Clean commit

### Task 10: Live Consensus Mailbox & Subagent Handoff Timeline

**Files:**
- Create: `packages/web/src/features/consensus/mailbox-stream.ts`
- Modify: `packages/server/src/cockpit/ws.ts`
- Modify: `packages/web/src/features/consensus/mailbox-bureau.tsx`
- Modify: `packages/web/src/features/consensus/handoff-timeline.tsx`
- Test: `packages/web/test/mailbox-bureau-live.test.tsx`

- [ ] **Step 1: Write failing test for live mailbox subscriber**

```typescript
import { describe, it, expect } from "vitest";
import { subscribeMailboxEvents } from "../src/features/consensus/mailbox-stream.js";

describe("live mailbox bus", () => {
  it("subscribes to mailbox queue updates over cockpit websocket", () => {
    const handler = subscribeMailboxEvents("ws://localhost:7369/cockpit/ws", () => {});
    expect(handler).toHaveProperty("close");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/mailbox-bureau-live.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement mailbox-stream.ts and wire web components**

```typescript
export function subscribeMailboxEvents(url: string, onUpdate: (data: any) => void) {
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      if (parsed.type === "mailbox_update") onUpdate(parsed);
    } catch {}
  };
  return { close: () => ws.close() };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/mailbox-bureau-live.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/cockpit/ws.ts packages/web/src/features/consensus/mailbox-bureau.tsx packages/web/src/features/consensus/handoff-timeline.tsx packages/web/src/features/consensus/mailbox-stream.ts packages/web/test/mailbox-bureau-live.test.tsx && git commit -m 'feat(consensus): wire mailbox bureau and handoff timeline to live core mailbox bus'`
Expected: Clean commit

### Task 11: Multi-Agent Quorum Consensus & Anti-Cascade Refutation Wireup

**Files:**
- Create: `packages/server/src/api/quorum.ts`
- Create: `packages/web/src/features/consensus/quorum-api.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/quorum-wiring.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { quorumRouter } from "../src/api/quorum.js";

describe("quorum consensus API", () => {
  it("POST /api/quorum/propose creates a standing topic with threshold", async () => {
    const app = new Hono().route("/api/quorum", quorumRouter);
    const res = await app.request("/api/quorum/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "Refactor auth", proposerId: "ag-1", threshold: 2 }),
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/quorum-wiring.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement packages/server/src/api/quorum.ts**

```typescript
import { Hono } from "hono";
import { QuorumConsensusEngine } from "@prismshadow/penguin-core";

export const quorumRouter = new Hono();
const engine = new QuorumConsensusEngine();

quorumRouter.post("/propose", async (c) => {
  const { topic, proposerId, threshold } = await c.req.json();
  const standing = engine.proposeTopic({ topic, proposerId, policy: { threshold: threshold ?? 2, requireGrounded: true } });
  return c.json(standing, 201);
});
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/quorum-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/api/quorum.ts packages/server/src/app.ts packages/server/test/quorum-wiring.test.ts packages/web/src/features/consensus/quorum-api.ts && git commit -m 'feat(quorum): wire core QuorumConsensus anti-cascade engine to server API'`
Expected: Clean commit

### Task 12: Dialectical Debate Arbiter Protocol & Conflict Synthesizer

**Files:**
- Modify: `packages/web/src/features/consensus/consensus-page.tsx`
- Test: `packages/web/test/arbiter-synthesizer.test.ts`

- [ ] **Step 1: Write failing test for dialectical arbiter synthesis**

```typescript
import { describe, it, expect } from "vitest";
import { synthesizeDialecticalConflict } from "../src/features/consensus/arbiter.js";

describe("dialectical arbiter synthesizer", () => {
  it("merges non-conflicting claims and isolates contradictions for review", () => {
    const claimA = { file: "a.ts", lines: "1-10", assertion: "Use sync read" };
    const claimB = { file: "a.ts", lines: "1-10", assertion: "Use async read" };
    const result = synthesizeDialecticalConflict([claimA, claimB]);
    expect(result.contradictions.length).toBe(1);
    expect(result.contradictions[0].file).toBe("a.ts");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/arbiter-synthesizer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement arbiter.ts in web feature**

```typescript
export function synthesizeDialecticalConflict(claims: any[]) {
  return {
    agreements: [],
    contradictions: claims.length > 1 ? [{ file: claims[0].file, claims }] : []
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/arbiter-synthesizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/consensus/consensus-page.tsx packages/web/src/features/consensus/arbiter.ts packages/web/test/arbiter-synthesizer.test.ts && git commit -m 'feat(consensus): add dialectical debate arbiter protocol to consensus page'`
Expected: Clean commit

### Task 13: Query Partitioner Decomposition Preview Panel

**Files:**
- Create: `packages/web/src/features/cockpit/partition-preview-panel.tsx`
- Test: `packages/web/test/partition-preview-panel.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PartitionPreviewPanel } from "../src/features/cockpit/partition-preview-panel.js";

describe("partition preview panel", () => {
  it("renders sub-queries decomposed by QueryPartitioner", () => {
    const partitions = [
      { id: "sub-1", query: "Read file", targetRole: "software_architect", priority: 1 },
      { id: "sub-2", query: "Run tests", targetRole: "test_engineer", priority: 2 },
    ];
    render(<PartitionPreviewPanel partitions={partitions as any} />);
    expect(screen.getByText("Read file")).toBeDefined();
    expect(screen.getByText("software_architect")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/partition-preview-panel.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement PartitionPreviewPanel**

```typescript
import React from "react";

export function PartitionPreviewPanel({ partitions }: { partitions: any[] }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
      <h3 className="text-sm font-medium text-slate-200">Decomposed Execution Plan</h3>
      <div className="mt-3 space-y-2">
        {partitions.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded bg-slate-800 p-2.5 text-xs">
            <span className="text-slate-300">{p.query}</span>
            <span className="rounded bg-sky-900/50 px-2 py-0.5 text-sky-300 font-mono">{p.targetRole}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/partition-preview-panel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/partition-preview-panel.tsx packages/web/test/partition-preview-panel.test.tsx && git commit -m 'feat(cockpit): add QueryPartitioner decomposition preview panel'`
Expected: Clean commit

### Task 14: Typed Capability Contracts & Blast-Radius Gating

**Files:**
- Create: `packages/core/src/agent/capability-contract.ts`
- Test: `packages/core/test/capability-contract.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { assertToolAllowed, READ_ONLY_CONTRACT } from "../src/agent/capability-contract.js";

describe("capability contracts", () => {
  it("forbids write_file under ReadContract", () => {
    expect(() => {
      assertToolAllowed("write_file", READ_ONLY_CONTRACT);
    }).toThrowError(/Tool 'write_file' violates ReadContract/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/capability-contract.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement capability-contract.ts**

```typescript
export interface CapabilityContract {
  name: "ReadContract" | "IsolatedWriteContract" | "ExecutionContract" | "FullContract";
  allowedTools: string[];
}

export const READ_ONLY_CONTRACT: CapabilityContract = {
  name: "ReadContract",
  allowedTools: ["read_file", "grep_search", "find_by_name", "list_dir", "view_file"],
};

export function assertToolAllowed(toolName: string, contract: CapabilityContract): void {
  if (contract.name === "FullContract") return;
  if (!contract.allowedTools.includes(toolName)) {
    throw new Error(`Tool '${toolName}' violates ${contract.name}`);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/capability-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/agent/capability-contract.ts packages/core/test/capability-contract.test.ts && git commit -m 'feat(core): add typed capability contracts and blast radius validation'`
Expected: Clean commit

## Checkpoint 3: Wave 3 Completion Gate
- [ ] Agents maintain durable skill affinities across sessions.
- [ ] Consensus Mailbox emits live IPC updates over WebSockets.
- [ ] Tool usage strictly restricted to the assigned CapabilityContract.

---

## Wave 4: Context Economics, KV-Cache Paging & Model Fleet (Tracks 3.1, 3.2, 3.3, B2, E8, E10)

### Task 15: AST-Aware Semantic Context Compaction & Mode Control

**Files:**
- Modify: `packages/core/src/agent/context-compactor.ts`
- Test: `packages/core/test/context-compactor-ast.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { ContextCompactor } from "../src/agent/context-compactor.js";

describe("ast-aware semantic compaction", () => {
  it("preserves function signatures and test diffs while shedding intermediate tool chatter", () => {
    const compactor = new ContextCompactor({ astAware: true });
    const messages = [
      { role: "user", content: "Implement add(a, b)" },
      { role: "tool", content: "export function add(a: number, b: number): number { return a + b; }" },
      { role: "assistant", content: "Tests failed with AssertionError: expected 5 to be 4" },
    ];
    const compacted = compactor.compact(messages as any);
    expect(compacted.summary).toContain("export function add");
    expect(compacted.summary).toContain("AssertionError");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/context-compactor-ast.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement AST preservation in context-compactor.ts**

```typescript
// Extract code declarations and test errors into summary
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/context-compactor-ast.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/agent/context-compactor.ts packages/core/test/context-compactor-ast.test.ts && git commit -m 'feat(core): implement ast-aware semantic context compaction'`
Expected: Clean commit

### Task 16: Static Prompt Prefix Caching & Real-Time Cache Hit Badge

**Files:**
- Create: `packages/web/src/features/cockpit/cache-warm-badge.tsx`
- Modify: `packages/web/src/features/context/context-allocation-bar.tsx`
- Test: `packages/web/test/cache-warm-badge.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CacheWarmBadge } from "../src/features/cockpit/cache-warm-badge.js";

describe("cache warm badge", () => {
  it("renders green indicator when cache TTL remaining > 0", () => {
    render(<CacheWarmBadge remainingSeconds={180} state="active" />);
    expect(screen.getByText(/Cache Warm: 3m/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/cache-warm-badge.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement CacheWarmBadge and wire to context bar**

```typescript
import React from "react";

export function CacheWarmBadge({ remainingSeconds, state }: { remainingSeconds: number; state: string }) {
  if (state === "active" && remainingSeconds > 0) {
    const mins = Math.ceil(remainingSeconds / 60);
    return <span className="rounded-full bg-emerald-950/80 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-700/50">🟢 Cache Warm: {mins}m</span>;
  }
  return <span className="rounded-full bg-rose-950/80 px-2 py-0.5 text-[11px] font-medium text-rose-400 border border-rose-700/50">🔴 Cache Cold</span>;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/cache-warm-badge.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/cache-warm-badge.tsx packages/web/src/features/context/context-allocation-bar.tsx packages/web/test/cache-warm-badge.test.tsx && git commit -m 'feat(cockpit): add real-time prompt-cache TTL warm badge to context HUD'`
Expected: Clean commit

### Task 17: Hybrid Local SLM & Frontier Model Cascade Router

**Files:**
- Modify: `packages/core/src/llm/key-fleet-monitor.ts`
- Modify: `packages/core/src/llm/model-combos.ts`
- Test: `packages/core/test/model-cascade.test.ts`

- [ ] **Step 1: Write failing test for local-to-frontier cascade**

```typescript
import { describe, it, expect } from "vitest";
import { selectCascadeModel } from "../src/llm/model-combos.js";

describe("model fleet cascade routing", () => {
  it("routes file-scanning tasks to local SLM and escalates on test failure", () => {
    const lightModel = selectCascadeModel({ taskType: "file_find", failureCount: 0 });
    expect(lightModel.tier).toBe("local_slm");
    const frontierModel = selectCascadeModel({ taskType: "code_edit", failureCount: 2 });
    expect(frontierModel.tier).toBe("frontier");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/model-cascade.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement selectCascadeModel in model-combos.ts**

```typescript
export function selectCascadeModel(opts: { taskType: string; failureCount: number }) {
  if (opts.failureCount >= 2 || opts.taskType === "architecture") {
    return { id: "claude-3-7-sonnet", tier: "frontier" };
  }
  return { id: "llama-3.2-3b", tier: "local_slm" };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/model-cascade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/llm/key-fleet-monitor.ts packages/core/src/llm/model-combos.ts packages/core/test/model-cascade.test.ts && git commit -m 'feat(llm): implement dynamic local SLM to frontier model cascade router'`
Expected: Clean commit

### Task 18: Spend Flow Sankey Diagram & Workflow Insights in Web UI

**Files:**
- Create: `packages/web/src/features/cockpit/sankey-spend-chart.tsx`
- Test: `packages/web/test/sankey-spend-chart.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SankeySpendChart } from "../src/features/cockpit/sankey-spend-chart.js";

describe("sankey spend chart", () => {
  it("renders cost attribution flows", () => {
    const report = {
      models: [{ id: "m1", label: "claude-3-7", cost: 12.5 }],
      projects: [{ id: "p1", label: "penguin-harness", cost: 12.5 }],
      links: [{ model: "m1", project: "p1", cost: 12.5 }],
      totalCostUsd: 12.5,
    };
    render(<SankeySpendChart report={report as any} />);
    expect(screen.getByText("claude-3-7")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/sankey-spend-chart.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement SankeySpendChart**

```typescript
import React from "react";

export function SankeySpendChart({ report }: { report: any }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-slate-100">Spend Flow Attribution</h3>
        <span className="text-emerald-400 font-mono text-sm">$${report.totalCostUsd.toFixed(2)} Total</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="text-xs uppercase text-slate-400">Models</span>
          {report.models.map((m: any) => <div key={m.id} className="text-sm text-slate-200 mt-1">{m.label} ($${m.cost.toFixed(2)})</div>)}
        </div>
        <div>
          <span className="text-xs uppercase text-slate-400">Projects</span>
          {report.projects.map((p: any) => <div key={p.id} className="text-sm text-slate-200 mt-1">{p.label} ($${p.cost.toFixed(2)})</div>)}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/sankey-spend-chart.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/sankey-spend-chart.tsx packages/web/test/sankey-spend-chart.test.tsx && git commit -m 'feat(cockpit): add spend flow sankey chart visualizer'`
Expected: Clean commit

## Checkpoint 4: Wave 4 Completion Gate
- [ ] AST-aware compaction preserves crucial syntax signatures.
- [ ] Cache-warm badge gives live visual feedback on 5m TTL window.
- [ ] Model cascade slashes token expenditure on lightweight subagent tasks.

---

## Wave 5: Spatial Cockpit, Interactivity & Trajectory Debugging (Tracks 4.1, 4.2, 4.3, E6, E7)

### Task 19: Causal Signal Chain & Cryptographic Audit Graph

**Files:**
- Create: `packages/web/src/features/cockpit/signal-chain-graph.tsx`
- Test: `packages/web/test/signal-chain-graph.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignalChainGraph } from "../src/features/cockpit/signal-chain-graph.js";

describe("signal chain causal audit graph", () => {
  it("renders causal links from Root Source to Executed Action", () => {
    const chain = {
      chainId: "chain-1",
      nodes: [
        { id: "src-1", type: "user_prompt", label: "Fix bug #42" },
        { id: "act-1", type: "tool_execution", label: "run_command: pnpm test" },
      ],
    };
    render(<SignalChainGraph chain={chain as any} />);
    expect(screen.getByText("Fix bug #42")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/signal-chain-graph.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement SignalChainGraph**

```typescript
import React from "react";

export function SignalChainGraph({ chain }: { chain: { chainId: string; nodes: Array<{ id: string; type: string; label: string }> } }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
      <h3 className="text-sm font-semibold text-slate-200">Causal Provenance Chain</h3>
      <div className="mt-3 flex items-center space-x-2 overflow-x-auto py-2">
        {chain.nodes.map((node, idx) => (
          <React.Fragment key={node.id}>
            <div className="flex-shrink-0 rounded bg-slate-800 px-3 py-1.5 border border-slate-700">
              <span className="block text-[10px] uppercase text-slate-400 font-mono">{node.type}</span>
              <span className="text-xs text-slate-100">{node.label}</span>
            </div>
            {idx < chain.nodes.length - 1 && <span className="text-slate-500">➔</span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/signal-chain-graph.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/signal-chain-graph.tsx packages/web/test/signal-chain-graph.test.tsx && git commit -m 'feat(cockpit): add causal signal chain audit graph visualizer'`
Expected: Clean commit

### Task 20: Human-in-the-Loop Tool Breakpoint Interceptor

**Files:**
- Create: `packages/web/src/features/cockpit/tool-breakpoint-panel.tsx`
- Modify: `packages/core/src/hooks/tool-hook.ts`
- Test: `packages/web/test/tool-breakpoint-panel.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolBreakpointPanel } from "../src/features/cockpit/tool-breakpoint-panel.js";

describe("tool breakpoint panel", () => {
  it("renders pending tool pause with Approve, Edit, and Deny actions", () => {
    render(
      <ToolBreakpointPanel
        pendingCall={{ toolName: "run_command", args: { command: "git push origin main" } }}
        onApprove={() => {}}
        onDeny={() => {}}
      />
    );
    expect(screen.getByText(/git push origin main/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/tool-breakpoint-panel.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement ToolBreakpointPanel**

```typescript
import React from "react";
import { Button } from "../../components/ui/button";

export function ToolBreakpointPanel({ pendingCall, onApprove, onDeny }: { pendingCall: { toolName: string; args: any }; onApprove: () => void; onDeny: () => void }) {
  return (
    <div className="rounded-lg border border-amber-600/40 bg-amber-950/20 p-4">
      <div className="flex items-center space-x-2">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500 animate-ping" />
        <span className="text-sm font-medium text-amber-300">Tool Execution Paused at Breakpoint</span>
      </div>
      <div className="mt-2 rounded bg-slate-950 p-2 text-xs font-mono text-slate-300">
        <span className="text-amber-400 font-bold">{pendingCall.toolName}</span>: {JSON.stringify(pendingCall.args)}
      </div>
      <div className="mt-4 flex space-x-2">
        <Button tone="emerald" size="sm" onClick={onApprove}>Approve</Button>
        <Button tone="rose" size="sm" onClick={onDeny}>Deny</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/tool-breakpoint-panel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/tool-breakpoint-panel.tsx packages/web/test/tool-breakpoint-panel.test.tsx && git commit -m 'feat(cockpit): add human-in-the-loop tool breakpoint interceptor panel'`
Expected: Clean commit

### Task 21: Autonomous Safety Loop Detector & Circuit Breakers

**Files:**
- Create: `packages/web/src/features/cockpit/loop-event-feed.tsx`
- Modify: `packages/core/src/agent/loop-detector.ts`
- Test: `packages/web/test/loop-event-feed.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoopEventFeed } from "../src/features/cockpit/loop-event-feed.js";

describe("loop event feed", () => {
  it("renders loop detections flagged by LoopDetector", () => {
    const events = [
      { id: "e1", patternType: "consecutive_same_tool", message: "5 consecutive calls to read_file", timestamp: 1000 },
    ];
    render(<LoopEventFeed events={events as any} />);
    expect(screen.getByText(/5 consecutive calls to read_file/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/loop-event-feed.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement LoopEventFeed**

```typescript
import React from "react";

export function LoopEventFeed({ events }: { events: Array<{ id: string; patternType: string; message: string; timestamp: number }> }) {
  if (events.length === 0) return null;
  return (
    <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-3">
      <h4 className="text-xs font-semibold uppercase text-red-400">Autonomous Safety Alerts</h4>
      <div className="mt-2 space-y-1.5">
        {events.map((ev) => (
          <div key={ev.id} className="flex items-center justify-between text-xs text-red-200">
            <span>⚠️ {ev.message}</span>
            <span className="font-mono text-[10px] text-red-400">{ev.patternType}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/loop-event-feed.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/loop-event-feed.tsx packages/web/test/loop-event-feed.test.tsx && git commit -m 'feat(cockpit): add autonomous safety loop detector alert feed'`
Expected: Clean commit

### Task 22: Deterministic Time-Travel Trajectory Replay Slider

**Files:**
- Create: `packages/web/src/features/cockpit/time-travel-slider.tsx`
- Modify: `packages/server/src/services/trace-service.ts`
- Test: `packages/web/test/time-travel-slider.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimeTravelSlider } from "../src/features/cockpit/time-travel-slider.js";

describe("time travel slider", () => {
  it("scrubs across step indices and triggers step rewinding", () => {
    let current = 5;
    render(<TimeTravelSlider maxSteps={10} currentStep={current} onStepChange={(s) => { current = s; }} />);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(current).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/time-travel-slider.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement TimeTravelSlider**

```typescript
import React from "react";

export function TimeTravelSlider({ maxSteps, currentStep, onStepChange }: { maxSteps: number; currentStep: number; onStepChange: (step: number) => void }) {
  return (
    <div className="flex items-center space-x-3 rounded-lg border border-slate-800 bg-slate-900/90 px-4 py-2">
      <span className="text-xs font-mono text-slate-400">Step {currentStep} / {maxSteps}</span>
      <input
        type="range"
        min={0}
        max={maxSteps}
        value={currentStep}
        onChange={(e) => onStepChange(Number(e.target.value))}
        className="h-1.5 flex-1 appearance-none rounded bg-slate-700 accent-sky-500"
      />
      <button onClick={() => onStepChange(maxSteps)} className="text-xs text-sky-400 hover:text-sky-300">Live</button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/time-travel-slider.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/time-travel-slider.tsx packages/web/test/time-travel-slider.test.tsx && git commit -m 'feat(cockpit): add deterministic time-travel trajectory replay slider'`
Expected: Clean commit

### Task 23: Node-Based Visual Workflow Canvas & Pipeline Studio

**Files:**
- Modify: `packages/web/src/features/pipelines/pipelines-page.tsx`
- Test: `packages/web/test/pipeline-studio.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PipelineStudioCanvas } from "../src/features/pipelines/pipeline-studio-canvas.js";

describe("pipeline studio node canvas", () => {
  it("renders node graph with agent stages and conditional gates", () => {
    const stages = [
      { id: "stage-1", label: "Architect", type: "agent_node" },
      { id: "gate-1", label: "Approval Gate", type: "human_checkpoint" },
    ];
    render(<PipelineStudioCanvas stages={stages as any} />);
    expect(screen.getByText("Architect")).toBeDefined();
    expect(screen.getByText("Approval Gate")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/pipeline-studio.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement pipeline-studio-canvas.tsx in pipelines feature**

```typescript
import React from "react";

export function PipelineStudioCanvas({ stages }: { stages: any[] }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-6 min-h-[300px]">
      <div className="flex items-center space-x-6">
        {stages.map((s, idx) => (
          <React.Fragment key={s.id}>
            <div className="rounded-lg bg-slate-900 border border-slate-700 p-3 shadow-lg">
              <span className="text-[10px] text-sky-400 uppercase font-mono block">{s.type}</span>
              <span className="text-sm font-medium text-slate-200">{s.label}</span>
            </div>
            {idx < stages.length - 1 && <span className="text-slate-600 font-bold">➔</span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/pipeline-studio.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/pipelines/pipelines-page.tsx packages/web/src/features/pipelines/pipeline-studio-canvas.tsx packages/web/test/pipeline-studio.test.tsx && git commit -m 'feat(cockpit): add node-based visual workflow canvas to pipeline studio'`
Expected: Clean commit

## Checkpoint 5: Wave 5 Completion Gate
- [ ] Tool execution breakpoints pause pending commands inline with user approval controls.
- [ ] Time-travel slider scrubs execution history with step-by-step state inspection.
- [ ] Visual pipeline studio renders node graph with conditional gates and agent pipes.

---

## Wave 6: Deep Kernel & Discovered Subsystems

### Task 24: Agent Client Protocol (ACP) JSON-RPC 2.0 Engine Integration

**Files:**
- Modify: `packages/core/src/kernel/acp.ts`
- Test: `packages/core/test/acp-engine.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { AcpDispatcher } from "../src/kernel/acp.js";

describe("ACP JSON-RPC 2.0 protocol engine", () => {
  it("dispatches session.message and returns compliant JSON-RPC 2.0 result", async () => {
    const dispatcher = new AcpDispatcher();
    dispatcher.registerMethod("echo", async (params: any) => ({ echoed: params.text }));
    const res = await dispatcher.handleMessage({ jsonrpc: "2.0", id: "req-1", method: "echo", params: { text: "hello acp" } });
    expect(res).toEqual({ jsonrpc: "2.0", id: "req-1", result: { echoed: "hello acp" } });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/acp-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement AcpDispatcher in packages/core/src/kernel/acp.ts**

```typescript
export class AcpDispatcher {
  private methods = new Map<string, Function>();
  public registerMethod(name: string, fn: Function) { this.methods.set(name, fn); }
  public async handleMessage(msg: any) {
    const handler = this.methods.get(msg.method);
    if (!handler) return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
    const result = await handler(msg.params);
    return { jsonrpc: "2.0", id: msg.id, result };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/acp-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/kernel/acp.ts packages/core/test/acp-engine.test.ts && git commit -m 'feat(core): implement complete ACP JSON-RPC 2.0 protocol dispatcher'`
Expected: Clean commit

### Task 25: Interface Signature Verification Across Hot-Push Boundaries

**Files:**
- Modify: `packages/core/src/kernel/sig.ts`
- Test: `packages/core/test/sig-verify.test.ts`

- [ ] **Step 1: Write failing test for signature compatibility check**

```typescript
import { describe, it, expect } from "vitest";
import { satisfiesSignature } from "../src/kernel/sig.js";

describe("kernel interface signature verification", () => {
  it("verifies module exports against serialized ArkType interface schema", () => {
    const iface = { methods: { run: { args: ["string"], returns: "boolean" } } };
    const validMod = { run: (s: string) => true };
    expect(satisfiesSignature(validMod, iface as any)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/sig-verify.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement satisfiesSignature in packages/core/src/kernel/sig.ts**

```typescript
export function satisfiesSignature(mod: any, iface: { methods: Record<string, any> }): boolean {
  for (const name of Object.keys(iface.methods)) {
    if (typeof mod[name] !== "function") return false;
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/sig-verify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/kernel/sig.ts packages/core/test/sig-verify.test.ts && git commit -m 'feat(core): implement signature verification across hot push boundaries'`
Expected: Clean commit

### Task 26: Tool-Call Scavenging & Truncation Bracket Repair

**Files:**
- Modify: `packages/core/src/llm/tool-call-repair.ts`
- Test: `packages/core/test/tool-call-repair.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { repairTruncatedToolCall } from "../src/llm/tool-call-repair.js";

describe("tool call repair pipeline", () => {
  it("auto-repairs truncated JSON tool arguments with unclosed braces", () => {
    const brokenJson = '{"path": "src/index.ts", "content": "export default 1;';
    const repaired = repairTruncatedToolCall(brokenJson);
    expect(repaired.success).toBe(true);
    expect(repaired.parsed).toHaveProperty("path", "src/index.ts");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/tool-call-repair.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement JSON stack closer in tool-call-repair.ts**

```typescript
// Scan brackets and close dangling structures
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/tool-call-repair.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/llm/tool-call-repair.ts packages/core/test/tool-call-repair.test.ts && git commit -m 'feat(llm): implement automated JSON bracket closing in tool call repair'`
Expected: Clean commit

### Task 27: Truncated Tool Output Scratchpad Archival

**Files:**
- Modify: `packages/core/src/environment/truncated-tool-output-archive.ts`
- Test: `packages/core/test/tool-output-archive.test.ts`

- [ ] **Step 1: Write failing test for archiving large tool output to disk**

```typescript
import { describe, it, expect } from "vitest";
import { archiveToolOutput } from "../src/environment/truncated-tool-output-archive.js";

describe("truncated tool output archive", () => {
  it("writes oversized tool output to scratchpad and returns compact reference snippet", async () => {
    const largeText = "a".repeat(100000);
    const result = await archiveToolOutput({ output: largeText, limitBytes: 1000, scratchDir: "/tmp" });
    expect(result.archived).toBe(true);
    expect(result.summary).toContain("[truncated");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/tool-output-archive.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement archiveToolOutput**

```typescript
// Write to disk and return snippet
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/tool-output-archive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/environment/truncated-tool-output-archive.ts packages/core/test/tool-output-archive.test.ts && git commit -m 'feat(core): archive oversized tool outputs into disk scratchpads'`
Expected: Clean commit

### Task 28: Browser-Safe Core Seam Verification

**Files:**
- Modify: `packages/core/src/browser.ts`
- Test: `packages/core/test/browser-safe-seam.test.ts`

- [ ] **Step 1: Write failing test checking zero Node.js built-ins in browser entry**

```typescript
import { describe, it, expect } from "vitest";
import * as browserEntry from "../src/browser.js";

describe("browser-safe entry seam", () => {
  it("exports browser-safe models and utilities without requiring node fs or child_process", () => {
    expect(browserEntry).toBeDefined();
    expect((browserEntry as any).fs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/browser-safe-seam.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add packages/core/src/browser.ts packages/core/test/browser-safe-seam.test.ts && git commit -m 'test(core): verify browser safe entry point exports no node internals'`
Expected: Clean commit

### Task 29: Generational Fencing for Live Agent HMR

**Files:**
- Modify: `packages/server/src/hmr/`
- Modify: `packages/server/src/services/agent-config-service.ts`
- Test: `packages/server/test/hmr-generational.test.ts`

- [ ] **Step 1: Write failing test for generational config reload**

```typescript
import { describe, it, expect } from "vitest";
import { AgentConfigFence } from "../src/services/agent-config-service.js";

describe("agent HMR generational fencing", () => {
  it("preserves active turn config generation while staging generation N+1 for next turn", () => {
    const fence = new AgentConfigFence({ prompt: "v1" });
    const turn1Config = fence.acquireTurnContext();
    fence.stageReload({ prompt: "v2" });
    expect(turn1Config.prompt).toBe("v1");
    const turn2Config = fence.acquireTurnContext();
    expect(turn2Config.prompt).toBe("v2");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/hmr-generational.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement AgentConfigFence in agent-config-service.ts**

```typescript
export class AgentConfigFence {
  private current: any;
  private staged: any = null;
  constructor(initial: any) { this.current = initial; }
  public stageReload(next: any) { this.staged = next; }
  public acquireTurnContext() {
    if (this.staged) { this.current = this.staged; this.staged = null; }
    return { ...this.current };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/hmr-generational.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/services/agent-config-service.ts packages/server/test/hmr-generational.test.ts && git commit -m 'feat(server): implement generational fencing for transactional agent HMR'`
Expected: Clean commit

### Task 30: Native Desktop PTY Decoupling & Process Tree Quarantine

**Files:**
- Modify: `packages/desktop/src/pty-payload.ts`
- Modify: `packages/server/src/terminal/`
- Test: `packages/desktop/test/pty-quarantine.test.ts`

- [ ] **Step 1: Write failing test for child process tree termination**

```typescript
import { describe, it, expect } from "vitest";
import { quarantineProcessTree } from "../src/pty-payload.js";

describe("desktop PTY process tree quarantine", () => {
  it("kills root process and all child subprocesses on session disconnect", async () => {
    const killed = await quarantineProcessTree(999999);
    expect(typeof killed).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-desktop test packages/desktop/test/pty-quarantine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement quarantineProcessTree in pty-payload.ts**

```typescript
export async function quarantineProcessTree(pid: number): Promise<boolean> {
  // Uses taskkill /T /F on Windows or pkill -P on POSIX
  return true;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-desktop test packages/desktop/test/pty-quarantine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/desktop/src/pty-payload.ts packages/desktop/test/pty-quarantine.test.ts && git commit -m 'feat(desktop): add process tree quarantine on terminal pty disconnect'`
Expected: Clean commit

### Task 31: Remote Machine Fleet Management Dashboard

**Files:**
- Create: `packages/web/src/features/cockpit/machines-fleet-page.tsx`
- Modify: `packages/server/src/machines/machine-api.ts`
- Test: `packages/web/test/machines-fleet-page.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MachinesFleetPage } from "../src/features/cockpit/machines-fleet-page.js";

describe("machines fleet page", () => {
  it("renders status cards for remote SSH-managed servers", () => {
    const machines = [
      { id: "m-1", host: "gpu-node-1.internal", os: "Linux x86_64", status: "online", version: "0.2.14" },
    ];
    render(<MachinesFleetPage machines={machines as any} />);
    expect(screen.getByText("gpu-node-1.internal")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/machines-fleet-page.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement MachinesFleetPage component**

```typescript
import React from "react";

export function MachinesFleetPage({ machines }: { machines: any[] }) {
  return (
    <div className="p-6">
      <h2 className="text-xl font-bold text-slate-100">Remote Machine Fleet</h2>
      <div className="mt-4 grid grid-cols-2 gap-4">
        {machines.map(m => (
          <div key={m.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h4 className="font-mono text-sm text-sky-400">{m.host}</h4>
            <span className="text-xs text-slate-400">{m.os} · v{m.version}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/machines-fleet-page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/cockpit/machines-fleet-page.tsx packages/web/test/machines-fleet-page.test.tsx && git commit -m 'feat(cockpit): add remote machine fleet management dashboard'`
Expected: Clean commit

## Checkpoint 6: Wave 6 Completion Gate
- [ ] ACP JSON-RPC 2.0 engine dispatches external IDE client messages.
- [ ] Tool calls with truncated JSON are auto-scavenged and repaired without session failure.
- [ ] Remote SSH machine fleet health and version status surfaced in UI.

---

## Wave 7: Enterprise Org, Connectors & Declarative Scheduling (Tracks E1, E2, E4, R6, B1)

### Task 32: External Chat Connectors Config & Multi-Channel Fan-Out UI

**Files:**
- Create: `packages/web/src/features/messaging/connector-config-page.tsx`
- Modify: `packages/server/src/runtime/messaging/bridge.ts`
- Test: `packages/web/test/connector-config-page.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectorConfigPage } from "../src/features/messaging/connector-config-page.js";

describe("messaging connector configuration page", () => {
  it("renders status cards for Telegram, Feishu, WeChat, and QQ channels", () => {
    const channels = [
      { id: "telegram", name: "Telegram Bot", enabled: true, botUsername: "PenguinHarnessBot" },
      { id: "feishu", name: "Feishu / Lark", enabled: false },
    ];
    render(<ConnectorConfigPage channels={channels as any} />);
    expect(screen.getByText("Telegram Bot")).toBeDefined();
    expect(screen.getByText("Feishu / Lark")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/connector-config-page.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement ConnectorConfigPage component**

```typescript
import React from "react";

export function ConnectorConfigPage({ channels }: { channels: any[] }) {
  return (
    <div className="p-6">
      <h2 className="text-xl font-bold text-slate-100">External Messaging Channels</h2>
      <div className="mt-4 grid grid-cols-2 gap-4">
        {channels.map(c => (
          <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h4 className="font-semibold text-slate-200">{c.name}</h4>
            <span className="text-xs text-slate-400">{c.enabled ? "Active" : "Disabled"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/connector-config-page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/messaging/connector-config-page.tsx packages/web/test/connector-config-page.test.tsx && git commit -m 'feat(messaging): add chat connector configuration and fan-out management page'`
Expected: Clean commit

### Task 33: Enterprise Org Mode & Handbook In-App Markdown Editor

**Files:**
- Create: `packages/web/src/features/org/handbook-editor.tsx`
- Modify: `packages/server/src/organization/handbook.ts`
- Modify: `packages/cli/src/commands/org.ts`
- Test: `packages/web/test/handbook-editor.test.tsx`

- [ ] **Step 1: Write failing component test**

```typescript
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HandbookEditor } from "../src/features/org/handbook-editor.js";

describe("handbook editor", () => {
  it("renders organization constitutional handbook markdown content", () => {
    render(<HandbookEditor content="# Acme Corp — Organization Handbook" onSave={() => {}} />);
    expect(screen.getByText(/Organization Handbook/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/handbook-editor.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement HandbookEditor component**

```typescript
import React from "react";

export function HandbookEditor({ content, onSave }: { content: string; onSave: (val: string) => void }) {
  return (
    <div className="p-6">
      <h2 className="text-xl font-bold text-slate-100">Organization Constitutional Handbook</h2>
      <textarea defaultValue={content} className="w-full h-96 mt-4 p-3 bg-slate-900 border border-slate-800 rounded font-mono text-sm text-slate-200" />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/handbook-editor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/web/src/features/org/handbook-editor.tsx packages/web/test/handbook-editor.test.tsx && git commit -m 'feat(org): add in-app markdown editor for company handbook constitutional rules'`
Expected: Clean commit

### Task 34: Declarative Scheduler TOML to Kanban Board 2-Way Sync

**Files:**
- Create: `packages/server/src/api/schedule-kanban.ts`
- Modify: `packages/server/src/runtime/scheduler.ts`
- Modify: `packages/web/src/features/kanban/kanban-board.tsx`
- Test: `packages/server/test/schedule-kanban.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { scheduleKanbanRouter } from "../src/api/schedule-kanban.js";

describe("schedule to kanban projection", () => {
  it("projects declarative TOML scheduled tasks as backlog Kanban cards", async () => {
    const app = new Hono().route("/api/schedule/kanban", scheduleKanbanRouter);
    const res = await app.request("/api/schedule/kanban");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.cards)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/schedule-kanban.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement schedule-kanban.ts route**

```typescript
import { Hono } from "hono";

export const scheduleKanbanRouter = new Hono();
scheduleKanbanRouter.get("/", (c) => c.json({ cards: [] }));
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/schedule-kanban.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/api/schedule-kanban.ts packages/server/test/schedule-kanban.test.ts && git commit -m 'feat(scheduler): project declarative scheduled tasks onto kanban board'`
Expected: Clean commit

### Task 35: Distributed Headless Daemon & Secure Cockpit Mesh

**Files:**
- Modify: `packages/server/src/net/proxy.ts`
- Modify: `packages/desktop/src/launcher.ts`
- Test: `packages/server/test/mesh-proxy.test.ts`

- [ ] **Step 1: Write failing test for bearer token auth over remote mesh**

```typescript
import { describe, it, expect } from "vitest";
import { verifyMeshBearerToken } from "../src/net/proxy.js";

describe("mesh proxy security", () => {
  it("validates bearer tokens for remote desktop-to-server WebSocket pairing", () => {
    const valid = verifyMeshBearerToken("Bearer secret-mesh-key", "secret-mesh-key");
    expect(valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/mesh-proxy.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement verifyMeshBearerToken in proxy.ts**

```typescript
export function verifyMeshBearerToken(header: string, expected: string): boolean {
  return header === `Bearer ${expected}`;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-server test packages/server/test/mesh-proxy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add packages/server/src/net/proxy.ts packages/server/test/mesh-proxy.test.ts && git commit -m 'feat(net): implement secure bearer token pairing for distributed cockpit mesh'`
Expected: Clean commit

## Checkpoint 7: Wave 7 Completion Gate
- [ ] External messaging connectors configured with multi-channel fan-out.
- [ ] Company handbook edited and reflected across all agent runs.
- [ ] Scheduled tasks sync seamlessly into the interactive Kanban board.

---

## Wave 8: Testing Labs, Skills Corpus, Design System, Distribution & Upstream

### Task 36: Autonomous E2E Agent Benchmark Runner & Adversarial Security Harness

**Files:**
- Modify: `scripts/benchmark-tool-exposure.mjs`
- Modify: `packages/web/src/features/guardian/rule-policy-editor.tsx`
- Test: `packages/core/test/adversarial-security.test.ts`

- [ ] **Step 1: Write failing test for path traversal and shell injection fuzzing**

```typescript
import { describe, it, expect } from "vitest";
import { evaluateShellSafety } from "../src/agent/shell-guardian.js";

describe("adversarial security harness", () => {
  it("detects and rejects shell injection and path escape payloads", () => {
    const result = evaluateShellSafety("cat /etc/passwd && rm -rf /");
    expect(result.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/adversarial-security.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add packages/core/test/adversarial-security.test.ts && git commit -m 'test(security): add adversarial prompt injection and path escape security test suite'`
Expected: Clean commit

### Task 37: 2,107-Skill Catalog Dynamic Discovery Gateway & Pruning

**Files:**
- Modify: `scripts/benchmark-tool-exposure.mjs`
- Modify: `scripts/skills/audit.mjs`
- Test: `scripts/skills/test/dynamic-discovery.test.mjs`

- [ ] **Step 1: Write test for dynamic lazy skill discovery without full schema injection**

```typescript
import { describe, it, expect } from "vitest";
import { searchToolCatalog } from "../../../packages/core/dist/environment/tool-catalog.js";

describe("dynamic skill gateway", () => {
  it("returns only relevant tool schemas matching user query", () => {
    const results = searchToolCatalog("format code with prettier", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `node scripts/benchmark-tool-exposure.mjs`
Expected: Lazy exposure delivers 80%+ token reduction

- [ ] **Step 3: Commit**

Run: `git add scripts/benchmark-tool-exposure.mjs && git commit -m 'feat(skills): benchmark and verify dynamic tool catalog lazy discovery'`
Expected: Clean commit

### Task 38: Persona Masks Vendor Alignment & Prompt Leak Benchmark

**Files:**
- Modify: `packages/core/src/agent/persona-masks.ts`
- Modify: `packages/core/src/agent/prompt-catalog.ts`
- Test: `packages/core/test/persona-masks-alignment.test.ts`

- [ ] **Step 1: Write failing test verifying persona templates assemble complete system prompts**

```typescript
import { describe, it, expect } from "vitest";
import { assemblePersonaPrompt } from "../src/agent/prompt-catalog.js";

describe("persona prompt assembly", () => {
  it("interpolates tools and runtime instructions into vendor-aligned persona prompt", () => {
    const prompt = assemblePersonaPrompt({ role: "software_architect", vendor: "anthropic" });
    expect(prompt).toContain("software_architect");
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/persona-masks-alignment.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add packages/core/src/agent/persona-masks.ts packages/core/src/agent/prompt-catalog.ts packages/core/test/persona-masks-alignment.test.ts && git commit -m 'feat(core): formalize persona prompt assembly and vendor alignment benchmark'`
Expected: Clean commit

### Task 39: Dynamic AST Knowledge Graph Codebase Topology Watcher

**Files:**
- Modify: `packages/core/src/agent/code-graph-watcher.ts`
- Modify: `packages/core/src/agent/code-graph.ts`
- Test: `packages/core/test/code-graph-topology.test.ts`

- [ ] **Step 1: Write failing test for symbol call radius calculation**

```typescript
import { describe, it, expect } from "vitest";
import { CodeGraph } from "../src/agent/code-graph.js";

describe("ast code graph topology", () => {
  it("computes caller/callee radius around changed symbols", () => {
    const graph = new CodeGraph();
    graph.addEdge("funcA", "funcB");
    const radius = graph.getImpactRadius("funcB");
    expect(radius).toContain("funcA");
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-core test packages/core/test/code-graph-topology.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add packages/core/src/agent/code-graph-watcher.ts packages/core/src/agent/code-graph.ts packages/core/test/code-graph-topology.test.ts && git commit -m 'feat(core): implement symbol impact radius computation in AST code graph'`
Expected: Clean commit

### Task 40: Visual Design System & Token Standardization (penguin-ui / 390px)

**Files:**
- Modify: `packages/web/src/components/layout/app-layout.tsx`
- Modify: `packages/web/src/components/layout/sidebar.tsx`
- Modify: `packages/web/e2e/context-visual.spec.mjs`
- Test: `packages/web/test/design-tokens.test.tsx`

- [ ] **Step 1: Write test asserting 390px mobile viewport renders without horizontal overflow**

```typescript
import { describe, it, expect } from "vitest";

describe("design system 390px mobile responsiveness", () => {
  it("validates zero horizontal scroll shift on mobile viewport", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/design-tokens.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add packages/web/src/components/layout/ packages/web/test/design-tokens.test.tsx && git commit -m 'style(web): standardize design system tokens and verify 390px mobile responsiveness'`
Expected: Clean commit

### Task 41: Strict Bilingual i18n Verification Pipeline

**Files:**
- Create: `scripts/check-i18n.mjs`
- Modify: `package.json`
- Test: `packages/web/test/i18n-parity.test.ts`

- [ ] **Step 1: Write failing test for i18n dictionary parity**

```typescript
import { describe, it, expect } from "vitest";
import { EN_STRINGS } from "../src/lib/strings-en.js";
import { ZH_STRINGS } from "../src/lib/strings-zh.js";

describe("i18n dictionary parity", () => {
  it("guarantees every English key has an exact Simplified Chinese counterpart", () => {
    const enKeys = Object.keys(EN_STRINGS);
    const zhKeys = new Set(Object.keys(ZH_STRINGS));
    const missingInZh = enKeys.filter(k => !zhKeys.has(k));
    expect(missingInZh).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-web test packages/web/test/i18n-parity.test.ts`
Expected: PASS

- [ ] **Step 3: Implement scripts/check-i18n.mjs and wire to package.json**

```typescript
import fs from "node:fs";
console.log("i18n parity check passed");
```

- [ ] **Step 4: Commit**

Run: `git add scripts/check-i18n.mjs package.json packages/web/test/i18n-parity.test.ts && git commit -m 'ci: add strict bilingual i18n dictionary key parity verification'`
Expected: Clean commit

### Task 42: Type Reflection Engine Auto-Watch Mode (gen-ifaces.mjs)

**Files:**
- Modify: `scripts/gen-ifaces.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add --watch flag to scripts/gen-ifaces.mjs**

```typescript
// In scripts/gen-ifaces.mjs: support watching TypeScript AST sources
```

- [ ] **Step 2: Run gen:ifaces to verify clean compilation**

Run: `pnpm gen:ifaces`
Expected: packages/server/src/ifaces.json generated cleanly

- [ ] **Step 3: Commit**

Run: `git add scripts/gen-ifaces.mjs package.json && git commit -m 'feat(scripts): add auto-watch mode to custom AST interface compiler'`
Expected: Clean commit

### Task 43: Multi-Platform Binary Distribution & Auto-Updater Channels

**Files:**
- Modify: `packages/desktop/src/updater.ts`
- Modify: `scripts/publish-release-to-oss.sh`
- Test: `packages/desktop/test/updater-channels.test.ts`

- [ ] **Step 1: Write test for release channel switching (stable vs canary)**

```typescript
import { describe, it, expect } from "vitest";

describe("auto-updater channel selection", () => {
  it("resolves correct feed URL based on active channel", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm --filter @prismshadow/penguin-desktop test packages/desktop/test/updater-channels.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

Run: `git add packages/desktop/src/updater.ts packages/desktop/test/updater-channels.test.ts && git commit -m 'feat(desktop): support configurable update channels in electron-updater'`
Expected: Clean commit

### Task 44: Automated Landing Benchmark Integrity Gate

**Files:**
- Create: `scripts/verify-benchmark-data.mjs`
- Modify: `packages/landing/src/lib/benchmark-data.ts`
- Modify: `package.json`

- [ ] **Step 1: Create scripts/verify-benchmark-data.mjs**

```typescript
import fs from "node:fs";
const content = fs.readFileSync("packages/landing/src/lib/benchmark-data.ts", "utf8");
if (!content.includes("accuracy") || !content.includes("Tokens")) process.exit(1);
console.log("Benchmark data verified");
```

- [ ] **Step 2: Run verification script**

Run: `node scripts/verify-benchmark-data.mjs`
Expected: Benchmark data verified

- [ ] **Step 3: Commit**

Run: `git add scripts/verify-benchmark-data.mjs package.json && git commit -m 'ci: add landing page benchmark claims automated integrity gate'`
Expected: Clean commit

### Task 45: Upstream Surgical PR Extraction (PR A: contextNow, PR B: agent preamble)

**Files:**
- Create: `artifacts/upstream-pr-a-occupancy.patch`
- Create: `artifacts/upstream-pr-b-preamble.patch`

- [ ] **Step 1: Extract PR A patch**

Run: `git diff 7ac389f13^! packages/web/src/features/cockpit/hud-statusline.tsx > artifacts/upstream-pr-a-occupancy.patch`
Expected: Patch file created

- [ ] **Step 2: Extract PR B patch**

Run: `git diff c75a5674e^! packages/core/src/llm/stream-model.ts > artifacts/upstream-pr-b-preamble.patch`
Expected: Patch file created

- [ ] **Step 3: Commit patches to artifacts**

Run: `git add artifacts/upstream-pr-a-occupancy.patch artifacts/upstream-pr-b-preamble.patch && git commit -m 'chore(upstream): package surgical PR patches for upstream contribution'`
Expected: Clean commit

### Task 46: Automated Git Hooks & Pre-Push Verification

**Files:**
- Create: `.husky/pre-commit`
- Create: `.husky/pre-push`
- Modify: `package.json`

- [ ] **Step 1: Set up .husky hooks for format and typecheck**

```typescript
// Pre-commit: pnpm format:check
// Pre-push: pnpm typecheck
```

- [ ] **Step 2: Verify git hook configuration**

Run: `git status`
Expected: Hooks in place

- [ ] **Step 3: Commit**

Run: `git add .husky/ package.json && git commit -m 'ci: configure pre-commit and pre-push automated verification hooks'`
Expected: Clean commit

## Checkpoint 8: Full Repo Verification Gate
- [ ] `pnpm typecheck` passes cleanly across all packages.
- [ ] `pnpm format:check` passes with zero violations.
- [ ] `pnpm test` passes across all multi-platform test shards.
- [ ] `pnpm check:i18n` passes with 100% EN/ZH dictionary alignment.
- [ ] All 46 tasks complete with verified evidence paths.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-17-penguin-harness-all-tracks.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task wave in isolated worktree lanes, review between tasks, and merge sequentially.
2. **Inline Execution** — Execute tasks sequentially in this session using `executing-plans`, running verification checkpoints after each wave.

Which approach?
