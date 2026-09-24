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
type PlaneCall = {
  method: string;
  sandboxId?: MicrovmId;
  command?: string;
  egressAllowList?: readonly string[];
  ceilings?: Record<string, number>;
};
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

  nextCreate(ceilings: Record<string, number> | undefined): unknown {
    this.calls.push({ method: "create", ceilings });
    const step = this.script[this.calls.length - 1];
    if (!step) {
      throw new MicrovmError(`scripted plane has no step for call #${this.calls.length} (create)`);
    }
    return step();
  }

  nextNetwork(method: string, sandboxId: MicrovmId, egressAllowList: readonly string[]): unknown {
    this.calls.push({ method, sandboxId, egressAllowList });
    const step = this.script[this.calls.length - 1];
    if (!step) {
      throw new MicrovmError(
        `scripted plane has no step for call #${this.calls.length} (${method})`,
      );
    }
    return step();
  }
}

function planeClient(plane: ScriptedPlane): MicrovmSandboxClient {
  return {
    create: async (params?: { ceilings?: Record<string, number> }) =>
      plane.nextCreate(params?.ceilings) as MicrovmInfo,
    getInfo: async (id: MicrovmId) => plane.next("getInfo", id) as MicrovmInfo,
    exists: async (id: MicrovmId) => Boolean(plane.next("exists", id)),
    kill: async (id: MicrovmId) => {
      plane.next("kill", id);
    },
    runCommand: async (id: MicrovmId, command: { cmd: string }) =>
      plane.next("runCommand", id, command.cmd) as MicrovmCommandResult,
    updateNetwork: async (id: MicrovmId, network: { egressAllowList?: readonly string[] }) => {
      plane.nextNetwork("updateNetwork", id, network.egressAllowList ?? []);
    },
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
    sessionKey: overrides.sessionKey ?? "test-session",
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
        () => undefined, // updateNetwork — network-off, the default command grants no network
        () => ok(),
      ]);
      const run = new MicrovmEscalationRuntime({
        client: planeClient(plane),
        log: () => {},
      });
      await run.run(command());
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "updateNetwork", "runCommand"]);
    });
  });

  describe("run", () => {
    it("boots a sandbox, runs the script, and returns its output", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
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
      expect(plane.calls[2]).toMatchObject({ method: "runCommand", command: "uname" });
    });

    it("refuses an empty script", async () => {
      const run = runtime(new ScriptedPlane([]));
      await expect(run.run(command({ script: "" }))).rejects.toBeInstanceOf(
        MicrovmInvalidArgumentError,
      );
    });

    it("refuses a missing sandbox namespace rather than sharing a default sandbox", async () => {
      const run = runtime(new ScriptedPlane([]));
      const missingKey = { ...command(), sessionKey: undefined } as unknown as IsolatedCommand;
      await expect(run.run(missingKey)).rejects.toBeInstanceOf(MicrovmInvalidArgumentError);
    });

    it("reuses the session sandbox across commands instead of re-booting", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork — boot
        () => ok("one"),
        () => ok("two"),
      ]);
      const run = runtime(plane);

      await run.run(command());
      await run.run(command());

      // One boot, one egress policy, two commands — the policy is unchanged, so it is not re-sent.
      expect(plane.calls.map((c) => c.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "runCommand",
      ]);
    });

    it("never reuses a sandbox across different session keys", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined,
        () => ok("session one"),
        () => ({ id: "sb2" }),
        () => undefined,
        () => ok("session two"),
      ]);
      const run = runtime(plane);

      const first = await run.run(command({ sessionKey: "session-one" }));
      const second = await run.run(command({ sessionKey: "session-two" }));

      expect(first.sandboxId).toBe("sb1");
      expect(second.sandboxId).toBe("sb2");
      expect(plane.calls.map((call) => call.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "create",
        "updateNetwork",
        "runCommand",
      ]);
    });

    it("serializes concurrent commands before changing a shared sandbox's policy", async () => {
      let finishFirst!: (result: MicrovmCommandResult) => void;
      const firstCommand = new Promise<MicrovmCommandResult>((resolve) => {
        finishFirst = resolve;
      });
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // initial policy
        () => firstCommand,
        () => undefined, // second policy
        () => ok("second"),
      ]);
      const run = runtime(plane);
      const first = run.run(command({ allowList: ["https://wide.example.test"] }));
      const second = run.run(command({ allowList: [] }));

      for (let i = 0; i < 20 && !plane.calls.some((call) => call.method === "runCommand"); i++) {
        await Promise.resolve();
      }
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "updateNetwork", "runCommand"]);

      finishFirst(ok("first"));
      expect((await first).stdout).toBe("first");
      expect((await second).stdout).toBe("second");
      expect(plane.calls.map((c) => c.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "updateNetwork",
        "runCommand",
      ]);
      expect(plane.calls[3]?.egressAllowList).toEqual([]);
    });

    it("constrains egress to the command's allow-list before the first command runs", async () => {
      // Without this call the sandbox keeps whatever egress its template defaults to, which is
      // how an escalation granted `network:outbound` silently reaches anywhere.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
        () => ok("ran"),
      ]);
      const run = runtime(plane);

      const result = await run.run(
        command({ allowList: ["https://api.example.test", { url: "https://cdn.example.test" }] }),
      );

      expect(result.stdout).toBe("ran");
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "updateNetwork", "runCommand"]);
      expect(plane.calls[1]).toMatchObject({
        method: "updateNetwork",
        sandboxId: "sb1",
        egressAllowList: ["https://api.example.test", "https://cdn.example.test"],
      });
    });

    it("refuses to run when the egress policy could not be applied", async () => {
      // Fail closed: a sandbox whose egress is unconstrained must not run a networked escalation,
      // so a rejected updateNetwork fails the boot instead of falling back to the template default.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => {
          throw new MicrovmError("egress policy rejected");
        },
        () => undefined, // kill the VM created before the policy failed
      ]);
      const logs: string[] = [];
      const logged = new MicrovmEscalationRuntime({
        client: planeClient(plane),
        templateId: "base",
        log: (message: string) => {
          logs.push(message);
        },
      });

      await expect(
        logged.run(command({ allowList: ["https://api.example.test"] })),
      ).rejects.toBeInstanceOf(MicrovmError);
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "updateNetwork", "kill"]);
      expect(logs.some((m) => m.includes("constraining egress"))).toBe(true);
    });

    it("revokes egress when the policy grants no network at all", async () => {
      // An empty allow-list is an explicit network-off, not "no policy": skipping the call would
      // leave the sandbox on whatever egress its template happens to default to.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
        () => ok("ran"),
      ]);
      const logs: string[] = [];
      const logged = new MicrovmEscalationRuntime({
        client: planeClient(plane),
        templateId: "base",
        log: (message: string) => {
          logs.push(message);
        },
      });

      const result = await logged.run(command({ allowList: [] }));

      expect(result.stdout).toBe("ran");
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "updateNetwork", "runCommand"]);
      expect(plane.calls[1]).toMatchObject({
        method: "updateNetwork",
        sandboxId: "sb1",
        egressAllowList: [],
      });
      expect(logs.some((m) => m.includes("revoking egress"))).toBe(true);
    });

    it("refuses to run when the network-off policy could not be applied", async () => {
      // Fail closed on the empty-list path too: a sandbox that could not be told to go network-off
      // must not run the escalation at all.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => {
          throw new MicrovmError("egress policy rejected");
        },
        () => undefined, // kill the VM created before the policy failed
      ]);
      const run = runtime(plane);

      await expect(run.run(command({ allowList: [] }))).rejects.toBeInstanceOf(MicrovmError);
      expect(plane.calls.map((c) => c.method)).toEqual(["create", "updateNetwork", "kill"]);
    });

    it("re-applies the egress policy when a later command's policy differs", async () => {
      // The sandbox is reused across the commands of one session, but the first command's
      // allow-list must not govern a later command whose policy is narrower.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork — boot, wide
        () => ok("wide"),
        () => undefined, // updateNetwork — narrowed
        () => ok("narrow"),
      ]);
      const run = runtime(plane);

      await run.run(command({ allowList: ["https://a.example.test", "https://b.example.test"] }));
      await run.run(command({ allowList: ["https://a.example.test"] }));

      expect(plane.calls.map((c) => c.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "updateNetwork",
        "runCommand",
      ]);
      expect(plane.calls[3]).toMatchObject({
        method: "updateNetwork",
        sandboxId: "sb1",
        egressAllowList: ["https://a.example.test"],
      });
    });

    it("marks the sandbox dead when a policy change could not be applied", async () => {
      // The sandbox's egress is now unknown, so it must not be reused — and this command does not run.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork — boot
        () => ok("wide"),
        () => {
          throw new MicrovmError("egress policy rejected");
        },
        () => undefined, // kill the reused VM after the failed policy change
      ]);
      const run = runtime(plane);

      await run.run(command({ allowList: ["https://a.example.test"] }));
      await expect(run.run(command({ allowList: [] }))).rejects.toBeInstanceOf(MicrovmError);

      expect(plane.calls.map((c) => c.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "updateNetwork",
        "kill",
      ]);
    });

    it("forwards the command's resource ceilings at boot", async () => {
      // The ceilings the policy computed are part of the boot, not an afterthought: a fork-bomb
      // cap that never reaches the plane is not a cap.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
        () => ok("ran"),
      ]);
      const run = runtime(plane);

      await run.run(
        command({
          ceilings: { maxProcesses: 8, maxMemoryBytes: 64 * 1024 * 1024, sigkillTimeoutMs: 1_000 },
        }),
      );

      expect(plane.calls[0]).toMatchObject({
        method: "create",
        ceilings: { maxProcesses: 8, maxMemoryBytes: 64 * 1024 * 1024, sigkillTimeoutMs: 1_000 },
      });
    });

    it("re-boots after a command timed out, since that sandbox is dead", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork — boot
        () => ({ exitCode: 124, stdout: "", stderr: "killed", timedOut: true }),
        () => undefined, // kill the timed-out sandbox
        () => ({ id: "sb2" }),
        () => undefined, // updateNetwork — re-boot
        () => ok("recovered"),
      ]);
      const run = runtime(plane);

      const first = await run.run(command());
      expect(first.limitHit).toBe("command_timeout");

      const second = await run.run(command());
      expect(second.sandboxId).toBe("sb2");
      expect(plane.calls.map((c) => c.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "kill",
        "create",
        "updateNetwork",
        "runCommand",
      ]);
    });

    it("records telemetry for a successful run", async () => {
      const plane = new ScriptedPlane([() => ({ id: "sb1" }), () => undefined, () => ok("data")]);
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
        () => undefined, // updateNetwork — boot
        () => {
          throw new MicrovmError("plane gone");
        },
        () => undefined, // kill the failed sandbox
        () => ({ id: "sb2" }),
        () => undefined, // updateNetwork — re-boot
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
      // Both runs share the default session's sandbox, so the plane sees one boot, one egress
      // policy and two commands — the reuse this runtime exists to provide.
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork — boot
        () => ok("a"),
        () => ok("bb"),
      ]);
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
        () => undefined, // updateNetwork
        () => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false }),
      ]);
      const run = runtime(plane);
      await run.run(command());
      expect(run.summarize().failures).toBe(1);
    });
  });

  describe("lifecycle release", () => {
    it("orders release between commands queued on the same session", async () => {
      let resolveFirst!: (result: MicrovmCommandResult) => void;
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined,
        () => {
          firstStarted();
          return new Promise<MicrovmCommandResult>((resolve) => {
            resolveFirst = resolve;
          });
        },
        () => undefined, // release kills sb1
        () => ({ id: "sb2" }),
        () => undefined,
        () => ok("second"),
      ]);
      const run = runtime(plane);

      const first = run.run(command());
      await started;
      const releasing = run.releaseSession("test-session");
      const second = run.run(command());
      resolveFirst(ok("first"));
      await first;
      await releasing;
      expect((await second).sandboxId).toBe("sb2");
      expect(plane.calls.map((call) => call.method)).toEqual([
        "create",
        "updateNetwork",
        "runCommand",
        "kill",
        "create",
        "updateNetwork",
        "runCommand",
      ]);
    });

    it("releaseSession kills its sandbox and is a no-op when unknown", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
        () => ok(),
        () => undefined, // kill
      ]);
      const run = runtime(plane);
      await run.run(command());

      await run.releaseSession("test-session");
      expect(plane.calls.some((c) => c.method === "kill")).toBe(true);
      expect(run.liveSandboxes).toBe(0);

      // Releasing a session that was never live does nothing.
      await run.releaseSession("nope");
      expect(plane.calls.filter((c) => c.method === "kill")).toHaveLength(1);
    });

    it("kill failures are swallowed except for a missing sandbox", async () => {
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
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
      const plane = new ScriptedPlane([
        () => ({ id: "sb1" }),
        () => undefined, // updateNetwork
        () => ok(),
        () => undefined, // kill
      ]);
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
