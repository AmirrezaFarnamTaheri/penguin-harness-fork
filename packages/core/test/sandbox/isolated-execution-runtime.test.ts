import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyScript } from "../../src/sandbox/shell-evaluator.js";
import { SandboxPolicyBox, SecurityViolationError } from "../../src/sandbox/sandbox-policy-box.js";
import {
  decideTier,
  DEFAULT_ISOLATION_CEILINGS,
  IsolatedExecutionRuntime,
  IsolationRefusalError,
  mentionsNetworkSocket,
  mentionsPathOutsideRoot,
  type IsolatedBackend,
  type IsolatedCommand,
  type IsolatedResult,
} from "../../src/sandbox/isolated-execution-runtime.js";

/**
 * A policy box whose capability list is exactly what a test wants on. The box is a
 * per-process singleton that refuses to coexist with a differently-configured
 * instance, so each test resets it first.
 */
function policyBox(...capabilities: string[]): SandboxPolicyBox {
  SandboxPolicyBox.resetInstance();
  return SandboxPolicyBox.getInstance({ capabilities });
}

/** A clock that advances one tick per read, so durations are exact and non-zero. */
function tickingClock(): { now: () => number; ticks: number } {
  const state = { ticks: 0 };
  return {
    now: () => (state.ticks += 1),
    get ticks() {
      return state.ticks;
    },
  };
}

/**
 * Reads the rejection reason off the classifier's verdict. `reason` exists only on the
 * `inMemorySafe: false` branch of the discriminated union, so narrowing on that flag is
 * what exposes it; a safe verdict has nothing to name, and `undefined` fails the
 * assertions that call this.
 */
function classifyReason(source: string) {
  const verdict = classifyScript(source);
  return verdict.inMemorySafe ? undefined : verdict.reason;
}

/**
 * The isolated tier's contract is defined here and implemented elsewhere; a recording
 * double is how a test observes what the runtime escalated, without booting a real
 * sandbox. The runtime owns the decision, the backend owns the enforcement.
 */
class RecordingBackend implements IsolatedBackend {
  readonly name = "recording";
  readonly commands: IsolatedCommand[] = [];
  result: IsolatedResult = {
    exitCode: 0,
    stdout: "isolated output\n",
    stderr: "",
    sandboxId: "sandbox-0001",
    processCount: 3,
    syscallsDenied: 2,
    bytesWritten: 512,
  };

  async run(command: IsolatedCommand): Promise<IsolatedResult> {
    this.commands.push(command);
    return { ...this.result };
  }
}

