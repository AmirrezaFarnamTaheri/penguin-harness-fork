/**
 * Sandbox policy box — the trust and capability layer for sandboxed execution.
 *
 * Ports three things and fuses them:
 *
 * 1. **The violation taxonomy and scoped activation model** from the donors'
 *    defense-in-depth box: the typed violation union, the ref-counted
 *    `activate()`/`deactivate()` handle pair, the `AsyncLocalStorage` execution
 *    context that makes blocks apply *only* to sandbox work and never to concurrent
 *    host work in the same process, the trusted-scope depth counter, the violation
 *    buffer cap, and the config-conflict guard that stops a weaker first caller from
 *    downgrading protection for a later one.
 *
 * 2. **The capability table** from its blocked-globals module: the
 *    `{ name, strategy, reason, allowedKeys }` shape, where `allowedKeys` is the
 *    list of reads that must still work because Node's own internals make them
 *    inside a sandboxed async context.
 *
 * 3. **The untrusted-content policy** from the donors' agent trust layer: the
 *    rules that say which instructions inside a context a sandbox may act on —
 *    stored scheduled-task content is untrusted, a compaction summary is historical
 *    note rather than live policy, and a live user message outranks both.
 *
 * What is deliberately NOT ported is the process-wide monkey-patching of JavaScript
 * globals. That implementation replaces `globalThis.Function` and `eval` with
 * blocking Proxies for the process's lifetime once activated, which is correct for a
 * dedicated sandbox worker and wrong for a general-purpose harness process hosting
 * unrelated work. The mechanism here is the *capability decision*: a sandbox asks
 * for a named capability, the box answers allow / deny / audit, and the denial is a
 * typed error the caller surfaces. That is the same security invariant — untrusted
 * code cannot reach the capability — expressed at the boundary instead of inside the
 * language runtime, and it is the boundary the donor's own documentation says is the
 * primary one.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Types of security violation the box records. Kept as a closed union because every
 * entry is something a test asserts on and something an audit log filters by; an
 * open string type would make both meaningless.
 *
 * The entries divide into: code-execution vectors, process-control vectors,
 * module-loading vectors, resource-exhaustion vectors, context-lifetime violations,
 * and cross-boundary content violations.
 */
export type SecurityViolationType =
  | "function_constructor"
  | "eval"
  | "dynamic_import"
  | "native_binary_exec"
  | "shell_exec"
  | "network_socket"
  | "network_bind"
  | "filesystem_write_outside_root"
  | "filesystem_read_outside_root"
  | "symlink_traversal"
  | "process_env"
  | "process_binding"
  | "process_dlopen"
  | "process_exit"
  | "process_kill"
  | "process_setuid"
  | "process_umask"
  | "module_load"
  | "webassembly"
  | "shared_array_buffer"
  | "atomics"
  | "prototype_mutation"
  | "json_mutation"
  | "math_mutation"
  | "syscall_denied"
  | "egress_denied"
  | "missing_defense_context"
  | "promise_then_after_deactivate"
  | "bound_callback_after_deactivate"
  | "untrusted_instruction_acted_on"
  | "capability_not_declared";

/** Strategy for handling a requested capability. */
export type CapabilityStrategy = "permit" | "deny" | "audit";

/**
 * A capability a sandbox may request. The `allowedKeys` field carries the
 * environment-variable reads Node's own internals perform inside a sandboxed async
 * context — none of them user secrets — because denying them breaks module loading
 * without buying any security.
 */
export interface CapabilityEntry {
  readonly name: string;
  readonly violationType: SecurityViolationType;
  readonly strategy: CapabilityStrategy;
  readonly reason: string;
  readonly allowedKeys?: ReadonlySet<string>;
}

/**
 * The capability table. Every entry is a *deny by default* decision unless a preset
 * or an explicit override says otherwise, which is the property the donor's
 * capability flags implemented: optional runtimes (python, javascript) were
 * default-off, and network was off unless configured.
 */
