/**
 * Launch-failure taxonomy for the browser cluster.
 *
 * Ports the donor's `launch-errors.ts` in full: the typed error hierarchy, the retryability
 * classification that the retry manager keys off, and the message-pattern classifier that maps an
 * arbitrary thrown value onto one of the typed errors.
 *
 * Why the taxonomy is worth porting rather than letting errors propagate raw: the cluster's launch
 * path is a fan-out of independent failure modes (bad config, missing binary, dead port, proxy
 * failure, a plugin hook throwing, a fingerprint dataset gap). Each has a different correct
 * response — a bad proxy URL is a permanent config error no retry will fix, while a sandboxed
 * browser failing to bind its debug port is transient. A single `Error` carries no signal to
 * branch on; a typed error carries exactly the signal the retry policy needs, and the classifier
 * means an untyped throw from any of those layers still lands in the right bucket.
 */

export enum LaunchErrorType {
  TIMEOUT = "TIMEOUT",
  CONFIGURATION = "CONFIGURATION",
  RESOURCE = "RESOURCE",
  SYSTEM = "SYSTEM",
  NETWORK = "NETWORK",
  FINGERPRINT = "FINGERPRINT",
  PLUGIN = "PLUGIN",
  CLEANUP = "CLEANUP",
  BROWSER_PROCESS = "BROWSER_PROCESS",
  SESSION_CONTEXT = "SESSION_CONTEXT",
}

export enum BrowserProcessState {
  PAGE_REFRESH = "page_refresh",
  LAUNCH_FAILED = "launch_failed",
  PAGE_ACCESS = "page_access",
  TARGET_SETUP = "target_setup",
  UNKNOWN = "unknown",
}

export enum PluginName {
  LAUNCH_MUTATOR = "launch_mutator",
  PLUGIN_MANAGER = "plugin_manager",
  UNKNOWN = "unknown",
}

export enum PluginOperation {
  PRE_LAUNCH_HOOK = "pre-launch hook",
  BROWSER_LAUNCH_NOTIFICATION = "browser launch notification",
  LAUNCH = "launch",
}

export enum CleanupType {
  PRE_LAUNCH_FILE_CLEANUP = "pre-launch file cleanup",
  GENERAL = "general",
}

export enum SessionContextType {
  CONTEXT_INJECTION = "context injection",
}

export enum FingerprintStage {
  GENERATION = "generation",
  INJECTION = "injection",
}

export enum ResourceType {
  EXTENSIONS = "extensions",
  FILE = "file",
}

export enum NetworkOperation {
  WEBSOCKET_SETUP = "websocket setup",
  PORT_BINDING = "port binding",
  NETWORK_SETUP = "network setup",
}

export enum SystemOperation {
  FILE_ACCESS = "file access",
  UNKNOWN_OPERATION = "unknown operation",
}

export enum ConfigurationField {
  DIMENSIONS = "dimensions",
  TIMEZONE = "timezone",
  PROXY_URL = "proxyUrl",
}

/**
 * Base class for every categorized launch failure. `isRetryable` is the field the retry manager
 * reads; the subclass constructors set it per failure kind.
 */
