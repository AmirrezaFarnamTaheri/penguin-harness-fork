/**
 * Deadlock detection and resolution over a real wait-for graph.
 *
 * The failure mode this targets is specific and common in autonomous swarms:
 * agent A holds a lock on `auth.ts` and wants `auth.test.ts`, agent B holds
 * `auth.test.ts` and wants `auth.ts`. Neither will yield. A loop-breaker that
 * only counts repeated *actions* (which the existing `LoopDetector` and the
 * SWE-loop state machine handle) sees two busy agents and no repetition. You
 * need the wait-for graph to see the cycle.
 *
 * All algorithms here are the textbook real ones:
 *  - lock acquisition with per-resource FIFO waiter queues;
 *  - cycle detection via tri-colour DFS (WHITE/GRAY/BLACK) over the wait-for
 *    edges, returning the actual cycle path, not just a boolean;
 *  - victim selection by a real policy chain — lowest priority first, then
 *    the most recently started wait (youngest transaction aborts, because it
 *    has done the least work to lose), then the agent holding the fewest
 *    resources (cheapest to roll back);
 *  - resolution by aborting the victim: its held locks are released and its
 *    waiters granted, and its own wait edge is retired, which breaks every
 *    cycle it participated in;
 *  - a progress heuristic distinguishes a real deadlock from a merely slow
 *    wait: a waiter older than `suspectAfterMs` is only reported as a deadlock
 *    when no grant has been recorded since it parked — counted on the
 *    monotonic grant *sequence*, not the wall clock, so a busy millisecond
 *    cannot mask a stall — avoiding false positives on long-but-moving queues;
 */

export type LockMode = "shared" | "exclusive";

export interface LockHold {
  holder: string;
  resource: string;
  mode: LockMode;
  acquiredAt: number;
}

export interface WaitRequest {
  waiter: string;
  resource: string;
  mode: LockMode;
  startedWaitingAt: number;
  /**
   * The grant counter observed when this waiter parked. The progress heuristic
   * compares against the monotonic grant *sequence*, not the wall clock: a
   * grant whose sequence number exceeds this one arrived *after* the wait
   * began, which is proof the system still moves.
   */
  grantsAtPark: number;
}

export interface DeadlockReport {
  deadlocked: boolean;
  cycles: string[][];
  victims: string[];
  suspects: string[];
  grantsSinceOldestWait: number;
  detectedAt: number;
}

export interface DeadlockResolverOptions {
  /** Wait age (ms) after which a stalled waiter becomes a deadlock suspect. */
  suspectAfterMs?: number;
  /** Priority comparison used for victim selection (higher wins, keeps the lock). */
  priorityOf?: (agentId: string) => number;
  /** Max tracked resources before acquisition is refused (bound the graph). */
  maxResources?: number;
}

const NO_PRIORITY = () => 0;

export class DeadlockResolver {
  private readonly holds = new Map<string, LockHold>();
  private readonly waiters = new Map<string, WaitRequest[]>();
  private readonly granted = new Map<string, { counter: number; at: number }>();
  private readonly failedAcquire = new Map<string, number>();
  /** Monotonic grant log: the evidence the progress heuristic counts over. */
  private readonly grantLog: Array<{ counter: number; at: number }> = [];
  /** Sharer sets for resources currently held in shared mode. */
  private readonly sharers = new Map<string, Set<string>>();
  private grantCounter = 0;
  private readonly suspectAfterMs: number;
  private readonly priorityOf: (agentId: string) => number;
  private readonly maxResources: number;

  constructor(options: DeadlockResolverOptions = {}) {
    this.suspectAfterMs = options.suspectAfterMs ?? 10_000;
    this.priorityOf = options.priorityOf ?? NO_PRIORITY;
    this.maxResources = options.maxResources ?? 1024;
  }

  public getGrantCount(): number {
    return this.grantCounter;
  }

