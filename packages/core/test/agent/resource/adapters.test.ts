import { describe, it, expect } from "vitest";
import {
  createBackgroundCommandReleasable,
  createFileIndexReleasable,
  createMcpConnectionReleasable,
  ownedProcessGuard,
  type McpIdleCloseCapable,
  type ReleasableIndex,
} from "../../../src/agent/resource/adapters.js";
import { IdleResourceRegistry } from "../../../src/agent/resource/idle-release.js";
import { AgentIdleSignal } from "../../../src/agent/resource/idle-signal.js";

/**
 * An MCP provider double with the same observable surface as the real one — including the
 * per-connection `lastUsedAt` filter that `closeIdleConnections` applies, because that
 * filter is the real idleness rule and a double that ignored it would make the "declines"
 * test below vacuous.
 */
function fakeProvider(configured: number) {
  const closeCalls: Array<{ maxIdleMs: number | undefined; now: number | undefined }> = [];
  const listToolsCalls: number[] = [];
  /** A clock the double and the test share, so "when was this last used" is explicit. */
  let at = 0;
  /** `null` = no live connection. A number = connected, last used at that time. */
  let lastUsedAt: number | null = 0;

  const provider: McpIdleCloseCapable = {
    closeIdleConnections(maxIdleMs?: number, now?: number): number {
      closeCalls.push({ maxIdleMs, now });
      if (lastUsedAt === null) return 0;
      const at = now ?? Date.now();
      // Same rule as the real provider: only connections untouched for longer than
      // `maxIdleMs` are closed.
      if (at - lastUsedAt <= (maxIdleMs ?? 15 * 60 * 1000)) return 0;
      lastUsedAt = null;
      return configured;
    },
    async listTools(): Promise<unknown[]> {
      listToolsCalls.push(lastUsedAt === null ? 0 : 1);
      lastUsedAt = at; // reconnection, as the real provider does on demand
      return Array.from({ length: 24 }, (_, i) => ({ name: `mcp__fixture__tool_${i}` }));
    },
    pendingServerNames(): string[] {
      return lastUsedAt === null ? Array.from({ length: configured }, (_, i) => `s${i}`) : [];
    },
  };

  return {
    provider,
    closeCalls,
    listToolsCalls,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => at,
    liveCount: () => configured - provider.pendingServerNames().length,
  };
}

function idleRegistry(overrides: { minIdleMs?: number; cooldownMs?: number } = {}) {
  let t = 0;
  const idle = new AgentIdleSignal({ now: () => t });
  const registry = new IdleResourceRegistry({
    idle,
    now: () => t,
    minIdleMs: overrides.minIdleMs ?? 1000,
    cooldownMs: overrides.cooldownMs ?? 10_000,
  });
  return {
    registry,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

describe("createMcpConnectionReleasable", () => {
  it("reports a live connection as idle and releases it", async () => {
    const h = idleRegistry();
    const fake = fakeProvider(1);
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 1,
      idleMs: 60_000,
    });
    h.registry.register(releasable, ownedProcessGuard([1234]));

    h.advance(90_000); // past the releasable's own 60s connection-idle window
    const result = await h.registry.sweep();
    expect(result.releasedCount).toBe(1);
    expect(fake.closeCalls).toHaveLength(1);
    expect(fake.closeCalls[0]?.maxIdleMs).toBe(60_000);
    expect(fake.liveCount()).toBe(0);
  });

  it("rebuilds by reconnecting, and the tools come back", async () => {
    // The reversibility the measurement confirmed against a real server process: after the
    // release, the next acquisition re-runs connect + discovery and the tool surface returns.
    const h = idleRegistry();
    const fake = fakeProvider(1);
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 1,
      // Shorter than the sweep's 10s advance, so the provider's own lastUsedAt filter
      // agrees the connection is idle rather than the adapter overriding it.
      idleMs: 1000,
    });
    h.registry.register(releasable, ownedProcessGuard([1234]));

    h.advance(10_000);
    await h.registry.sweep();
    expect(fake.liveCount()).toBe(0);

    expect(await h.registry.restore("mcp")).toBe(true);
    expect(fake.listToolsCalls).toHaveLength(1);
    expect(fake.liveCount()).toBe(1);
    const tools = await fake.provider.listTools();
    expect(tools).toHaveLength(24);
  });

  it("is not idle once every configured server is already disconnected", async () => {
    const fake = fakeProvider(1);
    fake.advance(1000);
    fake.provider.closeIdleConnections(0, fake.now());
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 1,
    });
    // Nothing connected means nothing to give up; claiming otherwise would make every sweep
    // report a release that released nothing.
    expect(releasable.isIdle(fake.now())).toBe(false);
  });

  it("declines when no connection has been idle long enough", async () => {
    // The provider's own lastUsedAt filter says zero closed: the adapter reports that
    // honestly rather than claiming a release. This is the case that protects an MCP server
    // the agent used a moment ago.
    const fake = fakeProvider(2);
    fake.advance(1000); // used 1s ago
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 2,
      idleMs: 60_000,
    });
    const outcome = await releasable.release(fake.now());
    expect(outcome.released).toBe(false);
    expect(outcome.detail).toMatch(/no MCP connection had been idle long enough/);
    expect(fake.liveCount()).toBe(2);
  });

  it("releases once the connection has been idle past the window", async () => {
    const fake = fakeProvider(1);
    fake.advance(90_000); // 90s since last use
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 1,
      idleMs: 60_000,
    });
    const outcome = await releasable.release(fake.now());
    expect(outcome.released).toBe(true);
    expect(outcome.detail).toMatch(/closed 1 idle MCP connection/);
    expect(fake.liveCount()).toBe(0);
  });

  it("needs an ownership guard, because closing a server kills a process", async () => {
    const h = idleRegistry();
    const fake = fakeProvider(1);
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 1,
    });
    h.registry.register(releasable); // deliberately no guard
    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(fake.closeCalls).toHaveLength(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-unowned-process");
  });

  it("names what it holds and what releasing costs", () => {
    const fake = fakeProvider(2);
    const releasable = createMcpConnectionReleasable({
      id: "mcp",
      provider: fake.provider,
      serverCount: 2,
    });
    expect(releasable.describe()).toMatch(/2 live of 2 configured/);
    expect(releasable.terminatesOwnedProcess).toBe(true);
    expect(releasable.reconstructable).toBe(true);
  });
});

