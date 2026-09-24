/**
 * MicroVM escalation runtime — the server-side half of the tiered execution model.
 *
 * Core owns the *decision* (`decideTier`: classify the script, run it in memory when
 * it is pure shell, escalate otherwise). This module owns the *escalation*: it is the
 * `IsolatedBackend` implementation that turns an isolated-tier command into a
 * provisioned microVM, runs the script inside it under the requested ceilings, and
 * collects the telemetry the cockpit reports and the QoS targets track.
 *
 * Ported from the donor remote-sandbox SDK's lifecycle layer: create → run → kill,
 * with a sandbox reused across commands within one escalation session and released
 * when the session ends. What does not come across is the donor's per-call sandbox
 * ergonomics (its `sandbox.commands.run` fluent API) — this server has a command
 * boundary, not an SDK boundary, so the same lifecycle is expressed as an
 * `IsolatedBackend`, which is the name core already defines for it.
 *
 * Fail-closed behaviour, which is the security-relevant part:
 * - a script classified unsafe is escalated, never approximated in memory;
 * - if the isolated tier is unreachable, the run is REFUSED with
 *   `runtime_unavailable`, never silently downgraded to the in-memory tier — a
 *   workload that needed a real process must not get a pretend one;
 * - every microVM this runtime provisions is tracked in a live set and killed on
 *   `dispose()`, so a crashed escalation cannot orphan a sandbox that keeps
 *   burning capacity;
 * - the run is bounded by the ceilings core resolved, not by a backend default.
 */
import type {
  ExecutionTelemetry,
  IsolatedBackend,
  IsolatedCommand,
  IsolatedResult,
} from "@prismshadow/penguin-core/plugin";
import {
  MicrovmError,
  MicrovmInvalidArgumentError,
  MicrovmRateLimitError,
  MicrovmSandboxNotFoundError,
  MicrovmServiceBusyError,
  MicrovmTimeoutError,
  type MicrovmCommandResult,
  type MicrovmId,
  type MicrovmInfo,
  type MicrovmSandboxClient,
} from "./microvm-sandbox-client.js";

/**
 * The latency targets the plan set for the isolated tier. The escalation budget is the
 * wall clock a caller pays from "decide to escalate" to "command output in hand";
 * boot is the component the microVM plane controls. Measured, not assumed: this
 * module records both so a regression in either shows up in telemetry.
 */
export const ESCALATION_BUDGET_MS = 220;
export const MICROVM_BOOT_BUDGET_MS = 2_000;

/** Why an escalation failed, for the telemetry `limitHit` field. */
export type EscalationFailure =
  | "boot_timeout"
  | "command_timeout"
  | "service_busy"
  | "rate_limited"
  | "not_found"
  | "bad_argument"
  | "unavailable";

/** A sandbox held open across the commands of one escalation session. */
interface LiveSandbox {
  readonly info: MicrovmInfo;
  /** Number of commands run in this sandbox, for the reuse accounting. */
  commands: number;
  /** Whether a command already reported it was killed or died. */
  dead: boolean;
  /** The egress policy this sandbox is currently running under, as URL strings. */
  egress: readonly string[];
}

/**
 * The egress policy a command carries, as the plane receives it. An empty array is an
 * explicit network-off, not "no policy": see `applyEgressPolicy`.
 */
function egressOf(command: IsolatedCommand): readonly string[] {
  return (command.allowList ?? []).map((entry) => (typeof entry === "string" ? entry : entry.url));
}

/** Whether two egress policies are the same list in the same order. */
function sameEgress(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url, index) => url === b[index]);
}

/**
 * Collected telemetry. The runtime keeps a bounded ring rather than an unbounded
 * list: a hostile or busy workload can generate escalations far faster than any
 * cockpit reads them, and the telemetry buffer must not become a memory ceiling.
 */
export interface EscalationTelemetryCollector {
  readonly recorded: readonly ExecutionTelemetry[];
  /** Aggregates for the cockpit panel. */
  summarize(): EscalationSummary;
}

export interface EscalationSummary {
  readonly total: number;
  readonly escalated: number;
  readonly inMemory: number;
  readonly failures: number;
  /** Mean escalation latency, over the recorded window. */
  readonly meanEscalationMs: number;
  /** Share of escalations that exceeded the escalation budget. */
  readonly overBudget: number;
  /** Live sandboxes this runtime has not released. */
  readonly liveSandboxes: number;
}