export const CAPABILITY_TABLE: readonly CapabilityEntry[] = [
  {
    name: "shell:exec",
    violationType: "shell_exec",
    strategy: "deny",
    reason: "executing a shell command is the highest-capability action a sandbox takes",
  },
  {
    name: "shell:native-binary",
    violationType: "native_binary_exec",
    strategy: "deny",
    reason: "a native binary runs outside the in-memory tier and requires the isolated tier",
  },
  {
    name: "network:outbound",
    violationType: "network_socket",
    strategy: "deny",
    reason: "network egress must be on an explicit allow-list",
  },
  {
    name: "network:bind",
    violationType: "network_bind",
    strategy: "deny",
    reason: "a sandboxed process must not become a service reachable by other tenants",
  },
  {
    name: "fs:write",
    violationType: "filesystem_write_outside_root",
    strategy: "deny",
    reason: "writes must stay inside the sandbox's copy-on-write root",
  },
  {
    name: "fs:read",
    violationType: "filesystem_read_outside_root",
    strategy: "deny",
    reason: "reads must stay inside the sandbox's permitted prefixes",
  },
  {
    name: "js:function-constructor",
    violationType: "function_constructor",
    strategy: "deny",
    reason: "the Function constructor allows arbitrary code execution",
  },
  {
    name: "js:eval",
    violationType: "eval",
    strategy: "deny",
    reason: "eval() allows arbitrary code execution",
  },
  {
    name: "js:dynamic-import",
    violationType: "dynamic_import",
    strategy: "deny",
    reason: "dynamic import can reach a built-in module or a data: URL",
  },
  {
    name: "js:webassembly",
    violationType: "webassembly",
    strategy: "deny",
    reason: "WebAssembly is a code-execution surface outside the interpreter's limits",
  },
  {
    name: "process:env",
    violationType: "process_env",
    strategy: "deny",
    reason: "process.env could leak sensitive environment variables",
    allowedKeys: new Set([
      "NODE_ENV",
      "NODE_DEBUG",
      "NODE_COMPILE_CACHE",
      "FORCE_COLOR",
      "DEBUG",
      "JEST_WORKER_ID",
      "VITEST_WORKER_ID",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TERM",
    ]),
  },
  {
    name: "process:binding",
    violationType: "process_binding",
    strategy: "deny",
    reason: "process.binding and process._linkedBinding reach native modules",
  },
  {
    name: "process:dlopen",
    violationType: "process_dlopen",
    strategy: "deny",
    reason: "process.dlopen loads native addons",
  },
  {
    name: "process:getBuiltinModule",
    violationType: "process_binding",
    strategy: "deny",
    reason: "process.getBuiltinModule reaches native modules (fs, child_process, vm)",
  },
  {
    name: "process:exit",
    violationType: "process_exit",
    strategy: "deny",
    reason: "process.exit could terminate the host",
  },
  {
    name: "process:kill",
    violationType: "process_kill",
    strategy: "deny",
    reason: "process.kill reaches outside the sandbox's process tree",
  },
];

/**
 * Environment keys that Node's own internals read inside a sandboxed async context.
 * Exported so a caller can answer a `process:env` request for a *specific key*
 * without granting the whole object.
 */
export const SAFE_ENV_KEYS: ReadonlySet<string> =
  CAPABILITY_TABLE.find((entry) => entry.name === "process:env")?.allowedKeys ?? new Set();

/** Information about a detected security violation. */
export interface SecurityViolation {
  readonly timestamp: number;
  readonly type: SecurityViolationType;
  readonly message: string;
  readonly path: string;
  readonly stack?: string;
  readonly executionId?: string;
}

/** Configuration for the policy box. */
export interface PolicyBoxConfig {
  /** Permitted capabilities, overriding the table's deny default. */
  readonly capabilities?: readonly string[];
  /** Permitted environment keys for `process:env` requests. */
  readonly envKeys?: readonly string[];
  /** Audit mode: record violations but do not deny them. */
  readonly auditMode?: boolean;
  /** Called for every violation, in both audit and blocking mode. */
  readonly onViolation?: (violation: SecurityViolation) => void;
  /** Violation types to exclude from denial (audit-only even when blocking). */
  readonly excludeViolationTypes?: readonly SecurityViolationType[];
}

