/**
 * LLM interface module entry point.
 *
 * Exports `GenerativeModel` (the LLMInterface implementation), along with internal
 * pure conversion functions for unit testing (message merging, event translation,
 * token accounting, UniConfig construction, retry determination).
 */
export {
  GenerativeModel,
  EventTranslator,
  groupHistoryToUniMessages,
  mergeOmniToUniMessage,
  translateEvents,
  usageToTokenCounts,
  isMalformedJsonParseError,
  isIncompleteStreamError,
  isFatalProviderRejection,
  isAuthenticationError,
  isFastModeUnsupportedError,
  isRateLimitError,
  FAST_MODE_UNSUPPORTED_GUIDANCE,
  mapThinkingLevel,
  toolDefinitionsToSchemas,
  buildUniConfig,
} from "./generative-model.js";
export {
  ApiKeyRotator,
  parseApiKeys,
  KeyRotatorRegistry,
  WeightedKeyRotator,
} from "./key-rotator.js";
export type {
  KeyStatus,
  KeyHealth,
  ApiKeyRotatorOptions,
  WeightedKeyStatus,
  WeightedKeyRotatorOptions,
} from "./key-rotator.js";
export { KeyFleetMonitor, maskApiKey } from "./key-fleet-monitor.js";
export type {
  KeyHealthStatus,
  KeyFleetRotationStrategy,
  KeyHealthItem,
  ModelKeyFleetReport,
  FleetHealthStats,
  KeyProbeResult,
  CockpitKeyFleetSnapshot,
  ProbeFunction,
  ProviderRegistration,
} from "./key-fleet-monitor.js";
export { listEndpointModels } from "./list-models.js";
export type { ListEndpointModelsOptions } from "./list-models.js";
export { ToolCallIdAllocator, stripToolCallIdSuffix } from "./tool-call-ids.js";
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_CONTEXT_LENGTH,
  OUTPUT_SAFETY_MARGIN,
  MIN_OUTPUT_TOKENS,
  COMPACTION_HEADROOM,
  resolveContextWindow,
  approximateTokens,
  approximateMessagesTokens,
  effectiveMaxOutputTokens,
  effectiveMaxContextLength,
} from "./context-limits.js";
export { detectQuotaExhaustion, parseDurationToMs, formatDurationMs } from "./quota-parser.js";
export type { QuotaDetectionResult } from "./quota-parser.js";
export { ModelComboRegistry } from "./model-combos.js";
export type {
  ModelCombo,
  ModelComboTarget,
  FallbackTrigger,
  ComboResolutionContext,
} from "./model-combos.js";
export {
  PricingCatalog,
  DEFAULT_PRICING_CATALOG,
  usageCountsFromTokenCounts,
} from "./pricing-catalog.js";
export type { ModelPricingEntry, DetailedUsageCounts, CostBreakdown } from "./pricing-catalog.js";
export { InferenceProxyPool, parseProxyUrl } from "./proxy-pool.js";
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
} from "./proxy-pool.js";
export {
  isTruncatedJSON,
  repairTruncatedJSON,
  scavengeToolCalls,
  truncateKeepEnds,
} from "./tool-call-repair.js";
export type { ScavengedToolCall } from "./tool-call-repair.js";