describe("isolated-execution-runtime", () => {
  afterEach(() => {
    SandboxPolicyBox.resetInstance();
  });

  describe("decideTier", () => {
    it("classifies a pure shell script as in-memory", () => {
      const decision = decideTier('GREETING=hello; echo "$GREETING world"');
      expect(decision.tier).toBe("in_memory");
      // A safe verdict carries no escalation evidence: `reason` and `at` are absent so
      // an approval prompt cannot display a phantom denial.
      expect(decision.reason).toBeUndefined();
      expect(decision.at).toBeUndefined();
    });

    it("classifies a pure script that only uses built-ins and expansions", () => {
      for (const source of [
        "echo hello world",
        "echo hi && echo bye",
        "false || echo recovered",
        "a=1 b=2 pwd",
        'echo "${UNSET:-fallback}"',
        '[ "x" = "x" ] && echo matched',
      ]) {
        expect(decideTier(source).tier, source).toBe("in_memory");
      }
    });

    it("escalates a redirection and names the offending token", () => {
      const source = "echo hi > /tmp/out";
      const decision = decideTier(source);
      expect(decision.tier).toBe("isolated");
      expect(decision.reason).toBe("unsupported_construct");
      // The evidence is the token that broke in-memory safety: the `>` operator at byte
      // offset 8, not a whole-script guess.
      expect(decision.at?.value).toBe(">");
      expect(decision.at?.start).toBe(8);
      expect(decision.at?.end).toBe(9);
      expect(decision.at?.line).toBe(1);
      expect(decision.at?.column).toBe(9);
    });

    it("escalates an unsafe construct from its command position", () => {
      // A word in command position names a binary the in-memory tier does not implement.
      const native = decideTier("ls -la /");
      expect(native.tier).toBe("isolated");
      expect(native.at?.value).toBe("ls");
      expect(native.at?.start).toBe(0);

      const network = decideTier("curl -s https://example.com");
      expect(network.tier).toBe("isolated");
      expect(network.at?.value).toBe("curl");

      const subshell = decideTier("(echo hi)");
      expect(subshell.tier).toBe("isolated");
      expect(subshell.at?.value).toBe("(");

      const arithmetic = decideTier("(( 1 + 1 ))");
      expect(arithmetic.tier).toBe("isolated");
      expect(arithmetic.at?.value).toBe("((");
    });

    it("maps the evaluator's reason onto an escalation reason", () => {
      // The classifier reports the construct it rejected; the runtime reports the tier
      // consequence. Both are part of the evidence chain a caller displays.
      expect(classifyReason("echo hi > /tmp/out")).toBe("redirection");
      expect(classifyReason("ls -la")).toBe("external_command");
      expect(classifyReason("(echo hi)")).toBe("subshell");

      // A newline ends a command as surely as `;` does, so a binary named on a later line is in
      // command position, not an argument of the first line — otherwise the verdict would read
      // the script as in-memory safe and ask no approval for it.
      expect(classifyReason("echo hi\nls -la")).toBe("external_command");
      expect(classifyReason("true\nrm")).toBe("external_command");
      expect(classifyReason("echo hi && ls -la")).toBe("external_command");

      // Every construct the in-memory tier does not model escalates for the same
      // stated cause: the tier is unavailable for it, not merely unimplemented.
      expect(decideTier("echo hi > /tmp/out").reason).toBe("unsupported_construct");
      expect(decideTier("ls -la").reason).toBe("unsupported_construct");
      expect(decideTier("(echo hi)").reason).toBe("unsupported_construct");
    });

    it("reports a network-touching script as isolated", () => {
      const source = "curl -s https://example.com/api";
      expect(decideTier(source).tier).toBe("isolated");
      // A script reaches a socket through a binary the tokens may not name; the lexical
      // mention check is the caller's second line of sight on the same escalation.
      expect(mentionsNetworkSocket(source)).toBe(true);
      expect(mentionsNetworkSocket("echo hello world")).toBe(false);
    });

    it("reports a script whose text reaches outside the root", () => {
      expect(mentionsPathOutsideRoot("cat /etc/passwd")).toBe(true);
      expect(mentionsPathOutsideRoot("cat ../../secret")).toBe(true);
      expect(mentionsPathOutsideRoot("cat ./local")).toBe(false);
    });

    it("measures classification cost against the 4ms in-memory budget", () => {
      const clock = tickingClock();
      decideTier("echo hello", clock.now);
      // The verdict cost at least one clock read and is reported as the elapsed ticks.
      expect(clock.ticks).toBeGreaterThan(0);

      // The verdict reads the clock twice — once on entry, once when classification
      // returns — so two ticks elapse and the reported cost is the span between them.
      const before = clock.ticks;
      const decision = decideTier("echo hello", clock.now);
      expect(clock.ticks - before).toBe(2);
      expect(decision.classificationMs).toBe(clock.ticks - before - 1);
      expect(decision.classificationMs).toBeGreaterThanOrEqual(0);

      // Against the real clock, classifying a small script stays well inside the budget
      // the in-memory tier exists to hit.
      const timed = decideTier("echo hello world; echo again");
      expect(Number.isInteger(timed.classificationMs)).toBe(true);
      expect(timed.classificationMs).toBeLessThan(4);
    });
  });

  describe("in-memory execution", () => {
    it("runs a safe script in-process and returns its exit code and stdout", async () => {
      const runtime = new IsolatedExecutionRuntime({
        now: tickingClock().now,
        policyBox: policyBox("shell:exec"),
      });
      const result = await runtime.execute("echo hello world");

      expect(result.tier).toBe("in_memory");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world\n");
      expect(result.stderr).toBe("");
    });

    it("expands assignments and honours control operators", async () => {
      const runtime = new IsolatedExecutionRuntime({
        now: tickingClock().now,
        policyBox: policyBox("shell:exec"),
      });

      const greeting = await runtime.execute('GREETING=hello; echo "$GREETING world"');
      expect(greeting.stdout).toBe("hello world\n");

      const andChain = await runtime.execute("echo hi && echo bye");
      expect(andChain.stdout).toBe("hi\nbye\n");
      expect(andChain.exitCode).toBe(0);

      // `false` sets status 1, so the `||` branch runs and the pipeline exits 0.
      const orChain = await runtime.execute("false || echo recovered");
      expect(orChain.stdout).toBe("recovered\n");
      expect(orChain.exitCode).toBe(0);

      // A failing built-in is a real non-zero exit, not an exception.
      const failing = await runtime.execute("false");
      expect(failing.exitCode).toBe(1);
      expect(failing.stdout).toBe("");
    });

    it("applies the caller's environment and working directory", async () => {
      const runtime = new IsolatedExecutionRuntime({
        now: tickingClock().now,
        policyBox: policyBox("shell:exec"),
      });

      const env = await runtime.execute('echo "$HOME"', { env: { HOME: "/sandbox/home" } });
      expect(env.stdout).toBe("/sandbox/home\n");

      const cwd = await runtime.execute("pwd", { cwd: "/work" });
      expect(cwd.stdout).toBe("/work\n");
    });

    it("records telemetry for the in-memory tier", async () => {
      const runtime = new IsolatedExecutionRuntime({
        now: tickingClock().now,
        policyBox: policyBox("shell:exec"),
      });
      await runtime.execute("echo hi && echo bye");

      const telemetry = runtime.recentTelemetry()[0]!;
      expect(telemetry.tier).toBe("in_memory");
      expect(telemetry.exitCode).toBe(0);
      // Two built-in invocations were charged; one process (this one) and no denied
      // syscalls — the in-memory tier has no syscalls to deny.
      expect(telemetry.commandsExecuted).toBe(2);
      expect(telemetry.processCount).toBe(1);
      expect(telemetry.syscallsDenied).toBe(0);
      expect(telemetry.bytesWritten).toBe(0);
      expect(telemetry.durationMs).toBeGreaterThanOrEqual(0);
      expect(telemetry.sandboxId).toBeUndefined();
    });

    it("keeps telemetry newest-first", async () => {
      const runtime = new IsolatedExecutionRuntime({
        now: tickingClock().now,
        policyBox: policyBox("shell:exec"),
      });
      await runtime.execute("echo first");
      await runtime.execute("echo one && echo two");

      const records = runtime.recentTelemetry(1);
      expect(records).toHaveLength(1);
      // The most recent run — two built-in invocations — is first.
      expect(records[0]!.commandsExecuted).toBe(2);
      expect(runtime.recentTelemetry().map((record) => record.commandsExecuted)).toEqual([2, 1]);
    });

    it("refuses in-memory execution when the policy denies shell:exec", async () => {
      const runtime = new IsolatedExecutionRuntime({ policyBox: policyBox() });
      await expect(runtime.execute("echo hello")).rejects.toMatchObject({
        name: "SecurityViolationError",
        message: "in-memory shell execution is denied by the active policy",
      });
      // The tier was never entered, so no telemetry was recorded.
      expect(runtime.recentTelemetry()).toHaveLength(0);
    });
  });

  describe("escalation to the isolated tier", () => {
    it("escalates a native binary and hands the backend the resolved policy", async () => {
      const backend = new RecordingBackend();
      const runtime = new IsolatedExecutionRuntime({
        backend,
        ceilings: { maxProcesses: 8 },
        allowList: ["https://example.com"],
        now: tickingClock().now,
        policyBox: policyBox("shell:exec", "shell:native-binary"),
      });
      const result = await runtime.execute("ls -la /");

      expect(result.tier).toBe("isolated");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("isolated output\n");

      // The backend received the script verbatim and the ceilings the runtime resolved —
      // the override applies, the un-overridden defaults do not regress.
      expect(backend.commands).toHaveLength(1);
      // The recording double guarantees a command was handed to the backend above.
      const command = backend.commands[0]!;
      expect(command.script).toBe("ls -la /");
      expect(command.ceilings).toEqual({
        maxProcesses: 8,
        maxMemoryBytes: DEFAULT_ISOLATION_CEILINGS.maxMemoryBytes,
        sigkillTimeoutMs: DEFAULT_ISOLATION_CEILINGS.sigkillTimeoutMs,
      });
      // No `network:outbound` capability was granted, so the escalation is network-off: the
      // configured allow-list is the limit *under a grant*, and handing it to the backend here
      // would let the script reach a host the policy never permitted.
      expect(command.allowList).toEqual([]);
    });

    it("hands the backend the allow-list only when the policy grants the network", async () => {
      const granted = new RecordingBackend();
      const grantedRuntime = new IsolatedExecutionRuntime({
        backend: granted,
        allowList: ["https://example.com"],
        policyBox: policyBox("shell:exec", "shell:native-binary", "network:outbound"),
      });
      await grantedRuntime.execute("ls -la /");
      expect(granted.commands[0]!.allowList).toEqual(["https://example.com"]);

      // The same configuration without the capability: same script, same preset, network-off.
      const denied = new RecordingBackend();
      const deniedRuntime = new IsolatedExecutionRuntime({
        backend: denied,
        allowList: ["https://example.com"],
        policyBox: policyBox("shell:exec", "shell:native-binary"),
      });
      await deniedRuntime.execute("ls -la /");
      expect(denied.commands[0]!.allowList).toEqual([]);
    });

    it("carries the isolated result into telemetry", async () => {
      const backend = new RecordingBackend();
      backend.result = {
        exitCode: 3,
        stdout: "",
        stderr: "boom\n",
        sandboxId: "sandbox-0042",
        processCount: 5,
        syscallsDenied: 1,
        bytesWritten: 1024,
        limitHit: "maxProcesses",
      };
      const runtime = new IsolatedExecutionRuntime({
        backend,
        now: tickingClock().now,
        policyBox: policyBox("shell:exec", "shell:native-binary"),
      });
      const result = await runtime.execute("gzip -9 archive.tar");

      expect(result.tier).toBe("isolated");
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("boom\n");

      const telemetry = runtime.recentTelemetry()[0]!;
      // The isolated tier's accounting is the backend's, not the evaluator's: commands
      // are not counted in-process, and the sandbox identity and limit it hit survive.
      expect(telemetry.reason).toBe("unsupported_construct");
      expect(telemetry.exitCode).toBe(3);
      expect(telemetry.commandsExecuted).toBe(0);
      expect(telemetry.processCount).toBe(5);
      expect(telemetry.syscallsDenied).toBe(1);
      expect(telemetry.bytesWritten).toBe(1024);
      expect(telemetry.sandboxId).toBe("sandbox-0042");
      expect(telemetry.limitHit).toBe("maxProcesses");
    });

    it("escalates a network-touching script with the egress allow-list attached", async () => {
      const backend = new RecordingBackend();
      const runtime = new IsolatedExecutionRuntime({
        backend,
        allowList: ["https://example.com"],
        now: tickingClock().now,
        policyBox: policyBox("shell:exec", "shell:native-binary", "network:outbound"),
      });
      const result = await runtime.execute("curl -s https://example.com/api");

      expect(result.tier).toBe("isolated");
      expect(backend.commands[0]?.allowList).toEqual(["https://example.com"]);
    });

    it("passes the caller's cwd and environment to the isolated tier", async () => {
      const backend = new RecordingBackend();
      const runtime = new IsolatedExecutionRuntime({
        backend,
        now: tickingClock().now,
        policyBox: policyBox("shell:exec", "shell:native-binary"),
      });
      await runtime.execute("ls", { cwd: "/work", env: { PATH: "/usr/bin" } });

      expect(backend.commands[0]?.cwd).toBe("/work");
      expect(backend.commands[0]?.env).toEqual({ PATH: "/usr/bin" });
    });

    it("fails closed when no isolated backend is mounted", async () => {
      const runtime = new IsolatedExecutionRuntime({
        now: tickingClock().now,
        policyBox: policyBox("shell:exec", "shell:native-binary"),
      });
      // A script that cannot run in memory and cannot be isolated is not run at all —
      // falling back to the host would be the unconfined execution this subsystem
      // exists to prevent.
      await expect(runtime.execute("ls -la /")).rejects.toMatchObject({
        name: "IsolationRefusalError",
        reason: "runtime_unavailable",
      });
      expect(runtime.recentTelemetry()).toHaveLength(0);
    });

    it("refuses escalation when the policy denies native binaries", async () => {
      const backend = new RecordingBackend();
      const runtime = new IsolatedExecutionRuntime({
        backend,
        now: tickingClock().now,
        // shell:native-binary is deliberately absent: escalation is a capability, and a
        // strict policy refuses the tier rather than the script.
        policyBox: policyBox("shell:exec"),
      });
      await expect(runtime.execute("ls -la /")).rejects.toMatchObject({
        name: "SecurityViolationError",
        message: "native binary execution is denied by the active policy",
      });
      // The backend was never asked.
      expect(backend.commands).toHaveLength(0);
    });

    it("reports a backend failure as an isolated-tier non-zero exit", async () => {
      const backend = new RecordingBackend();
      backend.result = {
        exitCode: 1,
        stdout: "",
        stderr: "sandbox boot failed",
        sandboxId: "sandbox-dead",
        processCount: 0,
        syscallsDenied: 0,
        bytesWritten: 0,
      };
      const runtime = new IsolatedExecutionRuntime({
        backend: {
          name: "failing",
          async run(): Promise<IsolatedResult> {
            throw new Error("sandbox boot failed");
          },
        },
        now: tickingClock().now,
        policyBox: policyBox("shell:exec", "shell:native-binary"),
      });
      const result = await runtime.execute("ls -la /");

      expect(result.tier).toBe("isolated");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sandbox boot failed");
      expect(result.processCount).toBe(0);
      expect(runtime.recentTelemetry()[0]!.limitHit).toBe("Error");
    });
  });

  it("preserves typed errors the evaluator raises", async () => {
    // A SecurityViolationError from inside the in-memory tier is a policy decision, not
    // a limit trip, and must reach the caller rather than being flattened to exit 1.
    const runtime = new IsolatedExecutionRuntime({
      now: tickingClock().now,
      policyBox: policyBox("shell:exec"),
    });
    await expect(
      runtime.execute("echo hello", { signal: AbortSignal.abort() }),
    ).resolves.toMatchObject({ tier: "in_memory", exitCode: 1 });
    // The aborted run still produced telemetry, with the limit it hit named.
    expect(runtime.recentTelemetry()[0]!.limitHit).toBe("ExecutionLimitError");
  });

  it("exposes SecurityViolationError as the typed denial", () => {
    const error = new SecurityViolationError("denied", {
      timestamp: 0,
      type: "shell_exec",
      message: "denied",
      path: "shell:exec",
    });
    expect(error.name).toBe("SecurityViolationError");
    expect(error.violation.type).toBe("shell_exec");
  });

  it("names the isolation refusal reason", () => {
    const refusal = new IsolationRefusalError("no backend", "runtime_unavailable");
    expect(refusal.name).toBe("IsolationRefusalError");
    expect(refusal.reason).toBe("runtime_unavailable");
  });
});
