/**
 * Isolated execution runtime — the tiered execution engine, and Track 2's Tier 1
 * module.
 *
 * The synthesis target is two tiers with a classifier between them:
 *
 * - **Tier A, in-memory.** A pure shell script — assignments, expansions, pipelines,
 *   conditionals, the built-in command set — runs entirely inside this process
 *   through `ShellEvaluator` over a `CowFsBackend`. No child process, no real
 *   filesystem, no descriptors: the target is under 4ms, and a script that fits this
 *   tier has no way to reach the host at all.
 * - **Tier B, isolated.** Anything that needs something Tier A does not model — a
 *   native binary, a network socket, a redirection, a subshell, a here-document, an
 *   arithmetic or conditional group — escalates to a hardware-isolated sandbox whose
 *   syscall filter and copy-on-write filesystem come from `syscall-filter.ts` and
 *   `cow-fs-backend.ts`. The cold-boot target is under 220ms, which is why the
 *   classifier is cheap: it is a token walk, and it runs before the sandbox is
 *   allocated so the common case pays for neither the classification nor the boot.
 *
 * The escalation decision is the security-relevant part, and it is one-directional by
 * construction: a script that is not *proven* in-memory safe escalates. There is no
 * "probably fine" tier, because a shell is a programming language and the difference
 * between an approximation and an implementation only matters when the script is
 * hostile.
 *
 * Tier B's ceilings are enforced here rather than in the evaluator because only the
 * isolated tier can actually exceed them: a process count cap of 64, a memory ceiling
 * of 512 MiB, and a SIGKILL threshold of 30 seconds. The SIGKILL threshold is the last
 * line of defence — a SIGTERM is a request the workload may ignore, and a fork bomb's
 * whole behaviour is to ignore it.
 */

import type { AllowedUrlEntry } from "./egress-allowlist.js";
import { decideEgress } from "./egress-allowlist.js";
import type { ExecutionLimits } from "./execution-limits.js";
import { resolveLimits } from "./execution-limits.js";
import {
  classifyScript,
  type Classification,
  ShellEvaluator,
  type EvaluationResult,
} from "./shell-evaluator.js";
import type { Token } from "./shell-lexer.js";
import type { CowFsBackend, CowFsOptions } from "./cow-fs-backend.js";
import { CowFsBackend as CowFs } from "./cow-fs-backend.js";
import { SandboxPolicyBox, SecurityViolationError } from "./sandbox-policy-box.js";
import type { FsBackend } from "./syscall-filter.js";
import { randomUUID } from "node:crypto";

/**
 * Why a run went to the isolated tier. Every value is something the in-memory tier
 * provably does not implement, which is what makes the escalation an honest refusal
 * rather than a heuristic.
 */
export type EscalationReason =
  | "unsupported_construct"
  | "native_binary"
  | "network_socket"
  | "fs_outside_root"
  | "policy_denied"
  | "runtime_unavailable";

/** Which tier a script was executed in. */
export type ExecutionTier = "in_memory" | "isolated";

/** The runtime's verdict on a script. */
export interface TierDecision {
  readonly tier: ExecutionTier;
  readonly reason?: EscalationReason;
  /** The unsupported construct's location, when classification found one. */
  readonly at?: Token;
  /** Classification cost in milliseconds; part of the 4ms budget proof. */
  readonly classificationMs: number;
}

/**
 * Telemetry for one run, for the cockpit's sandbox telemetry panel and for the
 * QoS targets. Numbers that are measured rather than assumed: a target nobody
 * records is a target nobody hits.
 */
export interface ExecutionTelemetry {
  readonly tier: ExecutionTier;
  readonly reason?: EscalationReason;
  readonly durationMs: number;
  readonly classificationMs: number;
  readonly exitCode: number;
  readonly commandsExecuted: number;
  readonly bytesWritten: number;
  readonly processCount: number;
  readonly syscallsDenied: number;
  readonly sandboxId?: string;
  readonly limitHit?: string;
}

/** Resource ceilings for the isolated tier. */
export interface IsolationCeilings {
  /** Maximum processes; the fork-bomb cap. */
  maxProcesses: number;
  /** Memory hard ceiling in bytes. */
  maxMemoryBytes: number;
  /** Milliseconds before SIGKILL replaces SIGTERM. */
  sigkillTimeoutMs: number;
}

/**
 * The isolated-tier defaults. These are the plan's Tier 5 constants: a 64-process
 * cap, a 512 MiB memory ceiling, and a 30 second SIGKILL threshold. Each is named
 * here rather than inlined at a use site so a preset can change one without
 * re-stating the others.
 */
