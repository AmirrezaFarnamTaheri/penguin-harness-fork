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
import { randomBytes } from "node:crypto";
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
  /**
   * The command never completed under sandbox supervision: a spawn failure, a missing sandbox
   * binary, a seatbelt-profile error, a timeout, or an output-limit breach. Distinct from
   * `allowed: true` + a non-zero `exitCode`, which means the command actually ran and exited.
   * `exitCode` is intentionally absent here so the two outcomes cannot be conflated.
   */
  spawnFailed?: boolean;
  /** Human-readable failure reason when `allowed` is false. */
  error?: string;
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

  /**
   * Writes the macOS Seatbelt profile to a per-process randomized path. The fixed shared path
   * (`os.tmpdir()/penguin-seatbelt.sb`) was both a multi-user collision hazard and a symlink
   * target; and a write failure used to return that path anyway, pointing sandbox-exec at a file
   * that does not exist. Returns null when the profile cannot be written.
   */
  private ensureSeatbeltProfile(): string | null {
    if (this.seatbeltProfilePath && fs.existsSync(this.seatbeltProfilePath)) {
      return this.seatbeltProfilePath;
    }
    const profile = `(version 1)\n(allow default)\n(deny file-read* file-write* (regex #"/(\\.(ssh|aws|kube))"))\n`;
    const target = path.join(
      os.tmpdir(),
      `penguin-seatbelt-${process.pid}-${randomBytes(8).toString("hex")}.sb`,
    );
    try {
      fs.writeFileSync(target, profile, { mode: 0o600, encoding: "utf8" });
    } catch {
      // Never advertise a profile that was not written: sandbox-exec would fail for the wrong reason.
      this.seatbeltProfilePath = null;
      return null;
    }
    this.seatbeltProfilePath = target;
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
      // Resolving the plan can itself fail (a seatbelt profile it cannot write), so it belongs
      // inside the guard: a preparation failure is an execution failure, not an exit code.
      const plan = this.resolveExecutionPlan(command, isolationMode, options.workingDirectory);
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

      const message = err instanceof Error ? err.message : String(err);
      return {
        command,
        allowed: false,
        spawnFailed: true,
        error: message,
        riskAssessment: assessment,
        platform: this.platform,
        isolationMode,
        stdout: (err as { stdout?: string })?.stdout ?? "",
        stderr: message,
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
      if (!profilePath) {
        throw new Error(
          "Failed to write the macOS Seatbelt profile; cannot prepare sandboxed execution.",
        );
      }
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
      if (!profilePath) {
        throw new Error("Failed to write the macOS Seatbelt profile; cannot wrap the command.");
      }
      return `sandbox-exec -f "${profilePath}" /bin/sh -lc ${JSON.stringify(command)}`;
    }

    if (mode === "bwrap") {
      const cwd = workingDir ?? process.cwd();
      return `bwrap --ro-bind / / --bind "${cwd}" "${cwd}" --dev /dev --proc /proc --unshare-net /bin/sh -lc ${JSON.stringify(command)}`;
    }

    return command;
  }
}