describe("createFileIndexReleasable", () => {
  function fakeIndex(entries: number) {
    let handle: string[] | null = Array.from({ length: entries }, (_, i) => `entry-${i}`);
    const events: string[] = [];
    const index: ReleasableIndex<string[]> = {
      get handle() {
        return handle;
      },
      get entryCount() {
        return handle?.length ?? 0;
      },
      drop(): void {
        events.push("drop");
        handle = null;
      },
      async rebuild(): Promise<void> {
        events.push("rebuild");
        handle = Array.from({ length: entries }, (_, i) => `entry-${i}`);
      },
    };
    return { index, events };
  }

  it("drops the index while idle and rebuilds it on restore", async () => {
    const h = idleRegistry();
    const fake = fakeIndex(1969);
    const releasable = createFileIndexReleasable({ id: "index", index: fake.index });
    h.registry.register(releasable);

    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(result.releasedCount).toBe(1);
    expect(fake.index.handle).toBeNull();
    expect(fake.events).toEqual(["drop"]);

    expect(await h.registry.restore("index")).toBe(true);
    expect(fake.index.handle).toHaveLength(1969);
    expect(fake.events).toEqual(["drop", "rebuild"]);
  });

  it("stays held while a query is reading it, even with the agent idle", async () => {
    const h = idleRegistry();
    const fake = fakeIndex(100);
    let reading = true;
    const releasable = createFileIndexReleasable({
      id: "index",
      index: fake.index,
      isBusy: () => reading,
    });
    h.registry.register(releasable);
    h.advance(10_000);
    const busy = await h.registry.sweep();
    expect(busy.outcomes[0]?.outcome).toBe("skipped-busy");
    expect(fake.index.handle).toHaveLength(100);

    // Once the reader is done, the same sweep releases it.
    reading = false;
    const free = await h.registry.sweep();
    expect(free.releasedCount).toBe(1);
  });

  it("is not idle once already released", async () => {
    const fake = fakeIndex(10);
    const releasable = createFileIndexReleasable({ id: "index", index: fake.index });
    expect(releasable.isIdle(Date.now())).toBe(true);
    await releasable.release(Date.now());
    expect(releasable.isIdle(Date.now())).toBe(false);
  });

  it("needs no ownership guard — no process is involved", () => {
    const fake = fakeIndex(1);
    const releasable = createFileIndexReleasable({ id: "index", index: fake.index });
    expect(releasable.terminatesOwnedProcess).toBe(false);
  });
});

describe("createBackgroundCommandReleasable — the deliberate refusal", () => {
  it("is never released by the registry, however idle everything is", async () => {
    // 11.7 MB is the smallest holding measured and the one thing that must not be touched:
    // a running test's result cannot be reconstructed by restarting it.
    const h = idleRegistry();
    const releasable = createBackgroundCommandReleasable({
      id: "cmd",
      label: "vitest run",
      running: false, // not even running: still refused
    });
    h.registry.register(releasable, ownedProcessGuard([999]));

    h.advance(10_000);
    const result = await h.registry.sweep();
    expect(result.releasedCount).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("skipped-not-reconstructable");
  });

  it("refuses at the resource level too, so no caller can route around the registry", async () => {
    const releasable = createBackgroundCommandReleasable({
      id: "cmd",
      label: "npm run dev",
      running: false,
    });
    const outcome = await releasable.release(Date.now());
    expect(outcome.released).toBe(false);
    expect(outcome.detail).toMatch(/cannot be reconstructed/);
  });

  it("still describes the command, so the agent can see it", () => {
    // Being told is the point. The agent may read pressure and decide to stop it itself;
    // what it must not find is a policy that stopped it without asking.
    const releasable = createBackgroundCommandReleasable({
      id: "cmd",
      label: "vitest run",
      running: true,
    });
    expect(releasable.describe()).toBe('background command "vitest run" (running)');
    expect(releasable.isIdle(Date.now())).toBe(false);
  });
});

describe("ownedProcessGuard", () => {
  it("vouches only for pids it was given", () => {
    const guard = ownedProcessGuard([1, 2, 3]);
    expect(guard.owns(2)).toBe(true);
    expect(guard.owns(4)).toBe(false);
  });
});
