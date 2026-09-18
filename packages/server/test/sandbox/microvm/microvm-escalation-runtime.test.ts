import { describe, expect, it } from "vitest";
import {
  ESCALATION_BUDGET_MS,
  MicrovmEscalationRuntime,
} from "../../../src/sandbox/microvm/microvm-escalation-runtime.js";
import {
  MicrovmError,
  MicrovmInvalidArgumentError,
  MicrovmSandboxNotFoundError,
  MicrovmServiceBusyError,
  type MicrovmCommandResult,
  type MicrovmId,
  type MicrovmInfo,
  type MicrovmSandboxClient,
} from "../../../src/sandbox/microvm/microvm-sandbox-client.js";
import type { IsolatedCommand } from "@prismshadow/penguin-core/plugin";

/** A scripted control plane: canned responses in order, plus the calls made against it. */
type PlaneCall = { method: string; sandboxId?: MicrovmId; command?: string };
class ScriptedPlane {
  readonly calls: PlaneCall[] = [];
  constructor(private readonly script: ReadonlyArray<() => unknown>) {}

  next(method: string, sandboxId?: MicrovmId, command?: string): unknown {
    this.calls.push({ method, sandboxId, command });
    const step = this.script[this.calls.length - 1];
    if (!step) {
      // Name the missing step rather than letting a bare TypeError escape, so a test
      // that under-scripts the plane reports what it actually forgot.
      throw new MicrovmError(
        `scripted plane has no step for call #${this.calls.length} (${method})`,
      );
    }
    return step();
  }
}

function planeClient(plane: ScriptedPlane): MicrovmSandboxClient {
  return {
    create: async () => plane.next("create") as MicrovmInfo,
    getInfo: async (id: MicrovmId) => plane.next("getInfo", id) as MicrovmInfo,
    exists: async (id: MicrovmId) => Boolean(plane.next("exists", id)),
    kill: async (id: MicrovmId) => {
      plane.next("kill", id);
    },
    runCommand: async (id: MicrovmId, command: { cmd: string }) =>
      plane.next("runCommand", id, command.cmd) as MicrovmCommandResult,
  } as unknown as MicrovmSandboxClient;
}

function runtime(plane: ScriptedPlane): MicrovmEscalationRuntime {
  return new MicrovmEscalationRuntime({
    client: planeClient(plane),
    templateId: "base",
    log: () => {},
  });
}

function command(overrides: Partial<IsolatedCommand> = {}): IsolatedCommand {
  return {
    script: overrides.script ?? "echo hello",
    ceilings: overrides.ceilings ?? {
      maxProcesses: 64,
      maxMemoryBytes: 512 * 1024 * 1024,
      sigkillTimeoutMs: 5_000,
    },
    allowList: overrides.allowList ?? [],
    ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
    ...(overrides.env ? { env: overrides.env } : {}),
  };
}

function ok(stdout = "hello"): MicrovmCommandResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
}

