/**
 * Task Execution Watchdog & Stall Protection Kernel.
 *
 * Monitors subagent and autonomous workflow execution for timeouts, runaway step loops,
 * silent process hangs, and stalled heartbeats. Enforces stage time budgets and triggers
 * structured abort or intervention events.
 */

export interface WatchdogConfig {
  maxStepCount: number;
  stepTimeoutMs: number;
  totalTimeoutMs: number;
  stallHeartbeatMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  maxStepCount: 60,
  stepTimeoutMs: 60_000,
  totalTimeoutMs: 600_000,
  stallHeartbeatMs: 30_000,
};

export type WatchdogState =
  "healthy" | "warning" | "stalled" | "timed_out" | "max_steps_exceeded" | "aborted";

export interface WatchdogStatus {
  state: WatchdogState;
  currentStep: number;
  elapsedMs: number;
  lastHeartbeatAgeMs: number;
  lastAction?: string;
  warnings: string[];
  abortReason?: string;
}

type TerminalWatchdogState = "timed_out" | "max_steps_exceeded" | "aborted";

export class TaskWatchdog {
  private readonly config: WatchdogConfig;
  private startTime = 0;
  private lastHeartbeatTime = 0;
  private currentStep = 0;
  private currentStepStartedAt = 0;
  private lastAction?: string;
  private abortReason?: string;
  private terminalState?: TerminalWatchdogState;
  private readonly warnings: string[] = [];

  constructor(config: Partial<WatchdogConfig> = {}) {
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...config };
  }

  public getConfig(): WatchdogConfig {
    return { ...this.config };
  }

  public start(): void {
    const now = Date.now();
    this.startTime = now;
    this.lastHeartbeatTime = now;
    this.currentStep = 0;
    this.currentStepStartedAt = now;
    this.terminalState = undefined;
    this.abortReason = undefined;
    this.warnings.length = 0;
  }

  public stop(): void {
    this.startTime = 0;
    this.currentStep = 0;
    this.terminalState = undefined;
    this.abortReason = undefined;
    this.warnings.length = 0;
  }

  public heartbeat(info?: { stepNumber?: number; action?: string }): WatchdogStatus {
    if (this.startTime === 0) this.start();
    if (this.terminalState) return this.checkHealth();

    const now = Date.now();
    const previousStep = this.currentStep;
    if (info?.stepNumber !== undefined) {
      if (!Number.isInteger(info.stepNumber) || info.stepNumber < previousStep) {
        throw new Error(
          `Watchdog stepNumber must be a monotonic integer (current: ${previousStep}, received: ${info.stepNumber})`,
        );
      }
      this.currentStep = info.stepNumber;
    } else {
      this.currentStep++;
    }

    this.lastHeartbeatTime = now;
    if (this.currentStep !== previousStep) this.currentStepStartedAt = now;
    if (info?.action) this.lastAction = info.action;

    return this.checkHealth();
  }

  public abort(reason: string): WatchdogStatus {
    this.terminalState = "aborted";
    this.abortReason = reason;
    return this.checkHealth();
  }

  private terminalStatus(
    state: TerminalWatchdogState,
    elapsedMs: number,
    heartbeatAge: number,
    warnings: string[],
    reason: string,
  ): WatchdogStatus {
    this.terminalState = state;
    this.abortReason ??= reason;
    return {
      state,
      currentStep: this.currentStep,
      elapsedMs,
      lastHeartbeatAgeMs: heartbeatAge,
      lastAction: this.lastAction,
      warnings,
      abortReason: this.abortReason,
    };
  }

  public checkHealth(): WatchdogStatus {
    const now = Date.now();
    if (this.startTime === 0) {
      return {
        state: "healthy",
        currentStep: 0,
        elapsedMs: 0,
        lastHeartbeatAgeMs: 0,
        warnings: [],
      };
    }

    const elapsedMs = now - this.startTime;
    const heartbeatAge = now - this.lastHeartbeatTime;
    const stepDuration = now - (this.currentStepStartedAt || this.startTime);
    const warnings: string[] = [...this.warnings];

    if (this.terminalState === "aborted") {
      return this.terminalStatus(
        "aborted",
        elapsedMs,
        heartbeatAge,
        warnings,
        this.abortReason ?? "Execution aborted",
      );
    }
    if (this.terminalState === "timed_out") {
      return this.terminalStatus(
        "timed_out",
        elapsedMs,
        heartbeatAge,
        warnings,
        this.abortReason ?? "Execution timed out",
      );
    }
    if (this.terminalState === "max_steps_exceeded") {
      return this.terminalStatus(
        "max_steps_exceeded",
        elapsedMs,
        heartbeatAge,
        warnings,
        this.abortReason ?? "Step count exceeded runaway threshold",
      );
    }

    if (elapsedMs > this.config.totalTimeoutMs) {
      return this.terminalStatus(
        "timed_out",
        elapsedMs,
        heartbeatAge,
        [...warnings, `Total execution duration exceeded ${this.config.totalTimeoutMs}ms`],
        "Execution exceeded total maximum timeout",
      );
    }

    if (stepDuration > this.config.stepTimeoutMs) {
      return this.terminalStatus(
        "timed_out",
        elapsedMs,
        heartbeatAge,
        [
          ...warnings,
          `Current step duration ${stepDuration}ms exceeded step limit ${this.config.stepTimeoutMs}ms`,
        ],
        "Step execution exceeded step timeout threshold",
      );
    }

    if (this.currentStep > this.config.maxStepCount) {
      return this.terminalStatus(
        "max_steps_exceeded",
        elapsedMs,
        heartbeatAge,
        [
          ...warnings,
          `Current step count ${this.currentStep} exceeded maximum ${this.config.maxStepCount}`,
        ],
        "Step count exceeded runaway threshold",
      );
    }

    if (heartbeatAge > this.config.stallHeartbeatMs) {
      return {
        state: "stalled",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings: [
          ...warnings,
          `Heartbeat age ${heartbeatAge}ms exceeded stall limit ${this.config.stallHeartbeatMs}ms`,
        ],
        abortReason: "Agent heartbeat stalled",
      };
    }

    if (heartbeatAge > this.config.stallHeartbeatMs * 0.7) {
      warnings.push(`Warning: No heartbeat received for ${heartbeatAge}ms`);
      return {
        state: "warning",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings,
      };
    }

    return {
      state: "healthy",
      currentStep: this.currentStep,
      elapsedMs,
      lastHeartbeatAgeMs: heartbeatAge,
      lastAction: this.lastAction,
      warnings,
    };
  }

  public isHealthy(): boolean {
    const status = this.checkHealth();
    return status.state === "healthy" || status.state === "warning";
  }
}