/**
 * The donor's default sandbox lifetime: how long a sandbox the plane keeps alive while
 * idle before it is reaped. Re-stated here rather than importing the client's constant
 * because the two mean different things at different layers — the client's is a request
 * default it sends on create, this is the escalation layer's assumption about reuse.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 300_000;

/**
 * Server-side escalation runtime: a `IsolatedBackend` backed by a microVM client.
 *
 * Construct one per control plane and let the session layer hold it; the class is
 * safe to share because the live-sandbox map is keyed per command stream.
 */
export class MicrovmEscalationRuntime implements IsolatedBackend, EscalationTelemetryCollector {
  readonly name = "microvm";

  private readonly client: MicrovmSandboxClient;
  private readonly templateId: string;
  private readonly log: (line: string) => void;
  private readonly live = new Map<string, LiveSandbox>();
  /** Serializes commands that share a sandbox, including policy changes and boot. */
  private readonly sessionRuns = new Map<string, Promise<void>>();
  private readonly telemetry: ExecutionTelemetry[] = [];
  private readonly maxTelemetry: number;
  private disposed = false;

  constructor(options: {
    client: MicrovmSandboxClient;
    /** Template to boot for escalated work. */
    templateId?: string;
    /** Bounded telemetry window; defaults to the last 512 runs. */
    maxTelemetry?: number;
    log?: (line: string) => void;
  }) {
    if (!options?.client) throw new MicrovmInvalidArgumentError("client is required");
    this.client = options.client;
    this.templateId = options.templateId ?? "base";
    this.maxTelemetry = options.maxTelemetry ?? 512;
    this.log = options.log ?? ((line) => console.error(line));
  }

  get recorded(): readonly ExecutionTelemetry[] {
    return this.telemetry;
  }

  get liveSandboxes(): number {
    return this.live.size;
  }

  /** Telemetry for callers that want the current window without the collector API. */
  summarize(): EscalationSummary {
    const window = this.telemetry;
    const escalated = window.filter((t) => t.tier === "isolated");
    const overBudget = escalated.filter((t) => t.durationMs > ESCALATION_BUDGET_MS).length;
    const failures = escalated.filter((t) => t.exitCode !== 0).length;
    return {
      total: window.length,
      escalated: escalated.length,
      inMemory: window.length - escalated.length,
      failures,
      meanEscalationMs:
        escalated.length === 0
          ? 0
          : escalated.reduce((sum, t) => sum + t.durationMs, 0) / escalated.length,
      overBudget,
      liveSandboxes: this.live.size,
    };
  }

  /**
   * Run an isolated command: boot (or reuse) a sandbox, run the script, record
   * telemetry, and translate any plane failure into the backend contract.
   */
  async run(command: IsolatedCommand): Promise<IsolatedResult> {
    if (this.disposed) {
      throw new MicrovmError("escalation runtime is disposed");
    }
    if (!command.script) {
      throw new MicrovmInvalidArgumentError("command.script is required");
    }
    if (typeof command.sessionKey !== "string" || command.sessionKey.trim() === "") {
      throw new MicrovmInvalidArgumentError("command.sessionKey is required");
    }

    const sessionKey = command.sessionKey;
    const previous = this.sessionRuns.get(sessionKey);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionRuns.set(sessionKey, done);
    if (previous) await previous;
    try {
      if (this.disposed) throw new MicrovmError("escalation runtime is disposed");
      return await this.runInSession(command, sessionKey);
    } finally {
      release();
      if (this.sessionRuns.get(sessionKey) === done) this.sessionRuns.delete(sessionKey);
    }
  }