/** Runtime capability of the box, for surfacing what a host actually got. */
export interface PolicyBoxStatus {
  readonly requested: "auto" | "enabled" | "disabled";
  readonly state: "enabled" | "unsupported" | "disabled";
  readonly level: "full" | "best-effort" | "none";
  readonly auditMode: boolean;
}

/** Statistics about the box's activity. */
export interface PolicyBoxStats {
  readonly violationsRecorded: number;
  readonly violations: readonly SecurityViolation[];
  readonly activeTimeMs: number;
  readonly refCount: number;
  readonly permitted: readonly string[];
}

/** Handle returned by `activate()` for scoped execution. */
export interface PolicyBoxHandle {
  /** Run code within the protected async context. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Deactivate; decrementing the ref count and restoring policy when it hits zero. */
  deactivate: () => void;
  /** Unique id for this execution, for correlating violations. */
  readonly executionId: string;
}

/** Error thrown when a violation is detected and blocking is enabled. */
export class SecurityViolationError extends Error {
  constructor(
    message: string,
    public readonly violation: SecurityViolation,
  ) {
    super(message);
    this.name = "SecurityViolationError";
  }
}

/** Maximum recorded violations, so a hostile workload cannot exhaust memory via the audit. */
const MAX_STORED_VIOLATIONS = 1000;

interface PolicyContext {
  readonly sandboxActive: true;
  readonly executionId: string;
  readonly trusted?: boolean;
  readonly forceUntrusted?: boolean;
}

type ResolvedConfig = Omit<PolicyBoxConfig, "capabilities" | "envKeys" | "auditMode"> & {
  capabilities: ReadonlySet<string>;
  envKeys: ReadonlySet<string>;
  auditMode: boolean;
  requested: "auto" | "enabled" | "disabled";
  enabled: boolean;
};

/** The execution context: an AsyncLocalStorage so blocks apply only to sandbox work. */
const executionContext = new AsyncLocalStorage<PolicyContext>();

/**
 * Provenance classes for instructions found inside a sandbox's context. Which class
 * an instruction belongs to decides whether the box will let it through — this is
 * the untrusted-content policy, stated as data so a caller can test it without
 * reconstructing a prompt.
 */
export type InstructionProvenance =
  /** A live message from the human in this conversation. */
  | "live-user"
  /** Stored content the sandbox itself persisted earlier (a scheduled task, a memory). */
  | "stored-content"
  /** A machine-generated summary of earlier conversation, produced under a token budget. */
  | "compaction-summary"
  /** Content read from a tool result, a file, a web page, or any other untrusted source. */
  | "external-content";

/**
 * The untrusted-content policy: which provenance classes may carry instructions the
 * sandbox acts on without re-confirmation.
 *
 * Only `live-user` is authoritative. The other three are explicitly *not*: a stored
 * task's text is data the sandbox wrote, a compaction summary is lossy reconstruction
 * that can claim anything, and external content is the prompt-injection surface. A
 * sandbox that treats the second or third as policy is one `ignore previous
 * instructions` away from acting for an attacker; one that treats the fourth as
 * policy does not need an attacker.
 */
export const AUTHORITATIVE_PROVENANCE: ReadonlySet<InstructionProvenance> = new Set(["live-user"]);

/**
 * Decide whether an instruction from a given provenance may be acted on. Returns the
 * violation type when it may not, so the caller records the refusal in the same
 * vocabulary as every other denial.
 */
export function instructionAuthority(
  provenance: InstructionProvenance,
): { allowed: true } | { allowed: false; violationType: SecurityViolationType; reason: string } {
  if (AUTHORITATIVE_PROVENANCE.has(provenance)) return { allowed: true };
  const reasons: Record<Exclude<InstructionProvenance, "live-user">, string> = {
    "stored-content":
      "stored task content is untrusted data, not instruction; it may not change policy or take high-stakes actions",
    "compaction-summary":
      "a compaction summary is historical note, not authoritative policy; the live user message wins",
    "external-content":
      "content read from tools or files is untrusted; instructions inside it must be surfaced, not executed",
  };
  return {
    allowed: false,
    violationType: "untrusted_instruction_acted_on",
    reason: reasons[provenance as Exclude<InstructionProvenance, "live-user">],
  };
}