export const STALE_TIMEOUT_MS = 60_000;
export const STALE_MAX_RETRY = 1;

export function getRandomBackoffMinutes(): number {
  return Math.floor(Math.random() * 11) + 5;
}

export interface StaleTaskCandidate {
  id: string;
  title: string;
  status: string;
  lastHeartbeatAt?: string;
  updatedAt: string;
  retryCount?: number;
}

export interface StaleRecoveryResult {
  taskId: string;
  action: "recovered" | "aborted" | "ignored";
  reason: string;
}

export interface BlockedTaskCandidate {
  id: string;
  title: string;
  blockedFromStatus?: string;
  retryAfter?: string;
}

export interface BlockedReleaseResult {
  taskId: string;
  restoredStatus: string;
  released: boolean;
}

export function recoverStaleInProgressTasks(
  candidates: StaleTaskCandidate[],
  timeoutMs = STALE_TIMEOUT_MS,
  maxRetry = STALE_MAX_RETRY,
): StaleRecoveryResult[] {
  const now = Date.now();
  const results: StaleRecoveryResult[] = [];

  for (const task of candidates) {
    const refTime = task.lastHeartbeatAt
      ? Date.parse(task.lastHeartbeatAt)
      : Date.parse(task.updatedAt);
    const age = now - refTime;

    if (age > timeoutMs) {
      const retries = task.retryCount ?? 0;
      if (retries < maxRetry) {
        results.push({
          taskId: task.id,
          action: "recovered",
          reason: `Stale task heartbeats absent for ${age}ms; rescheduled with backoff`,
        });
      } else {
        results.push({
          taskId: task.id,
          action: "aborted",
          reason: `Exceeded max stale retries (${maxRetry}); task aborted`,
        });
      }
    } else {
      results.push({
        taskId: task.id,
        action: "ignored",
        reason: "Heartbeat age within acceptable bounds",
      });
    }
  }

  return results;
}

export function releaseDueBlockedTasks(
  candidates: BlockedTaskCandidate[],
  nowMs = Date.now(),
): BlockedReleaseResult[] {
  const results: BlockedReleaseResult[] = [];

  for (const task of candidates) {
    if (!task.blockedFromStatus) {
      results.push({ taskId: task.id, restoredStatus: "", released: false });
      continue;
    }

    const retryAfterMs = task.retryAfter ? Date.parse(task.retryAfter) : 0;
    if (nowMs >= retryAfterMs) {
      results.push({ taskId: task.id, restoredStatus: task.blockedFromStatus, released: true });
    } else {
      results.push({ taskId: task.id, restoredStatus: task.blockedFromStatus, released: false });
    }
  }

  return results;
}