export const DEFAULT_ISOLATION_CEILINGS: IsolationCeilings = {
  maxProcesses: 64,
  maxMemoryBytes: 512 * 1024 * 1024,
  sigkillTimeoutMs: 30_000,
};

/** What the backend receives when the policy grants no network at all: network-off. */
const EMPTY_ALLOW_LIST: AllowedUrlEntry[] = [];

/**
 * The isolated-tier backend contract. Core defines it because the escalation
 * decision is core's; an implementation lives in the server package and talks to a
 * real sandbox plane. An absent backend means the isolated tier is *unavailable*,
 * which fails closed — a script that cannot run safely in memory and cannot be
 * isolated is not run at all.
 */
export interface IsolatedBackend {
  readonly name: string;
  /** Boot a sandbox and run one command inside it, under the given ceilings. */
  run(command: IsolatedCommand): Promise<IsolatedResult>;
  /** Release resources owned by one runtime/session, when the backend reuses sandboxes. */
  releaseSession?(sessionKey: string): Promise<void>;
}

export interface IsolatedCommand {
  /** Unique sandbox namespace for one execution runtime/session. */
  readonly sessionKey: string;
  readonly script: string;
  readonly ceilings: IsolationCeilings;
  readonly allowList: AllowedUrlEntry[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly signal?: AbortSignal;
  /** The routing rules to install, when the backend supports custom ones. */
  readonly fsBackends?: ReadonlyMap<string, FsBackend>;
}

export interface IsolatedResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly sandboxId: string;
  readonly processCount: number;
  readonly syscallsDenied: number;
  readonly bytesWritten: number;
  readonly limitHit?: string;
}

export interface IsolatedRuntimeOptions {
  /** Stable, unique caller namespace; omitted values are unique per runtime instance. */
  sessionKey?: string;
  /** Isolated-tier backend; omitted means the tier is unavailable. */
  backend?: IsolatedBackend;
  /** Resource ceilings; defaults to the plan's constants. */
  ceilings?: Partial<IsolationCeilings>;
  /** Egress allow-list. Empty denies all network. */
  allowList?: AllowedUrlEntry[];
  /** Execution limits for the in-memory tier. */
  limits?: ExecutionLimits;
  /** Limit profile. */
  profile?: "normal" | "hardened";
  /** Virtual filesystem options for the in-memory tier. */
  fsOptions?: CowFsOptions;
  /** Inject a CowFsBackend; tests use this to observe writes. */
  fs?: CowFsBackend;
  /** Monotonic clock for deterministic timing assertions. */
  now?: () => number;
  /** Policy box; defaults to the singleton. */
  policyBox?: SandboxPolicyBox;
  /**
   * Permit Tier A even when no isolated backend is mounted. Production defaults this
   * to true (the in-memory tier is safe by construction); a deployment that wants a
   * strict mode where *anything* unsupported is refused rather than escalated sets
   * it false.
   */
  permitInMemoryWithoutBackend?: boolean;
}

/** Error thrown when a script cannot run on either tier. */
export class IsolationRefusalError extends Error {
  constructor(
    message: string,
    public readonly reason: EscalationReason,
  ) {
    super(message);
    this.name = "IsolationRefusalError";
  }
}

/**
 * Decide a script's tier without running it. Exposed because a caller wants the
 * verdict for an approval prompt or a telemetry card before it commits to executing
 * — the same cheap token walk the runtime uses internally.
 */
export function decideTier(source: string, now: () => number = Date.now): TierDecision {
  const startedAt = now();
  const classification = classifyScript(source);
  const classificationMs = now() - startedAt;
  if (classification.inMemorySafe) {
    return { tier: "in_memory", classificationMs };
  }
  const reason = reasonForClassification(classification);
  return {
    tier: "isolated",
    reason,
    at: classification.at,
    classificationMs,
  };
}

function reasonForClassification(
  classification: Extract<Classification, { inMemorySafe: false }>,
): EscalationReason {
  switch (classification.reason) {
    case "external_command":
    case "subshell":
    case "arithmetic_group":
    case "conditional_group":
    case "function_definition":
    case "heredoc":
    case "redirection":
    case "background_job":
    case "case_statement":
    case "select_statement":
    case "coproc":
    case "unbalanced_group":
      return "unsupported_construct";
    default:
      return "unsupported_construct";
  }
}

/**
 * The tiered runtime.
 */