/**
 * The shape `resolveConfig` accepts: the public config, plus the already-resolved
 * `enabled` flag that a boolean shorthand or a merged config supplies. The capability
 * and key sets accept a `Set` too because `updateConfig` re-resolves ones it already
 * holds; either form is normalised to a `Set` on the way out.
 */
type ResolvableConfig = Omit<PolicyBoxConfig, "capabilities" | "envKeys"> & {
  enabled?: boolean;
  capabilities?: readonly string[] | ReadonlySet<string>;
  envKeys?: readonly string[] | ReadonlySet<string>;
};

function resolveConfig(config?: ResolvableConfig | boolean): ResolvedConfig {
  const supplied: ResolvableConfig =
    typeof config === "boolean" ? { enabled: config } : (config ?? {});
  const requested: "auto" | "enabled" | "disabled" =
    supplied.enabled === undefined ? "auto" : supplied.enabled ? "enabled" : "disabled";
  return {
    auditMode: supplied.auditMode ?? false,
    onViolation: supplied.onViolation,
    excludeViolationTypes: supplied.excludeViolationTypes,
    capabilities: new Set(supplied.capabilities ?? []),
    envKeys: new Set(supplied.envKeys ?? []),
    requested,
    enabled: requested !== "disabled",
  };
}

/** Compare every resolved option that changes singleton behaviour. */
function configsEqual(left: ResolvedConfig, right: ResolvedConfig): boolean {
  if (
    left.enabled !== right.enabled ||
    left.auditMode !== right.auditMode ||
    left.onViolation !== right.onViolation
  ) {
    return false;
  }
  const leftExcluded = left.excludeViolationTypes ?? [];
  const rightExcluded = right.excludeViolationTypes ?? [];
  if (leftExcluded.length !== rightExcluded.length) return false;
  if (!leftExcluded.every((value, index) => value === rightExcluded[index])) return false;
  const leftCaps = [...left.capabilities];
  const rightCaps = [...right.capabilities];
  return (
    leftCaps.length === rightCaps.length &&
    leftCaps.every((value, index) => value === rightCaps[index])
  );
}

/**
 * The policy box. A singleton per process, because the async context it installs is
 * process-wide; two instances would each believe they owned it.
 */
export class SandboxPolicyBox {
  private static instance: SandboxPolicyBox | null = null;
  private static trustedExecutionDepth = new Map<string, number>();

  private config: ResolvedConfig;
  private refCount = 0;
  private violations: SecurityViolation[] = [];
  private activeExecutionIds = new Set<string>();
  private readonly contextCache = new Map<string, PolicyContext>();
  private activationTime = 0;
  private totalActiveTimeMs = 0;

  private constructor(config: ResolvedConfig) {
    this.config = config;
  }

  /**
   * Get or create the singleton. A config that conflicts with the live instance's
   * security-relevant settings throws: a weaker first caller must not silently
   * downgrade protection for a later caller, so incompatible configs are an error
   * rather than a merge.
   */
  static getInstance(config?: PolicyBoxConfig | boolean): SandboxPolicyBox {
    const resolved = resolveConfig(config);
    if (!SandboxPolicyBox.instance) {
      SandboxPolicyBox.instance = new SandboxPolicyBox(resolved);
    } else {
      const active = SandboxPolicyBox.instance.config;
      if (!configsEqual(resolved, active)) {
        throw new Error(
          "SandboxPolicyBox config conflict: all resolved policy options — enabled, auditMode, " +
            "exclusions, the violation callback, and the capability list — must match across " +
            "instances. Call SandboxPolicyBox.resetInstance() between incompatible configurations.",
        );
      }
    }
    return SandboxPolicyBox.instance;
  }

  /** Reset the singleton; for tests. */
  static resetInstance(): void {
    if (SandboxPolicyBox.instance) {
      SandboxPolicyBox.instance.forceDeactivate();
      SandboxPolicyBox.instance = null;
    }
    SandboxPolicyBox.trustedExecutionDepth.clear();
  }

