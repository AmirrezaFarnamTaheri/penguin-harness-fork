/**
 * The stealth browser plane's server half: the cluster daemon that owns the browser process and
 * its CDP endpoint, the session pooler that keeps warm target sessions, and the two pure
 * support modules the cluster keys its interception and retry policy off.
 *
 * The split between the cluster and the pool is deliberate. The cluster answers "is there a
 * browser, is it healthy, what identity does this session present"; the pool answers "give me a
 * live CDP session for this target and take it back intact". Mixing the two is what produces
 * the leak the exit criterion names — a session that ends while its CDP session stays checked
 * out, or a browser that is killed while its pool still believes it has sessions to hand out.
 *
 * Nothing here is wired into the HTTP surface yet: the module is imported on demand by the
 * sandbox and cockpit routes, which is why there is no route registration in this barrel.
 */
export {
  SteerableBrowserCluster,
  COLD_LAUNCH_TARGET_MS,
  STATIC_STEALTH_ARGS,
  HEADLESS_ARGS,
  HEADFUL_ARGS,
  BROWSER_PROCESS_PATTERNS,
  buildFingerprintInjectionScript,
  DOM_SNAPSHOT_EXPRESSION,
  normalizeResourceType,
  defaultExecutablePath,
  shouldDisableSandbox,
  dedupe,
  sweepLinuxProcesses,
  type BrowserProduct,
  type SteerableSessionConfig,
  type SteerableBrowserClusterOptions,
  type LaunchResult,
  type ClusterTelemetryListener,
} from "./steerable-browser-cluster.js";

export {
  CdpTransport,
  CdpSessionPool,
  connectCdpTransport,
  discoverCdpUrl,
  repairLoneSurrogates,
  tryReadCommandId,
  tryReadSessionId,
  bracketIPv6,
  rewriteWsHost,
  appendQuery,
  normalizeWsRootPath,
  type CdpEvent,
  type CdpErrorObject,
  type RawCdpMessage,
  type SessionEvictionReason,
  type CdpTransportOptions,
  type CdpSessionPoolOptions,
  type PooledSessionHandle,
} from "./cdp-session-pool.js";

export {
  LaunchErrorType,
  BrowserProcessState,
  PluginName,
  PluginOperation,
  CleanupType,
  SessionContextType,
  FingerprintStage,
  ResourceType,
  NetworkOperation,
  SystemOperation,
  ConfigurationField,
  BaseLaunchError,
  LaunchTimeoutError,
  ConfigurationError,
  ResourceError,
  SystemError,
  NetworkError,
  FingerprintError,
  PluginError,
  CleanupError,
  BrowserProcessError,
  SessionContextError,
  categorizeError,
  isErrorRetryable,
} from "./launch-error-taxonomy.js";

export {
  tryParseUrl,
  isAdRequest,
  isImageRequest,
  isHeavyMediaRequest,
  isHostBlocked,
  compileUrlPatterns,
  isUrlMatchingPatterns,
  classifyRequest,
  isLocalFileSystemRequest,
  AD_HOSTS,
  type OptimizeBandwidthOptions,
  type ResourceTypeLabel,
  type RequestDecision,
} from "./request-classifier.js";
