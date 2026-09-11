import { createHash } from "node:crypto";

export interface LoopDetectorOptions {
  /** Maximum consecutive calls to the same tool before flagging a loop (default: 5). */
  maxRepeats?: number;
  /** Maximum time per operation/file in seconds before timing out (default: 600). */
  timeoutSeconds?: number;
  /** Maximum seconds without recorded progress before flagging a stall (default: 300). */
  stallThreshold?: number;
  /** Maximum consecutive errors before forcing an abort (default: 10). */
  maxErrors?: number;
  /** Maximum repeating period length to detect (e.g. A->B->A->B has period 2; default: 3). */
  maxCycleLength?: number;
}

export interface ToolCallEntry {
  toolName: string;
  inputHash: string;
  timestamp: number;
}

export interface LoopCheckResult {
  status: "ok" | "loop_detected" | "timeout" | "stall" | "max_errors";
  message: string;
  shouldStop: boolean;
  patternType?: "consecutive_same_tool" | "identical_input_repeat" | "alternating_cycle";
}

export interface LoopDetectorSummary {
  currentFile: string | null;
  fileElapsedSeconds: number;
  totalElapsedSeconds: number;
  consecutiveErrors: number;
  recentTools: string[];
  timeSinceLastProgressSeconds: number;
  isAborted: boolean;
  abortReason: string | null;
}

/**
 * LoopDetector monitors autonomous tool-execution sequences to detect infinite
 * loops, cyclical ping-pong patterns, execution timeouts, and progress stalls.
 */
export class LoopDetector {
  public readonly maxRepeats: number;
  public readonly timeoutSeconds: number;
  public readonly stallThreshold: number;
  public readonly maxErrors: number;
  public readonly maxCycleLength: number;

  private toolHistory: ToolCallEntry[] = [];
  private readonly startTime: number;
  private lastProgressTime: number;
  private consecutiveErrors = 0;
  private currentFile: string | null = null;
  private fileStartTime: number | null = null;

  constructor(options: LoopDetectorOptions = {}) {
    this.maxRepeats = options.maxRepeats ?? 5;
    this.timeoutSeconds = options.timeoutSeconds ?? 600;
    this.stallThreshold = options.stallThreshold ?? 300;
    this.maxErrors = options.maxErrors ?? 10;
    this.maxCycleLength = options.maxCycleLength ?? 3;

    const now = Date.now();
    this.startTime = now;
    this.lastProgressTime = now;
  }

  /**
   * Start tracking work on a specific file.
   */
  public startFile(filename: string): void {
    this.currentFile = filename;
    const now = Date.now();
    this.fileStartTime = now;
    this.lastProgressTime = now;
  }