  /** Whether the current async context is sandboxed work. */
  static isInSandboxedContext(): boolean {
    return executionContext.getStore()?.sandboxActive === true;
  }

  /** The execution id of the current sandboxed context, if any. */
  static getCurrentExecutionId(): string | undefined {
    return executionContext.getStore()?.executionId;
  }

  private static enterTrustedScope(executionId: string): void {
    const current = SandboxPolicyBox.trustedExecutionDepth.get(executionId) ?? 0;
    SandboxPolicyBox.trustedExecutionDepth.set(executionId, current + 1);
  }

  private static leaveTrustedScope(executionId: string): void {
    const current = SandboxPolicyBox.trustedExecutionDepth.get(executionId);
    if (!current) return;
    if (current === 1) {
      SandboxPolicyBox.trustedExecutionDepth.delete(executionId);
      return;
    }
    SandboxPolicyBox.trustedExecutionDepth.set(executionId, current - 1);
  }

  private static isTrustedScopeActive(executionId: string | undefined): boolean {
    if (!executionId) return false;
    return (SandboxPolicyBox.trustedExecutionDepth.get(executionId) ?? 0) > 0;
  }

  private static isTrustedContext(store: PolicyContext | undefined): boolean {
    if (!store || store.forceUntrusted) return false;
    return store.trusted === true || SandboxPolicyBox.isTrustedScopeActive(store.executionId);
  }

  /** Whether a given execution id is still live (its handle not deactivated). */
  private isExecutionIdActive(executionId: string): boolean {
    return this.activeExecutionIds.has(executionId);
  }

  /** Runtime capability without activating. */
  getStatus(): PolicyBoxStatus {
    return {
      requested: this.config.requested,
      state: this.config.enabled ? "enabled" : "disabled",
      level: this.config.auditMode ? "none" : this.config.enabled ? "full" : "none",
      auditMode: this.config.auditMode,
    };
  }

  /** Change configuration; only future activations are affected. */
  updateConfig(config: Partial<PolicyBoxConfig>): void {
    if (this.refCount > 0) {
      throw new Error("SandboxPolicyBox configuration cannot change while protection is active");
    }
    const merged: ResolvableConfig = {
      ...this.config,
      ...config,
      capabilities: config.capabilities ? new Set(config.capabilities) : this.config.capabilities,
      envKeys: config.envKeys ? new Set(config.envKeys) : this.config.envKeys,
    };
    this.config = resolveConfig(merged);
  }

  /**
   * Activate the box. Returns a handle whose `run()` installs the async context.
   * Ref-counted: nested activations share one installed context, and the count
   * reaching zero is what clears it — so a forgetful caller leaves the box on,
   * which is the safe direction to fail in.
   */
  activate(): PolicyBoxHandle {
    if (!this.config.enabled) {
      // A disabled box still hands out a handle so a caller's try/finally works,
      // but the handle never installs a context and cannot block anything.
      const noopId = `noop-${cryptoRandomId()}`;
      let noopDeactivated = false;
      return {
        executionId: noopId,
        run: <T>(fn: () => Promise<T>): Promise<T> => {
          if (noopDeactivated) {
            return Promise.reject(
              new Error("SandboxPolicyBox handle is deactivated and cannot run new work"),
            );
          }
          return fn();
        },
        deactivate: () => {
          noopDeactivated = true;
        },
      };
    }

    this.refCount++;
    if (this.refCount === 1) {
      this.activationTime = Date.now();
    }

    const executionId = cryptoRandomId();
    let deactivated = false;

    return {
      executionId,
      run: <T>(fn: () => Promise<T>): Promise<T> => {
        if (deactivated) {
          return Promise.reject(
            new Error("SandboxPolicyBox handle is deactivated and cannot run new work"),
          );
        }
        this.activeExecutionIds.add(executionId);
        return executionContext.run({ sandboxActive: true, executionId }, fn);
      },
      deactivate: () => {
        if (deactivated) return;
        deactivated = true;
        this.activeExecutionIds.delete(executionId);
        this.contextCache.delete(executionId);

        this.refCount--;
        if (this.refCount === 0) {
          this.totalActiveTimeMs += Date.now() - this.activationTime;
        }
        // An unbalanced deactivate must not drive the count negative, which would
        // make a later activation think protection was already installed.
        if (this.refCount < 0) this.refCount = 0;
      },
    };
  }

