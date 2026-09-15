import { describe, it, expect } from "vitest";
import { SandboxedCommandRunner } from "../src/agent/sandbox-runner.js";
import { SwarmCoordinator } from "../src/agent/swarm-coordinator.js";

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
});