describe("microvm-escalation-runtime", () => {
  describe("construction", () => {
    it("requires a client", () => {
      expect(
        () =>
          new MicrovmEscalationRuntime({
            client: undefined as unknown as MicrovmSandboxClient,
          }),
      ).toThrow(MicrovmInvalidArgumentError);
    });

    it("boots the configured template by default", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1", templateId: "base" }),
        () => ok(),
        () => undefined,
      ]);
      const run = new MicrovmEscalationRuntime({
        client: planeClient(plane),
        log: () => {},
      });
      await run.run(command());
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "runCommand"]);
    });
  });

  describe("run", () => {
    it("boots a sandbox, runs the script, and returns its output", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => ({ exitCode: 0, stdout: "out", stderr: "err", timedOut: false }),
      ]);
      const run = runtime(plane);

      const result = await run.run(command({ script: "uname" }));

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "out",
        stderr: "err",
        sandboxId: "sb1",
      });
      expect(plane.calls[1]).toMatchObject({ method: "runCommand", command: "uname" });
    });

    it("refuses an empty script", async () => {
      const run = runtime(new ScriptedPlane([]));
      await expect(run.run(command({ script: "" }))).rejects.toBeInstanceOf(
        MicrovmInvalidArgumentError,
      );
    });

    it("reuses the session sandbox across commands instead of re-booting", async () => {
      const plane = new ScriptedPlane([() => ({ id: "sb1" }), () => ok("one"), () => ok("two")]);
      const run = runtime(plane);

      await run.run(command());
      await run.run(command());

      // One boot, two commands.
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "runCommand", "runCommand"]);
    });

    it("re-boots after a command timed out, since that sandbox is dead", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => ({ exitCode: 124, stdout: "", stderr: "killed", timedOut: true }),
        () => ({ id: "sb2" }),
        () => ok("recovered"),
      ]);
      const run = runtime(plane);

      const first = await run.run(command());
      expect(first.limitHit).toBe("command_timeout");

      const second = await run.run(command());
      expect(second.sandboxId).toBe("sb2");
      expect(plane.calls.map((c) => c.method)).toEqual([
        "create",
        "runCommand",
        "create",
        "runCommand",
      ]);
    });

    it("records telemetry for a successful run", async () => {
      const plane = new ScriptedPlane([() => ({ id: "sb1" }), () => ok("data")]);
      const run = runtime(plane);

      await run.run(command());

      const [sample] = run.recorded;
      expect(sample).toMatchObject({
        tier: "isolated",
        exitCode: 0,
        bytesWritten: 4,
        sandboxId: "sb1",
      });
    });

    it("translates a plane failure into a backend error with telemetry", async () => {
      const plane = new ScriptedPlane([
        () => {
          throw new MicrovmServiceBusyError("no capacity");
        },
      ]);
      const run = runtime(plane);

      await expect(run.run(command())).rejects.toBeInstanceOf(MicrovmError);

      const [sample] = run.recorded;
      // A boot failure still records one sample: an escalation that never ran is
      // still an escalation the cockpit must count.
      expect(sample).toBeDefined();
      expect(sample!.tier).toBe("isolated");
      expect(sample!.reason).toBe("runtime_unavailable");
      expect(sample!.limitHit).toBe("service_busy");
    });

    it("marks the sandbox dead and refuses after a command error", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => {
          throw new MicrovmError("plane gone");
        },
        () => ({ id: "sb2" }),
        () => ok(),
      ]);
      const run = runtime(plane);

      await expect(run.run(command())).rejects.toBeInstanceOf(MicrovmError);
      // The next run boots fresh, because the first sandbox is dead.
      const result = await run.run(command());
      expect(result.sandboxId).toBe("sb2");
    });
  });

  describe("summarize", () => {
    it("reports zeros before any run", () => {
      const run = runtime(new ScriptedPlane([]));
      expect(run.summarize()).toMatchObject({
        total: 0,
        escalated: 0,
        inMemory: 0,
        failures: 0,
        meanEscalationMs: 0,
        overBudget: 0,
        liveSandboxes: 0,
      });
    });

    it("aggregates runs and counts budget breaches", async () => {
      // Both runs share the default session's sandbox, so the plane sees one boot and
      // two commands — the reuse this runtime exists to provide.
      const plane = new ScriptedPlane([() => ({ id: "sb1" }), () => ok("a"), () => ok("bb")]);
      const run = runtime(plane);

      await run.run(command());
      await run.run(command());

      const summary = run.summarize();
      expect(summary.total).toBe(2);
      expect(summary.escalated).toBe(2);
      expect(summary.liveSandboxes).toBe(1);
      // Every run here is sub-millisecond, so none breach the 220ms budget.
      expect(summary.overBudget).toBe(0);
      expect(summary.meanEscalationMs).toBeGreaterThanOrEqual(0);
      expect(ESCALATION_BUDGET_MS).toBe(220);
    });

    it("counts non-zero exits as failures", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false }),
      ]);
      const run = runtime(plane);
      await run.run(command());
      expect(run.summarize().failures).toBe(1);
    });
  });

  describe("lifecycle release", () => {
    it("releaseSession kills its sandbox and is a no-op when unknown", async () => {
      const plane = new ScriptedPlane([() => ({ id: "sb1" }), () => ok(), () => undefined]);
      const run = runtime(plane);
      await run.run(command());

      await run.releaseSession("default");
      expect(plane.calls.some((c) => c.method === "kill")).toBe(true);
      expect(run.liveSandboxes).toBe(0);

      // Releasing a session that was never live does nothing.
      await run.releaseSession("nope");
      expect(plane.calls.filter((c) => c.method === "kill")).toHaveLength(1);
    });

    it("kill failures are swallowed except for a missing sandbox", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => ok(),
        () => {
          throw new MicrovmSandboxNotFoundError("already gone");
        },
      ]);
      const run = runtime(plane);
      await run.run(command());
      // A not-found during release is expected, not an error.
      await expect(run.releaseSession("default")).resolves.toBeUndefined();
    });

    it("dispose releases every live sandbox", async () => {
      const plane = new ScriptedPlane([() => ({ id: "sb1" }), () => ok(), () => undefined]);
      const run = runtime(plane);
      await run.run(command());
      await run.dispose();
      expect(run.liveSandboxes).toBe(0);
    });

    it("a disposed runtime refuses further runs", async () => {
      const run = runtime(new ScriptedPlane([]));
      await run.dispose();
      await expect(run.run(command())).rejects.toBeInstanceOf(MicrovmError);
    });
  });
});