  /** Force deactivation regardless of ref count; for error recovery. */
  forceDeactivate(): void {
    if (this.refCount > 0) {
      this.totalActiveTimeMs += Date.now() - this.activationTime;
    }
    this.activeExecutionIds.clear();
    this.contextCache.clear();
    this.refCount = 0;
  }

  isActive(): boolean {
    return this.refCount > 0;
  }

  getStats(): PolicyBoxStats {
    return {
      violationsRecorded: this.violations.length,
      violations: [...this.violations],
      activeTimeMs:
        this.totalActiveTimeMs + (this.refCount > 0 ? Date.now() - this.activationTime : 0),
      refCount: this.refCount,
      permitted: [...this.config.capabilities],
    };
  }

  /** Whether blocking applies to the current context. */
  private shouldBlock(): boolean {
    if (this.config.auditMode) return false;
    const store = executionContext.getStore();
    if (store?.sandboxActive !== true) return false;
    if (SandboxPolicyBox.isTrustedContext(store)) return false;
    return true;
  }

  /** Whether audit-only recording applies to the current context. */
  private shouldAudit(): boolean {
    if (!this.config.auditMode) return false;
    const store = executionContext.getStore();
    return store?.sandboxActive === true && !SandboxPolicyBox.isTrustedContext(store);
  }

  /** Record a violation; capped so the audit cannot itself exhaust memory. */
  recordViolation(type: SecurityViolationType, path: string, message: string): SecurityViolation {
    const violation: SecurityViolation = {
      timestamp: Date.now(),
      type,
      message,
      path,
      stack: new Error().stack,
      executionId: executionContext.getStore()?.executionId,
    };

    if (this.violations.length < MAX_STORED_VIOLATIONS) {
      this.violations.push(violation);
    }
    if (this.config.onViolation) {
      try {
        this.config.onViolation(violation);
      } catch (callbackError) {
        // A throwing observer must not become a way to escape the denial.
        console.debug(
          "[SandboxPolicyBox] onViolation callback threw:",
          callbackError instanceof Error ? callbackError.message : String(callbackError),
        );
      }
    }
    return violation;
  }

  clearViolations(): void {
    this.violations = [];
  }

  /**
   * The capability decision. This is the box's real work: a sandbox asks for a named
   * capability, and the answer is one of permit / deny / audit — with `deny` the
   * default for anything the table does not explicitly permit.
   *
   * @param capability the capability name (`shell:exec`, `process:env`, …)
   * @param key for `process:env` and similar keyed capabilities, the specific key
   *   requested. A permitted key inside a denied capability is allowed through,
   *   because those keys are the ones Node's own internals read.
   */
  decide(
    capability: string,
    key?: string,
  ): {
    readonly outcome: "permit" | "deny" | "audit";
    readonly reason: string;
    readonly violationType: SecurityViolationType;
  } {
    const entry = CAPABILITY_TABLE.find((candidate) => candidate.name === capability);
    if (entry === undefined) {
      // An unknown capability is not permitted by default — the box has not been
      // told it is safe, and guessing is the wrong default for a security decision.
      const unknown = this.recordViolation(
        "capability_not_declared",
        capability,
        `capability '${capability}' is not declared in the capability table`,
      );
      if (this.shouldBlock()) {
        throw new SecurityViolationError(
          `capability '${capability}' is not declared in the capability table`,
          unknown,
        );
      }
      return {
        outcome: this.config.auditMode ? "audit" : "deny",
        reason: "capability is not declared",
        violationType: "capability_not_declared",
      };
    }

    const explicitlyPermitted =
      this.config.capabilities.has(capability) ||
      this.config.capabilities.has(`${capability}:${key}`);
    if (explicitlyPermitted) {
      return {
        outcome: "permit",
        reason: "capability is explicitly permitted by the active policy",
        violationType: entry.violationType,
      };
    }

    if (key !== undefined && entry.allowedKeys?.has(key)) {
      return {
        outcome: "permit",
        reason: `key '${key}' is on the capability's safe-key list`,
        violationType: entry.violationType,
      };
    }

    const excluded = this.config.excludeViolationTypes?.includes(entry.violationType) ?? false;
    if (excluded) {
      return {
        outcome: "audit",
        reason: "violation type is excluded from denial by the active policy",
        violationType: entry.violationType,
      };
    }

    if (this.shouldBlock()) {
      const violation = this.recordViolation(
        entry.violationType,
        key !== undefined ? `${capability}[${key}]` : capability,
        `${capability} is blocked during sandbox execution: ${entry.reason}`,
      );
      throw new SecurityViolationError(
        `${capability} is blocked during sandbox execution`,
        violation,
      );
    }

    if (this.shouldAudit()) {
      this.recordViolation(
        entry.violationType,
        key !== undefined ? `${capability}[${key}]` : capability,
        `${capability} requested (audit mode): ${entry.reason}`,
      );
    }

    return {
      outcome: this.config.auditMode ? "audit" : "deny",
      reason: entry.reason,
      violationType: entry.violationType,
    };
  }