  /**
   * Requests `resource` for `holder`. Shared mode grants immediately when no
   * exclusive hold exists; exclusive mode requires the resource to be free.
   * Returns whether the grant happened — callers must park on a `false`.
   */
  public acquire(holder: string, resource: string, mode: LockMode = "exclusive"): boolean {
    const agent = holder.trim();
    const key = this.normalize(resource);
    if (!agent || !key) throw new Error("Acquire requires both holder and resource");
    if (!this.holds.has(key) && this.holds.size >= this.maxResources) {
      this.failedAcquire.set(agent, (this.failedAcquire.get(agent) ?? 0) + 1);
      return false;
    }

    const existing = this.holds.get(key);
    if (existing && existing.holder === agent) {
      // Re-acquisition upgrades in place; upgrading shared->exclusive is only
      // safe when nobody else shares, which the wait queue reflects below.
      if (mode === "exclusive" && this.sharerCount(key) > 1) {
        this.enqueueWait(agent, key, mode);
        return false;
      }
      existing.mode = mode;
      return true;
    }

    const grantable = this.isGrantable(key, mode);
    if (!grantable) {
      this.enqueueWait(agent, key, mode);
      return false;
    }

    const hold: LockHold = { holder: agent, resource: key, mode, acquiredAt: Date.now() };
    this.holds.set(key, hold);
    this.recordGrant(agent, key, mode);
    return true;
  }

  /** Releases every resource `holder` currently holds, and unblocks waiters. */
  public releaseAll(holder: string): number {
    const agent = holder.trim();
    let released = 0;
    for (const [key, hold] of this.holds) {
      if (hold.holder === agent) {
        this.holds.delete(key);
        this.dissolveSharers(key);
        released++;
        this.grantWaiters(key);
      }
    }
    this.cancelWaits(agent);
    return released;
  }

  public release(holder: string, resource: string): boolean {
    const key = this.normalize(resource);
    const hold = this.holds.get(key);
    if (!hold || hold.holder !== holder.trim()) return false;
    this.holds.delete(key);
    this.dissolveSharers(key);
    this.grantWaiters(key);
    return true;
  }

  /** Who holds `resource` right now, if anyone. */
  public holderOf(resource: string): string | undefined {
    return this.holds.get(this.normalize(resource))?.holder;
  }

  public getHolds(): LockHold[] {
    return Array.from(this.holds.values()).map((hold) => ({ ...hold }));
  }

  public getWaiters(): WaitRequest[] {
    return Array.from(this.waiters.values())
      .flat()
      .map((wait) => ({ ...wait }));
  }