  private async runInSession(
    command: IsolatedCommand,
    sessionKey: string,
  ): Promise<IsolatedResult> {
    const startedAt = performance.now();
    let sandbox = this.live.get(sessionKey);
    let bootedNow = false;

    if (!sandbox || sandbox.dead) {
      const info = await this.bootSandbox(command, startedAt);
      sandbox = { info, commands: 0, dead: false, egress: egressOf(command) };
      this.live.set(sessionKey, sandbox);
      bootedNow = true;
    } else {
      // A reused sandbox keeps the egress policy of its boot — but only while this command's
      // policy agrees with it. A later command whose policy is narrower must not inherit the
      // wider allow-list of the first command of the session.
      const egress = egressOf(command);
      if (!sameEgress(sandbox.egress, egress)) {
        try {
          await this.applyEgressPolicy(sandbox.info.id, command);
        } catch (error) {
          // The sandbox is now in an unknown egress state, so it must not be reused: kill the
          // bookkeeping and let the next command boot a fresh one. This command does not run,
          // which is the same fail-closed answer a failed boot gives.
          await this.retireSandbox(sessionKey, sandbox);
          throw this.translate(error, this.classifyFailure(error));
        }
        sandbox.egress = egress;
      }
    }

    const bootMs = bootedNow ? performance.now() - startedAt : 0;
    if (bootMs > MICROVM_BOOT_BUDGET_MS) {
      this.log(
        `microvm boot took ${bootMs.toFixed(0)}ms, over the ${MICROVM_BOOT_BUDGET_MS}ms budget`,
      );
    }

    try {
      const result = await this.client.runCommand(sandbox.info.id, {
        cmd: command.script,
        cwd: command.cwd,
        env: command.env,
        timeoutMs: command.ceilings.sigkillTimeoutMs,
        ...(command.signal ? { signal: command.signal } : {}),
      });
      sandbox.commands += 1;

      if (result.timedOut) {
        await this.retireSandbox(sessionKey, sandbox);
      }

      return this.toIsolatedResult(sandbox.info.id, result, command, startedAt, bootMs);
    } catch (error) {
      // A sandbox that died cannot be reused: the next command must re-boot.
      await this.retireSandbox(sessionKey, sandbox);
      const failure = this.classifyFailure(error);
      this.record({
        tier: "isolated",
        reason: "runtime_unavailable",
        durationMs: performance.now() - startedAt,
        classificationMs: 0,
        exitCode: 1,
        commandsExecuted: sandbox.commands,
        bytesWritten: 0,
        processCount: 0,
        syscallsDenied: 0,
        sandboxId: sandbox.info.id,
        limitHit: failure,
      });
      throw this.translate(error, failure);
    }
  }

  /**
   * Boot a sandbox sized to the command's ceilings. A boot failure is recorded as
   * telemetry too — an escalation that never ran is still an escalation the cockpit
   * needs to count, and the failure vocabulary is what makes it attributable.
   */
  private async bootSandbox(command: IsolatedCommand, startedAt: number): Promise<MicrovmInfo> {
    let info: MicrovmInfo | undefined;
    try {
      info = await this.client.create({
        templateId: this.templateId,
        timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
        env: command.env,
        // The ceilings the policy computed for this escalation are part of the boot: they have
        // to be in place before the first script runs. The plane applies the ones it recognises
        // and ignores the rest, so a plane without resource caps still boots.
        ceilings: command.ceilings,
      });
      // Egress is applied at boot so the allow-list is in place before the first script runs; a
      // sandbox reused across later commands keeps it until a command's policy differs (see run).
      await this.applyEgressPolicy(info.id, command);
      return info;
    } catch (error) {
      // A create can succeed before network configuration fails. That VM must not remain
      // alive on the template's default policy after this command is refused.
      if (info) await this.killQuietly(info.id);
      const failure = this.classifyFailure(error);
      this.record({
        tier: "isolated",
        reason: "runtime_unavailable",
        durationMs: performance.now() - startedAt,
        classificationMs: 0,
        exitCode: 1,
        commandsExecuted: 0,
        bytesWritten: 0,
        processCount: 0,
        syscallsDenied: 0,
        limitHit: failure,
      });
      this.log(`microvm boot failed (${failure}): ${this.describe(error)}`);
      throw this.translate(error, failure);
    }
  }