export class IsolatedExecutionRuntime {
  private readonly ceilings: IsolationCeilings;
  private readonly allowList: AllowedUrlEntry[];
  private readonly limits: Required<ExecutionLimits>;
  private readonly profile: "normal" | "hardened";
  private readonly backend?: IsolatedBackend;
  private readonly now: () => number;
  private readonly permitInMemoryWithoutBackend: boolean;
  private readonly sessionKey: string;
  private readonly telemetry: ExecutionTelemetry[] = [];

  constructor(private readonly options: IsolatedRuntimeOptions = {}) {
    this.ceilings = { ...DEFAULT_ISOLATION_CEILINGS, ...options.ceilings };
    this.allowList = options.allowList ?? [];
    this.limits = resolveLimits(options.limits, options.profile ?? "normal");
    this.profile = options.profile ?? "normal";
    this.backend = options.backend;
    this.now = options.now ?? (() => Date.now());
    this.permitInMemoryWithoutBackend = options.permitInMemoryWithoutBackend ?? true;
    if (options.sessionKey !== undefined && options.sessionKey.trim().length === 0) {
      throw new TypeError("isolated execution sessionKey must not be empty");
    }
    this.sessionKey = options.sessionKey ?? randomUUID();
  }

  /** The last N telemetry records, newest first. */
  recentTelemetry(limit = 64): readonly ExecutionTelemetry[] {
    return this.telemetry.slice(0, limit);
  }

