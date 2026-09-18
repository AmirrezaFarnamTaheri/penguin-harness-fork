/**
 * The Universal Tool Mesh: standardized tool integration for 250+ SaaS providers with
 * managed OAuth/PKCE, credential rotation, dynamic CLI wrapping, and encrypted
 * credential storage.
 *
 * Layers, from the bottom up:
 *
 *  - {@link EncryptedCredentialStore} — AES-256-GCM vault; secrets at rest, plaintext
 *    only between a `get` and its use.
 *  - {@link *PkceExchange} — RFC 7636 token exchange: real S256 verifier/challenge
 *    derivation, loopback redirect receiver, refresh with rotation.
 *  - {@link CredentialRotationTracker} / {@link CredentialRefreshScheduler} — rate-limit
 *    tracking, exponential backoff with jitter, health scoring, scheduled refreshes.
 *  - {@link CliWrapperRegistry} — declarative manifest → safe `argv` → spawned process,
 *    with no shell in the path and secret redaction built in.
 *  - {@link ProviderPreset} catalog — 300 real providers distilled from 1,519 toolkits.
 *  - {@link ToolCapabilityCatalog} — intent-based discovery over the tool surface.
 *  - {@link ToolMeshRegistry} — the synthesis point: tools + presets + credentials +
 *    capabilities, resolved in one call with an encrypted audit trail.
 */
export {
  CREDENTIAL_AUTH_SCHEMES,
  CREDENTIAL_PERSISTENCE,
  CredentialStoreError,
  ENVELOPE_HEADER,
  EncryptedCredentialStore,
  computeHash,
  deriveKey,
  encryptEnvelope,
  decryptEnvelope,
  generateIv,
  generateSalt,
  machineIdentifier,
  type CredentialAuthScheme,
  type CredentialModifiers,
  type CredentialPersistence,
  type CredentialSetOptions,
  type CredentialStoreErrorKind,
  type EncryptedCredentialStoreOptions,
  type StoredCredential,
} from "./encrypted-credential-store.js";

export {
  CONNECTION_STATUS,
  PKCE_FLOW_STATUS,
  PKCE_METHOD,
  PKCE_VERIFIER_BYTES,
  PkceError,
  base64url,
  basicAuthHeader,
  buildAuthorizationUrl,
  buildRefreshBody,
  buildTokenExchangeBody,
  deriveCodeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generatePkcePair,
  parseCallbackUrl,
  refreshTokens,
  startLoopbackReceiver,
  startPkceSession,
  tokenExpiry,
  validateTokenResponse,
  type AuthorizationRequest,
  type LoopbackCallbackResult,
  type LoopbackReceiver,
  type LoopbackReceiverOptions,
  type PkceFlowStatus,
  type PkcePair,
  type PkceProviderConfig,
  type PkceSession,
  type ConnectionStatus,
  type TokenResponse,
  type TokenTransport,
} from "./oauth-pkce-exchange.js";

export {
  BACKOFF_BASE_MS,
  BACKOFF_CEILING_MS,
  BACKOFF_FLOOR_MS,
  CredentialRefreshScheduler,
  CredentialRotationTracker,
  FAILURE_EXPIRY_MS,
  MAX_LOCKOUT_MS,
  PERMANENT_REASONS,
  RATE_LIMIT_REASON,
  SELECTION_MODE,
  SESSION_BINDING_MS,
  backoffFor,
  classifyRateLimitReason,
  healthScore,
  limitKey,
  selectCredential,
  type CredentialHealth,
  type CredentialStats,
  type RateLimitEntry,
  type RateLimitReason,
  type RefreshJob,
  type RefreshSchedulerOptions,
  type RotationEvent,
  type SelectCredentialRequest,
  type SelectionMode,
} from "./credential-rotation.js";

export {
  ARG_TYPES,
  CLI_STRATEGY,
  CliWrapperError,
  CliWrapperRegistry,
  CommandSpacer,
  buildArgv,
  coerceArgValue,
  formatArgSummary,
  formatCommandExample,
  invokeCli,
  redactArgv,
  serializeArg,
  type ArgType,
  type CliArgSpec,
  type CliCommandManifest,
  type CliStrategy,
  type CommandAccess,
  type InvokeOptions,
  type InvokeResult,
  type SerializedArg,
} from "./cli-wrapper.js";

export {
  BASE_URL_FIELDS,
  PROVIDER_COUNT,
  PROVIDER_TOOL_TOTAL,
  baseUrlField,
  getProvider,
  hasProvider,
  listProviders,
  preferredScheme,
  providerCategories,
  providersByCategory,
  providersByScheme,
  searchProviders,
  type ProviderPreset,
} from "./provider-preset-catalog.js";

export {
  BUILTIN_CAPABILITY_ROWS,
  CAPABILITY_ACCESS,
  CAPABILITY_SEARCH_MODE,
  CapabilityCatalogError,
  HYBRID_RANKER,
  KEYWORD_RANKER,
  SEMANTIC_RANKER,
  ToolCapabilityCatalog,
  createBuiltinCapabilityCatalog,
  idTokens,
  keywordScore,
  semanticScore,
  seedCapabilityCatalog,
  tokenize,
  type Capability,
  type CapabilityAccess,
  type CapabilityInput,
  type CapabilityRanker,
  type CapabilitySearchMode,
} from "./tool-capability-catalog.js";

export {
  ToolMeshError,
  ToolMeshRegistry,
  oauthConnectableProviders,
  type AuditEntry,
  type MeshTool,
  type ResolvedTool,
  type ToolBinding,
  type ToolExecutor,
  type ToolInvocationResult,
  type ToolMeshRegistryOptions,
} from "./tool-mesh-registry.js";
