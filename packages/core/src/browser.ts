/**
 * Browser-safe entry point for @prismshadow/penguin-core.
 * Contains zero Node.js runtime dependencies (no fs, child_process, @aws-sdk, etc.)
 */

// Agent & Swarm Governance
export {
  QueryPartitioner,
  type PartitionResult,
  type SubQuery,
} from "./agent/query-partitioner.js";

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