  /**
   * Run a function as trusted infrastructure code, suspending denial for the current
   * async context only. Other concurrent sandboxes remain protected — the depth
   * counter is per executionId precisely so one sandbox's trusted scope cannot lift
   * another's.
   */
  static runTrusted<T>(fn: () => Promise<T>): Promise<T>;
  static runTrusted<T>(fn: () => T): T;
  static runTrusted<T>(fn: () => T | Promise<T>): T | Promise<T> {
    const current = executionContext.getStore();
    if (!current) return fn();
    const { executionId } = current;
    return executionContext.run({ ...current, trusted: true, forceUntrusted: false }, () => {
      SandboxPolicyBox.enterTrustedScope(executionId);
      const leave = () => SandboxPolicyBox.leaveTrustedScope(executionId);
      try {
        const result = fn();
        if (
          typeof result === "object" &&
          result !== null &&
          "finally" in result &&
          typeof (result as { finally: unknown }).finally === "function"
        ) {
          return (result as Promise<T>).finally(leave);
        }
        leave();
        return result;
      } catch (error) {
        leave();
        throw error;
      }
    });
  }

  /** Async variant of `runTrusted`. */
  static async runTrustedAsync<T>(fn: () => Promise<T>): Promise<T> {
    const current = executionContext.getStore();
    if (!current) return fn();
    const { executionId } = current;
    return executionContext.run({ ...current, trusted: true, forceUntrusted: false }, async () => {
      SandboxPolicyBox.enterTrustedScope(executionId);
      try {
        return await fn();
      } finally {
        SandboxPolicyBox.leaveTrustedScope(executionId);
      }
    });
  }

  /** Restore denial for an untrusted operation nested inside trusted host code. */
  static async runUntrustedAsync<T>(fn: () => Promise<T>): Promise<T> {
    const current = executionContext.getStore();
    if (!current) return fn();
    return executionContext.run({ ...current, trusted: false, forceUntrusted: true }, fn);
  }

  /**
   * Bind a callback to the current context so infrastructure callbacks that fire
   * later still attribute their work to the right execution — and are refused if
   * that execution has ended. A callback firing after deactivation is a classic
   * lifetime escape; recording it and dropping the work is the safe answer.
   */
  static bindCurrentContext<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    const current = executionContext.getStore();
    const executionId = current?.sandboxActive === true ? current.executionId : undefined;
    if (!executionId) return fn;

    const captured: PolicyContext = {
      sandboxActive: true,
      executionId,
      forceUntrusted: current?.forceUntrusted,
    };
    return (...args: TArgs): TResult => {
      const activeBox = SandboxPolicyBox.instance;
      if (activeBox && !activeBox.isExecutionIdActive(executionId)) {
        activeBox.recordViolation(
          "bound_callback_after_deactivate",
          "bound callback",
          "Bound callback blocked after originating execution was deactivated",
        );
        if (!activeBox.config.auditMode) {
          return undefined as unknown as TResult;
        }
      }
      return executionContext.run(captured, () => fn(...args));
    };
  }
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
