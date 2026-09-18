/**
 * Tool-loop state machine for one autonomous SWE run.
 *
 * This is the control plane the existing `engine/context-engine.ts` does not
 * have: that engine runs the ReAct loop for a *single* agent and yields tool
 * output as it streams. It deliberately makes no judgement about whether the
 * run as a whole is making progress, whether it is time to submit, or whether
 * the model has produced a third malformed action in a row. Those are
 * whole-run decisions, and they are what this machine decides.
 *
 * Shape, taken from the real SWE-loop archives:
 *  - mini-swe-agent's `DefaultAgent.run` — a step loop that exits on an
 *    `exit` message, with `max_consecutive_format_errors` as a first-class
 *    limit (a repeated format failure ends the run, it is not retried
 *    forever);
 *  - SWE-agent's `RetryAgent`/`DefaultAgent` — `RETRY_WITH_OUTPUT` and
 *    `RETRY_WITHOUT_OUTPUT` tokens, where a retry decides whether the failed
 *    observation stays in the model context or is dropped;
 *  - Magentic-One's progress ledger — stall accounting where a stall
 *    increments, progress decrements it, and breaching `max_stalls` triggers
 *    a re-plan rather than another loop iteration.
 *
 * All limits here are enforced by real arithmetic against counters, and every
 * illegal transition throws naming both the current state and the event.
 */

export type ToolLoopState =
  | "planning"
  | "awaiting_model"
  | "dispatching"
  | "running"
  | "observing"
  | "format_error"
  | "retrying"
  | "submitting"
  | "submitted"
  | "exited"
  | "limit_exceeded"
  | "aborted";

export type ToolLoopEventKind =
  | "enter_planning"
  | "model_requested"
  | "model_responded"
  | "format_error"
  | "retry_with_output"
  | "retry_without_output"
  | "tool_dispatched"
  | "tool_succeeded"
  | "tool_failed"
  | "loop_break"
  | "submit_requested"
  | "submit_completed"
  | "limit_reached"
  | "abort";

export interface ToolLoopLimits {
  maxSteps: number;
  maxConsecutiveFormatErrors: number;
  costLimit: number;
  wallTimeLimitMs: number;
  /** Max repeats of the same tool+args signature before a loop break. */
  maxRepeats: number;
  /** Stall budget, in stalls, before a re-plan is forced. */
  maxStalls: number;
}

export const DEFAULT_TOOL_LOOP_LIMITS: ToolLoopLimits = Object.freeze({
  maxSteps: 40,
  maxConsecutiveFormatErrors: 3,
  costLimit: 3,
  wallTimeLimitMs: 1_800_000,
  maxRepeats: 4,
  maxStalls: 3,
});

export type RetryMode = "with_output" | "without_output";

export interface ToolLoopTransition {
  from: ToolLoopState;
  to: ToolLoopState;
  kind: ToolLoopEventKind;
  at: number;
  step: number;
  note?: string;
}

export interface ToolLoopSnapshot {
  state: ToolLoopState;
  step: number;
  modelCalls: number;
  toolCalls: number;
  consecutiveFormatErrors: number;
  totalFormatErrors: number;
  stalls: number;
  cost: number;
  elapsedMs: number;
  retries: number;
  lastRetryMode?: RetryMode;
  lastSignature?: string;
  repeatCount: number;
  terminal: boolean;
  exitStatus?: string;
}

interface SignatureRecord {
  signature: string;
  count: number;
  lastSeenStep: number;
}

function toolSignature(toolName: string, args: unknown): string {
  const argPart = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return `${toolName}::${argPart}`;
}

export class ToolLoopStateMachine {
  public state: ToolLoopState = "planning";
  private readonly limits: ToolLoopLimits;
  private readonly startedAt: number;
  private step = 0;
  private modelCalls = 0;
  private toolCalls = 0;
  private consecutiveFormatErrors = 0;
  private totalFormatErrors = 0;
  private stalls = 0;
  private cost = 0;
  private retries = 0;
  private lastRetryMode: RetryMode | undefined;
  private lastSignature: string | undefined;
  private repeatCount = 0;
  private exitStatus: string | undefined;
  private readonly transitions: ToolLoopTransition[] = [];
  private readonly signatures: SignatureRecord[] = [];

