/**
 * Releasables for the holders the idle-holdings measurement actually found, plus one
 * deliberate refusal.
 *
 * The measurement (`measure-idle-holdings.ts`, re-runnable) came back with this ranking of
 * what an idle agent holds on win32/x64, node v26.1.0:
 *
 * | holder                        | heap held | system memory | release verdict                    |
 * |-------------------------------|-----------|----------------|------------------------------------|
 * | Chromium browser tree         | 0         | 752.2 MB       | already handled server-side        |
 * | MCP stdio server              | +4.2 MB   | 51.2 MB        | release — reconstructable, measured |
 * | background command            | 0         | 11.7 MB        | **never release** — destructive     |
 * | file index (1969 files)       | +3.2 MB   | 3.2 MB         | release — rebuildable from disk     |
 *
 * The browser is 92% of the footprint and is deliberately absent from this file:
 * `SteerableBrowserCluster` already shuts its browser down after `idleShutdownMs` (120s
 * default) and its CDP pool already evicts sessions past `maxIdleAgeMs` (300s). Rebuilding
 * that here would be a second, weaker mechanism racing an existing one.
 *
 * The background command is the interesting refusal. It holds the least memory of the four
 * and is the one thing that must never be released: a running test or dev server cannot be
 * reconstructed — killing it and restarting produces a different result, not the one the
 * agent was waiting for. {@link createBackgroundCommandReleasable} exists so that fact is
 * enforced by the registry rather than left to a caller to remember.
 */
import { OwnedProcessGuard, type ReleasableResource } from "./idle-release.js";

/**
 * The part of `McpToolProvider` this adapter uses. Declared structurally rather than
 * imported so the adapter carries no dependency on the provider's internals, and so a test
 * can supply a double that behaves the same way.
 */
export interface McpIdleCloseCapable {
  /** Closes connections unused for longer than `maxIdleMs`; returns how many were closed. */
  closeIdleConnections(maxIdleMs?: number, now?: number): number;
  /** Connects anything pending and returns the tool surface. This is the rebuild path. */
  listTools(): Promise<unknown[]>;
  /** Configured servers with no live connection right now. */
  pendingServerNames(): string[];
}

export interface McpReleasableOptions {
  id: string;
  provider: McpIdleCloseCapable;
  /**
   * How many MCP servers are configured. Required, because it is the only way to tell a
   * live connection from a pending one: the provider publishes `pendingServerNames()` but
   * not a live-connection count, and a releasable that guessed at "is anything connected"
   * would be guessing. The caller resolves the config at assembly time and already has it.
   */
  serverCount: number;
  /** Current child PIDs that closing an idle connection could terminate. */
  ownedProcessIds?(): Iterable<number>;
  /**
   * Idle age a connection must reach before it counts as releasable. Passed straight to
   * `closeIdleConnections`, so this adapter does not invent a second idleness rule — the
   * provider's per-connection `lastUsedAt` is the real one, and it is the component that
   * actually knows when a connection was last used.
   */
  idleMs?: number;
  description?: string;
}

/**
 * Wraps an MCP provider so its stdio server processes can be given up while idle.
 *
 * Reconstructability is not a hope: releasing sets the provider's connect promise to null,
 * and the next `listTools()` re-runs discovery, which respawns the server and re-registers
 * its tools. The measurement confirmed this end to end — 1 connection released, 24 tools
 * back, a new server pid.
 *
 * Idleness is answered from two real facts, not a guess: `isIdle` asks whether any
 * configured server currently holds a live connection (configured minus pending), and the
 * per-connection age is enforced by `closeIdleConnections` itself, which refuses to close
 * anything touched inside `idleMs`. Combined with the registry's own agent-idle gate, a
 * connection is only closed when the agent has declared itself idle *and* no tool call has
 * touched that server inside the window.
 */