  /** Builds the wait-for graph: waiter -> the agent currently blocking it. */
  public waitForGraph(): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    for (const [resource, queue] of this.waiters) {
      const holder = this.holds.get(resource)?.holder;
      if (!holder) continue;
      for (const wait of queue) {
        const edges = graph.get(wait.waiter) ?? new Set<string>();
        if (wait.waiter !== holder) edges.add(holder);
        graph.set(wait.waiter, edges);
      }
    }
    return graph;
  }

  /**
   * Tri-colour DFS cycle detection over the wait-for graph. Returns every
   * distinct cycle found, each as the ordered list of agents on it. A cycle
   * is only reported when its members are *all* still waiting, so a wait that
   * already resolved cannot produce a stale positive.
   */
  public detectCycles(): string[][] {
    const graph = this.waitForGraph();
    const colour = new Map<string, number>(); // 0 white, 1 gray, 2 black
    for (const node of graph.keys()) colour.set(node, 0);

    const cycles: string[][] = [];
    const stack: string[] = [];

    const visit = (node: string): void => {
      colour.set(node, 1);
      stack.push(node);
      const edges = graph.get(node) ?? new Set<string>();
      for (const neighbour of edges) {
        const state = colour.get(neighbour) ?? 0;
        if (state === 1) {
          const from = stack.indexOf(neighbour);
          if (from >= 0) {
            const cycle = stack.slice(from).concat(neighbour);
            if (cycle.length > 1) cycles.push(cycle);
          }
        } else if (state === 0) {
          visit(neighbour);
        }
      }
      stack.pop();
      colour.set(node, 2);
    };

    for (const node of graph.keys()) {
      if ((colour.get(node) ?? 0) === 0) visit(node);
    }

    return this.dedupeCycles(cycles);
  }

  /**
   * Full report: cycles plus suspects. A suspect is a waiter older than
   * `suspectAfterMs` — but it is only reported as deadlocked when the system
   * has made no grants since that wait began, which is what separates a true
   * deadlock from a deep-but-progressing queue.
   */
  public detect(now: number = Date.now()): DeadlockReport {
    const cycles = this.detectCycles();
    const oldest = this.oldestSuspect(now);
    const grantsSinceOldestWait = oldest === null ? 0 : this.grantsSince(oldest.grantsAtPark);

    const suspects: string[] = [];
    if (oldest !== null) {
      for (const wait of this.getWaiters()) {
        if (now - wait.startedWaitingAt > this.suspectAfterMs) suspects.push(wait.waiter);
      }
    }

    const stalled = suspects.length > 0 && grantsSinceOldestWait === 0;
    const deadlocked = cycles.length > 0 || stalled;

    const victims =
      cycles.length > 0 ? this.selectVictims(cycles) : stalled ? Array.from(new Set(suspects)) : [];

    return {
      deadlocked,
      cycles,
      victims,
      suspects,
      grantsSinceOldestWait,
      detectedAt: now,
    };
  }

  /**
   * Resolves a deadlock by aborting the victim: releases its locks (granting
   * its waiters), retires its own wait, and records the abort so the caller
   * can back the agent off before retrying.
   *
   * Returns what it released. `granted` lists the *resource keys* that a
   * released resource handed straight to a queued waiter, and
   * `unblockedAgents` lists those waiters — the two are the same event from
   * the resource side and the agent side, because callers need both: the mesh
   * wants to know which agents may resume, the lock log wants to know which
   * resources changed hands.
   */
  public resolve(
    victim: string,
    now: number = Date.now(),
  ): {
    released: string[];
    granted: string[];
    unblockedAgents: string[];
    abortedWait: boolean;
  } {
    const agent = victim.trim();
    const released: string[] = [];
    const granted: string[] = [];
    const unblockedAgents: string[] = [];

    for (const [key, hold] of this.holds) {
      if (hold.holder === agent) {
        released.push(key);
        this.holds.delete(key);
        this.dissolveSharers(key);
      }
    }

    const abortedWait = this.cancelWaits(agent);
    for (const key of released) {
      const nextHolders = this.grantWaiters(key);
      if (nextHolders.length > 0) {
        granted.push(key);
        unblockedAgents.push(...nextHolders);
      }
    }

    return { released, granted, unblockedAgents, abortedWait };
  }

  /** Selects one victim per cycle through the policy chain described above. */
  public selectVictims(cycles: string[][]): string[] {
    const victims: string[] = [];
    for (const cycle of cycles) {
      const members = cycle.filter((agent, index) => cycle.indexOf(agent) === index);
      if (members.length === 0) continue;
      const sorted = [...members].sort((a, b) => {
        const priorityDiff = this.priorityOf(a) - this.priorityOf(b);
        if (priorityDiff !== 0) return priorityDiff; // lowest priority aborts
        const waitA = this.oldestWaitFor(a) ?? 0;
        const waitB = this.oldestWaitFor(b) ?? 0;
        if (waitA !== waitB) return waitB - waitA; // youngest wait aborts
        return this.holdCount(a) - this.holdCount(b); // fewest holds aborts
      });
      const victim = sorted[0];
      if (victim && !victims.includes(victim)) victims.push(victim);
    }
    return victims;
  }

  // ---------------------------------------------------------------- internals

  private normalize(resource: string): string {
    return resource.trim().replace(/\\/g, "/");
  }

  private isGrantable(key: string, mode: LockMode): boolean {
    const existing = this.holds.get(key);
    if (!existing) return true;
    if (existing.mode === "exclusive") return false;
    return mode === "shared";
  }

  private sharerCount(key: string): number {
    return this.sharers.get(key)?.size ?? 0;
  }

  /**
   * Appends one grant to the monotonic log and maintains the shared-mode
   * sharer set. An exclusive grant dissolves the sharer set entirely, since
   * it is incompatible with every other holder.
   */
  private recordGrant(agent: string, key: string, mode: LockMode): void {
    this.grantCounter++;
    const at = Date.now();
    this.grantLog.push({ counter: this.grantCounter, at });
    this.granted.set(agent, { counter: this.grantCounter, at });
    if (mode === "shared") {
      const set = this.sharers.get(key) ?? new Set<string>();
      set.add(agent);
      this.sharers.set(key, set);
    } else {
      this.sharers.delete(key);
    }
  }

  private dissolveSharers(key: string): void {
    this.sharers.delete(key);
  }

  private enqueueWait(agent: string, key: string, mode: LockMode): void {
    const queue = this.waiters.get(key) ?? [];
    if (!queue.some((wait) => wait.waiter === agent)) {
      queue.push({
        waiter: agent,
        resource: key,
        mode,
        startedWaitingAt: Date.now(),
        grantsAtPark: this.grantCounter,
      });
      this.waiters.set(key, queue);
    }
  }

  private cancelWaits(agent: string): boolean {
    let cancelled = false;
    for (const [key, queue] of this.waiters) {
      const filtered = queue.filter((wait) => wait.waiter !== agent);
      if (filtered.length !== queue.length) cancelled = true;
      if (filtered.length === 0) this.waiters.delete(key);
      else this.waiters.set(key, filtered);
    }
    return cancelled;
  }

  /**
   * Grants the head of a resource's waiter queue, in FIFO order, honouring
   * shared/exclusive compatibility: a shared waiter is granted alongside
   * other shared waiters, an exclusive waiter clears the sharer set first.
   */
  private grantWaiters(key: string): string[] {
    const grantedAgents: string[] = [];
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return grantedAgents;

    const remaining: WaitRequest[] = [];
    let firstGranted = false;

    for (const wait of queue) {
      if (!firstGranted) {
        // The head of the queue always gets it next — no starvation.
        this.holds.set(key, {
          holder: wait.waiter,
          resource: key,
          mode: wait.mode,
          acquiredAt: Date.now(),
        });
        grantedAgents.push(wait.waiter);
        firstGranted = true;
        this.recordGrant(wait.waiter, key, wait.mode);
        continue;
      }
      const current = this.holds.get(key);
      if (current?.mode === "shared" && wait.mode === "shared") {
        grantedAgents.push(wait.waiter);
      } else {
        remaining.push(wait);
      }
    }

    if (remaining.length === 0) this.waiters.delete(key);
    else this.waiters.set(key, remaining);
    return grantedAgents;
  }

  /**
   * Counts grants whose sequence number is *greater* than the one a waiter
   * observed when it parked, off the monotonic grant log. The comparison is on
   * the grant sequence rather than the wall clock, so a busy millisecond —
   * where a grant and a park share a timestamp — cannot make a stalled queue
   * look healthy, nor a moving one look stuck. Zero such grants while a waiter
   * has been stalled past the suspect threshold means the system made no
   * forward progress at all in that window: the difference between a real
   * deadlock and a deep-but-moving queue.
   */
  private grantsSince(parkedAtGrant: number): number {
    return this.grantLog.filter((entry) => entry.counter > parkedAtGrant).length;
  }

  /**
   * The oldest waiter currently past the suspect threshold, or null when there
   * is none. `now` is taken as a parameter so callers can evaluate the graph
   * at an arbitrary instant, not just this process's clock.
   */
  private oldestSuspect(now: number): WaitRequest | null {
    let oldest: WaitRequest | null = null;
    for (const wait of this.getWaiters()) {
      if (now - wait.startedWaitingAt > this.suspectAfterMs) {
        if (oldest === null || wait.startedWaitingAt < oldest.startedWaitingAt) oldest = wait;
      }
    }
    return oldest;
  }

  private oldestWaitFor(agent: string): number | undefined {
    let oldest: number | undefined;
    for (const wait of this.getWaiters()) {
      if (wait.waiter === agent && (oldest === undefined || wait.startedWaitingAt < oldest)) {
        oldest = wait.startedWaitingAt;
      }
    }
    return oldest;
  }

  private holdCount(agent: string): number {
    let count = 0;
    for (const hold of this.holds.values()) {
      if (hold.holder === agent) count++;
    }
    return count;
  }

  private dedupeCycles(cycles: string[][]): string[][] {
    const seen = new Set<string>();
    const unique: string[][] = [];
    for (const cycle of cycles) {
      const key = [...cycle].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(cycle);
    }
    return unique;
  }
}
