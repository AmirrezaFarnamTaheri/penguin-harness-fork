import { describe, expect, it } from "vitest";
import { SandboxManager } from "../src/environment/sandbox-provider.js";

describe("SandboxManager", () => {
  it("spawns sandbox instances across different provider types", () => {
    const manager = new SandboxManager();

    const localSbx = manager.createSandbox({
      provider: "local_process",
      workingDirectory: "/workspace",
    });
    expect(localSbx.id).toBeDefined();
    expect(localSbx.provider).toBe("local_process");
    expect(localSbx.status).toBe("running");

    const e2bSbx = manager.createSandbox({
      provider: "e2b",
      image: "python-3.11",
    });
    expect(e2bSbx.provider).toBe("e2b");

    const list = manager.listSandboxes();
    expect(list.length).toBe(2);
  });

  it("executes commands and terminates sandboxes", () => {
    const manager = new SandboxManager();
    const sbx = manager.createSandbox({ provider: "docker", image: "node:24-alpine" });

    const execResult = manager.exec(sbx.id, "echo hello");
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain("[docker] Executed: echo hello");

    const term = manager.terminate(sbx.id);
    expect(term.status).toBe("terminated");
    expect(term.terminatedAt).toBeDefined();

    expect(() => manager.exec(sbx.id, "echo fail")).toThrow(/is not running/);
  });

  it("executes real commands using local_process provider", () => {
    const manager = new SandboxManager();
    const sbx = manager.createSandbox({ provider: "local_process" });

    const execResult = manager.exec(sbx.id, "node -e \"console.log('penguin-local-sandbox')\"");
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain("penguin-local-sandbox");
  });
});
