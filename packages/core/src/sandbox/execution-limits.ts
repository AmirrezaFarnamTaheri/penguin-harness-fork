/**
 * Execution limits — centralized ceilings that keep an in-memory shell workload
 * bounded. Ported from the donor in-memory bash implementation's limits module:
 * the numeric values, the two named profiles, and the resolution/validation rules
 * come across verbatim; the shell-specific resource kinds that have no meaning in
 * this harness (jq/awk/csv/parser budgets) are dropped rather than carried as
 * dead knobs.
 *
 * Two profiles exist because the two consumers disagree about what "bounded" means:
 * `normal` is a compatibility profile sized for real, large-but-legitimate data
 * transforms, and keeps every ceiling finite only as defense-in-depth. `hardened`
 * is the opt-in profile for genuinely untrusted source, and is what the strict
 * sandbox presets select. A limit of positive Infinity is permitted by the
 * validator (a caller may lift a ceiling explicitly) but no preset uses it.
 */

/**
 * Execution limits. Every field is optional; an omitted field falls back to the
 * selected profile's default.
 */
export interface ExecutionLimits {
  /** Maximum shell source bytes accepted before parsing (normal default: 64 MiB). */
  maxSourceBytes?: number;
  /** Maximum nested interpreter executions through an exec primitive (default: 64). */
  maxExecDepth?: number;
  /** Maximum function call / recursion depth (default: 100). */
  maxCallDepth?: number;
  /** Maximum number of commands to execute (default: 100000). */
  maxCommandCount?: number;
  /** Maximum loop iterations for while/for/until loops (default: 100000). */
  maxLoopIterations?: number;
  /** Aggregate execution work units shared across nested execution (default: 1000000). */
  maxWorkUnits?: number;
  /** Maximum filesystem entries visited by one traversal (default: 1000000). */
  maxTraversalEntries?: number;
  /** Maximum filesystem traversal nesting depth (default: 1000). */
  maxTraversalDepth?: number;
  /** Maximum filesystem traversal operations (default: 1000000). */
  maxTraversalWork?: number;
  /** Maximum reserved live/intermediate bytes (default: 512 MiB). */
  maxLiveBytes?: number;
  /** Maximum aggregate input bytes (default: 512 MiB). */
  maxInputBytes?: number;
  /** Maximum bytes retained by the in-memory filesystem layer (default: 1 GiB). */
  maxFileSystemBytes?: number;
  /** Maximum bytes in one in-memory file (default: 512 MiB). */
  maxFileBytes?: number;
  /** Maximum top-level execution wall time in milliseconds (default: 1 hour). */
  maxExecutionTimeMs?: number;
  /**
   * Maximum time to let an aborted command acknowledge cancellation before its
   * execution context is revoked (default: 100ms).
   */
  maxExtensionCleanupTimeMs?: number;
  /** Maximum total output size in bytes (default: 256 MiB). */
  maxOutputSize?: number;
  /** Maximum number of open file descriptors (default: 4096). */
  maxFileDescriptors?: number;
  /** Maximum source/. nesting depth (default: 100). */
  maxSourceDepth?: number;
  /** Maximum command substitution nesting depth (default: 50). */
  maxSubstitutionDepth?: number;
  /** Maximum brace expansion results (default: 100000). */
  maxBraceExpansionResults?: number;
}

/** Named limit presets. `normal` favors compatibility; `hardened` is opt-in. */
export type ExecutionLimitProfile = "normal" | "hardened";

/** Liberal default shared by shell entry points. */
export const DEFAULT_MAX_SOURCE_BYTES: number = 64 * 1024 * 1024;

/**
 * Default execution limits. These liberal compatibility defaults remain bounded —
 * every value is finite — so a runaway workload hits a ceiling rather than the
 * machine. Select the hardened profile for tighter untrusted-workload policy.
 */
const DEFAULT_LIMITS: Required<ExecutionLimits> = {
  maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  maxExecDepth: 64,
  maxCallDepth: 100,
  maxCommandCount: 100000,
  maxLoopIterations: 100000,
  maxWorkUnits: 1_000_000,
  maxTraversalEntries: 1_000_000,
  maxTraversalDepth: 1_000,
  maxTraversalWork: 1_000_000,
  maxLiveBytes: 512 * 1024 * 1024,
  maxInputBytes: 512 * 1024 * 1024,
  maxFileSystemBytes: 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxExecutionTimeMs: 60 * 60 * 1000,
  maxExtensionCleanupTimeMs: 100,
  maxOutputSize: 256 * 1024 * 1024,
  maxFileDescriptors: 4096,
  maxSourceDepth: 100,
  maxSubstitutionDepth: 50,
  maxBraceExpansionResults: 100000,
};

