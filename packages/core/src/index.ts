/**
 * @prismshadow/penguin-core — public entry point for the PenguinHarness core SDK.
 *
 * Exports the OmniMessage protocol, the three interface contracts (Human/LLM/Environment),
 * and the runtime entry points for Agent / Session / context_engine along with their
 * submodules (state / llm / environment / trace).
 *
 * Typical usage:
 *
 * ```ts
 * const agent = await createAgent({ agentId: "default_agent" });
 * // A model reference is always the (provider, model_id) pair; omit both for the Project default.
 * const session = await agent.createSession({ workspaceDir, provider, modelId });
 * for await (const output of session.run([userText("...")])) { ... }
 * ```
 */

import type { BuildInfo } from "./version-info.js";
import { resolveBuildInfo } from "./internal/build-info.js";

// Protocol and interface contracts (foundation)
export * from "./omnimessage/index.js";
export * from "./interfaces/index.js";
// Build/harness identity: not an interface contract, so it sits outside interfaces/ (see version-info.ts).
export type * from "./version-info.js";

// Only the default server port leaves internal: the CLI / server default-port source of truth.
export { DEFAULT_SERVER_PORT } from "./internal/ports.js";
export { SERVER_RESTART_EXIT_CODE } from "./internal/server-lifecycle.js";

// Submodules
export * from "./state/index.js";
export * from "./llm/index.js";
export * from "./environment/index.js";
export * from "./trace/index.js";
export * from "./hooks/index.js";
export * from "./plugins/index.js";
export * from "./hud/index.js";
export * from "./agent/index.js";
export * from "./environment/worktrees.js";
// The Universal Tool Mesh: 250+ SaaS providers, OAuth/PKCE exchange, credential rotation,
// dynamic CLI wrapping, and the encrypted credential vault. A subpath-free re-export so the
// server's tool-fleet services reach it through the package root.
export * from "./fleet/index.js";

// Semantic code topology, AST diffing and automated review — the codegraph subsystem.
// Re-exported barrel-for-barrel: every name below is exactly what ./codegraph/index.js ships,
// and the matching ./codegraph subpath bundles it without the rest of the SDK.
export * from "./codegraph/index.js";

// NOTE on prompts: the prompts subsystem is published through its own ./prompts subpath only,
// not from this root barrel. prompts/index.js exports a `DEFAULT_CONTEXT_WINDOW` that already
// ships from ./llm/index.js, so a root-level `export *` is ambiguous (TS2308) and cannot be
// resolved without either renaming one of the two constants or dropping one side's name from
// the root. It stays reachable through its subpath, the way ./kernel, ./paths,
// ./context-limits and ./model-catalog already publish.
// Memory carries no such collision, so it is re-exported barrel-for-barrel here as well as
// through the ./memory subpath; if a future memory symbol ever collides with another root
// export, prefer the prompts resolution (subpath only) over renaming either name.
export * from "./memory/index.js";

// Runtime entry points
export { ContextEngine, reconnectDelayMs } from "./engine/context-engine.js";
export type {
  CompactAvailability,
  CompactionSettings,
  ContextEngineDeps,
  EngineInitialState,
  OpenContextOptions,
  OpenedContext,
  RunOptions,
  TraceSink,
} from "./engine/context-engine.js";
export { Session } from "./session.js";
export type { SessionConfig } from "./session.js";
export type { AgentAssembly, PromptSection } from "./agent.js";
// Session-title generation lives in internal/ (an assembly detail of Session.generateTitle);
// only its narrow public surface is re-exported: the result type (part of
// Session.generateTitle's signature) and the two cleaners, sanitizeTitle and truncateTitle,
// which a host also runs over the fallback title it derives from the user's first line — one
// implementation, so a title is cut the same way whichever path produced it. The
// prompt/request internals (buildTitlePrompt / generateTitleWithLLM) are deliberately not
// public; marker stripping (stripConversationMarkers) is exported from the markers module
// via the omnimessage barrel.
export { sanitizeTitle, truncateTitle } from "./internal/session-title.js";
export type { SessionTitleResult } from "./internal/session-title.js";
// Session assembly likewise stays internal; only the attachment-line placement rule is
// re-exported, because the server appends `[attached file: …]` lines for the composer's
// uploads and both producers must place them identically (see the markers module).
export { appendAttachmentLines } from "./internal/session-support.js";
// Model-visible path spelling (forward slashes on Windows); the server uses it for its
// [attached file: ...] lines so every path the model reads has one spelling per platform.
export { modelVisiblePath } from "./internal/model-visible-path.js";
// Atomic file replacement: the writer behind every Harness state file, shared with the server so
// both sides of the same file (core's saveProjectConfig, the server's writeRaw) replace it the
// same way.
export { atomicWriteFile } from "./internal/atomic-write.js";
export type { AtomicWriteOptions } from "./internal/atomic-write.js";
// SSRF-safe HTTP client and URL validator for web fetch and tool execution.
export {
  safeFetch,
  validateSafeUrl,
  isPrivateOrReservedIPv4,
  isPrivateOrReservedIPv6,
  isSafeIpAddress,
} from "./internal/safe-http.js";
export type { SafeHttpOptions, SafeHttpResponse } from "./internal/safe-http.js";
export {
  redactCredentials,
  containsCredentials,
  redactObject,
  REDACTED_MARKER,
  CREDENTIAL_RULES,
} from "./internal/credential-redactor.js";
export type { RedactionRule } from "./internal/credential-redactor.js";

export { InferenceProxyPool, parseProxyUrl } from "./llm/proxy-pool.js";
export type {
  ProxyProtocol,
  ProxyStatus,
  RotationStrategy,
  ProxyAuth,
  ProxyEntry,
  ProxyInput,
  ProxyPoolOptions,
  ProxySelectionCriteria,
  ProxyPoolStats,
} from "./llm/proxy-pool.js";
export {
  isTruncatedJSON,
  repairTruncatedJSON,
  scavengeToolCalls,
  truncateKeepEnds,
} from "./llm/tool-call-repair.js";
export type { ScavengedToolCall } from "./llm/tool-call-repair.js";

// `metaMaxTokens` is the output cap every out-of-band meta request shares — a small budget,
// tightened by the entry's pinned per-model cap. Exported so a host running its own one-off
// requests on a Project's model sizes them the way the SDK sizes its own.
export { Agent, createAgent, metaMaxTokens } from "./agent.js";
export type {
  ControlEnvContext,
  CreateAgentOptions,
  CreateSessionOptions,
  ResumeSessionOptions,
} from "./agent.js";

/** SDK version number. */
export const VERSION = "0.2.16";
/** Release build date (UTC yyyy-mm-dd), stamped by the release workflow next to VERSION; null in a dev/source build. */
export const BUILD_DATE: string | null = null;
/** Full commit sha the release was built from, stamped by the release workflow next to VERSION; null in a dev/source build. */
export const BUILD_COMMIT: string | null = null;

/**
 * Identity of the running build — the sole producer behind `penguin version [--json]` and
 * GET /api/version. The three stamped constants above are the only inputs the release
 * workflow rewrites, so they are declared here and passed in rather than imported by
 * build-info.ts, which would make this barrel and that module a cycle.
 */
export function buildInfo(): BuildInfo {
  return resolveBuildInfo({ version: VERSION, buildDate: BUILD_DATE, commit: BUILD_COMMIT });
}
// Version-string helpers (shared by the CLI's `penguin update` and the server's update check).
export { compareVersions, normalizeVersion } from "./internal/version.js";
