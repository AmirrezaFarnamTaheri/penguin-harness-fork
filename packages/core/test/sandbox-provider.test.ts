import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxManager } from "../src/environment/sandbox-provider.js";

describe("SandboxManager", () => {
  it("spawns sandbox instances across different provider types", () => {
    const manager = new SandboxManager();

    const localSbx = manager.createSandbox({ provider: "local_process" });
    expect(localSbx.id).toBeDefined();
    expect(localSbx.provider).toBe("local_process");
    expect(localSbx.status).toBe("running");

    const e2bSbx = manager.createSandbox({ provider: "e2b", image: "python-3.11" });
    expect(e2bSbx.provider).toBe("e2b");
    expect(manager.listSandboxes()).toHaveLength(2);
  });

  it("reports unconnected providers as unsupported instead of fake success", async () => {
    const manager = new SandboxManager();
    const sbx = manager.createSandbox({ provider: "docker", image: "node:24-alpine" });

    await expect(manager.exec(sbx.id, "echo hello")).rejects.toThrow(/unsupported/i);
    const term = manager.terminate(sbx.id);
    expect(term.status).toBe("terminated");
    expect(term.terminatedAt).toBeDefined();
    await expect(manager.exec(sbx.id, "echo fail")).rejects.toThrow(/is not running/);
  });

  it("executes real commands using local_process provider", async () => {
    const manager = new SandboxManager();
    const sbx = manager.createSandbox({ provider: "local_process" });

    const execResult = await manager.exec(
      sbx.id,
      "node -e \"console.log('penguin-local-sandbox')\"",
    );
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain("penguin-local-sandbox");
  });

  it("rejects a configured missing working directory instead of falling back", async () => {
    const manager = new SandboxManager();
    const missing = path.join(os.tmpdir(), `penguin-missing-${Date.now()}`);
    const sbx = manager.createSandbox({ provider: "local_process", workingDirectory: missing });

    await expect(manager.exec(sbx.id, "echo should-not-run")).rejects.toThrow(
      /working directory does not exist/i,
    );
  });

  it("terminates an in-flight local process", async () => {
    const manager = new SandboxManager({ defaultTimeoutMs: 10_000 });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-sandbox-"));
    const sbx = manager.createSandbox({ provider: "local_process", workingDirectory: cwd });

    const running = manager.exec(sbx.id, 'node -e "setTimeout(() => {}, 5000)"');
    await new Promise((resolve) => setTimeout(resolve, 25));
    manager.terminate(sbx.id);
    const result = await running;
    expect(result.exitCode).not.toBe(0);
    expect(manager.getSandbox(sbx.id)?.status).toBe("terminated");
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
