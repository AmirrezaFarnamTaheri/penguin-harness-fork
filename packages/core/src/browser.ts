/**
 * Browser-safe entry point for @prismshadow/penguin-core.
 * Contains zero Node.js runtime dependencies (no fs, child_process, @aws-sdk, etc.)
 */

// Agent & Swarm Governance
export {
  ShellGuardian,
  type ShellRiskLevel,
  type ShellFinding,
  type ShellSafetyAssessment,
} from "./agent/shell-guardian.js";

export {
  QuorumConsensusEngine,
  type TopicConsensusStatus,
  type QuorumPolicy,
  type Endorsement,
  type Refutation,
  type TopicStanding,
} from "./agent/quorum-consensus.js";

export {
  CodeGraph,
  type CodeNodeKind,
  type CodeEdgeKind,
  type CodeGraphNode,
  type CodeGraphEdge,
  type CodeGraphSubgraph,
  type ConceptExplanation,
} from "./agent/code-graph.js";

export {
  MailboxKernel,
  normalizeMailboxOwnerName,
  type MailboxMessage,
  type MailboxSummary,
  type MailboxLease,
  type LeaseState,
} from "./agent/mailbox.js";

export {
  LoopDetector,
  type LoopDetectorOptions,
  type LoopCheckResult,
} from "./agent/loop-detector.js";

export type { TurnStatus, Envelope, TerminalSummary, ReplayView } from "./agent/turn-ledger.js";

export {
  KanbanBoard,
  type KanbanTask,
  type KanbanTaskState,
  type KanbanTaskPriority,
  type TriageDraft,
} from "./agent/kanban.js";

export {
  WorkflowPipeline,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowNodeState,
  type WorkflowEdge,
  type WorkflowRunState,
} from "./agent/workflow-pipeline.js";

export { PersonaRegistry, BUILTIN_PERSONA_MASKS, type PersonaMask } from "./agent/persona-masks.js";

// Query decomposition: pure string surgery — bullet/clause splitting, shared-constraint
// carrying, intent classification over a keyword table — with no Node dependency, so the
// cockpit's decomposition preview renders the same partitioning the agent runtime performs.
export {
  QueryPartitioner,
  DEFAULT_SPECIALISTS,
  type SubQuery,
  type PartitionResult,
  type SpecialistCapability,
} from "./agent/query-partitioner.js";

// Wiki Engine & Knowledge Graph
export {
  WikiEngine,
  type WikiNode,
  type WikiNodeType,
  type WikiEdge,
  type WikiEdgeType,
  type WikiGraph,
  type WikiLintIssue,
  type WikiLintReport,
  type WikiSearchMatch,
} from "./state/wiki-engine.js";

// LLM Combos & Key Fleet
export {
  ModelComboRegistry,
  type ModelCombo,
  type ModelComboTarget,
  type FallbackTrigger,
} from "./llm/model-combos.js";

export {
  maskApiKey,
  type KeyHealthStatus,
  type KeyFleetRotationStrategy,
  type KeyHealthItem,
  type ModelKeyFleetReport,
  type FleetHealthStats,
  type KeyProbeResult,
  type CockpitKeyFleetSnapshot,
} from "./llm/key-fleet-monitor.js";

// HUD & Telemetry
export type {
  HudSpeedMetrics,
  HudPromptCacheMetrics,
  HudVcsMetrics,
  HudActiveTask,
} from "./hud/types.js";

export type {
  SpendFlowReport,
  SpendFlowNode,
  SpendFlowLink,
  SessionCostRecord,
} from "./hud/spend-flow.js";

// Stealth Browser Plane (Track 1)
//
// Every module below is pure, dependency-free TypeScript: the fingerprint and cursor math, the
// canvas-noise field, the WebGL parameter table, the TLS/JA3 record builders, the DOM
// interaction rules, the US keyboard layout, the Tier 4 profile presets, and the cockpit wire
// contract the browser cluster emits and the cockpit widgets render. They are re-exported here
// — the browser-safe entry — because both halves of the plane consume them: the server-side
// cluster composes them into the scripts it injects, and the web-side cockpit renders the
// contract types. Nothing in this block may import a Node.js built-in; the browser-safe-seam
// test asserts the whole entry bundles without one.
export {
  CANVAS_NOISE_COEFFICIENTS,
  canvasNoiseOffset,
  perturbPixel,
  buildCanvasNoiseScript,
  type CanvasNoiseOptions,
} from "./browser/canvas-noise-injector.js";

