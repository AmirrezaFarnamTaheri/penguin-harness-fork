/**
 * The isolated-execution contract a backend outside core implements.
 *
 * Why this module exists: {@link IsolatedBackend} and the shapes it carries were
 * declared inside the sandbox subsystem, which core keeps internal — the subsystem's
 * own barrel is not a package entry point. But the contract's whole purpose is to be
 * compiled against by a backend in *another* package (for this harness, the microVM
 * escalation runtime in `@prismshadow/penguin-server`), and a backend cannot import a
 * path the package does not export.
 *
 * So the contract is surfaced here, on the plugin barrel, which is the documented home
 * for "the vocabulary a plugin compiles against". This module adds no declarations of
 * its own: it re-exports what the sandbox subsystem already defines, so there is one
 * definition and one surface for it. Types only — a backend importing this carries no
 * runtime dependency on core, the same way every other plugin type does.
 *
 * What a backend is NOT given: the in-memory tier. The shell evaluator, the COW
 * filesystem, and the policy box stay internal. A backend receives a command that has
 * already been classified as unsafe to run in memory; how it isolates that command is
 * its business, and the contract below is the whole of what core promises about the
 * request.
 */
export type {
  /** Why a script was escalated, from {@link decideTier}. */
  EscalationReason,
  /** The tier a script ran in: in memory, or isolated. */
  ExecutionTier,
  /** The classifier's verdict on a script. */
  TierDecision,
  /** One run's measured outcome, for the cockpit and the QoS targets. */
  ExecutionTelemetry,
  /** Resource ceilings the isolated tier must enforce. */
  IsolationCeilings,
  /** The isolated-tier backend contract. */
  IsolatedBackend,
  /** A command the isolated tier must run inside a sandbox. */
  IsolatedCommand,
  /** The isolated tier's result. */
  IsolatedResult,
  /** Options for the tiered runtime that selects between the two tiers. */
  IsolatedRuntimeOptions,
  /** A URL/host entry the egress allow-list admits. */
  AllowedUrlEntry,
} from "../sandbox/index.js";

export {
  /** The isolated-tier defaults: process, memory and SIGKILL ceilings. */
  DEFAULT_ISOLATION_CEILINGS,
  /** Classify a script without running it: run it in memory, or escalate. */
  decideTier,
  /** Raised when a script can run on neither tier. */
  IsolationRefusalError,
} from "../sandbox/index.js";