  /**
   * Check whether a proposed tool call constitutes a loop, timeout, or stall.
   */
  public checkToolCall(toolName: string, toolInput?: unknown): LoopCheckResult {
    const now = Date.now();

    if (toolName.trim().length > 0) {
      const inputHash = this.computeHash(toolInput);
      this.toolHistory.push({
        toolName,
        inputHash,
        timestamp: now,
      });

      if (this.toolHistory.length > 20) {
        this.toolHistory = this.toolHistory.slice(-20);
      }
    }

    // 1. Consecutive identical tool call check
    if (this.toolHistory.length >= this.maxRepeats) {
      const recent = this.toolHistory.slice(-this.maxRepeats);
      const first = recent[0];
      if (first) {
        const allSameTool = recent.every((t) => t.toolName === first.toolName);

        if (allSameTool) {
          const allIdenticalInput = recent.every((t) => t.inputHash === first.inputHash);
          const patternType = allIdenticalInput ? "identical_input_repeat" : "consecutive_same_tool";

          return {
            status: "loop_detected",
            message: allIdenticalInput
              ? `Loop detected: '${first.toolName}' called with identical arguments ${this.maxRepeats} times consecutively`
              : `Loop detected: '${first.toolName}' called ${this.maxRepeats} times consecutively`,
            shouldStop: true,
            patternType,
          };
        }
      }
    }

    // 2. Cyclical alternating pattern check (e.g., period 2: A->B->A->B->A->B, period 3: A->B->C->A->B->C)
    const cycleResult = this.detectCycle();
    if (cycleResult) {
      return cycleResult;
    }

    // 3. Operation timeout per file
    if (this.fileStartTime !== null) {
      const elapsedFileSeconds = (now - this.fileStartTime) / 1000;
      if (elapsedFileSeconds > this.timeoutSeconds) {
        return {
          status: "timeout",
          message: `Timeout: File processing for '${this.currentFile}' exceeded ${this.timeoutSeconds}s (elapsed: ${elapsedFileSeconds.toFixed(1)}s)`,
          shouldStop: true,
        };
      }
    }

    // 4. Progress stall check
    const elapsedSinceProgress = (now - this.lastProgressTime) / 1000;
    if (elapsedSinceProgress > this.stallThreshold) {
      return {
        status: "stall",
        message: `Progress stall: No progress recorded for ${this.stallThreshold}s (elapsed: ${elapsedSinceProgress.toFixed(1)}s)`,
        shouldStop: true,
      };
    }

    // 5. Consecutive error threshold
    if (this.consecutiveErrors >= this.maxErrors) {
      return {
        status: "max_errors",
        message: `Too many errors: Reached ${this.consecutiveErrors} consecutive errors (maximum: ${this.maxErrors})`,
        shouldStop: true,
      };
    }

    return {
      status: "ok",
      message: "Execution normal",
      shouldStop: false,
    };
  }

  /**
   * Detect repeating cyclical sequences in recent tool calls.
   */
  private detectCycle(): LoopCheckResult | null {
    if (this.toolHistory.length < 4) {
      return null;
    }

    // Check periods from 2 up to maxCycleLength
    for (let period = 2; period <= this.maxCycleLength; period++) {
      const minEntries = period * 3; // At least 3 repetitions of the period
      if (this.toolHistory.length < minEntries) {
        continue;
      }

      const recent = this.toolHistory.slice(-minEntries);
      let matches = true;

      for (let i = 0; i < minEntries; i++) {
        const expected = recent[i % period]?.toolName;
        const actual = recent[i]?.toolName;
        if (!expected || !actual || actual !== expected) {
          matches = false;
          break;
        }
      }

      if (matches) {
        const cyclePattern = recent
          .slice(0, period)
          .map((r) => r.toolName)
          .join(" -> ");
        return {
          status: "loop_detected",
          message: `Cycle loop detected: Repeating pattern [${cyclePattern}] occurred 3 consecutive times`,
          shouldStop: true,
          patternType: "alternating_cycle",
        };
      }
    }

    return null;
  }

  /**
   * Record that tangible forward progress has occurred.
   */
  public recordProgress(): void {
    this.lastProgressTime = Date.now();
    this.consecutiveErrors = 0;
  }

  /**
   * Exclude an LLM generation/waiting duration from the stall budget.
   */
  public noteLlmWait(elapsedSeconds: number): void {
    if (elapsedSeconds <= 0) {
      return;
    }
    // Advance lastProgressTime by the wait duration so waiting on the model isn't penalized
    this.lastProgressTime += elapsedSeconds * 1000;
  }

  /**
   * Record that a tool or execution step produced an error.
   */
  public recordError(_errorMessage?: string): void {
    this.consecutiveErrors++;
  }

  /**
   * Record a successful operation, resetting error counters.
   */
  public recordSuccess(): void {
    this.consecutiveErrors = 0;
    this.recordProgress();
  }

  /**
   * Check whether execution should abort immediately.
   */
  public shouldAbort(): boolean {
    return this.checkToolCall("").shouldStop;
  }

