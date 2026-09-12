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

export class SandboxManager {
  private sandboxes = new Map<string, SandboxInstance>();
  private activeChildren = new Map<string, child_process.ChildProcess>();
  private defaultTimeoutMs: number;

  constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
  }

  public createSandbox(spec: SandboxSpec): SandboxInstance {
    const id = `sbx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workingDirectory =
      spec.workingDirectory ?? (spec.provider === "local_process" ? process.cwd() : "/workspace");
    const instance: SandboxInstance = {
      id,
      provider: spec.provider,
      status: "running",
      startedAt: Date.now(),
      workingDirectory,
      env: { ...(spec.env ?? {}) },
      metadata: {
        image: spec.image,
        timeoutMs: spec.timeoutMs ?? this.defaultTimeoutMs,
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

  public async exec(sandboxId: string, command: string): Promise<SandboxExecResult> {
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
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Sandbox timeout must be a positive finite number");
    }

    const startedAt = Date.now();
    return await new Promise<SandboxExecResult>((resolve, reject) => {
      const child = child_process.spawn(command, {
        shell: true,
        cwd: sbx.workingDirectory,
        env: { ...process.env, ...sbx.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.activeChildren.set(sandboxId, child);

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeChildren.get(sandboxId) === child) this.activeChildren.delete(sandboxId);
        callback();
      };

      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() =>
          reject(new Error(`Sandbox command timed out after ${timeoutMs}ms in '${sbx.workingDirectory}'`)),
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
      child.kill("SIGKILL");
      this.activeChildren.delete(sandboxId);
    }
    sbx.status = "terminated";
    sbx.terminatedAt = Date.now();
    return { ...sbx };
  }
}
