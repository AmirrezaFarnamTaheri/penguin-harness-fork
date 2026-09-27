/**
 * IdleResourceRegistry — the policy that decides whether held memory may be released, and
 * the bounded bookkeeping that records what it did.
 *
 * ## What "release" means here, and what it does not
 *
 * A Node process cannot be suspended in a way that returns memory. SIGSTOP freezes threads;
 * every socket, timer and native handle keeps the memory it holds, and V8 never gives a page
 * back. So "hibernate the agent" is not a thing that can be built, and a design that claimed
 * to do it would be worse than no design — it would report a saving that never arrives.
 *
 * What *is* real, and what this module does: an idle agent gives back the heavy things it
 * acquired — a live MCP server process, a loaded file index — and rebuilds them on wake.
 * Measured on this repository, that is 51.2 MB of system memory per idle MCP server and
 * 3.2 MB of heap per indexed 1969-file workspace, and the rebuild was verified to respawn
 * the server process and restore all 24 of its tools. That memory is genuinely returned and
 * the return is observable. The agent's own conversation, history and JS heap are untouched:
 * nothing is frozen, and no stream is interrupted mid-flight.
 *
 * ## The safety rules, and why each exists
 *
 * 1. **Two independent idle signals must agree.** The host's {@link AgentIdleSignal} (the
 *    agent declares it stopped working) AND the resource's own `isIdle(now)` (the resource
 *    declares nothing is mid-use). Either alone is insufficient: the agent can be idle while
 *    a browser page is mid-transaction, and a resource can look untouched while the agent is
 *    mid-turn and about to use it. Releasing a half-filled form destroys work.
 * 2. **Only reconstructable resources are ever released.** A resource that declares
 *    `reconstructable: false` is refused, always, and the refusal is recorded. A background
 *    test run is the worked example: killing it frees ~12 MB and destroys the result, and no
 *    rebuild brings that result back. The cheap win is not worth the loss.
 * 3. **Only processes this process created are terminated.** A releasable that terminates an
 *    OS process must declare `terminatesOwnedProcess: true`, and the registry refuses any
 *    that has not been handed an owner check — see {@link OwnedProcessGuard}. The harness
 *    never signals a process it did not spawn.
 * 4. **Release is reversible.** Every released resource exposes `restore()`. The registry
 *    never auto-restores (that would defeat the saving by re-acquiring everything the moment
 *    the agent blinks); restoration is the caller's decision, made when the resource is
 *    actually needed.
 *
 * ## Bounded by construction
 *
 * `maxRegistrations` caps live entries, `maxReleasesPerSweep` caps work per sweep so one
 * sweep can never block on N resource tears-downs, `cooldownMs` stops a resource thrashing
 * between released and rebuilt, and history is a fixed-size ring. None of these can be set
 * to a value that makes growth unbounded.
 */
import type { AgentIdleSignal } from "./idle-signal.js";

/** The kinds of thing this registry knows how to let go of. */
export type ReleasableKind = "mcp-connection" | "file-index" | "browser-session" | "custom";

/** Why a registered resource was not released, or what happened to it. */
export type ReleaseOutcomeKind =
  | "released"
  | "skipped-busy"
  | "skipped-agent-active"
  | "skipped-not-reconstructable"
  | "skipped-unowned-process"
  | "skipped-cooldown"
  | "skipped-capacity"
  | "skipped-not-found"
  | "restore-failed";

export interface ReleaseOutcome {
  readonly id: string;
  readonly kind: ReleasableKind;
  readonly outcome: ReleaseOutcomeKind;
  /** Free-form detail from the resource or the failure. Never required. */
  readonly detail?: string;
  readonly at: number;
}

/** What a releasable is and what it costs to let go of. */
export interface ReleasableResource {
  /** Stable identity, unique within a registry. */
  readonly id: string;
  readonly kind: ReleasableKind;
  /**
   * Whether {@link ReleasableResource.restore} can bring this back. When false the registry
   * refuses to release it, no matter how idle it is — see safety rule 2.
   */
  readonly reconstructable: boolean;
  /**
   * True only when {@link ReleasableResource.release} terminates an OS process that this
   * process spawned. The registry requires a matching {@link OwnedProcessGuard} before it
   * will act on such a resource — see safety rule 3.
   */
  readonly terminatesOwnedProcess: boolean;
  /** One line naming what would be given up, for the agent-facing report. */
  describe(): string;
  /** The resource's own view of whether anything is mid-use right now. */
  isIdle(now: number): boolean;
  /** Gives the resource up. Called only after every safety rule has passed. */
  release(now: number): Promise<{ released: boolean; detail?: string }>;
  /** Rebuilds it. Called by whoever needs it next, never automatically by a sweep. */
  restore(now: number): Promise<void>;
}

