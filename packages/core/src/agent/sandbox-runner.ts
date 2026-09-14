/**
 * OS-Adaptive Sandboxed Command Runner.
 *
 * Enforces ShellGuardian security barriers before command dispatch,
 * adapts sandbox isolation to the host OS (macOS Seatbelt, Linux Bubblewrap,
 * Windows taskkill process tree isolation), and captures structured execution metrics.
 */

import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { ShellGuardian, type ShellSafetyAssessment } from "./shell-guardian.js";
import { SandboxManager, type SandboxExecResult } from "../environment/sandbox-provider.js";

export type SandboxIsolationMode = "seatbelt" | "bwrap" | "process_isolated" | "blocked";

export interface SandboxExecutionOptions {
  workingDirectory?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  allowCritical?: boolean;
}

export interface SandboxExecutionResult {
  command: string;
  allowed: boolean;
  blockedReason?: string;
  riskAssessment: ShellSafetyAssessment;
  platform: NodeJS.Platform;
  isolationMode: SandboxIsolationMode;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export class SandboxedCommandRunner {
  private readonly guardian: ShellGuardian;
  private readonly sandboxManager: SandboxManager;
  private readonly platform: NodeJS.Platform;

  constructor(options?: {
    guardian?: ShellGuardian;
    sandboxManager?: SandboxManager;
    platform?: NodeJS.Platform;
  }) {
    this.guardian = options?.guardian ?? new ShellGuardian();
    this.sandboxManager = options?.sandboxManager ?? new SandboxManager();
    this.platform = options?.platform ?? process.platform;
  }

  public getGuardian(): ShellGuardian {
    return this.guardian;
  }

  public getSandboxManager(): SandboxManager {
    return this.sandboxManager;
  }

  /**
   * Evaluates command safety and executes in an OS-appropriate sandbox.
   */
  public async execute(
    command: string,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxExecutionResult> {
    const assessment = this.guardian.analyzeCommand(command);

    if (assessment.suggestedAction === "block" && !options.allowCritical) {
      return {
        command,
        allowed: false,
        blockedReason: assessment.findings[0]?.description ?? "Blocked by Shell Guardian critical safety policy",
        riskAssessment: assessment,
        platform: this.platform,
        isolationMode: "blocked",
      };
    }

    const isolationMode = this.resolveIsolationMode();
    const wrappedCommand = this.wrapCommandForPlatform(command, isolationMode, options.workingDirectory);

    const cwd = options.workingDirectory ?? process.cwd();
    const sandbox = this.sandboxManager.createSandbox({
      provider: "local_process",
      workingDirectory: cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      env: options.env,
    });

    try {
      const execResult: SandboxExecResult = await this.sandboxManager.exec(sandbox.id, wrappedCommand);
      this.sandboxManager.terminate(sandbox.id);

      return {
        command,
        allowed: true,
        riskAssessment: assessment,
        platform: this.platform,
        isolationMode,
        exitCode: execResult.exitCode,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        durationMs: execResult.durationMs,
      };
    } catch (err: unknown) {
      try {
        this.sandboxManager.terminate(sandbox.id);
      } catch {
        // ignore
      }

      return {
        command,
        allowed: true,
        riskAssessment: assessment,
        platform: this.platform,
        isolationMode,
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      };
    }
  }

  /**
   * Resolves the available OS isolation mode.
   */
  public resolveIsolationMode(): SandboxIsolationMode {
    if (this.platform === "darwin") {
      if (fs.existsSync("/usr/bin/sandbox-exec")) {
        return "seatbelt";
      }
    } else if (this.platform === "linux") {
      try {
        const res = child_process.spawnSync("which", ["bwrap"], { stdio: "ignore" });
        if (res.status === 0) {
          return "bwrap";
        }
      } catch {
        // fallback
      }
    }

    return "process_isolated";
  }

  /**
   * Wraps a shell command with native sandbox primitives if available.
   */
  public wrapCommandForPlatform(
    command: string,
    mode: SandboxIsolationMode,
    workingDir?: string,
  ): string {
    if (mode === "seatbelt") {
      // Basic macOS seatbelt profile restricting sensitive keys and credentials
      const profile = `(version 1) (allow default) (deny file-read* file-write* (regex #"/(\\.ssh|\\.aws|\\.kube)"))`;
      return `sandbox-exec -p "${profile}" ${command}`;
    }

    if (mode === "bwrap") {
      const cwd = workingDir ?? process.cwd();
      return `bwrap --ro-bind / / --bind "${cwd}" "${cwd}" --dev /dev --proc /proc --unshare-net ${command}`;
    }

    return command;
  }
}