export abstract class BaseLaunchError extends Error {
  public readonly type: LaunchErrorType;
  public readonly isRetryable: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(
    type: LaunchErrorType,
    message: string,
    isRetryable = false,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.type = type;
    this.isRetryable = isRetryable;
    this.context = context;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Browser launch exceeded its deadline — usually transient resource pressure. */
export class LaunchTimeoutError extends BaseLaunchError {
  constructor(timeoutMs = 30_000, cause?: unknown) {
    super(
      LaunchErrorType.TIMEOUT,
      `Browser launch timeout after ${timeoutMs}ms`,
      true,
      { timeoutMs },
      cause,
    );
  }
}

/** Invalid or incompatible configuration — retrying cannot fix it. */
export class ConfigurationError extends BaseLaunchError {
  constructor(
    message: string,
    configField?: ConfigurationField,
    configValue?: unknown,
    cause?: unknown,
  ) {
    super(
      LaunchErrorType.CONFIGURATION,
      `Configuration error: ${message}`,
      false,
      { configField, configValue },
      cause,
    );
  }
}

/** A required system resource is unavailable. Some sub-kinds are retryable, a missing binary is not. */
export class ResourceError extends BaseLaunchError {
  constructor(message: string, resourceType: ResourceType, isRetryable = false, cause?: unknown) {
    super(
      LaunchErrorType.RESOURCE,
      `Resource error: ${message}`,
      isRetryable,
      { resourceType },
      cause,
    );
  }
}

/** A system-level operation failed — usually transient. */
export class SystemError extends BaseLaunchError {
  constructor(message: string, operation: SystemOperation, originalError?: Error) {
    super(
      LaunchErrorType.SYSTEM,
      `System error during ${operation}: ${message}`,
      true,
      { operation, originalError: originalError?.message },
      originalError,
    );
  }
}

/** Network operations: proxy negotiation, WebSocket setup, port binding. Usually transient. */
export class NetworkError extends BaseLaunchError {
  constructor(message: string, networkOperation: NetworkOperation, cause?: unknown) {
    super(
      LaunchErrorType.NETWORK,
      `Network error during ${networkOperation}: ${message}`,
      true,
      { networkOperation },
      cause,
    );
  }
}

/** Fingerprint generation or injection failed — retryable, with a no-fingerprint fallback. */
export class FingerprintError extends BaseLaunchError {
  constructor(message: string, stage: FingerprintStage, cause?: unknown) {
    super(
      LaunchErrorType.FINGERPRINT,
      `Fingerprint error during ${stage}: ${message}`,
      true,
      { stage },
      cause,
    );
  }
}

/** A plugin hook failed during launch. Retryability is the plugin's call. */
export class PluginError extends BaseLaunchError {
  constructor(
    message: string,
    pluginName: PluginName,
    operation: PluginOperation,
    isRetryable = true,
    cause?: unknown,
  ) {
    super(
      LaunchErrorType.PLUGIN,
      `Plugin error in ${pluginName} during ${operation}: ${message}`,
      isRetryable,
      { pluginName, operation },
      cause,
    );
  }
}

/** A cleanup step failed — non-critical to the launch itself. */
export class CleanupError extends BaseLaunchError {
  constructor(message: string, cleanupType: CleanupType, cause?: unknown) {
    super(
      LaunchErrorType.CLEANUP,
      `Cleanup error during ${cleanupType}: ${message}`,
      true,
      { cleanupType },
      cause,
    );
  }
}

/** The browser process failed to start or crashed immediately. Usually transient. */
export class BrowserProcessError extends BaseLaunchError {
  constructor(
    message: string,
    processState: BrowserProcessState,
    cause?: unknown,
    exitCode?: number,
  ) {
    super(
      LaunchErrorType.BROWSER_PROCESS,
      `Browser process error (${processState}): ${message}`,
      true,
      { processState, exitCode },
      cause,
    );
  }
}

/** Session-context (cookie/storage) injection failed. */
export class SessionContextError extends BaseLaunchError {
  constructor(message: string, contextType: SessionContextType, cause?: unknown) {
    super(
      LaunchErrorType.SESSION_CONTEXT,
      `Session context error with ${contextType}: ${message}`,
      true,
      { contextType },
      cause,
    );
  }
}

/**
 * Maps an unknown thrown value onto a typed error by inspecting its message. The donor's original
 * classifier; the patterns are the substrings a Node errno or a browser-launcher actually emits.
 * An already-typed error passes through untouched.
 */
export function categorizeError(error: unknown, context?: string): BaseLaunchError {
  if (error instanceof BaseLaunchError) return error;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
    return new LaunchTimeoutError();
  }
  if (
    lowerMessage.includes("enoent") ||
    lowerMessage.includes("not found") ||
    lowerMessage.includes("no such file")
  ) {
    return new ResourceError(errorMessage, ResourceType.FILE, false);
  }
  if (lowerMessage.includes("eacces") || lowerMessage.includes("permission denied")) {
    return new SystemError(errorMessage, SystemOperation.FILE_ACCESS);
  }
  if (lowerMessage.includes("eaddrinuse") || lowerMessage.includes("address already in use")) {
    return new NetworkError(errorMessage, NetworkOperation.PORT_BINDING);
  }
  if (lowerMessage.includes("proxy") || lowerMessage.includes("websocket")) {
    return new NetworkError(errorMessage, NetworkOperation.NETWORK_SETUP);
  }
  if (lowerMessage.includes("fingerprint")) {
    return new FingerprintError(errorMessage, FingerprintStage.GENERATION);
  }
  if (lowerMessage.includes("plugin")) {
    return new PluginError(errorMessage, PluginName.UNKNOWN, PluginOperation.LAUNCH);
  }
  if (lowerMessage.includes("cleanup") || lowerMessage.includes("clean")) {
    return new CleanupError(errorMessage, CleanupType.GENERAL);
  }
  if (
    lowerMessage.includes("chrome") ||
    lowerMessage.includes("browser") ||
    lowerMessage.includes("process")
  ) {
    return new BrowserProcessError(errorMessage, BrowserProcessState.UNKNOWN);
  }
  return new SystemError(
    errorMessage,
    SystemOperation.UNKNOWN_OPERATION,
    error instanceof Error ? error : undefined,
  );
}

/** True when the error type is worth retrying — the retry manager's entire policy. */
export function isErrorRetryable(error: Error): boolean {
  if (
    error instanceof ConfigurationError ||
    error instanceof ResourceError ||
    error instanceof LaunchTimeoutError
  ) {
    return false;
  }
  if (error instanceof BaseLaunchError) return error.isRetryable;
  // Conservative default for unclassified errors: do NOT retry. A retry loop that retries
  // everything burns its budget on errors that will never succeed.
  return false;
}

export { SystemError as SystemLaunchError };
