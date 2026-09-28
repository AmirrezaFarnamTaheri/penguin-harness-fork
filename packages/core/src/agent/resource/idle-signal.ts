/**
 * AgentIdleSignal — the explicit "this agent is waiting" answer that idle release is
 * allowed to act on.
 *
 * ## Why this is not a timer
 *
 * The failure mode this exists to prevent is releasing a resource that is in use: a browser
 * with a form half-filled, an MCP connection mid-transaction, a file index being read while
 * it is dropped. A wall-clock "N seconds since the last tool call" heuristic cannot tell
 * those apart from a genuinely finished turn — the model can be *thinking* for a minute
 * between two tool calls, and during that time a form the agent is about to type into is
 * exactly as idle as a browser nobody will touch again.
 *
 * So idleness is **declared, not inferred**. The host calls {@link AgentIdleSignal.noteActivity}
 * when the agent does something that touches held resources (a turn starts, a tool call is
 * dispatched, a resource is restored). The signal answers "how long since the last declared
 * activity", and the release policy requires BOTH this signal and the resource's own `isIdle`
 * to agree before it releases anything. Neither alone is trusted.
 *
 * This is also why there is no "hibernate" here. A Node process cannot be suspended in a
 * way that returns V8 heap: SIGSTOP freezes threads while every socket, timer and native
 * handle keeps the memory it holds. Freeing memory here means *releasing what was acquired
 * and rebuilding it on demand*, never freezing the process.
 *
 * No scheduling of its own: {@link AgentIdleSignal.isIdle} is a pure comparison, so the
 * caller decides when to ask and a sweep loop is never required.
 */

/** Injectable clock; defaults to `Date.now` so tests can drive time deterministically. */
export type IdleClock = () => number;

export interface AgentIdleSignalOptions {
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: IdleClock;
  /**
   * Timestamp of the last declared activity. Defaults to construction time, so a signal
   * that is never touched is idle from the moment it exists — a freshly constructed agent
   * has genuinely not done anything yet.
   */
  lastActivityAt?: number;
}

export class AgentIdleSignal {
  private readonly now: IdleClock;
  private lastActivityAt: number;

  constructor(options: AgentIdleSignalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lastActivityAt = options.lastActivityAt ?? this.now();
  }

  /**
   * Declares that the agent just did something — started a turn, dispatched a tool call,
   * restored a resource. Resets the idle clock to now.
   *
   * Idempotent within a turn: calling it repeatedly costs nothing and is the correct thing
   * for a busy agent, because "the last thing I did was a moment ago" is the answer it wants.
   */
  noteActivity(at?: number): void {
    this.lastActivityAt = at ?? this.now();
  }

  /** Timestamp of the most recent declared activity. */
  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /**
   * When the agent went idle, or null when it has been active within `idleMs`. The
   * boundary is inclusive of `>=`: an agent idle for exactly `idleMs` has been idle that
   * long, and one millisecond less has not.
   */
  idleSince(idleMs: number, now = this.now()): number | null {
    const elapsed = now - this.lastActivityAt;
    return elapsed >= idleMs ? this.lastActivityAt : null;
  }

  /** True when no activity has been declared for at least `idleMs`. */
  isIdle(idleMs: number, now = this.now()): boolean {
    return this.idleSince(idleMs, now) !== null;
  }

  /**
   * Milliseconds still to wait before the agent counts as idle, floored at 0. Lets a caller
   * schedule its next check without re-deriving the arithmetic.
   */
  remainingIdleMs(idleMs: number, now = this.now()): number {
    return Math.max(0, this.lastActivityAt + idleMs - now);
  }
}