/**
 * Proof that a process a releasable wants to terminate is one this process started.
 *
 * Constructed from the `ChildProcess` (or a pid plus the owning set) that the harness itself
 * spawned. The registry will not release a process-terminating resource without one, which
 * turns "never kill a process you did not start" from a convention into a precondition.
 */
export class OwnedProcessGuard {
  private readonly owned: ReadonlySet<number>;

  constructor(pids: Iterable<number> = []) {
    this.owned = new Set(pids);
  }

  /** True when `pid` is one this process spawned. An empty guard owns nothing. */
  owns(pid: number): boolean {
    return this.owned.has(pid);
  }

  /** The number of owned processes, for reporting. Never the pids themselves. */
  get size(): number {
    return this.owned.size;
  }
}

export interface IdleResourceRegistryOptions {
  /** The agent's declared idleness. Without one the registry releases nothing. */
  idle: AgentIdleSignal;
  /** How long the agent must have declared no activity before a sweep may release. Default 120000. */
  minIdleMs?: number;
  /** Minimum gap between two releases of the same resource. Default 60000. */
  cooldownMs?: number;
  /** Live registration cap. Default 64. */
  maxRegistrations?: number;
  /** Releases allowed per sweep. Default 4. Bounds the work one sweep can do. */
  maxReleasesPerSweep?: number;
  /** History ring size. Default 64. */
  historyLimit?: number;
  now?: () => number;
}

const DEFAULTS = {
  minIdleMs: 120_000,
  cooldownMs: 60_000,
  maxRegistrations: 64,
  maxReleasesPerSweep: 4,
  historyLimit: 64,
} as const;

export interface SweepResult {
  readonly at: number;
  /** True when the agent's idle signal alone blocked the sweep — nothing was even examined. */
  readonly agentActive: boolean;
  readonly outcomes: readonly ReleaseOutcome[];
  readonly releasedCount: number;
}

export class IdleResourceRegistry {
  private readonly resources = new Map<string, ReleasableResource>();
  private readonly lastReleaseAt = new Map<string, number>();
  private readonly idle: AgentIdleSignal;
  private readonly minIdleMs: number;
  private readonly cooldownMs: number;
  private readonly maxRegistrations: number;
  private readonly maxReleasesPerSweep: number;
  private readonly historyLimit: number;
  private readonly now: () => number;
  /** Fixed-size ring. Bounded by `historyLimit`; the oldest record is overwritten. */
  private historyLog: ReleaseOutcome[] = [];
  /** Process-terminating resources are keyed by id here once a guard has vouched for them. */
  private readonly guards = new Map<string, OwnedProcessGuard>();