  /**
   * Get the reason for aborting if an abort condition is met.
   */
  public getAbortReason(): string | null {
    const result = this.checkToolCall("");
    return result.shouldStop ? result.message : null;
  }

  /**
   * Provide a structured summary of loop detector metrics.
   */
  public getStatusSummary(): LoopDetectorSummary {
    const now = Date.now();
    const fileElapsed =
      this.fileStartTime !== null ? Math.max(0, (now - this.fileStartTime) / 1000) : 0;
    const totalElapsed = Math.max(0, (now - this.startTime) / 1000);
    const timeSinceLastProgress = Math.max(0, (now - this.lastProgressTime) / 1000);
    const abortReason = this.getAbortReason();

    return {
      currentFile: this.currentFile,
      fileElapsedSeconds: Math.round(fileElapsed * 10) / 10,
      totalElapsedSeconds: Math.round(totalElapsed * 10) / 10,
      consecutiveErrors: this.consecutiveErrors,
      recentTools: this.toolHistory.slice(-5).map((t) => t.toolName),
      timeSinceLastProgressSeconds: Math.round(timeSinceLastProgress * 10) / 10,
      isAborted: abortReason !== null,
      abortReason,
    };
  }

  private computeHash(input: unknown): string {
    if (input === undefined || input === null) {
      return "";
    }
    try {
      const serialized = typeof input === "string" ? input : JSON.stringify(input);
      return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
    } catch {
      return String(input).slice(0, 32);
    }
  }
}

export interface ProgressInfo {
  phase: string;
  phaseProgress: number;
  filesCompleted: number;
  totalFiles: number;
  fileProgress: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number;
}

/**
 * ProgressTracker provides idempotent file and phase tracking for implementation workflows.
 */
export class ProgressTracker {
  public totalFiles: number;
  public completedFiles = 0;
  private readonly completedFilePaths = new Set<string>();
  public currentPhase = "Initializing";
  public phaseProgress = 0;
  private readonly startTime: number;

  constructor(totalFiles = 0) {
    this.totalFiles = Math.max(0, totalFiles);
    this.startTime = Date.now();
  }

  public setPhase(phaseName: string, progressPercent: number): void {
    this.currentPhase = phaseName;
    this.phaseProgress = Math.min(100, Math.max(0, progressPercent));
  }

  public setTotalFiles(totalFiles: number): void {
    this.totalFiles = Math.max(0, totalFiles);
  }

  public static normalizeFilePath(filename: string): string {
    return (filename || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  }

  /**
   * Complete a unique file. Returns true if first time, false if already counted.
   */
  public completeFile(filename: string): boolean {
    const normalized = ProgressTracker.normalizeFilePath(filename);
    if (normalized.length > 0 && this.completedFilePaths.has(normalized)) {
      return false;
    }
    if (normalized.length > 0) {
      this.completedFilePaths.add(normalized);
    }
    this.completedFiles++;
    return true;
  }

  public getProgressInfo(): ProgressInfo {
    const elapsedSeconds = Math.max(0, (Date.now() - this.startTime) / 1000);
    let estimatedRemainingSeconds = 0;

    if (this.completedFiles > 0 && this.totalFiles > this.completedFiles) {
      const avgTimePerFile = elapsedSeconds / this.completedFiles;
      const remainingFiles = this.totalFiles - this.completedFiles;
      estimatedRemainingSeconds = Math.round(avgTimePerFile * remainingFiles);
    }

    const fileProgress =
      this.totalFiles > 0
        ? Math.min(100, Math.round((this.completedFiles / this.totalFiles) * 100))
        : 0;

    return {
      phase: this.currentPhase,
      phaseProgress: this.phaseProgress,
      filesCompleted: this.completedFiles,
      totalFiles: this.totalFiles,
      fileProgress,
      elapsedSeconds: Math.round(elapsedSeconds),
      estimatedRemainingSeconds,
    };
  }
}
