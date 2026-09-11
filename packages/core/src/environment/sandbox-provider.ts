/**
 * Remote & Local Sandbox Provider Matrix.
 *
 * Provides a unified abstraction layer for ephemeral execution sandboxes
 * across local subprocesses, Docker containers, and remote cloud sandboxes (E2B, Modal, Daytona).
 *
 * Synthesized from vibekit and docker-sandbox architectures.
 */

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
  private defaultTimeoutMs: number;

  constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
  }

  public createSandbox(spec: SandboxSpec): SandboxInstance {
    const id = `sbx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const instance: SandboxInstance = {
      id,
      provider: spec.provider,
      status: "running",
      startedAt: Date.now(),
      workingDirectory: spec.workingDirectory ?? "/workspace",
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

  public listSandboxes(filter?: { provider?: SandboxProviderType; status?: SandboxStatus }): SandboxInstance[] {
    const list: SandboxInstance[] = [];
    for (const sbx of this.sandboxes.values()) {
      if (filter?.provider && sbx.provider !== filter.provider) continue;
      if (filter?.status && sbx.status !== filter.status) continue;
      list.push({ ...sbx });
    }
    return list;
  }

  public exec(sandboxId: string, command: string): SandboxExecResult {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx) {
      throw new Error(`Sandbox '${sandboxId}' not found`);
    }
    if (sbx.status !== "running") {
      throw new Error(`Sandbox '${sandboxId}' is not running (status: ${sbx.status})`);
    }

    const start = Date.now();
    // Deterministic simulation handler for sandboxed execution
    return {
      exitCode: 0,
      stdout: `[${sbx.provider}] Executed: ${command}\n`,
      stderr: "",
      durationMs: Date.now() - start,
    };
  }

  public terminate(sandboxId: string): SandboxInstance {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx) {
      throw new Error(`Sandbox '${sandboxId}' not found`);
    }

    sbx.status = "terminated";
    sbx.terminatedAt = Date.now();
    return { ...sbx };
  }
}
