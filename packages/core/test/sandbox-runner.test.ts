import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { SandboxedCommandRunner } from "../src/agent/sandbox-runner.js";
import { SwarmCoordinator } from "../src/agent/swarm-coordinator.js";
import type { SandboxInstance, SandboxManager } from "../src/environment/sandbox-provider.js";

describe("sandboxed-command-runner", () => {
  it("blocks dangerous commands before process execution", async () => {
    const runner = new SandboxedCommandRunner();
    const result = await runner.execute("rm -rf /");

    expect(result.allowed).toBe(false);
    expect(result.isolationMode).toBe("blocked");
    expect(result.blockedReason).toBeDefined();
    expect(result.exitCode).toBeUndefined();
  });

  it("executes safe commands and captures output and metrics", async () => {
    const runner = new SandboxedCommandRunner();
    const result = await runner.execute('node -e "console.log(12345 + 67890)"');

    expect(result.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim()).toBe("80235");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(["process_isolated", "seatbelt", "bwrap"]).toContain(result.isolationMode);
  });

  it("formats command wrapping based on platform mode", () => {
    const runner = new SandboxedCommandRunner();

    const seatbeltWrapped = runner.wrapCommandForPlatform("npm test", "seatbelt", "/app");
    expect(seatbeltWrapped).toContain("sandbox-exec -f");
    expect(seatbeltWrapped).toContain("npm test");

    const bwrapWrapped = runner.wrapCommandForPlatform("npm test", "bwrap", "/app");
    expect(bwrapWrapped).toContain("bwrap");
    expect(bwrapWrapped).toContain("--unshare-net");

    const direct = runner.wrapCommandForPlatform("npm test", "process_isolated", "/app");
    expect(direct).toBe("npm test");
  });

  it("safely generates execution plan with shell:false and argument vector for sandboxes", () => {
    const runner = new SandboxedCommandRunner();
    const dangerousCommand = "echo inside; cat /etc/shadow && rm -rf /";

    const bwrapPlan = runner.resolveExecutionPlan(dangerousCommand, "bwrap", "/app");
    expect(bwrapPlan.executable).toBe("bwrap");
    expect(bwrapPlan.shell).toBe(false);
    expect(bwrapPlan.args).toContain(dangerousCommand);
    expect(bwrapPlan.args.indexOf(dangerousCommand)).toBe(bwrapPlan.args.length - 1);

    const seatbeltPlan = runner.resolveExecutionPlan(dangerousCommand, "seatbelt", "/app");
    expect(seatbeltPlan.executable).toBe("/usr/bin/sandbox-exec");
    expect(seatbeltPlan.shell).toBe(false);
    expect(seatbeltPlan.args).toContain(dangerousCommand);
  });

  it("gates commands requiring approval unless explicitly approved", async () => {
    const runner = new SandboxedCommandRunner();
    // High-risk command requiring approval
    const result = await runner.execute("git push origin main --force");
    expect(result.allowed).toBe(false);
    expect(result.blockedReason).toContain("approval");

    // Can proceed when approved
    const approvedResult = await runner.execute("node -e \"console.log('ok')\"", {
      approved: true,
    });
    expect(approvedResult.allowed).toBe(true);
  });

  it("integrates with SwarmCoordinator command execution", async () => {
    const coordinator = new SwarmCoordinator();
    const result = await coordinator.executeCommand("node -e \"console.log('swarm_exec_ok')\"");

    expect(result.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim()).toBe("swarm_exec_ok");

    // Check ledger recorded the tool dispatch
    const replay = coordinator.getReplayView();
    expect(replay.events.some((e) => e.kind === "tool_dispatch")).toBe(true);
  });

  it("reports a spawn failure distinctly from a command that ran and exited non-zero", async () => {
    const failingManager: SandboxManager = {
      createSandbox: () =>
        ({
          id: "failing-sandbox",
          provider: "local_process",
          status: "running",
          startedAt: Date.now(),
          workingDirectory: process.cwd(),
          env: {},
        }) as SandboxInstance,
      exec: async () => {
        throw new Error("spawn ENOENT: bwrap not found");
      },
      terminate: () => {
        // nothing to terminate
      },
    } as unknown as SandboxManager;

    const runner = new SandboxedCommandRunner({
      sandboxManager: failingManager,
      platform: "linux",
    });
    const result = await runner.execute("some-command --flag");

    // Before the fix this returned allowed:true with exitCode 1 — indistinguishable from a command
    // that ran and failed, which is exactly what the turn ledger would record.
    expect(result.allowed).toBe(false);
    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(result.error).toContain("spawn ENOENT");
    expect(result.stderr).toContain("spawn ENOENT");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("still reports a real non-zero exit as allowed with that exit code", async () => {
    const runner = new SandboxedCommandRunner();
    const result = await runner.execute('node -e "process.exit(3)"');
    expect(result.allowed).toBe(true);
    expect(result.spawnFailed).toBeUndefined();
    expect(result.exitCode).toBe(3);
  });

  it("writes a per-process randomized seatbelt profile with 0600 permissions", () => {
    const first = new SandboxedCommandRunner({ platform: "darwin" });
    const second = new SandboxedCommandRunner({ platform: "darwin" });

    const planA = first.resolveExecutionPlan("echo hi", "seatbelt", "/app");
    const planB = second.resolveExecutionPlan("echo hi", "seatbelt", "/app");
    const pathA = planA.args[1]!;
    const pathB = planB.args[1]!;

    // Not the old fixed shared path, and not shared between two runners.
    expect(pathA).not.toBe(pathB);
    expect(pathA).not.toMatch(/penguin-seatbelt\.sb$/);
    expect(pathA).toContain("penguin-seatbelt-");

    // The profile the plan points at must actually exist and be private to this process.
    // (The 0600 mode is a POSIX guarantee; Windows ignores `mode` on file creation.)
    expect(fs.existsSync(pathA)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(pathA).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(pathA, "utf8")).toContain("(deny file-read*");
  });

  it("does not point sandbox-exec at a profile it failed to write", () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied, open");
    });
    try {
      const runner = new SandboxedCommandRunner({ platform: "darwin" });
      expect(() => runner.resolveExecutionPlan("echo hi", "seatbelt", "/app")).toThrow(
        /Seatbelt profile/,
      );
      // The wrapper path must fail the same way instead of emitting a dangling -f argument.
      expect(() => runner.wrapCommandForPlatform("echo hi", "seatbelt", "/app")).toThrow(
        /Seatbelt profile/,
      );
    } finally {
      writeSpy.mockRestore();
    }
  });
});
