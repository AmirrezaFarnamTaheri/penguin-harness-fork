/**
 * OS-Adaptive Sandboxed Command Runner.
 *
 * Enforces ShellGuardian security barriers before command dispatch,
 * adapts sandbox isolation to the host OS (macOS Seatbelt, Linux Bubblewrap,
 * Windows taskkill process tree isolation), and captures structured execution metrics.
 */

import fs from "node:fs";
import os from "node:os";
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
  approved?: boolean;
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

const DEFAULT_SAFE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "NODE",
  "NODE_PATH",
];

export class SandboxedCommandRunner {
  private readonly guardian: ShellGuardian;
  private readonly sandboxManager: SandboxManager;
  private readonly platform: NodeJS.Platform;
  private seatbeltProfilePath: string | null = null;

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

  private ensureSeatbeltProfile(): string {
    if (this.seatbeltProfilePath && fs.existsSync(this.seatbeltProfilePath)) {
      return this.seatbeltProfilePath;
    }
    const profileDir = os.tmpdir();
    const target = path.join(profileDir, "penguin-seatbelt.sb");
    const profile = `(version 1)\n(allow default)\n(deny file-read* file-write* (regex #"/(\\.(ssh|aws|kube))"))\n`;
    try {
      fs.writeFileSync(target, profile, "utf8");
      this.seatbeltProfilePath = target;
    } catch {
      this.seatbeltProfilePath = target;
    }
    return target;
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
        blockedReason:
          assessment.findings[0]?.description ?? "Blocked by Shell Guardian critical safety policy",
        riskAssessment: assessment,
        platform: this.platform,
        isolationMode: "blocked",
      };
    }

    if (
      (assessment.suggestedAction === "prompt_user" || assessment.requiresApproval) &&
      !options.allowCritical &&
      !options.approved
    ) {
      const reason = assessment.findings[0]?.description
        ? `${assessment.findings[0].description} (requires explicit approval)`
        : "Command requires explicit approval before unattended execution";
      return {
        command,
        allowed: false,
        blockedReason: reason,
        riskAssessment: assessment,
        platform: this.platform,
        isolationMode: "blocked",
      };
    }

    const isolationMode = this.resolveIsolationMode();
    const plan = this.resolveExecutionPlan(command, isolationMode, options.workingDirectory);

    // Build sanitized environment without inheriting parent secrets
    const sanitizedEnv: Record<string, string> = {};
    for (const key of DEFAULT_SAFE_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        sanitizedEnv[key] = process.env[key]!;
      }
    }
    if (options.env) {
      Object.assign(sanitizedEnv, options.env);
    }

    const cwd = options.workingDirectory ?? process.cwd();
    const sandbox = this.sandboxManager.createSandbox({
      provider: "local_process",
      workingDirectory: cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      env: sanitizedEnv,
    });

    const startTime = Date.now();
    try {
      const execResult: SandboxExecResult = await this.sandboxManager.exec(
        sandbox.id,
        plan.executable,
        plan.args.length > 0 ? { args: plan.args, shell: plan.shell } : { shell: plan.shell },
      );
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
        durationMs: Math.max(execResult.durationMs, Date.now() - startTime),
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
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
        exitCode: (err as any)?.exitCode ?? (err as any)?.status ?? 1,
        stdout: (err as any)?.stdout ?? "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs,
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
   * Resolves the concrete executable and argv vector for the target platform.
   */
  public resolveExecutionPlan(
    command: string,
    mode: SandboxIsolationMode,
    workingDir?: string,
  ): { executable: string; args: string[]; shell: boolean } {
    if (mode === "seatbelt") {
      const profilePath = this.ensureSeatbeltProfile();
      return {
        executable: "/usr/bin/sandbox-exec",
        args: ["-f", profilePath, "/bin/sh", "-lc", command],
        shell: false,
      };
    }

    if (mode === "bwrap") {
      const cwd = workingDir ?? process.cwd();
      return {
        executable: "bwrap",
        args: [
          "--ro-bind",
          "/",
          "/",
          "--bind",
          cwd,
          cwd,
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-net",
          "/bin/sh",
          "-lc",
          command,
        ],
        shell: false,
      };
    }

    return {
      executable: command,
      args: [],
      shell: true,
    };
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
      const profilePath = this.ensureSeatbeltProfile();
      return `sandbox-exec -f "${profilePath}" /bin/sh -lc ${JSON.stringify(command)}`;
    }

    if (mode === "bwrap") {
      const cwd = workingDir ?? process.cwd();
      return `bwrap --ro-bind / / --bind "${cwd}" "${cwd}" --dev /dev --proc /proc --unshare-net /bin/sh -lc ${JSON.stringify(command)}`;
    }

    return command;
  }
}