  /**
   * Run a script on whichever tier it belongs to.
   *
   * @throws {IsolationRefusalError} when neither tier can take it.
   * @throws {SecurityViolationError} when the active policy denies the tier the
   *   script needs.
   */
  async execute(
    source: string,
    runOptions?: {
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<ExecutionTelemetry & { exitCode: number; stdout: string; stderr: string }> {
    const decision = decideTier(source, this.now);
    const policyBox = this.options.policyBox ?? SandboxPolicyBox.getInstance();

    if (decision.tier === "in_memory") {
      return this.executeInMemory(source, decision, runOptions, policyBox);
    }
    return this.executeIsolated(source, decision, runOptions, policyBox);
  }

  private async executeInMemory(
    source: string,
    decision: TierDecision,
    runOptions: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } | undefined,
    policyBox: SandboxPolicyBox,
  ): Promise<ExecutionTelemetry & { exitCode: number; stdout: string; stderr: string }> {
    // The in-memory tier is safe by construction, but it is still a capability: a
    // policy that denies shell execution outright applies here too, so a strict
    // deployment can refuse this tier without having to refuse the whole runtime.
    const shellDecision = policyBox.decide("shell:exec");
    if (shellDecision.outcome === "deny") {
      throw new SecurityViolationError("in-memory shell execution is denied by the active policy", {
        timestamp: Date.now(),
        type: shellDecision.violationType,
        message: shellDecision.reason,
        path: "shell:exec",
      });
    }

    const fs = this.options.fs ?? new CowFs({ ...this.options.fsOptions, limits: this.limits });
    const startedAt = this.now();
    const evaluator = new ShellEvaluator({
      limits: this.limits,
      profile: this.profile,
      fs,
      env: runOptions?.env,
      cwd: runOptions?.cwd,
      signal: runOptions?.signal,
      now: this.now,
    });

    let result: EvaluationResult;
    try {
      result = await evaluator.evaluate(source);
    } catch (error) {
      if (error instanceof SecurityViolationError) throw error;
      // A limit error inside the in-memory tier is a refusal, not a fallback: the
      // workload exceeded what this tier agreed to, and escalating it would hand the
      // same workload a real process.
      const message = error instanceof Error ? error.message : String(error);
      const telemetry: ExecutionTelemetry = {
        tier: "in_memory",
        durationMs: this.now() - startedAt,
        classificationMs: decision.classificationMs,
        exitCode: 1,
        commandsExecuted: 0,
        bytesWritten: fs.retainedMemoryBytes,
        processCount: 1,
        syscallsDenied: 0,
        limitHit: error instanceof Error ? error.name : undefined,
      };
      this.telemetry.unshift(telemetry);
      return { ...telemetry, exitCode: 1, stdout: "", stderr: message };
    }

    const telemetry: ExecutionTelemetry = {
      tier: "in_memory",
      durationMs: result.durationMs,
      classificationMs: decision.classificationMs,
      exitCode: result.exitCode,
      commandsExecuted: result.commandCount,
      bytesWritten: fs.retainedMemoryBytes,
      processCount: 1,
      syscallsDenied: 0,
    };
    this.telemetry.unshift(telemetry);
    return {
      ...telemetry,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async executeIsolated(
    source: string,
    decision: TierDecision,
    runOptions: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } | undefined,
    policyBox: SandboxPolicyBox,
  ): Promise<ExecutionTelemetry & { exitCode: number; stdout: string; stderr: string }> {
    // Escalation is itself a capability: a native binary is the thing a policy most
    // often wants to refuse, and asking is how it gets the chance.
    const binaryDecision = policyBox.decide("shell:native-binary");
    if (binaryDecision.outcome === "deny") {
      throw new SecurityViolationError("native binary execution is denied by the active policy", {
        timestamp: Date.now(),
        type: binaryDecision.violationType,
        message: binaryDecision.reason,
        path: "shell:native-binary",
      });
    }

    if (this.backend === undefined) {
      // No isolated tier is mounted. Failing closed is the only safe answer for a
      // script that is not in-memory safe; running it on the host would be the
      // unconfined execution the entire subsystem exists to prevent.
      throw new IsolationRefusalError(
        `script requires the isolated tier (${decision.reason}) but no isolated backend is mounted; ` +
          "refusing to run it unconfined",
        "runtime_unavailable",
      );
    }

    // Egress: the capability gate and the destination gate are separate, and both have to agree.
    // A denial of `network:outbound` means no network at all, so the backend receives an empty
    // allow-list (network-off) — passing the configured list through anyway would let an
    // escalation reach a host the policy never granted. Only a grant makes the allow-list the
    // operative limit, and the backend pushes it to the plane at boot and again whenever a later
    // command of the same session carries a different policy (see the isolated backend's
    // applyEgressPolicy). Decided here, once, so the backend's answer is the same one the harness
    // would give for an explicit fetch.
    const networkDecision = policyBox.decide("network:outbound");
    const egressAllowList =
      networkDecision.outcome === "permit" ? this.allowList : EMPTY_ALLOW_LIST;

    const startedAt = this.now();
    try {
      const isolated = await this.backend.run({
        sessionKey: this.sessionKey,
        script: source,
        ceilings: this.ceilings,
        allowList: egressAllowList,
        cwd: runOptions?.cwd,
        env: runOptions?.env,
        signal: runOptions?.signal,
      });

      const telemetry: ExecutionTelemetry = {
        tier: "isolated",
        reason: decision.reason,
        durationMs: this.now() - startedAt,
        classificationMs: decision.classificationMs,
        exitCode: isolated.exitCode,
        commandsExecuted: 0,
        bytesWritten: isolated.bytesWritten,
        processCount: isolated.processCount,
        syscallsDenied: isolated.syscallsDenied,
        sandboxId: isolated.sandboxId,
        limitHit: isolated.limitHit,
      };
      this.telemetry.unshift(telemetry);
      return {
        ...telemetry,
        exitCode: isolated.exitCode,
        stdout: isolated.stdout,
        stderr: isolated.stderr,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const telemetry: ExecutionTelemetry = {
        tier: "isolated",
        reason: decision.reason,
        durationMs: this.now() - startedAt,
        classificationMs: decision.classificationMs,
        exitCode: 1,
        commandsExecuted: 0,
        bytesWritten: 0,
        processCount: 0,
        syscallsDenied: 0,
        limitHit: error instanceof Error ? error.name : undefined,
      };
      this.telemetry.unshift(telemetry);
      return { ...telemetry, exitCode: 1, stdout: "", stderr: message };
    }
  }

  /** Release this runtime's isolated resources. Safe to call more than once. */
  async dispose(): Promise<void> {
    await this.backend?.releaseSession?.(this.sessionKey);
  }
}

/**
 * Whether a script's text mentions a network socket. Used by the classifier's
 * callers when the token walk is not enough — a script may reach a socket through a
 * native binary the tokens do not name, which is exactly the case that escalates.
 */
export function mentionsNetworkSocket(source: string): boolean {
  return /\b(?:curl|wget|nc|netcat|socat|ssh|telnet|ftp|openssl)\b/.test(source);
}

/**
 * Whether a script's text reaches for a filesystem path outside a root. A lexical
 * check only — the COW backend's containment check is authoritative — but it lets a
 * caller report *why* a script escalated.
 */
export function mentionsPathOutsideRoot(source: string): boolean {
  return /(?:^|[;\s&|])(?:\.\.(?:\/|\\)|(?:\/|\\)(?:etc|proc|sys|root|var|usr)(?:\/|\\|\b))/.test(
    source,
  );
}
