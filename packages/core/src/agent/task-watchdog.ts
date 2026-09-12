/**
 * Task Execution Watchdog & Stall Protection Kernel.
 *
 * Monitors subagent and autonomous workflow execution for timeouts, runaway step loops,
 * silent process hangs, and stalled heartbeats. Enforces stage time budgets and triggers
 * structured abort or intervention events.
 *
 * Synthesized from aif-handoff taskWatchdog, claurst hooks, and CCB execution services.
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
  | "healthy"
  | "warning"
  | "stalled"
  | "timed_out"
  | "max_steps_exceeded"
  | "aborted";

export interface WatchdogStatus {
  state: WatchdogState;
  currentStep: number;
  elapsedMs: number;
  lastHeartbeatAgeMs: number;
  lastAction?: string;
  warnings: string[];
  abortReason?: string;
}

export class TaskWatchdog {
  private readonly config: WatchdogConfig;
  private startTime = 0;
  private lastHeartbeatTime = 0;
  private currentStep = 0;
  private currentStepStartedAt = 0;
  private lastAction?: string;
  private abortReason?: string;
  private aborted = false;
  private readonly warnings: string[] = [];

  constructor(config: Partial<WatchdogConfig> = {}) {
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...config };
  }

  public start(): void {
    const now = Date.now();
    this.startTime = now;
    this.lastHeartbeatTime = now;
    this.currentStep = 0;
    this.currentStepStartedAt = now;
    this.aborted = false;
    this.abortReason = undefined;
    this.warnings.length = 0;
  }

  public heartbeat(info?: { stepNumber?: number; action?: string }): WatchdogStatus {
    const now = Date.now();
    if (this.startTime === 0) {
      this.start();
    }

    this.lastHeartbeatTime = now;
    const previousStep = this.currentStep;
    if (info?.stepNumber !== undefined) {
      this.currentStep = info.stepNumber;
    } else {
      this.currentStep++;
    }

    if (this.currentStep !== previousStep) {
      this.currentStepStartedAt = now;
    }

    if (info?.action) {
      this.lastAction = info.action;
    }

    return this.checkHealth();
  }

  public abort(reason: string): WatchdogStatus {
    this.aborted = true;
    this.abortReason = reason;
    return this.checkHealth();
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

    if (this.aborted) {
      return {
        state: "aborted",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings,
        abortReason: this.abortReason,
      };
    }

    if (elapsedMs > this.config.totalTimeoutMs) {
      return {
        state: "timed_out",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings: [...warnings, `Total execution duration exceeded ${this.config.totalTimeoutMs}ms`],
        abortReason: "Execution exceeded total maximum timeout",
      };
    }

    if (stepDuration > this.config.stepTimeoutMs) {
      return {
        state: "timed_out",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings: [...warnings, `Current step duration ${stepDuration}ms exceeded step limit ${this.config.stepTimeoutMs}ms`],
        abortReason: "Step execution exceeded step timeout threshold",
      };
    }

    if (this.currentStep > this.config.maxStepCount) {
      return {
        state: "max_steps_exceeded",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings: [...warnings, `Current step count ${this.currentStep} exceeded maximum ${this.config.maxStepCount}`],
        abortReason: "Step count exceeded runaway threshold",
      };
    }

    if (heartbeatAge > this.config.stallHeartbeatMs) {
      return {
        state: "stalled",
        currentStep: this.currentStep,
        elapsedMs,
        lastHeartbeatAgeMs: heartbeatAge,
        lastAction: this.lastAction,
        warnings: [...warnings, `Heartbeat age ${heartbeatAge}ms exceeded stall limit ${this.config.stallHeartbeatMs}ms`],
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

/**
 * Task Watchdog constants and stale recovery heuristics derived from aif-handoff.
 */
export const STALE_TIMEOUT_MS = 60_000;
export const STALE_MAX_RETRY = 1;

export function getRandomBackoffMinutes(): number {
  return Math.floor(Math.random() * 11) + 5; // 5..15 minutes
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

/**
 * Recovers stale in-progress tasks whose heartbeats or updates exceed the stale timeout.
 */
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

/**
 * Releases tasks from blocked_external status once their retryAfter backoff window has elapsed.
 */
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
      results.push({
        taskId: task.id,
        restoredStatus: task.blockedFromStatus,
        released: true,
      });
    } else {
      results.push({
        taskId: task.id,
        restoredStatus: task.blockedFromStatus,
        released: false,
      });
    }
  }

  return results;
}