export {
  type CursorPoint,
  type CursorSimulatorOptions,
  type CursorStep,
  seededRandom,
  cubicBezier,
  easeDeceleration,
  stepDurationMs,
  planControlPoints,
  planCursorPath,
  estimateTravelDurationMs,
} from "./browser/cursor-simulator.js";

export {
  type DeviceClass,
  type FingerprintNavigator,
  type FingerprintScreen,
  type BrowserFingerprint,
  type FingerprintGeneratorOptions,
  relaxScreenConstraints,
  generateFingerprint,
  fingerprintsEqual,
} from "./browser/fingerprint-randomizer.js";

export {
  DEFAULT_WEBGL_IDENTITY,
  FALLBACK_WEBGL_IDENTITY,
  type WebGLIdentity,
  WEBGL_PARAMETER_OVERRIDES,
  GL_CONSTANT,
  buildWebGlParameterLookup,
  buildWebGlOverrideScript,
  webGlIdentityEquals,
} from "./browser/webgl-parameter-override.js";

export {
  type BrowserFamily,
  type TlsFingerprintProfile,
  TLS13_CIPHER_SUITES,
  CHROME_TLS12_CIPHER_SUITES,
  FIREFOX_TLS12_CIPHER_SUITES,
  SAFARI_TLS12_CIPHER_SUITES,
  COMMON_EXTENSIONS,
  CHROME_EXTENSIONS,
  CHROME_SUPPORTED_GROUPS,
  FIREFOX_SUPPORTED_GROUPS,
  CHROME_SIGNATURE_ALGORITHMS,
  ALPN_BY_FAMILY,
  GREASE_CODEPOINTS,
  applyGrease,
  buildCipherSuiteList,
  buildTlsFingerprintProfile,
  serializeJa3Record,
  serializeJa4Record,
  validateTlsFingerprintProfile,
} from "./browser/tls-fingerprint-profile.js";

export {
  type DomNodeDescriptor,
  ALWAYS_ACCEPT_TAGS,
  LEAF_ELEMENT_DENYLIST,
  INTERACTIVE_TAGS,
  INTERACTIVE_ROLES,
  INTERACTIVE_CURSORS,
  NON_INTERACTIVE_CURSORS,
  EXPLICIT_DISABLE_TAGS,
  INTERACTIVE_ARIA_ATTRS,
  DISTINCT_INTERACTIVE_TAGS,
  DISTINCT_INTERACTIVE_ROLES,
  TEST_ID_ATTRIBUTES,
  HEURISTIC_INTERACTIVE_CLASS_REGEX,
  SCROLLABLE_THRESHOLD_PX,
  INTERACTIVE_CONTAINER_SELECTOR,
  IGNORE_ATTRIBUTES,
  isElementAccepted,
  isElementVisible,
  computeScrollData,
  isInteractiveCandidate,
  hasInteractiveAria,
  isInteractiveElement,
  isHeuristicallyInteractive,
  isElementDistinctInteraction,
} from "./browser/dom-interaction-rules.js";

export {
  type KeyInfo,
  charToKeyInfo,
  punctuationKeyInfo,
  keyTextFor,
  namedKeyInfo,
  splitTypableSegments,
  MOUSE_BUTTON_BITMASK,
  type MouseButton,
  MOUSE_EVENT_SEQUENCE,
  periodIsNotVkDelete,
} from "./browser/us-keyboard-layout.js";

export {
  type ProfileId,
  type BrowserProfilePreset,
  DESKTOP_CHROME_WIN11,
  MOBILE_SAFARI_IOS17,
  ENTERPRISE_FIREFOX_LINUX,
  BROWSER_PROFILE_PRESETS,
  DEFAULT_BROWSER_PROFILE,
  getBrowserProfile,
  validateBrowserProfile,
  presetToFingerprint,
} from "./browser/browser-profile-presets.js";

export {
  CockpitBrowserEventKind,
  BrowserSessionState,
  type TargetDescriptor,
  type ViewportInfo,
  type ViewportFrame,
  type DomTreeNode,
  type DomSnapshot,
  type NetworkResourceType,
  type NetworkHarvestEntry,
  type ConsoleMessage,
  type BrowserClusterMetrics,
  type CockpitBrowserEvent,
} from "./browser/cockpit-browser-events.js";