  constructor(limits: Partial<ToolLoopLimits> = {}) {
    this.limits = { ...DEFAULT_TOOL_LOOP_LIMITS, ...limits };
    this.startedAt = Date.now();
  }

  public getState(): ToolLoopState {
    return this.state;
  }

  public isTerminal(): boolean {
    return (
      this.state === "submitted" ||
      this.state === "exited" ||
      this.state === "limit_exceeded" ||
      this.state === "aborted"
    );
  }

  public getExitStatus(): string | undefined {
    return this.exitStatus;
  }

  public snapshot(): ToolLoopSnapshot {
    return {
      state: this.state,
      step: this.step,
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      consecutiveFormatErrors: this.consecutiveFormatErrors,
      totalFormatErrors: this.totalFormatErrors,
      stalls: this.stalls,
      cost: this.cost,
      elapsedMs: Date.now() - this.startedAt,
      retries: this.retries,
      lastRetryMode: this.lastRetryMode,
      lastSignature: this.lastSignature,
      repeatCount: this.repeatCount,
      terminal: this.isTerminal(),
      exitStatus: this.exitStatus,
    };
  }

  public getTransitions(): ToolLoopTransition[] {
    return this.transitions.map((transition) => ({ ...transition }));
  }

  /** True iff every budget still has headroom — checked before each step. */
  public canStep(): { allowed: boolean; reason?: string } {
    if (this.isTerminal()) {
      return { allowed: false, reason: `tool loop is terminal in state '${this.state}'` };
    }
    if (this.step >= this.limits.maxSteps) {
      return {
        allowed: false,
        reason: `step budget exhausted (${this.step}/${this.limits.maxSteps})`,
      };
    }
    if (this.cost >= this.limits.costLimit) {
      return {
        allowed: false,
        reason: `cost budget exhausted (${this.cost.toFixed(4)} >= ${this.limits.costLimit.toFixed(4)})`,
      };
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.limits.wallTimeLimitMs) {
      return {
        allowed: false,
        reason: `wall-time budget exhausted (${elapsed}ms >= ${this.limits.wallTimeLimitMs}ms)`,
      };
    }
    return { allowed: true };
  }

  /** Records a model call's cost; a budget breach forces a terminal transition. */
  public recordCost(delta: number): void {
    if (Number.isFinite(delta) && delta > 0) this.cost += delta;
    if (this.cost >= this.limits.costLimit && !this.isTerminal()) {
      this.transition("limit_reached", "limit_exceeded", {
        exitStatus: "CostLimitExceeded",
        note: `cost ${this.cost.toFixed(4)} reached the limit ${this.limits.costLimit.toFixed(4)}`,
      });
    }
  }

  /**
   * Feeds one event and moves the machine. Every disallowed move throws with
   * both states named, because a silent no-op here would look like progress.
   */
  public transition(
    kind: ToolLoopEventKind,
    to: ToolLoopState,
    options: {
      toolName?: string;
      args?: unknown;
      exitStatus?: string;
      note?: string;
    } = {},
  ): ToolLoopTransition {
    if (this.isTerminal()) {
      throw new Error(
        `Tool loop is terminal ('${this.state}'); event '${kind}' -> '${to}' is not permitted`,
      );
    }
    if (!this.allowed(kind, to)) {
      throw new Error(
        `Illegal tool-loop transition: event '${kind}' from '${this.state}' to '${to}'`,
      );
    }

    const from = this.state;
    this.apply(kind, to, options);
    const record: ToolLoopTransition = {
      from,
      to,
      kind,
      at: Date.now(),
      step: this.step,
      note: options.note,
    };
    this.transitions.push(record);
    return { ...record };
  }

  /**
   * Records a repeated tool signature and decides whether the loop is
   * spinning. Returns whether a loop break was triggered — the caller should
   * treat that as "stop, do not dispatch this again".
   */
  public trackRepeat(toolName: string, args: unknown): { breaking: boolean; repeats: number } {
    const signature = toolSignature(toolName, args);
    const existing = this.signatures.find((record) => record.signature === signature);
    if (existing) {
      existing.count += 1;
      existing.lastSeenStep = this.step;
    } else {
      this.signatures.push({ signature, count: 1, lastSeenStep: this.step });
    }

    this.lastSignature = signature;
    const matched = this.signatures.find((record) => record.signature === signature);
    this.repeatCount = matched ? matched.count : 1;

    if (this.repeatCount > this.limits.maxRepeats && !this.isTerminal()) {
      this.transition("loop_break", "exited", {
        exitStatus: "LoopDetected",
        note: `tool signature '${signature.slice(0, 64)}' repeated ${this.repeatCount} times (max ${this.limits.maxRepeats})`,
      });
      return { breaking: true, repeats: this.repeatCount };
    }
    return { breaking: false, repeats: this.repeatCount };
  }