export function createMcpConnectionReleasable(options: McpReleasableOptions): ReleasableResource {
  const idleMs = options.idleMs ?? 15 * 60 * 1000;
  const liveConnectionCount = (): number =>
    Math.max(0, options.serverCount - options.provider.pendingServerNames().length);
  return {
    id: options.id,
    kind: "mcp-connection",
    reconstructable: true,
    // A stdio MCP server is a child process this process spawned, so giving it up does
    // terminate a process — which is exactly why the registry demands a guard for it.
    terminatesOwnedProcess: true,
    ownedProcessIds: options.ownedProcessIds,
    describe: () =>
      options.description ??
      `MCP server connections (${liveConnectionCount()} live of ${options.serverCount} configured; idle ones respawn on next use)`,
    isIdle: () => liveConnectionCount() > 0,
    release: async (at: number) => {
      const closed = options.provider.closeIdleConnections(idleMs, at);
      return {
        released: closed > 0,
        ...(closed > 0
          ? { detail: `closed ${closed} idle MCP connection(s); they reconnect on next use` }
          : { detail: "no MCP connection had been idle long enough" }),
      };
    },
    restore: async () => {
      // The real rebuild: re-runs connect + discovery, respawning any server that was closed.
      await options.provider.listTools();
    },
  };
}

/**
 * What a releasable in-memory index must offer. `handle` is the live object; `drop` removes
 * the reference; `rebuild` re-reads from disk.
 */
export interface ReleasableIndex<T> {
  /** The live index. Null once released. */
  handle: T | null;
  /** How many entries the index held, for the report. */
  readonly entryCount: number;
  /** Releases the reference chain holding the index. */
  drop(): void;
  /** Re-reads the source and repopulates `handle`. */
  rebuild(): Promise<void>;
}

export interface FileIndexReleasableOptions<T> {
  id: string;
  index: ReleasableIndex<T>;
  now?: () => number;
  description?: string;
  /**
   * Whether something is reading the index right now. Returning true keeps it held even
   * when the agent is idle — an index being walked by a live query is not idle.
   */
  isBusy?: () => boolean;
}

/**
 * A loaded file index — the shape `CodeGraph` has: one entry per file plus its symbols,
 * measured at 3.2 MB of heap for a 1969-file workspace, held in full while the agent waits
 * for an LLM turn that may not consult it for minutes.
 *
 * Release drops the reference chain; restore re-reads from disk. Purely reconstructable: the
 * source files did not change while the index was gone, and the rebuild is bounded by the
 * same file walk that produced it.
 */
export function createFileIndexReleasable<T>(
  options: FileIndexReleasableOptions<T>,
): ReleasableResource {
  const isBusy = options.isBusy ?? ((): boolean => false);
  return {
    id: options.id,
    kind: "file-index",
    reconstructable: true,
    // No process is involved: the index lives in this process's heap.
    terminatesOwnedProcess: false,
    describe: () =>
      options.description ??
      `file index holding ${options.index.entryCount} entries (rebuilt from disk on wake)`,
    isIdle: () => !isBusy() && options.index.handle !== null,
    release: async () => {
      if (options.index.handle === null) {
        return { released: false, detail: "index already released" };
      }
      const count = options.index.entryCount;
      options.index.drop();
      return { released: true, detail: `dropped ${count} indexed entries` };
    },
    restore: async () => {
      await options.index.rebuild();
    },
  };
}

/** What the caller knows about a running background command. */
export interface BackgroundCommandState {
  readonly id: string;
  /** Human description of the command, e.g. "vitest run". */
  readonly label: string;
  /** True while the process is still running. */
  readonly running: boolean;
}

/**
 * A background command, registered so the policy can see it and **decline to release it**.
 *
 * This is a real object with a real implementation, not a placeholder: `release()` refuses,
 * and the registry refuses before it ever gets there because `reconstructable` is false. It
 * exists so that "we looked at it and chose not to" is a decision the code makes and a test
 * pins, rather than an absence someone later fills in with a `process.kill`.
 *
 * The agent can still see that the command is running, and can still read resource pressure
 * and decide for itself what to do about it. Being told is the point; being stopped is not.
 */
export function createBackgroundCommandReleasable(
  state: BackgroundCommandState,
): ReleasableResource {
  return {
    id: state.id,
    kind: "custom",
    reconstructable: false,
    terminatesOwnedProcess: true,
    describe: () => `background command "${state.label}" (${state.running ? "running" : "exited"})`,
    isIdle: () => !state.running,
    release: async () => ({
      released: false,
      detail: "a background command's result cannot be reconstructed; refusing to release it",
    }),
    restore: async () => {
      /* Nothing was released, so there is nothing to rebuild. */
    },
  };
}

/**
 * Builds the guard a process-terminating releasable needs: the pids this process spawned
 * and is therefore permitted to signal.
 */
export function ownedProcessGuard(pids: Iterable<number>): OwnedProcessGuard {
  return new OwnedProcessGuard(pids);
}
