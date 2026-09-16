/**
 * Remote & Local Sandbox Provider Matrix.
 *
 * Provides a unified abstraction layer for ephemeral execution sandboxes.
 * Only providers with a connected runtime may report successful execution.
 */

import child_process from "node:child_process";
import fs from "node:fs";

export type SandboxProviderType = "local_process" | "docker" | "e2b" | "modal" | "daytona";
export type SandboxStatus = "starting" | "running" | "paused" | "terminated" | "error";

export interface SandboxSpec {
  provider: SandboxProviderType;
  image?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  workingDirectory?: string;
}

export interface SandboxInstance {
  id: string;
  provider: SandboxProviderType;
  status: SandboxStatus;
  startedAt: number;
  terminatedAt?: number;
  workingDirectory: string;
  env: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const SAFE_BASELINE_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEPATH",
  "HOMEDRIVE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "COMSPEC",
  "ComSpec",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "TERM",
] as const;

export function buildSafeChildEnv(customEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of SAFE_BASELINE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      base[key] = process.env[key]!;
    }
  }
  return { ...base, ...(customEnv ?? {}) };
}

export class SandboxManager {
  private sandboxes = new Map<string, SandboxInstance>();
  private activeChildren = new Map<string, child_process.ChildProcess>();
  private defaultTimeoutMs: number;
  private defaultMaxOutputBytes: number;

  constructor(options: { defaultTimeoutMs?: number; defaultMaxOutputBytes?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 4 * 1024 * 1024;
  }

  private killProcessTree(child: child_process.ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;

    if (process.platform === "win32") {
      // A shell command can create descendants that outlive the shell itself. taskkill /T owns the
      // whole Windows process tree; keep this synchronous so terminate() does not advertise a free
      // execution slot before the termination request has been issued.
      child_process.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }

    try {
      // POSIX children are spawned detached below, making the child's pid its process-group id.
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "ESRCH") {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited between the group and direct kill attempts.
        }
      }
    }
  }

  public createSandbox(spec: SandboxSpec): SandboxInstance {
    const id = `sbx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workingDirectory =
      spec.workingDirectory ?? (spec.provider === "local_process" ? process.cwd() : "/workspace");
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = spec.maxOutputBytes ?? this.defaultMaxOutputBytes;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Sandbox timeout must be a positive finite number");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error("Sandbox maxOutputBytes must be a positive safe integer");
    }

    const instance: SandboxInstance = {
      id,
      provider: spec.provider,
      status: "running",
      startedAt: Date.now(),
      workingDirectory,
      env: { ...(spec.env ?? {}) },
      metadata: {
        image: spec.image,
        timeoutMs,
        maxOutputBytes,
      },
    };

    this.sandboxes.set(id, instance);
    return { ...instance };
  }

  public getSandbox(id: string): SandboxInstance | undefined {
    const sbx = this.sandboxes.get(id);
    return sbx ? { ...sbx } : undefined;
  }

  public listSandboxes(filter?: {
    provider?: SandboxProviderType;
    status?: SandboxStatus;
  }): SandboxInstance[] {
    const list: SandboxInstance[] = [];
    for (const sbx of this.sandboxes.values()) {
      if (filter?.provider && sbx.provider !== filter.provider) continue;
      if (filter?.status && sbx.status !== filter.status) continue;
      list.push({ ...sbx });
    }
    return list;
  }

  public async exec(
    sandboxId: string,
    command: string,
    options?: { args?: string[]; shell?: boolean },
  ): Promise<SandboxExecResult> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx) throw new Error(`Sandbox '${sandboxId}' not found`);
    if (sbx.status !== "running") {
      throw new Error(`Sandbox '${sandboxId}' is not running (status: ${sbx.status})`);
    }
    if (sbx.provider !== "local_process") {
      throw new Error(
        `Sandbox provider '${sbx.provider}' is not connected in this runtime; execution is unsupported.`,
      );
    }
    if (!fs.existsSync(sbx.workingDirectory) || !fs.statSync(sbx.workingDirectory).isDirectory()) {
      throw new Error(`Sandbox working directory does not exist: ${sbx.workingDirectory}`);
    }
    if (this.activeChildren.has(sandboxId)) {
      throw new Error(`Sandbox '${sandboxId}' already has an active command`);
    }

    const timeoutMs =
      typeof sbx.metadata?.timeoutMs === "number" ? sbx.metadata.timeoutMs : this.defaultTimeoutMs;
    const maxOutputBytes =
      typeof sbx.metadata?.maxOutputBytes === "number"
        ? sbx.metadata.maxOutputBytes
        : this.defaultMaxOutputBytes;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Sandbox timeout must be a positive finite number");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error("Sandbox maxOutputBytes must be a positive safe integer");
    }

    const startedAt = Date.now();
    const childEnv = buildSafeChildEnv(sbx.env);
    return await new Promise<SandboxExecResult>((resolve, reject) => {
      const child = options?.args
        ? child_process.spawn(command, options.args, {
            shell: options.shell ?? false,
            cwd: sbx.workingDirectory,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
          })
        : child_process.spawn(command, {
            shell: options?.shell ?? true,
            cwd: sbx.workingDirectory,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
          });
      this.activeChildren.set(sandboxId, child);

      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeChildren.get(sandboxId) === child) this.activeChildren.delete(sandboxId);
        callback();
      };
      const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        capturedBytes += buffer.byteLength;
        if (capturedBytes > maxOutputBytes) {
          this.killProcessTree(child);
          finish(() =>
            reject(new Error(`Sandbox command exceeded output limit of ${maxOutputBytes} bytes`)),
          );
          return;
        }
        if (stream === "stdout") stdout += buffer.toString("utf-8");
        else stderr += buffer.toString("utf-8");
      };

      child.stdout?.on("data", (chunk: Buffer | string) => appendOutput("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => appendOutput("stderr", chunk));

      timer = setTimeout(() => {
        this.killProcessTree(child);
        finish(() =>
          reject(
            new Error(
              `Sandbox command timed out after ${timeoutMs}ms in '${sbx.workingDirectory}'`,
            ),
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, signal) => {
        finish(() => {
          resolve({
            exitCode: code ?? (signal ? 1 : 0),
            stdout,
            stderr: signal && !stderr ? `Process terminated by ${signal}` : stderr,
            durationMs: Date.now() - startedAt,
          });
        });
      });
    });
  }

  public terminate(sandboxId: string): SandboxInstance {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx) throw new Error(`Sandbox '${sandboxId}' not found`);

    const child = this.activeChildren.get(sandboxId);
    if (child) {
      this.killProcessTree(child);
      // Keep the child registered until its close/error event settles exec(); otherwise a caller
      // could start another command while descendants from the old execution are still exiting.
    }
    sbx.status = "terminated";
    sbx.terminatedAt = Date.now();
    return { ...sbx };
  }
}