  /**
   * Push the command's egress allow-list into the sandbox. The runtime has already decided
   * this escalation may reach the network; the allow-list is the limit on *where*.
   *
   * An empty list is not "no policy" — it is an explicit network-off the caller's capability
   * gate decided (`EMPTY_ALLOW_LIST` in `isolated-execution-runtime.ts`), so it is pushed to
   * the plane rather than skipped. Skipping it would leave the sandbox on whatever egress its
   * template happens to default to, which is more access than the policy granted. The control
   * plane distinguishes an explicit `[]` from an absent field, so the empty list does reach it.
   *
   * Failing the boot rather than falling back: a sandbox whose egress could not be constrained
   * must not run an escalation the harness granted `network:outbound` to.
   */
  private async applyEgressPolicy(sandboxId: MicrovmId, command: IsolatedCommand): Promise<void> {
    const egressAllowList = egressOf(command);
    this.log(
      egressAllowList.length === 0
        ? `revoking egress for sandbox ${String(sandboxId)}: the policy grants no network`
        : `constraining egress for sandbox ${String(sandboxId)} to ${egressAllowList.length} allowed origin(s)`,
    );
    await this.client.updateNetwork(sandboxId, { egressAllowList });
  }

  /** Map a client failure onto the backend's failure vocabulary. */
  private classifyFailure(error: unknown): EscalationFailure {
    if (error instanceof MicrovmTimeoutError) return "boot_timeout";
    if (error instanceof MicrovmServiceBusyError) return "service_busy";
    if (error instanceof MicrovmRateLimitError) return "rate_limited";
    if (error instanceof MicrovmSandboxNotFoundError) return "not_found";
    if (error instanceof MicrovmInvalidArgumentError) return "bad_argument";
    return "unavailable";
  }

  /** Turn a client error into the message a caller of the backend sees. */
  private translate(error: unknown, failure: EscalationFailure): Error {
    if (error instanceof MicrovmError || error instanceof MicrovmServiceBusyError) {
      return new MicrovmError(`isolated tier ${failure}: ${this.describe(error)}`, 503);
    }
    return new MicrovmError(`isolated tier ${failure}: ${this.describe(error)}`);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  private toIsolatedResult(
    sandboxId: MicrovmId,
    result: MicrovmCommandResult,
    command: IsolatedCommand,
    startedAt: number,
    bootMs: number,
  ): IsolatedResult {
    const durationMs = performance.now() - startedAt;
    this.record({
      tier: "isolated",
      durationMs,
      classificationMs: 0,
      exitCode: result.exitCode,
      commandsExecuted: 1,
      bytesWritten: result.stdout.length + result.stderr.length,
      processCount: 0,
      syscallsDenied: 0,
      sandboxId,
      ...(result.timedOut ? { limitHit: "command_timeout" as const } : {}),
    });
    void bootMs;
    void command;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      sandboxId,
      processCount: 0,
      syscallsDenied: 0,
      bytesWritten: result.stdout.length + result.stderr.length,
      ...(result.timedOut ? { limitHit: "command_timeout" } : {}),
    };
  }

  /** Record one telemetry sample, evicting the oldest when the window is full. */
  private record(sample: ExecutionTelemetry): void {
    if (this.telemetry.length >= this.maxTelemetry) this.telemetry.shift();
    this.telemetry.push(sample);
  }

  /** Release a session's sandbox. Idempotent; a second call is a no-op. */
  async releaseSession(sessionKey: string): Promise<void> {
    const previous = this.sessionRuns.get(sessionKey);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionRuns.set(sessionKey, done);
    try {
      await previous;
      const sandbox = this.live.get(sessionKey);
      if (!sandbox) return;
      this.live.delete(sessionKey);
      await this.killQuietly(sandbox.info.id);
    } finally {
      release();
      if (this.sessionRuns.get(sessionKey) === done) this.sessionRuns.delete(sessionKey);
    }
  }

  /** Retire a sandbox after a command or policy failure so no later run reuses it. */
  private async retireSandbox(sessionKey: string, sandbox: LiveSandbox): Promise<void> {
    sandbox.dead = true;
    if (this.live.get(sessionKey) === sandbox) this.live.delete(sessionKey);
    await this.killQuietly(sandbox.info.id);
  }

  /** Kill a sandbox, swallowing the not-found case. */
  private async killQuietly(sandboxId: MicrovmId): Promise<void> {
    try {
      await this.client.kill(sandboxId);
    } catch (error) {
      if (error instanceof MicrovmSandboxNotFoundError) return;
      this.log(`failed to kill microvm ${sandboxId}: ${this.describe(error)}`);
    }
  }

  /** Release every live sandbox. Call on session end or server shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessionRuns.values()]);
    const ids = [...this.live.values()].map((s) => s.info.id);
    this.live.clear();
    await Promise.all(ids.map((id) => this.killQuietly(id)));
  }
}