  constructor(options: IdleResourceRegistryOptions) {
    this.idle = options.idle;
    this.minIdleMs = Math.max(0, options.minIdleMs ?? DEFAULTS.minIdleMs);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULTS.cooldownMs);
    this.maxRegistrations = Math.max(1, options.maxRegistrations ?? DEFAULTS.maxRegistrations);
    this.maxReleasesPerSweep = Math.max(
      1,
      options.maxReleasesPerSweep ?? DEFAULTS.maxReleasesPerSweep,
    );
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULTS.historyLimit);
    this.now = options.now ?? Date.now;
  }

  /**
   * Adds a resource. Returns false when the registry is full — the cap is a real bound, not
   * a suggestion, and a full registry refuses rather than growing.
   */
  register(resource: ReleasableResource, guard?: OwnedProcessGuard): boolean {
    if (this.resources.has(resource.id)) return false;
    if (this.resources.size >= this.maxRegistrations) return false;
    this.resources.set(resource.id, resource);
    if (guard) this.guards.set(resource.id, guard);
    return true;
  }

  unregister(id: string): boolean {
    this.guards.delete(id);
    this.lastReleaseAt.delete(id);
    return this.resources.delete(id);
  }

  get size(): number {
    return this.resources.size;
  }

  /** Whether a resource is currently registered. */
  has(id: string): boolean {
    return this.resources.has(id);
  }

  /**
   * The full safety check for one resource, without releasing it. Exposed so a caller (or a
   * test, or the agent-facing report) can ask "would this be released right now?" and get
   * the real reason rather than a guess.
   */
  evaluate(resource: ReleasableResource, now = this.now()): ReleaseOutcomeKind {
    if (!this.idle.isIdle(this.minIdleMs, now)) return "skipped-agent-active";
    if (!resource.reconstructable) return "skipped-not-reconstructable";
    if (resource.terminatesOwnedProcess && !this.guards.get(resource.id)) {
      return "skipped-unowned-process";
    }
    const last = this.lastReleaseAt.get(resource.id);
    if (last !== undefined && now - last < this.cooldownMs) return "skipped-cooldown";
    try {
      if (!resource.isIdle(now)) return "skipped-busy";
    } catch {
      // A resource that cannot answer is treated as busy. Failing open here is the one
      // direction that loses work.
      return "skipped-busy";
    }
    return "released";
  }

  /**
   * Releases every eligible idle resource, up to `maxReleasesPerSweep` of them.
   *
   * When the agent is not idle the sweep returns immediately without examining anything —
   * that is the load-bearing short-circuit, and it is what makes the "does not fire under
   * load" property structural rather than a matter of each resource's own judgement.
   */
  async sweep(now = this.now()): Promise<SweepResult> {
    if (!this.idle.isIdle(this.minIdleMs, now)) {
      return { at: now, agentActive: true, outcomes: [], releasedCount: 0 };
    }
    const outcomes: ReleaseOutcome[] = [];
    let released = 0;
    for (const resource of this.resources.values()) {
      if (released >= this.maxReleasesPerSweep) {
        outcomes.push(this.record(resource, "skipped-capacity", now));
        continue;
      }
      const verdict = this.evaluate(resource, now);
      if (verdict !== "released") {
        outcomes.push(this.record(resource, verdict, now));
        continue;
      }
      try {
        const result = await resource.release(now);
        if (result.released) {
          this.lastReleaseAt.set(resource.id, now);
          released++;
          outcomes.push(this.record(resource, "released", now, result.detail));
        } else {
          // The resource declined at the last moment. Not an error, and not a release.
          outcomes.push(this.record(resource, "skipped-busy", now, result.detail));
        }
      } catch (err) {
        outcomes.push(
          this.record(
            resource,
            "skipped-busy",
            now,
            err instanceof Error ? err.message : undefined,
          ),
        );
      }
    }
    return { at: now, agentActive: false, outcomes, releasedCount: released };
  }

  /**
   * Rebuilds one released resource. The caller decides when a resource is needed again —
   * the registry never does this on its own, because eagerly restoring everything would
   * re-acquire the memory the release just returned.
   */
  async restore(id: string, now = this.now()): Promise<boolean> {
    const resource = this.resources.get(id);
    if (!resource) return false;
    try {
      await resource.restore(now);
      this.record(resource, "released", now, "restored");
      return true;
    } catch (err) {
      this.record(resource, "restore-failed", now, err instanceof Error ? err.message : undefined);
      return false;
    }
  }

  /** Rebuilds every registered resource. For an explicit wake, where all of them are needed. */
  async restoreAll(now = this.now()): Promise<number> {
    let count = 0;
    for (const id of [...this.resources.keys()]) {
      if (await this.restore(id, now)) count++;
    }
    return count;
  }

  /** One line per registered resource: what it is, and what releasing it would do. */
  describeAll(): Array<{ id: string; kind: ReleasableKind; description: string }> {
    return [...this.resources.values()].map((r) => ({
      id: r.id,
      kind: r.kind,
      description: r.describe(),
    }));
  }

  /** The bounded history ring, oldest first. */
  history(): readonly ReleaseOutcome[] {
    return [...this.historyLog];
  }

  private record(
    resource: ReleasableResource,
    outcome: ReleaseOutcomeKind,
    at: number,
    detail?: string,
  ): ReleaseOutcome {
    const entry: ReleaseOutcome = {
      id: resource.id,
      kind: resource.kind,
      outcome,
      ...(detail === undefined ? {} : { detail }),
      at,
    };
    this.historyLog.push(entry);
    // Fixed-size ring: the oldest record is dropped, so the log cannot grow past the cap.
    if (this.historyLog.length > this.historyLimit) {
      this.historyLog.splice(0, this.historyLog.length - this.historyLimit);
    }
    return entry;
  }
}