const HARDENED_LIMITS: Required<ExecutionLimits> = {
  ...DEFAULT_LIMITS,
  maxSourceBytes: 8 * 1024 * 1024,
  maxCommandCount: 10_000,
  maxLoopIterations: 10_000,
  maxExtensionCleanupTimeMs: 25,
  maxOutputSize: 10 * 1024 * 1024,
  maxFileDescriptors: 1_024,
  maxTraversalEntries: 100_000,
  maxTraversalDepth: 256,
  maxTraversalWork: 100_000,
  maxLiveBytes: 64 * 1024 * 1024,
  maxInputBytes: 32 * 1024 * 1024,
  maxFileSystemBytes: 128 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxWorkUnits: 100_000,
  maxExecutionTimeMs: 30_000,
  maxBraceExpansionResults: 10_000,
};

/**
 * Resolve execution limits by merging user-provided limits over the selected
 * profile's defaults. Every field of the result is populated, so consumers read a
 * `Required<ExecutionLimits>` without a chain of `?? fallback`.
 *
 * @throws {RangeError} for an unknown profile name, or for any resolved limit that
 *   is neither a non-negative safe integer nor positive Infinity. Infinity is the
 *   one escape hatch — a caller that wants an unbounded resource says so — and it
 *   is tested explicitly so the validator cannot quietly become a wall.
 */
export function resolveLimits(
  userLimits?: ExecutionLimits,
  profile: ExecutionLimitProfile = "normal",
): Required<ExecutionLimits> {
  if (profile !== "normal" && profile !== "hardened") {
    throw new RangeError('executionLimitProfile must be "normal" or "hardened"');
  }
  const defaults = profile === "hardened" ? HARDENED_LIMITS : DEFAULT_LIMITS;
  if (!userLimits) {
    return { ...defaults };
  }
  const resolved: Required<ExecutionLimits> = {
    maxSourceBytes: userLimits.maxSourceBytes ?? defaults.maxSourceBytes,
    maxExecDepth: userLimits.maxExecDepth ?? defaults.maxExecDepth,
    maxCallDepth: userLimits.maxCallDepth ?? defaults.maxCallDepth,
    maxCommandCount: userLimits.maxCommandCount ?? defaults.maxCommandCount,
    maxLoopIterations: userLimits.maxLoopIterations ?? defaults.maxLoopIterations,
    maxWorkUnits: userLimits.maxWorkUnits ?? defaults.maxWorkUnits,
    maxTraversalEntries: userLimits.maxTraversalEntries ?? defaults.maxTraversalEntries,
    maxTraversalDepth: userLimits.maxTraversalDepth ?? defaults.maxTraversalDepth,
    maxTraversalWork: userLimits.maxTraversalWork ?? defaults.maxTraversalWork,
    maxLiveBytes: userLimits.maxLiveBytes ?? defaults.maxLiveBytes,
    maxInputBytes: userLimits.maxInputBytes ?? defaults.maxInputBytes,
    maxFileSystemBytes: userLimits.maxFileSystemBytes ?? defaults.maxFileSystemBytes,
    maxFileBytes: userLimits.maxFileBytes ?? defaults.maxFileBytes,
    maxExecutionTimeMs: userLimits.maxExecutionTimeMs ?? defaults.maxExecutionTimeMs,
    maxExtensionCleanupTimeMs:
      userLimits.maxExtensionCleanupTimeMs ?? defaults.maxExtensionCleanupTimeMs,
    maxOutputSize: userLimits.maxOutputSize ?? defaults.maxOutputSize,
    maxFileDescriptors: userLimits.maxFileDescriptors ?? defaults.maxFileDescriptors,
    maxSourceDepth: userLimits.maxSourceDepth ?? defaults.maxSourceDepth,
    maxSubstitutionDepth: userLimits.maxSubstitutionDepth ?? defaults.maxSubstitutionDepth,
    maxBraceExpansionResults:
      userLimits.maxBraceExpansionResults ?? defaults.maxBraceExpansionResults,
  };

  for (const key of Object.keys(resolved) as (keyof ExecutionLimits)[]) {
    const value = resolved[key];
    if (value === Number.POSITIVE_INFINITY) {
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${key} must be a non-negative safe integer or positive Infinity`);
    }
  }

  return resolved;
}
