/**
 * Multi-agent neural swarm plane — peer mesh, dynamic roles, mathematical
 * consensus, wait-for-graph deadlock resolution, dependency-aware fan-out,
 * leased capability announcements, and evidence grounding.
 *
 * These modules sit *above* the existing `agent/` primitives rather than
 * beside them: `MeshProtocol` routes over `MailboxKernel` queues,
 * `ConsensusVotingEngine` tallies weighted ballots that `quorum-consensus.ts`
 * can then accept as endorsement grounds, and `TaskParallelizer` splits work
 * that `WorkflowPipeline` settles statically.
 */
export {
  MESH_BROADCAST,
  MailboxKernelMeshTransport,
  MeshProtocol,
  type MeshEnvelope,
  type MeshLinkKind,
  type MeshLinkState,
  type MeshNodeState,
  type MeshProtocolOptions,
  type MeshRoutingResult,
  type MeshTopologyView,
  type MeshTransport,
} from "./mesh-protocol.js";

export {
  RoleAllocator,
  STANDARD_SWARM_ROLES,
  type AgentProfile,
  type RoleAllocation,
  type RoleAllocatorOptions,
  type RoleDefinition,
  type ScoredPair,
  type SwarmRoleId,
} from "./role-allocator.js";

export {
  ConsensusVotingEngine,
  type Ballot,
  type BallotBoxOptions,
  type BallotOutcome,
  type Question,
  type TallyResult,
  type TieBreakPolicy,
  type VoteChoice,
  type VotingPolicy,
} from "./consensus-voting.js";

export {
  DeadlockResolver,
  type DeadlockReport,
  type DeadlockResolverOptions,
  type LockHold,
  type LockMode,
  type WaitRequest,
} from "./deadlock-resolver.js";

export {
  TaskParallelizer,
  type FanOutPlan,
  type ParallelWave,
  type Subtask,
  type SubtaskStatus,
  type TaskParallelizerOptions,
} from "./task-parallelizer.js";

export {
  AnnouncementDirectory,
  type Announcement,
  type AnnouncementDirectoryOptions,
  type AnnouncementEvent,
  type AnnouncementEventType,
  type AnnouncementQuery,
  type AnnouncementSubscription,
} from "./agent-announcement.js";

export {
  GroundingAgent,
  type EvidenceCitation,
  type GroundedArtifact,
  type GroundingAgentOptions,
  type GroundingSummary,
  type GroundingVerdict,
  type SwarmClaim,
} from "./grounding-agent.js";
