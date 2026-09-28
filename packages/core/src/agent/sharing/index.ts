/**
 * Sharing one verification run between the agents that are waiting on the same answer.
 *
 * The product request was: "if one is running a lint test the other doesn't run exact lint tests
 * instead wait and use the results of the other one." Taken literally that is a cache with the
 * command as its key, and it is wrong in a way that only shows up under load — the second agent
 * is reasoning about code that changed between the two runs, and the inherited result is
 * byte-identical to a fresh one, so nothing tells it otherwise. What is built here keeps the
 * waiting and drops the guessing: the key is the command together with a content fingerprint of
 * everything its answer depends on, and two callers share only on an exact match of that whole
 * thing.
 *
 * Three modules, each with one job:
 *
 * - {@link admitOperation} — MAY this operation be shared? A refusal-first allowlist, because a
 *   denylist is one typo away from sharing a build. See `policy.ts` for what is refused and why,
 *   including the two things the product request asked for that cannot be built safely at all.
 * - {@link fingerprintOperation} + {@link shareKey} — is the answer still true? The fingerprint is
 *   hashed from the watched roots' CONTENT and from named config and toolchain material, and a
 *   fingerprint that cannot be computed is a refusal rather than a weaker one.
 * - {@link OperationShareRegistry} — do the work, or take someone else's? Bounded in-flight
 *   joining, a bounded wait that falls back to running it yourself, a retained cache bounded by
 *   count, bytes and age, and counters for every path through it, because a share that cannot be
 *   seen is indistinguishable from a bug.
 *
 * Not wired into any other module: this is a primitive with one caller-facing entry point
 * (`run`), and a caller that wants sharing has to name the roots it is claiming are covered.
 * Guessing those from a tool name is how a fingerprint ends up watching the wrong half of a
 * monorepo and reporting a confident answer about files nobody changed.
 */

export {
  fingerprintOperation,
  shareKey,
  repoFingerprintMaterials,
  DEFAULT_EXCLUDED_DIR_NAMES,
  DEFAULT_MAX_INLINE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  SHARE_KEY_HEX_LENGTH,
} from "./fingerprint.js";
export type {
  FingerprintFailure,
  FingerprintInput,
  FingerprintMaterial,
  FingerprintResult,
  ShareKeyInput,
  // Published under a qualified name because `agent/completion-tracker.ts` has
  // already exported a `VerificationKind` from the package root, and the two
  // describe unrelated things: that one is how a task is verified, this one is
  // which read-only tool shape a shared run may be. Two `export *` barrels
  // claiming one name would silently drop it, so the name is disambiguated
  // here rather than renaming a type the module already uses correctly.
  VerificationKind as ShareVerificationKind,
} from "./fingerprint.js";

export { admitOperation, normalizeProgramName, REFUSED_PROGRAM_NOTES } from "./policy.js";
export type {
  EffectDeclaration,
  ExcludeReason,
  ShareDecision,
  ShareOperationSpec,
} from "./policy.js";

export { OperationShareRegistry, DEFAULT_SHARE_LIMITS } from "./registry.js";
export type {
  OperationOutcome,
  ShareCounters,
  ShareEvictionCounters,
  ShareOrigin,
  ShareRegistryLimits,
  ShareRegistryOptions,
  ShareStats,
  SharedRun,
} from "./registry.js";