  /**
   * Magentic-One stall accounting: a stall increments the counter, evidence of
   * progress decrements it (floored at zero), and breaching the budget forces
   * a re-plan via `limit_exceeded`.
   */
  public recordStall(isStalled: boolean): { stalls: number; replanning: boolean } {
    if (this.isTerminal()) return { stalls: this.stalls, replanning: false };
    if (isStalled) this.stalls += 1;
    else this.stalls = Math.max(0, this.stalls - 1);

    if (this.stalls >= this.limits.maxStalls) {
      this.transition("limit_reached", "limit_exceeded", {
        exitStatus: "StallBudgetExceeded",
        note: `${this.stalls} consecutive stalls (budget ${this.limits.maxStalls})`,
      });
      return { stalls: this.stalls, replanning: true };
    }
    return { stalls: this.stalls, replanning: false };
  }

  /** The retry token the model emitted, and whether its output is retained. */
  public retry(mode: RetryMode): ToolLoopTransition {
    this.retries += 1;
    this.lastRetryMode = mode;
    return this.transition(
      mode === "with_output" ? "retry_with_output" : "retry_without_output",
      "retrying",
      {
        note:
          mode === "with_output"
            ? "retry retains the failed observation in context"
            : "retry drops the failed observation from context",
      },
    );
  }

  // ---------------------------------------------------------------- internals

  private allowed(kind: ToolLoopEventKind, to: ToolLoopState): boolean {
    const from = this.state;
    switch (kind) {
      case "enter_planning":
        return from === "planning" && to === "awaiting_model";
      case "model_requested":
        return from === "awaiting_model" && to === "awaiting_model";
      case "model_responded":
        return (
          (from === "awaiting_model" || from === "retrying") &&
          (to === "dispatching" || to === "submitting" || to === "format_error" || to === "exited")
        );
      case "format_error":
        return from === "awaiting_model" || from === "dispatching" || from === "format_error";
      case "retry_with_output":
      case "retry_without_output":
        return from === "format_error" && to === "retrying";
      case "tool_dispatched":
        return (from === "dispatching" || from === "retrying") && to === "running";
      case "tool_succeeded":
      case "tool_failed":
        return from === "running" && to === "observing";
      case "loop_break":
        return to === "exited";
      case "submit_requested":
        return (
          (from === "observing" || from === "dispatching" || from === "running") &&
          to === "submitting"
        );
      case "submit_completed":
        return from === "submitting" && (to === "submitted" || to === "observing");
      case "limit_reached":
        return to === "limit_exceeded";
      case "abort":
        return to === "aborted";
      default:
        return false;
    }
  }

  private apply(
    kind: ToolLoopEventKind,
    to: ToolLoopState,
    options: { toolName?: string; args?: unknown; exitStatus?: string; note?: string },
  ): void {
    this.state = to;

    if (kind === "model_requested" || kind === "enter_planning") this.modelCalls += 1;
    if (kind === "tool_dispatched") {
      this.toolCalls += 1;
      this.step += 1;
      if (options.toolName) this.trackRepeat(options.toolName, options.args);
    }
    if (kind === "format_error") {
      this.consecutiveFormatErrors += 1;
      this.totalFormatErrors += 1;
      if (
        this.consecutiveFormatErrors >= this.limits.maxConsecutiveFormatErrors &&
        !this.isTerminal()
      ) {
        // Repeated format errors are a stop condition, not a retry target:
        // the model is not parsing its own output format.
        this.state = "exited";
        this.exitStatus = "RepeatedFormatError";
        return;
      }
    }
    // Any clean forward progress resets the consecutive format-error streak.
    if (kind === "model_responded" || kind === "tool_dispatched") {
      this.consecutiveFormatErrors = 0;
    }
    if (options.exitStatus) this.exitStatus = options.exitStatus;
  }
}
